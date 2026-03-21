import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildIssueAlignedMemorySearchBrief,
  detectManagedMemoryRecallFromRunLog,
  diffManagedMemorySnapshots,
  evaluateManagedMemoryAudit,
  evaluateManagedMemoryRecallAudit,
  snapshotManagedMemoryState,
} from "../services/heartbeat.ts";

const cleanupDirs = new Set<string>();

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

describe("snapshotManagedMemoryState", () => {
  it("captures only managed memory files under agent home", async () => {
    const agentHome = await makeTempDir("paperclip-managed-memory-");

    await fs.mkdir(path.join(agentHome, "memory"), { recursive: true });
    await fs.mkdir(path.join(agentHome, "life", "areas", "companies", "checkmymanuscript"), { recursive: true });
    await fs.writeFile(path.join(agentHome, "memory", "2026-03-21.md"), "daily note", "utf8");
    await fs.writeFile(
      path.join(agentHome, "life", "areas", "companies", "checkmymanuscript", "summary.md"),
      "summary",
      "utf8",
    );
    await fs.writeFile(
      path.join(agentHome, "life", "areas", "companies", "checkmymanuscript", "items.yaml"),
      "facts: []",
      "utf8",
    );
    await fs.writeFile(path.join(agentHome, "MEMORY.md"), "tacit", "utf8");
    await fs.writeFile(path.join(agentHome, "README.md"), "ignore me", "utf8");

    const snapshot = await snapshotManagedMemoryState(agentHome);

    expect(Object.keys(snapshot).sort()).toEqual([
      "MEMORY.md",
      "life/areas/companies/checkmymanuscript/items.yaml",
      "life/areas/companies/checkmymanuscript/summary.md",
      "memory/2026-03-21.md",
    ]);
  });
});

describe("diffManagedMemorySnapshots", () => {
  it("detects created and modified managed memory files only", async () => {
    const agentHome = await makeTempDir("paperclip-managed-memory-diff-");
    const memoryFile = path.join(agentHome, "memory", "2026-03-21.md");
    const lifeFile = path.join(agentHome, "life", "areas", "companies", "checkmymanuscript", "summary.md");

    await fs.mkdir(path.dirname(memoryFile), { recursive: true });
    await fs.writeFile(memoryFile, "before", "utf8");

    const before = await snapshotManagedMemoryState(agentHome);

    await new Promise((resolve) => setTimeout(resolve, 20));
    await fs.writeFile(memoryFile, "after with more content", "utf8");
    await fs.mkdir(path.dirname(lifeFile), { recursive: true });
    await fs.writeFile(lifeFile, "new durable fact", "utf8");
    await fs.writeFile(path.join(agentHome, "notes.txt"), "not managed memory", "utf8");

    const after = await snapshotManagedMemoryState(agentHome);

    expect(diffManagedMemorySnapshots(before, after)).toEqual([
      "life/areas/companies/checkmymanuscript/summary.md",
      "memory/2026-03-21.md",
    ]);
  });
});

describe("evaluateManagedMemoryAudit", () => {
  it("returns written when managed memory files changed", () => {
    expect(
      evaluateManagedMemoryAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        changedFiles: ["memory/2026-03-21.md"],
      }),
    ).toEqual({
      status: "written",
      reason: null,
      issueStatus: "done",
      changedFiles: ["memory/2026-03-21.md"],
    });
  });

  it("returns missing when a completed issue has no memory writes", () => {
    expect(
      evaluateManagedMemoryAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        changedFiles: [],
      }),
    ).toEqual({
      status: "missing",
      reason: "completed_without_memory",
      issueStatus: "done",
      changedFiles: [],
    });
  });

  it("returns skipped when the issue is not done", () => {
    expect(
      evaluateManagedMemoryAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "in_progress",
        changedFiles: [],
      }),
    ).toEqual({
      status: "skipped",
      reason: "issue_not_done",
      issueStatus: "in_progress",
      changedFiles: [],
    });
  });

  it("returns skipped for unsupported adapters", () => {
    expect(
      evaluateManagedMemoryAudit({
        supportsManagedMemory: false,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        changedFiles: ["memory/2026-03-21.md"],
      }),
    ).toEqual({
      status: "skipped",
      reason: "unsupported_adapter",
      issueStatus: "done",
      changedFiles: [],
    });
  });

  it("returns skipped when managed memory requires a project but none is present", () => {
    expect(
      evaluateManagedMemoryAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: null,
        issueStatus: "done",
        changedFiles: [],
      }),
    ).toEqual({
      status: "skipped",
      reason: "project_required",
      issueStatus: "done",
      changedFiles: [],
    });
  });
});

describe("buildIssueAlignedMemorySearchBrief", () => {
  it("builds a compact recall brief from issue context", () => {
    expect(
      buildIssueAlignedMemorySearchBrief({
        issueIdentifier: "CHE-17",
        issueTitle: "Recommend one KPI dashboard for CheckMyManuscript",
        issueDescription: "Propose exactly seven metrics for a CEO/CFO weekly review.",
        goalTitle: "Refine the business operating model",
        projectName: "CheckMyManuscript",
        ancestorTitles: ["Commercial strategy", "Pricing and reporting"],
        wakeCommentBody: "Please prioritize metrics that can be reviewed weekly.",
      }),
    ).toBe(
      "CHE-17: Recommend one KPI dashboard for CheckMyManuscript | Issue: Propose exactly seven metrics for a CEO/CFO weekly review. | Goal: Refine the business operating model | Project: CheckMyManuscript | Ancestors: Commercial strategy > Pricing and reporting | Wake comment: Please prioritize metrics that can be reviewed weekly.",
    );
  });
});

describe("detectManagedMemoryRecallFromRunLog", () => {
  it("detects CLI searches and fetches for required collections", () => {
    const log = [
      JSON.stringify({
        ts: "2026-03-21T00:00:00.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: {
                  command:
                    'qmd search "CheckMyManuscript KPI dashboard" --collection agent-cfo 2>&1',
                },
              },
            ],
          },
        }),
      }),
      JSON.stringify({
        ts: "2026-03-21T00:00:01.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content:
                  "qmd://agent-cfo/life/areas/companies/CheckMyManuscript/summary.md\nTitle: Summary",
              },
            ],
          },
        }),
      }),
      JSON.stringify({
        ts: "2026-03-21T00:00:02.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: {
                  command:
                    "qmd get qmd://agent-cfo/life/areas/companies/CheckMyManuscript/summary.md 2>&1",
                },
              },
            ],
          },
        }),
      }),
    ].join("\n");

    expect(
      detectManagedMemoryRecallFromRunLog(log, {
        ownCollection: "agent-cfo",
        expectedChildCollections: ["agent-cpo-2"],
      }),
    ).toEqual({
      searchedCollections: ["agent-cfo"],
      fetchedCollections: ["agent-cfo"],
      hitCollections: ["agent-cfo"],
    });
  });

  it("detects MCP searches and fetches for required collections", () => {
    const log = [
      JSON.stringify({
        ts: "2026-03-21T00:00:00.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "mcp__plugin_qmd_qmd__query",
                input: {
                  query: "pricing recommendation",
                  collections: ["agent-ceo", "agent-cfo"],
                },
              },
            ],
          },
        }),
      }),
      JSON.stringify({
        ts: "2026-03-21T00:00:01.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "mcp__plugin_qmd_qmd__multi_get",
                input: {
                  uris: [
                    "qmd://agent-ceo/memory/2026-03-21.md",
                    "qmd://agent-cfo/life/areas/companies/CheckMyManuscript/summary.md",
                  ],
                },
              },
            ],
          },
        }),
      }),
    ].join("\n");

    expect(
      detectManagedMemoryRecallFromRunLog(log, {
        ownCollection: "agent-ceo",
        expectedChildCollections: ["agent-cfo"],
      }),
    ).toEqual({
      searchedCollections: ["agent-ceo", "agent-cfo"],
      fetchedCollections: ["agent-ceo", "agent-cfo"],
      hitCollections: ["agent-ceo", "agent-cfo"],
    });
  });

  it("treats env-var based collection commands as project-scoped recall activity", () => {
    const log = [
      JSON.stringify({
        ts: "2026-03-21T00:00:00.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: {
                  command:
                    'qmd query "$BRIEF" --collection "$PAPERCLIP_MEMORY_COLLECTION"\nfor c in $(echo "$PAPERCLIP_DIRECT_REPORT_MEMORY_COLLECTIONS_JSON"); do qmd search "$BRIEF" --collection "$c"; done',
                },
              },
            ],
          },
        }),
      }),
      JSON.stringify({
        ts: "2026-03-21T00:00:01.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Bash",
                input: {
                  command:
                    'qmd get "qmd://$PAPERCLIP_MEMORY_COLLECTION/memory/2026-03-21.md"\nfor c in $(echo "$PAPERCLIP_DIRECT_REPORT_MEMORY_COLLECTIONS_JSON"); do qmd get "qmd://$c/life/projects/checkmymanuscript/summary.md"; done',
                },
              },
            ],
          },
        }),
      }),
      JSON.stringify({
        ts: "2026-03-21T00:00:02.000Z",
        stream: "stdout",
        chunk: JSON.stringify({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content:
                  "qmd://agent-ceo-project-project-1/memory/2026-03-21.md\nqmd://agent-cfo-project-project-1/life/projects/checkmymanuscript/summary.md",
              },
            ],
          },
        }),
      }),
    ].join("\n");

    expect(
      detectManagedMemoryRecallFromRunLog(log, {
        ownCollection: "agent-ceo-project-project-1",
        expectedChildCollections: ["agent-cfo-project-project-1"],
      }),
    ).toEqual({
      searchedCollections: ["agent-ceo-project-project-1", "agent-cfo-project-project-1"],
      fetchedCollections: ["agent-ceo-project-project-1", "agent-cfo-project-project-1"],
      hitCollections: ["agent-ceo-project-project-1", "agent-cfo-project-project-1"],
    });
  });
});

describe("evaluateManagedMemoryRecallAudit", () => {
  it("returns loaded when own and child collections were searched and fetched", () => {
    expect(
      evaluateManagedMemoryRecallAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        hasIssue: true,
        ownCollection: "agent-ceo",
        expectedChildCollections: ["agent-cfo", "agent-cpo-2"],
        recallDetection: {
          searchedCollections: ["agent-cfo", "agent-ceo", "agent-cpo-2"],
          fetchedCollections: ["agent-ceo", "agent-cfo"],
          hitCollections: ["agent-ceo", "agent-cfo"],
        },
      }),
    ).toEqual({
      status: "loaded",
      reason: null,
      issueStatus: "done",
      ownCollection: "agent-ceo",
      expectedChildCollections: ["agent-cfo", "agent-cpo-2"],
      searchedCollections: ["agent-ceo", "agent-cfo", "agent-cpo-2"],
      fetchedCollections: ["agent-ceo", "agent-cfo"],
      hitCollections: ["agent-ceo", "agent-cfo"],
      missingCollections: [],
      unfetchedHitCollections: [],
    });
  });

  it("returns partial when a child collection was not searched", () => {
    expect(
      evaluateManagedMemoryRecallAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        hasIssue: true,
        ownCollection: "agent-ceo",
        expectedChildCollections: ["agent-cfo", "agent-cpo-2"],
        recallDetection: {
          searchedCollections: ["agent-ceo", "agent-cfo"],
          fetchedCollections: ["agent-ceo"],
          hitCollections: ["agent-ceo"],
        },
      }),
    ).toEqual({
      status: "partial",
      reason: "child_collections_not_searched",
      issueStatus: "done",
      ownCollection: "agent-ceo",
      expectedChildCollections: ["agent-cfo", "agent-cpo-2"],
      searchedCollections: ["agent-ceo", "agent-cfo"],
      fetchedCollections: ["agent-ceo"],
      hitCollections: ["agent-ceo"],
      missingCollections: ["agent-cpo-2"],
      unfetchedHitCollections: [],
    });
  });

  it("returns partial when search results were not fetched", () => {
    expect(
      evaluateManagedMemoryRecallAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        hasIssue: true,
        ownCollection: "agent-cfo",
        expectedChildCollections: [],
        recallDetection: {
          searchedCollections: ["agent-cfo"],
          fetchedCollections: [],
          hitCollections: ["agent-cfo"],
        },
      }),
    ).toEqual({
      status: "partial",
      reason: "search_hits_not_fetched",
      issueStatus: "done",
      ownCollection: "agent-cfo",
      expectedChildCollections: [],
      searchedCollections: ["agent-cfo"],
      fetchedCollections: [],
      hitCollections: ["agent-cfo"],
      missingCollections: [],
      unfetchedHitCollections: ["agent-cfo"],
    });
  });

  it("returns missing when the own collection was not searched", () => {
    expect(
      evaluateManagedMemoryRecallAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        hasIssue: true,
        ownCollection: "agent-cfo",
        expectedChildCollections: [],
        recallDetection: {
          searchedCollections: [],
          fetchedCollections: [],
          hitCollections: [],
        },
      }),
    ).toEqual({
      status: "missing",
      reason: "own_collection_not_searched",
      issueStatus: "done",
      ownCollection: "agent-cfo",
      expectedChildCollections: [],
      searchedCollections: [],
      fetchedCollections: [],
      hitCollections: [],
      missingCollections: ["agent-cfo"],
      unfetchedHitCollections: [],
    });
  });

  it("returns skipped for unsupported adapters", () => {
    expect(
      evaluateManagedMemoryRecallAudit({
        supportsManagedMemory: false,
        outcome: "succeeded",
        projectId: "project-1",
        issueStatus: "done",
        hasIssue: true,
        ownCollection: "agent-cfo",
        expectedChildCollections: ["agent-cpo-2"],
        recallDetection: {
          searchedCollections: ["agent-cfo", "agent-cpo-2"],
          fetchedCollections: ["agent-cfo"],
          hitCollections: ["agent-cfo"],
        },
      }),
    ).toEqual({
      status: "skipped",
      reason: "unsupported_adapter",
      issueStatus: "done",
      ownCollection: "agent-cfo",
      expectedChildCollections: ["agent-cpo-2"],
      searchedCollections: [],
      fetchedCollections: [],
      hitCollections: [],
      missingCollections: [],
      unfetchedHitCollections: [],
    });
  });

  it("returns skipped when managed memory requires a project but none is present", () => {
    expect(
      evaluateManagedMemoryRecallAudit({
        supportsManagedMemory: true,
        outcome: "succeeded",
        projectId: null,
        issueStatus: "done",
        hasIssue: true,
        ownCollection: null,
        expectedChildCollections: [],
        recallDetection: {
          searchedCollections: [],
          fetchedCollections: [],
          hitCollections: [],
        },
      }),
    ).toEqual({
      status: "skipped",
      reason: "project_required",
      issueStatus: "done",
      ownCollection: null,
      expectedChildCollections: [],
      searchedCollections: [],
      fetchedCollections: [],
      hitCollections: [],
      missingCollections: [],
      unfetchedHitCollections: [],
    });
  });
});
