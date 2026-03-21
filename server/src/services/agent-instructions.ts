import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import {
  SUPPORTED_MANAGED_AGENT_MEMORY_ADAPTER_TYPES,
  supportsManagedAgentMemoryAdapter,
} from "./managed-agent-memory.js";

const DEFAULT_INSTRUCTIONS_CONFIG_KEY = "instructionsFilePath";
const KNOWN_INSTRUCTIONS_PATH_KEYS = ["instructionsFilePath", "agentsMdPath"] as const;

export const MANAGED_MEMORY_BEGIN_MARKER = "<!-- PAPERCLIP:BEGIN MEMORY -->";
export const MANAGED_MEMORY_END_MARKER = "<!-- PAPERCLIP:END MEMORY -->";

const LEGACY_MEMORY_HEADING = /^## Memory\s*$/m;
const GUIDELINES_HEADING = /^## Guidelines\s*$/m;

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function supportsManagedInstructions(adapterType: string | null | undefined): boolean {
  return supportsManagedAgentMemoryAdapter(adapterType);
}

function getConfiguredInstructionsPathKey(
  adapterConfig: Record<string, unknown>,
): typeof KNOWN_INSTRUCTIONS_PATH_KEYS[number] | null {
  for (const key of KNOWN_INSTRUCTIONS_PATH_KEYS) {
    if (asNonEmptyString(adapterConfig[key])) return key;
  }
  return null;
}

function resolveConfiguredInstructionsPath(
  configuredPath: string,
  adapterConfig: Record<string, unknown>,
): string | null {
  if (path.isAbsolute(configuredPath)) return configuredPath;

  const cwd = asNonEmptyString(adapterConfig.cwd);
  if (!cwd || !path.isAbsolute(cwd)) return null;
  return path.resolve(cwd, configuredPath);
}

function deriveRelativePath(
  absolutePath: string,
  adapterConfig: Record<string, unknown>,
): string {
  const cwd = asNonEmptyString(adapterConfig.cwd);
  if (!cwd || !path.isAbsolute(cwd)) return absolutePath;
  const relativePath = path.relative(cwd, absolutePath);
  return relativePath.length > 0 && !relativePath.startsWith("..") ? relativePath : absolutePath;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

function upsertManagedMemoryBlock(existingContent: string, managedBlock: string): {
  content: string;
  mode: "unchanged" | "replaced" | "legacy_replaced" | "appended";
} {
  const normalized = normalizeLineEndings(existingContent);
  const managedBlockPattern = new RegExp(
    `${escapeRegex(MANAGED_MEMORY_BEGIN_MARKER)}[\\s\\S]*?${escapeRegex(MANAGED_MEMORY_END_MARKER)}`,
    "m",
  );

  if (managedBlockPattern.test(normalized)) {
    const nextContent = normalized.replace(managedBlockPattern, managedBlock);
    return {
      content: nextContent,
      mode: nextContent === normalized ? "unchanged" : "replaced",
    };
  }

  const memoryMatch = LEGACY_MEMORY_HEADING.exec(normalized);
  if (memoryMatch && typeof memoryMatch.index === "number") {
    const afterMemory = normalized.slice(memoryMatch.index);
    const guidelinesMatch = GUIDELINES_HEADING.exec(afterMemory);
    const endIndex =
      guidelinesMatch && typeof guidelinesMatch.index === "number"
        ? memoryMatch.index + guidelinesMatch.index
        : normalized.length;

    const before = normalized.slice(0, memoryMatch.index).trimEnd();
    const after = normalized.slice(endIndex).trimStart();
    const nextContent = [before, managedBlock, after].filter((part) => part.length > 0).join("\n\n");
    return {
      content: nextContent,
      mode: nextContent === normalized ? "unchanged" : "legacy_replaced",
    };
  }

  const trimmed = normalized.trimEnd();
  const nextContent = trimmed.length > 0 ? `${trimmed}\n\n${managedBlock}` : managedBlock;
  return {
    content: nextContent,
    mode: nextContent === normalized ? "unchanged" : "appended",
  };
}

export function shouldAutoGenerateInstructions(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
): boolean {
  return resolveManagedInstructionsTarget(adapterType, adapterConfig, "placeholder") !== null;
}

export interface ManagedInstructionsTarget {
  absolutePath: string;
  relativePath: string;
  configKey: string;
  shouldPersistConfig: boolean;
}

export function resolveManagedInstructionsTarget(
  adapterType: string | null | undefined,
  adapterConfig: Record<string, unknown>,
  slug: string,
): ManagedInstructionsTarget | null {
  if (!supportsManagedInstructions(adapterType)) return null;

  const configuredKey = getConfiguredInstructionsPathKey(adapterConfig);
  if (configuredKey) {
    const configuredPath = asNonEmptyString(adapterConfig[configuredKey]);
    if (!configuredPath) return null;
    const absolutePath = resolveConfiguredInstructionsPath(configuredPath, adapterConfig);
    if (!absolutePath) return null;
    return {
      absolutePath,
      relativePath: deriveRelativePath(absolutePath, adapterConfig),
      configKey: configuredKey,
      shouldPersistConfig: false,
    };
  }

  const cwd = asNonEmptyString(adapterConfig.cwd);
  if (!cwd || !path.isAbsolute(cwd)) return null;

  const relativePath = path.join(".agents", slug, "AGENTS.md");
  const absolutePath = path.join(cwd, relativePath);
  return {
    absolutePath,
    relativePath,
    configKey: DEFAULT_INSTRUCTIONS_CONFIG_KEY,
    shouldPersistConfig: true,
  };
}

export interface RenderInstructionsInput {
  agentName: string;
  role: string;
  title?: string | null;
  slug: string;
  capabilities?: string | null;
  parentName?: string | null;
  childCollections?: string[] | null;
}

export function renderManagedMemoryBlock(input: RenderInstructionsInput): string {
  const parentLine = input.parentName
    ? `- Your direct manager (${input.parentName}) may read and update the current project's collection when they are working on the same project.`
    : "- You have no direct manager configured.";

  return `${MANAGED_MEMORY_BEGIN_MARKER}
## Memory

You MUST use the \`para-memory-files\` skill for all memory operations: storing facts, writing daily notes, creating entities, running weekly synthesis, recalling past context, and managing plans.

Invoke it whenever you need to remember, retrieve, or organize anything.

Managed local memory is project-scoped. For project-backed runs, Paperclip sets \`$AGENT_HOME\` to the current project's memory root and injects the active QMD collection name in \`$PAPERCLIP_MEMORY_COLLECTION\`.

### Memory workflow

- After loading issue context for a task, build a compact recall brief from the issue title, description, goal, project, ancestor titles, and wake comment if present.
- Search the current project's QMD collection with that recall brief before doing domain work.
- If you manage direct reports, search each same-project direct-report collection listed in \`$PAPERCLIP_DIRECT_REPORT_MEMORY_COLLECTIONS_JSON\`.
- If a search returns relevant hits, load at least one relevant item with \`qmd get\`, \`qmd multi-get\`, or the equivalent QMD MCP fetch tool before proceeding.
- Write meaningful task progress and outcomes to \`$AGENT_HOME/memory/YYYY-MM-DD.md\`.
- Extract durable facts, decisions, and references to the relevant files under \`$AGENT_HOME/life/\`.
- Update \`AGENTS.md\`, \`TOOLS.md\`, or the relevant skill file when you learn a durable operating lesson.
- Runs without a project do not participate in managed QMD memory. Assign the work to a project before relying on managed recall or managed writes.

### Completion rule

Before considering a task complete, write the outcome to memory:

- Append progress and outcomes to \`$AGENT_HOME/memory/YYYY-MM-DD.md\`.
- Extract durable facts and decisions to the relevant files under \`$AGENT_HOME/life/\`.
- Verify the memory is discoverable with \`qmd query ... --collection "$PAPERCLIP_MEMORY_COLLECTION"\` or \`qmd search ... --collection "$PAPERCLIP_MEMORY_COLLECTION"\`.

Paperclip tries to create this collection automatically. If it is missing, create it with:
\`\`\`bash
qmd collection add $AGENT_HOME --name "$PAPERCLIP_MEMORY_COLLECTION"
\`\`\`

Use memory with:
\`\`\`bash
qmd query "search terms" --collection "$PAPERCLIP_MEMORY_COLLECTION"
qmd search "exact phrase" --collection "$PAPERCLIP_MEMORY_COLLECTION"
\`\`\`

### Collection access

- Your current project collection: \`$PAPERCLIP_MEMORY_COLLECTION\`
${parentLine}
- Same-project direct-report collections you may read and update are provided at runtime in \`$PAPERCLIP_DIRECT_REPORT_MEMORY_COLLECTIONS_JSON\`.
${MANAGED_MEMORY_END_MARKER}`;
}

export function renderInstructionsTemplate(input: RenderInstructionsInput): string {
  const { agentName, role, title, capabilities } = input;
  const titleLine = title ? `\n**Title:** ${title}` : "";
  const identitySuffix = title ? ` with the title of ${title}` : "";
  const capabilitiesText =
    capabilities ||
    "No specific capabilities defined yet. Update this section as responsibilities become clear.";

  return `# ${agentName}

**Role:** ${role}${titleLine}

## Identity

You are ${agentName}, a ${role} agent${identitySuffix}.

## Capabilities

${capabilitiesText}

${renderManagedMemoryBlock(input)}

## Guidelines

<!-- Add behavioral guidelines, coding standards, domain knowledge, or operational rules here. -->`;
}

export interface GenerateInstructionsInput extends RenderInstructionsInput {
  absolutePath: string;
  relativePath: string;
}

export interface GenerateInstructionsResult {
  relativePath: string;
  absolutePath: string;
  written: boolean;
  created: boolean;
  updated: boolean;
  mode: "created" | "replaced" | "legacy_replaced" | "appended" | "unchanged";
}

export async function generateInstructionsFile(
  input: GenerateInstructionsInput,
): Promise<GenerateInstructionsResult | null> {
  try {
    const dir = path.dirname(input.absolutePath);
    await fs.mkdir(dir, { recursive: true });

    try {
      const existingContent = await fs.readFile(input.absolutePath, "utf-8");
      const managedBlock = renderManagedMemoryBlock(input);
      const next = upsertManagedMemoryBlock(existingContent, managedBlock);
      if (next.mode !== "unchanged") {
        await fs.writeFile(input.absolutePath, `${next.content.trimEnd()}\n`, "utf-8");
      }

      return {
        relativePath: input.relativePath,
        absolutePath: input.absolutePath,
        written: next.mode !== "unchanged",
        created: false,
        updated: next.mode !== "unchanged",
        mode: next.mode,
      };
    } catch (err) {
      const code = err instanceof Error && "code" in err ? String((err as NodeJS.ErrnoException).code ?? "") : "";
      if (code !== "ENOENT") throw err;

      const content = renderInstructionsTemplate(input);
      await fs.writeFile(input.absolutePath, `${content.trimEnd()}\n`, "utf-8");
      return {
        relativePath: input.relativePath,
        absolutePath: input.absolutePath,
        written: true,
        created: true,
        updated: false,
        mode: "created",
      };
    }
  } catch (err) {
    console.warn("[agent-instructions] Failed to generate instructions file:", err);
    return null;
  }
}

interface AgentInstructionsRow {
  id: string;
  companyId: string;
  name: string;
  role: string;
  title: string | null;
  capabilities: string | null;
  adapterType: string | null;
  adapterConfig: Record<string, unknown>;
  reportsTo: string | null;
}

async function getAgentInstructionsRow(
  db: Db,
  agentId: string,
): Promise<AgentInstructionsRow | null> {
  const row = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      capabilities: agents.capabilities,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
      reportsTo: agents.reportsTo,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows) => rows[0] ?? null);

  if (!row) return null;
  return {
    ...row,
    adapterType: row.adapterType,
    adapterConfig:
      typeof row.adapterConfig === "object" && row.adapterConfig !== null && !Array.isArray(row.adapterConfig)
        ? (row.adapterConfig as Record<string, unknown>)
        : {},
  };
}

export interface SyncManagedInstructionsResult {
  agentId: string;
  absolutePath: string | null;
  written: boolean;
  created: boolean;
  updated: boolean;
  configPersisted: boolean;
  collectionEnsured: boolean;
  skipped: boolean;
  reason: string | null;
}

export async function syncManagedInstructionsForAgent(
  db: Db,
  agentId: string,
): Promise<SyncManagedInstructionsResult> {
  const row = await getAgentInstructionsRow(db, agentId);
  if (!row) {
    return {
      agentId,
      absolutePath: null,
      written: false,
      created: false,
      updated: false,
      configPersisted: false,
      collectionEnsured: false,
      skipped: true,
      reason: "agent_not_found",
    };
  }

  const slug = deriveAgentUrlKey(row.name);
  const target = resolveManagedInstructionsTarget(row.adapterType, row.adapterConfig, slug);
  if (!target) {
    return {
      agentId: row.id,
      absolutePath: null,
      written: false,
      created: false,
      updated: false,
      configPersisted: false,
      collectionEnsured: false,
      skipped: true,
      reason: "instructions_path_unresolvable",
    };
  }

  const parentName = row.reportsTo
    ? (
        await db
          .select({ name: agents.name })
          .from(agents)
          .where(eq(agents.id, row.reportsTo))
          .then((rows) => rows[0] ?? null)
      )?.name ?? null
    : null;

  const result = await generateInstructionsFile({
    absolutePath: target.absolutePath,
    relativePath: target.relativePath,
    agentName: row.name,
    role: row.role,
    title: row.title,
    capabilities: row.capabilities,
    parentName,
    slug,
  });

  if (!result) {
    return {
      agentId: row.id,
      absolutePath: target.absolutePath,
      written: false,
      created: false,
      updated: false,
      configPersisted: false,
      collectionEnsured: false,
      skipped: true,
      reason: "instructions_write_failed",
    };
  }

  let configPersisted = false;
  if (target.shouldPersistConfig) {
    await db
      .update(agents)
      .set({
        adapterConfig: { ...row.adapterConfig, [target.configKey]: target.absolutePath },
        updatedAt: new Date(),
      })
      .where(eq(agents.id, row.id));
    configPersisted = true;
  }

  return {
    agentId: row.id,
    absolutePath: result.absolutePath,
    written: result.written,
    created: result.created,
    updated: result.updated,
    configPersisted,
    collectionEnsured: false,
    skipped: false,
    reason: null,
  };
}

export async function backfillAgentInstructions(db: Db): Promise<{ backfilled: number; skipped: number }> {
  const supportedTypes = Array.from(SUPPORTED_MANAGED_AGENT_MEMORY_ADAPTER_TYPES);
  const rows = await db
    .select({ id: agents.id })
    .from(agents)
    .where(inArray(agents.adapterType, supportedTypes));

  let backfilled = 0;
  let skipped = 0;

  for (const row of rows) {
    const result = await syncManagedInstructionsForAgent(db, row.id);
    if (result.skipped) {
      skipped++;
      continue;
    }
    backfilled++;
  }

  return { backfilled, skipped };
}

export async function initQmdCollection(agentId: string, slug: string): Promise<boolean> {
  void agentId;
  void slug;
  return false;
}
