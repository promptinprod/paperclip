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

export function supportsManagedAgentMemoryAdapter(adapterType: string | null | undefined): boolean {
  return Boolean(adapterType && SUPPORTED_MANAGED_AGENT_MEMORY_ADAPTER_TYPES.has(adapterType));
}

export function buildManagedAgentCollectionName(slug: string): string {
  return `agent-${slug}`;
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

export async function initManagedAgentQmdCollection(agentId: string, slug: string): Promise<boolean> {
  try {
    const agentHome = resolveDefaultAgentWorkspaceDir(agentId);
    await fs.mkdir(agentHome, { recursive: true });

    const collectionName = buildManagedAgentCollectionName(slug);
    const existing = await runQmd(["collection", "show", collectionName]);
    if (existing.ok) {
      const existingPath = parseCollectionPath(existing.stdout);
      if (!existingPath) {
        console.warn(
          `[managed-agent-memory] Existing QMD collection ${collectionName} could not be parsed from output.`,
        );
        return false;
      }
      if (path.resolve(existingPath) === path.resolve(agentHome)) {
        return true;
      }
      console.warn(
        `[managed-agent-memory] QMD collection ${collectionName} already points to ${existingPath}, expected ${agentHome}.`,
      );
      return false;
    }

    if (!isMissingCollectionResult(existing)) {
      console.warn(
        `[managed-agent-memory] Failed to inspect QMD collection ${collectionName}: ${formatQmdFailure(existing)}`,
      );
      return false;
    }

    const created = await addManagedAgentCollection(agentHome, collectionName);
    if (!created.ok) {
      console.warn(
        `[managed-agent-memory] Failed to create QMD collection ${collectionName}: ${formatQmdFailure(created)}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[managed-agent-memory] Failed to init QMD collection:", err);
    return false;
  }
}

export async function refreshManagedAgentQmdCollection(agentId: string, slug: string): Promise<boolean> {
  try {
    const agentHome = resolveDefaultAgentWorkspaceDir(agentId);
    await fs.mkdir(agentHome, { recursive: true });

    const collectionName = buildManagedAgentCollectionName(slug);
    const existing = await runQmd(["collection", "show", collectionName]);
    if (existing.ok) {
      const existingPath = parseCollectionPath(existing.stdout);
      if (!existingPath) {
        console.warn(
          `[managed-agent-memory] Existing QMD collection ${collectionName} could not be parsed from output during refresh.`,
        );
        return false;
      }
      if (path.resolve(existingPath) !== path.resolve(agentHome)) {
        console.warn(
          `[managed-agent-memory] Replacing QMD collection ${collectionName} from ${existingPath} to ${agentHome}.`,
        );
      }

      // QMD does not expose a reliable collection-scoped refresh command, so rebuild the
      // managed collection to force the index to pick up fresh agent-authored files.
      const removed = await removeManagedAgentCollection(collectionName);
      if (!removed.ok && !isMissingCollectionResult(removed)) {
        console.warn(
          `[managed-agent-memory] Failed to remove QMD collection ${collectionName} during refresh: ${formatQmdFailure(removed)}`,
        );
        return false;
      }
    } else if (!isMissingCollectionResult(existing)) {
      console.warn(
        `[managed-agent-memory] Failed to inspect QMD collection ${collectionName} during refresh: ${formatQmdFailure(existing)}`,
      );
      return false;
    }

    const recreated = await addManagedAgentCollection(agentHome, collectionName);
    if (!recreated.ok) {
      console.warn(
        `[managed-agent-memory] Failed to refresh QMD collection ${collectionName}: ${formatQmdFailure(recreated)}`,
      );
      return false;
    }

    return true;
  } catch (err) {
    console.warn("[managed-agent-memory] Failed to refresh QMD collection:", err);
    return false;
  }
}
