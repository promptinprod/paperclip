import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { resolveDefaultAgentWorkspaceDir } from "../home-paths.js";

export const SUPPORTED_MANAGED_AGENT_MEMORY_ADAPTER_TYPES = new Set([
  "claude_local",
  "codex_local",
  "gemini_local",
  "opencode_local",
  "cursor",
  "pi_local",
]);

type QmdCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  errorMessage: string | null;
};

type ManagedAgentCollectionTarget = {
  rootDir: string;
  collectionName: string;
};

const PATH_SEGMENT_RE = /^[a-zA-Z0-9_-]+$/;
const PROJECT_MEMORY_DIR = "memory-projects";
const LEGACY_REVIEW_DIR = "memory-legacy-review";

export function supportsManagedAgentMemoryAdapter(adapterType: string | null | undefined): boolean {
  return Boolean(adapterType && SUPPORTED_MANAGED_AGENT_MEMORY_ADAPTER_TYPES.has(adapterType));
}

function normalizePathSegment(value: string, label: string): string {
  const trimmed = value.trim();
  if (!PATH_SEGMENT_RE.test(trimmed)) {
    throw new Error(`Invalid ${label} '${value}'.`);
  }
  return trimmed;
}

export function buildManagedAgentCollectionName(slug: string): string {
  return `agent-${slug}`;
}

export function buildManagedAgentProjectCollectionName(slug: string, projectId: string): string {
  return `agent-${slug}-project-${normalizePathSegment(projectId, "project id")}`;
}

export function buildManagedAgentLegacyReviewCollectionName(slug: string): string {
  return `agent-${slug}-legacy-review`;
}

export function resolveManagedAgentProjectMemoryDir(agentId: string, projectId: string): string {
  const baseDir = resolveDefaultAgentWorkspaceDir(agentId);
  return path.resolve(baseDir, PROJECT_MEMORY_DIR, normalizePathSegment(projectId, "project id"));
}

export function resolveManagedAgentLegacyReviewDir(agentId: string): string {
  return path.resolve(resolveDefaultAgentWorkspaceDir(agentId), LEGACY_REVIEW_DIR);
}

export function resolveManagedAgentProjectCollectionTarget(
  agentId: string,
  slug: string,
  projectId: string,
): ManagedAgentCollectionTarget {
  return {
    rootDir: resolveManagedAgentProjectMemoryDir(agentId, projectId),
    collectionName: buildManagedAgentProjectCollectionName(slug, projectId),
  };
}

export function resolveManagedAgentLegacyReviewCollectionTarget(
  agentId: string,
  slug: string,
): ManagedAgentCollectionTarget {
  return {
    rootDir: resolveManagedAgentLegacyReviewDir(agentId),
    collectionName: buildManagedAgentLegacyReviewCollectionName(slug),
  };
}

async function runQmd(args: string[]): Promise<QmdCommandResult> {
  return new Promise((resolve) => {
    execFile("qmd", args, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
        errorMessage: err ? err.message : null,
      });
    });
  });
}

function parseCollectionPath(output: string): string | null {
  const match = output.match(/^\s*Path:\s+(.+)$/m);
  return match?.[1]?.trim() ?? null;
}

function isMissingCollectionResult(result: QmdCommandResult): boolean {
  if (result.ok) return false;
  const combined = `${result.stdout}\n${result.stderr}\n${result.errorMessage ?? ""}`;
  return combined.includes("Collection not found:");
}

function formatQmdFailure(result: QmdCommandResult): string {
  return result.errorMessage || result.stderr.trim() || result.stdout.trim() || "unknown qmd error";
}

async function addManagedAgentCollection(agentHome: string, collectionName: string): Promise<QmdCommandResult> {
  return runQmd(["collection", "add", agentHome, "--name", collectionName]);
}

async function removeManagedAgentCollection(collectionName: string): Promise<QmdCommandResult> {
  return runQmd(["collection", "remove", collectionName]);
}

async function initManagedAgentQmdCollectionTarget(target: ManagedAgentCollectionTarget): Promise<boolean> {
  try {
    await fs.mkdir(target.rootDir, { recursive: true });

    const existing = await runQmd(["collection", "show", target.collectionName]);
    if (existing.ok) {
      const existingPath = parseCollectionPath(existing.stdout);
      if (!existingPath) {
        console.warn(
          `[managed-agent-memory] Existing QMD collection ${target.collectionName} could not be parsed from output.`,
        );
        return false;
      }
      if (path.resolve(existingPath) === path.resolve(target.rootDir)) {
        return true;
      }
      console.warn(
        `[managed-agent-memory] QMD collection ${target.collectionName} already points to ${existingPath}, expected ${target.rootDir}.`,
      );
      return false;
    }

    if (!isMissingCollectionResult(existing)) {
      console.warn(
        `[managed-agent-memory] Failed to inspect QMD collection ${target.collectionName}: ${formatQmdFailure(existing)}`,
      );
      return false;
    }

    const created = await addManagedAgentCollection(target.rootDir, target.collectionName);
    if (!created.ok) {
      console.warn(
        `[managed-agent-memory] Failed to create QMD collection ${target.collectionName}: ${formatQmdFailure(created)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[managed-agent-memory] Failed to init QMD collection:", err);
    return false;
  }
}

async function refreshManagedAgentQmdCollectionTarget(target: ManagedAgentCollectionTarget): Promise<boolean> {
  try {
    await fs.mkdir(target.rootDir, { recursive: true });

    const existing = await runQmd(["collection", "show", target.collectionName]);
    if (existing.ok) {
      const existingPath = parseCollectionPath(existing.stdout);
      if (!existingPath) {
        console.warn(
          `[managed-agent-memory] Existing QMD collection ${target.collectionName} could not be parsed from output during refresh.`,
        );
        return false;
      }
      if (path.resolve(existingPath) !== path.resolve(target.rootDir)) {
        console.warn(
          `[managed-agent-memory] Replacing QMD collection ${target.collectionName} from ${existingPath} to ${target.rootDir}.`,
        );
      }

      // QMD does not expose a reliable collection-scoped refresh command, so rebuild the
      // managed collection to force the index to pick up fresh agent-authored files.
      const removed = await removeManagedAgentCollection(target.collectionName);
      if (!removed.ok && !isMissingCollectionResult(removed)) {
        console.warn(
          `[managed-agent-memory] Failed to remove QMD collection ${target.collectionName} during refresh: ${formatQmdFailure(removed)}`,
        );
        return false;
      }
    } else if (!isMissingCollectionResult(existing)) {
      console.warn(
        `[managed-agent-memory] Failed to inspect QMD collection ${target.collectionName} during refresh: ${formatQmdFailure(existing)}`,
      );
      return false;
    }

    const recreated = await addManagedAgentCollection(target.rootDir, target.collectionName);
    if (!recreated.ok) {
      console.warn(
        `[managed-agent-memory] Failed to refresh QMD collection ${target.collectionName}: ${formatQmdFailure(recreated)}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    console.warn("[managed-agent-memory] Failed to refresh QMD collection:", err);
    return false;
  }
}

export async function initManagedAgentQmdCollection(agentId: string, slug: string): Promise<boolean> {
  return initManagedAgentQmdCollectionTarget({
    rootDir: resolveDefaultAgentWorkspaceDir(agentId),
    collectionName: buildManagedAgentCollectionName(slug),
  });
}

export async function initManagedAgentProjectQmdCollection(
  agentId: string,
  slug: string,
  projectId: string,
): Promise<boolean> {
  return initManagedAgentQmdCollectionTarget(resolveManagedAgentProjectCollectionTarget(agentId, slug, projectId));
}

export async function initManagedAgentLegacyReviewQmdCollection(
  agentId: string,
  slug: string,
): Promise<boolean> {
  return initManagedAgentQmdCollectionTarget(resolveManagedAgentLegacyReviewCollectionTarget(agentId, slug));
}

export async function refreshManagedAgentQmdCollection(agentId: string, slug: string): Promise<boolean> {
  return refreshManagedAgentQmdCollectionTarget({
    rootDir: resolveDefaultAgentWorkspaceDir(agentId),
    collectionName: buildManagedAgentCollectionName(slug),
  });
}

export async function refreshManagedAgentProjectQmdCollection(
  agentId: string,
  slug: string,
  projectId: string,
): Promise<boolean> {
  return refreshManagedAgentQmdCollectionTarget(resolveManagedAgentProjectCollectionTarget(agentId, slug, projectId));
}

export async function refreshManagedAgentLegacyReviewQmdCollection(
  agentId: string,
  slug: string,
): Promise<boolean> {
  return refreshManagedAgentQmdCollectionTarget(resolveManagedAgentLegacyReviewCollectionTarget(agentId, slug));
}
