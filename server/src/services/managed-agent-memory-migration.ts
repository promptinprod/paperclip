import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, projects } from "@paperclipai/db";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import {
  refreshManagedAgentLegacyReviewQmdCollection,
  refreshManagedAgentProjectQmdCollection,
  resolveManagedAgentLegacyReviewDir,
  resolveManagedAgentProjectMemoryDir,
} from "./managed-agent-memory.js";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

const MANAGED_MEMORY_TOP_LEVEL_FILES = ["MEMORY.md"] as const;
const MANAGED_MEMORY_RELATIVE_DIRS = ["memory", "life"] as const;
const MIGRATION_STATE_FILENAME = ".paperclip-managed-memory-project-migration.json";
const MIGRATION_VERSION = 1;
const ISSUE_IDENTIFIER_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const BULLET_START_RE = /^\s*(?:[-*]|\d+\.)\s+/;
const SECTION_HEADING_RE = /^##\s+/;
const TITLE_HEADING_RE = /^#\s+/;

type MigrationProjectRecord = {
  id: string;
  name: string;
  slug: string;
};

export type LegacyManagedMemoryProjectLookup = {
  issueProjectByIdentifier: Map<string, string>;
  projectBySlug: Map<string, string>;
  projectNamePatterns: Array<{ id: string; pattern: string }>;
};

type DailyNoteSplitResult = {
  byProjectId: Map<string, string>;
  quarantineContent: string | null;
};

type WriteResult = {
  changed: boolean;
  conflict: boolean;
};

export type LegacyManagedMemoryMigrationResult = {
  status: "migrated" | "skipped";
  reason: "already_migrated" | "no_legacy_memory" | null;
  projectIds: string[];
  quarantined: boolean;
  migratedFiles: number;
  migratedDailyNoteBlocks: number;
  quarantinedFiles: number;
  quarantinedDailyNoteBlocks: number;
  conflictingWrites: number;
};

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function listManagedLegacyFiles(rootDir: string): Promise<string[]> {
  const relativePaths: string[] = [];

  for (const filename of MANAGED_MEMORY_TOP_LEVEL_FILES) {
    const absolutePath = path.join(rootDir, filename);
    const entry = await fs.stat(absolutePath).catch(() => null);
    if (entry?.isFile()) {
      relativePaths.push(filename);
    }
  }

  for (const directory of MANAGED_MEMORY_RELATIVE_DIRS) {
    const absoluteDir = path.join(rootDir, directory);
    const entries = await fs.readdir(absoluteDir, { withFileTypes: true }).catch(() => null);
    if (!entries) continue;

    const walk = async (baseDir: string, relativeDir: string) => {
      const children = await fs.readdir(baseDir, { withFileTypes: true }).catch(() => null);
      if (!children) return;
      for (const child of children) {
        const absolutePath = path.join(baseDir, child.name);
        const relativePath = path.posix.join(relativeDir, child.name);
        if (child.isDirectory()) {
          await walk(absolutePath, relativePath);
          continue;
        }
        if (child.isFile()) {
          relativePaths.push(relativePath);
        }
      }
    };

    await walk(absoluteDir, directory);
  }

  return relativePaths.sort();
}

function buildMigrationStatePath(agentId: string): string {
  return path.join(resolveDefaultAgentWorkspaceDir(agentId), MIGRATION_STATE_FILENAME);
}

async function readMigrationState(agentId: string): Promise<Record<string, unknown> | null> {
  const statePath = buildMigrationStatePath(agentId);
  const raw = await fs.readFile(statePath, "utf8").catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

async function writeMigrationState(agentId: string, payload: Record<string, unknown>): Promise<void> {
  const statePath = buildMigrationStatePath(agentId);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        version: MIGRATION_VERSION,
        ...payload,
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function buildMigrationLookup(db: Db, companyId: string): Promise<LegacyManagedMemoryProjectLookup> {
  const [issueRows, projectRows] = await Promise.all([
    db
      .select({ identifier: issues.identifier, projectId: issues.projectId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), isNotNull(issues.identifier), isNotNull(issues.projectId))),
    db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(eq(projects.companyId, companyId)),
  ]);

  const issueProjectByIdentifier = new Map<string, string>();
  for (const row of issueRows) {
    if (!row.identifier || !row.projectId) continue;
    issueProjectByIdentifier.set(row.identifier.toUpperCase(), row.projectId);
  }

  const records: MigrationProjectRecord[] = projectRows.map((row) => ({
    id: row.id,
    name: row.name,
    slug: deriveAgentUrlKey(row.name),
  }));

  return {
    issueProjectByIdentifier,
    projectBySlug: new Map(records.map((record) => [record.slug, record.id])),
    projectNamePatterns: records.map((record) => ({
      id: record.id,
      pattern: record.name.trim().toLowerCase(),
    })),
  };
}

function classifyTextToProjectId(
  text: string,
  lookup: LegacyManagedMemoryProjectLookup,
): { projectId: string | null; ambiguous: boolean } {
  const normalized = normalizeText(text);
  const matchedProjectIds = new Set<string>();

  for (const match of normalized.matchAll(ISSUE_IDENTIFIER_RE)) {
    const projectId = lookup.issueProjectByIdentifier.get(match[0].toUpperCase());
    if (projectId) matchedProjectIds.add(projectId);
  }

  const lower = normalized.toLowerCase();
  for (const project of lookup.projectNamePatterns) {
    if (!project.pattern || !lower.includes(project.pattern)) continue;
    matchedProjectIds.add(project.id);
  }

  if (matchedProjectIds.size === 1) {
    return { projectId: Array.from(matchedProjectIds)[0] ?? null, ambiguous: false };
  }

  return {
    projectId: null,
    ambiguous: matchedProjectIds.size > 1,
  };
}

export function splitLegacyManagedDailyNoteByProject(
  content: string,
  lookup: LegacyManagedMemoryProjectLookup,
): DailyNoteSplitResult {
  const normalized = normalizeText(content);
  const lines = normalized.split("\n");
  const titleLine = lines.find((line) => TITLE_HEADING_RE.test(line.trim())) ?? null;
  const bodyStartIndex =
    titleLine == null ? 0 : Math.max(0, lines.findIndex((line) => line === titleLine) + 1);
  const bodyLines = lines.slice(bodyStartIndex);

  const sections: Array<{ heading: string | null; lines: string[] }> = [];
  let currentHeading: string | null = null;
  let currentLines: string[] = [];
  const flushSection = () => {
    if (currentLines.length === 0 && currentHeading == null) return;
    sections.push({ heading: currentHeading, lines: currentLines });
    currentHeading = null;
    currentLines = [];
  };

  for (const line of bodyLines) {
    if (SECTION_HEADING_RE.test(line.trim())) {
      flushSection();
      currentHeading = line;
      continue;
    }
    currentLines.push(line);
  }
  flushSection();

  const grouped = new Map<string, string[]>();
  const seenSectionsByGroup = new Map<string, Set<string>>();
  const ensureGroup = (key: string) => {
    let parts = grouped.get(key);
    if (!parts) {
      parts = [];
      if (titleLine) parts.push(titleLine);
      grouped.set(key, parts);
    }
    let seen = seenSectionsByGroup.get(key);
    if (!seen) {
      seen = new Set<string>();
      seenSectionsByGroup.set(key, seen);
    }
    return { parts, seen };
  };

  const splitBlocks = (sectionLines: string[]): string[] => {
    const blocks: string[] = [];
    let current: string[] = [];
    const flush = () => {
      const value = current.join("\n").trim();
      if (value) blocks.push(value);
      current = [];
    };

    for (const line of sectionLines) {
      const trimmed = line.trim();
      if (!trimmed) {
        flush();
        continue;
      }
      if (BULLET_START_RE.test(line) && current.length > 0) {
        flush();
      }
      current.push(line);
    }
    flush();
    return blocks;
  };

  for (const section of sections) {
    const blocks = splitBlocks(section.lines);
    for (const block of blocks) {
      const classification = classifyTextToProjectId(block, lookup);
      const key = classification.projectId ?? "__quarantine__";
      const { parts, seen } = ensureGroup(key);
      const sectionKey = section.heading ?? "__default__";
      if (section.heading && !seen.has(sectionKey)) {
        parts.push(section.heading);
        seen.add(sectionKey);
      }
      parts.push(block);
    }
  }

  const byProjectId = new Map<string, string>();
  for (const [key, parts] of grouped.entries()) {
    if (key === "__quarantine__") continue;
    byProjectId.set(key, parts.join("\n\n").trim());
  }

  return {
    byProjectId,
    quarantineContent: grouped.get("__quarantine__")?.join("\n\n").trim() ?? null,
  };
}

async function writeFileIfChanged(targetPath: string, content: string): Promise<WriteResult> {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  const existing = await fs.readFile(targetPath, "utf8").catch(() => null);
  if (existing == null) {
    await fs.writeFile(targetPath, content, "utf8");
    return { changed: true, conflict: false };
  }
  if (normalizeText(existing) === normalizeText(content)) {
    return { changed: false, conflict: false };
  }
  return { changed: false, conflict: true };
}

async function writeWithConflictQuarantine(input: {
  destinationRoot: string;
  relativePath: string;
  content: string;
  quarantineRoot: string;
  conflictScope: string;
}): Promise<WriteResult> {
  const targetPath = path.join(input.destinationRoot, input.relativePath);
  const result = await writeFileIfChanged(targetPath, input.content);
  if (!result.conflict) return result;

  const conflictPath = path.join(
    input.quarantineRoot,
    "conflicts",
    input.conflictScope,
    input.relativePath,
  );
  await fs.mkdir(path.dirname(conflictPath), { recursive: true });
  await fs.writeFile(conflictPath, input.content, "utf8");
  return { changed: true, conflict: true };
}

function resolveProjectIdFromLegacyProjectPath(
  relativePath: string,
  lookup: LegacyManagedMemoryProjectLookup,
): string | null {
  const segments = relativePath.split("/");
  if (segments.length < 3) return null;
  const projectSlug = deriveAgentUrlKey(segments[2] ?? "");
  return lookup.projectBySlug.get(projectSlug) ?? null;
}

export async function migrateLegacyManagedAgentMemory(input: {
  db: Db;
  agentId: string;
  companyId: string;
  slug: string;
}): Promise<LegacyManagedMemoryMigrationResult> {
  const existingState = await readMigrationState(input.agentId);
  if ((existingState?.version as number | undefined) === MIGRATION_VERSION) {
    return {
      status: "skipped",
      reason: "already_migrated",
      projectIds: [],
      quarantined: false,
      migratedFiles: 0,
      migratedDailyNoteBlocks: 0,
      quarantinedFiles: 0,
      quarantinedDailyNoteBlocks: 0,
      conflictingWrites: 0,
    };
  }

  const legacyRoot = resolveDefaultAgentWorkspaceDir(input.agentId);
  await fs.mkdir(legacyRoot, { recursive: true });
  const legacyFiles = await listManagedLegacyFiles(legacyRoot);
  if (legacyFiles.length === 0) {
    await writeMigrationState(input.agentId, {
      migratedAt: new Date().toISOString(),
      status: "no_legacy_memory",
      projectIds: [],
      quarantined: false,
    });
    return {
      status: "skipped",
      reason: "no_legacy_memory",
      projectIds: [],
      quarantined: false,
      migratedFiles: 0,
      migratedDailyNoteBlocks: 0,
      quarantinedFiles: 0,
      quarantinedDailyNoteBlocks: 0,
      conflictingWrites: 0,
    };
  }

  const lookup = await buildMigrationLookup(input.db, input.companyId);
  const legacyReviewRoot = resolveManagedAgentLegacyReviewDir(input.agentId);
  const usedProjectIds = new Set<string>();
  let quarantined = false;
  let migratedFiles = 0;
  let migratedDailyNoteBlocks = 0;
  let quarantinedFiles = 0;
  let quarantinedDailyNoteBlocks = 0;
  let conflictingWrites = 0;

  for (const relativePath of legacyFiles) {
    const sourcePath = path.join(legacyRoot, relativePath);
    const content = await fs.readFile(sourcePath, "utf8").catch(() => null);
    if (content == null) continue;

    if (relativePath === "MEMORY.md") {
      const result = await writeWithConflictQuarantine({
        destinationRoot: legacyReviewRoot,
        relativePath,
        content,
        quarantineRoot: legacyReviewRoot,
        conflictScope: "legacy-review",
      });
      quarantined = true;
      quarantinedFiles += 1;
      if (result.conflict) conflictingWrites += 1;
      continue;
    }

    if (relativePath.startsWith("life/projects/")) {
      const projectId = resolveProjectIdFromLegacyProjectPath(relativePath, lookup);
      if (!projectId) {
        const result = await writeWithConflictQuarantine({
          destinationRoot: legacyReviewRoot,
          relativePath,
          content,
          quarantineRoot: legacyReviewRoot,
          conflictScope: "legacy-review",
        });
        quarantined = true;
        quarantinedFiles += 1;
        if (result.conflict) conflictingWrites += 1;
        continue;
      }

      const result = await writeWithConflictQuarantine({
        destinationRoot: resolveManagedAgentProjectMemoryDir(input.agentId, projectId),
        relativePath,
        content,
        quarantineRoot: legacyReviewRoot,
        conflictScope: projectId,
      });
      usedProjectIds.add(projectId);
      migratedFiles += 1;
      if (result.conflict) conflictingWrites += 1;
      continue;
    }

    if (relativePath.startsWith("memory/") && relativePath.endsWith(".md")) {
      const split = splitLegacyManagedDailyNoteByProject(content, lookup);
      for (const [projectId, projectContent] of split.byProjectId.entries()) {
        if (!projectContent.trim()) continue;
        const result = await writeWithConflictQuarantine({
          destinationRoot: resolveManagedAgentProjectMemoryDir(input.agentId, projectId),
          relativePath,
          content: projectContent,
          quarantineRoot: legacyReviewRoot,
          conflictScope: projectId,
        });
        usedProjectIds.add(projectId);
        migratedDailyNoteBlocks += 1;
        if (result.conflict) conflictingWrites += 1;
      }
      if (split.quarantineContent?.trim()) {
        const result = await writeWithConflictQuarantine({
          destinationRoot: legacyReviewRoot,
          relativePath,
          content: split.quarantineContent,
          quarantineRoot: legacyReviewRoot,
          conflictScope: "legacy-review",
        });
        quarantined = true;
        quarantinedDailyNoteBlocks += 1;
        if (result.conflict) conflictingWrites += 1;
      }
      continue;
    }

    const result = await writeWithConflictQuarantine({
      destinationRoot: legacyReviewRoot,
      relativePath,
      content,
      quarantineRoot: legacyReviewRoot,
      conflictScope: "legacy-review",
    });
    quarantined = true;
    quarantinedFiles += 1;
    if (result.conflict) conflictingWrites += 1;
  }

  for (const projectId of Array.from(usedProjectIds).sort()) {
    await refreshManagedAgentProjectQmdCollection(input.agentId, input.slug, projectId);
  }
  if (quarantined) {
    await refreshManagedAgentLegacyReviewQmdCollection(input.agentId, input.slug);
  }

  await writeMigrationState(input.agentId, {
    migratedAt: new Date().toISOString(),
    status: "migrated",
    projectIds: Array.from(usedProjectIds).sort(),
    quarantined,
    migratedFiles,
    migratedDailyNoteBlocks,
    quarantinedFiles,
    quarantinedDailyNoteBlocks,
    conflictingWrites,
  });

  return {
    status: "migrated",
    reason: null,
    projectIds: Array.from(usedProjectIds).sort(),
    quarantined,
    migratedFiles,
    migratedDailyNoteBlocks,
    quarantinedFiles,
    quarantinedDailyNoteBlocks,
    conflictingWrites,
  };
}
