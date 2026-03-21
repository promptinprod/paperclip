import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issues, projects } from "@paperclipai/db";
import {
  type LegacyManagedMemoryProjectLookup,
  migrateLegacyManagedAgentMemory,
  splitLegacyManagedDailyNoteByProject,
} from "../services/managed-agent-memory-migration.js";
import {
  resolveManagedAgentLegacyReviewDir,
  resolveManagedAgentProjectMemoryDir,
} from "../services/managed-agent-memory.js";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

const cleanupDirs = new Set<string>();
const originalPaperclipHome = process.env.PAPERCLIP_HOME;

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function makeDb(input: {
  issueRows: Array<{ identifier: string | null; projectId: string | null }>;
  projectRows: Array<{ id: string; name: string }>;
}) {
  return {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              if (table === issues) return Promise.resolve(input.issueRows);
              if (table === projects) return Promise.resolve(input.projectRows);
              return Promise.resolve([]);
            },
          };
        },
      };
    },
  };
}

afterEach(async () => {
  process.env.PAPERCLIP_HOME = originalPaperclipHome;
  await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("splitLegacyManagedDailyNoteByProject", () => {
  it("splits project-tagged note blocks and quarantines unmatched residue", () => {
    const lookup: LegacyManagedMemoryProjectLookup = {
      issueProjectByIdentifier: new Map([["CHE-18", "project-1"]]),
      projectBySlug: new Map([["checkmymanuscript", "project-1"]]),
      projectNamePatterns: [{ id: "project-1", pattern: "checkmymanuscript" }],
    };

    const split = splitLegacyManagedDailyNoteByProject(
      `# 2026-03-21

## Completed

- **CHE-18** — Recommended weekly operating review for CheckMyManuscript.

## Org Snapshot

Active direct reports: CFO, CPO 2, CMO 2.
`,
      lookup,
    );

    expect(split.byProjectId.get("project-1")).toContain("CHE-18");
    expect(split.byProjectId.get("project-1")).toContain("## Completed");
    expect(split.quarantineContent).toContain("## Org Snapshot");
    expect(split.quarantineContent).toContain("Active direct reports");
  });
});

describe("migrateLegacyManagedAgentMemory", () => {
  it("copies classified legacy memory into project roots and quarantines ambiguous residue", async () => {
    const paperclipHome = await makeTempDir("paperclip-managed-memory-migration-");
    process.env.PAPERCLIP_HOME = paperclipHome;

    const agentId = "11111111-1111-4111-8111-111111111111";
    const companyId = "company-1";
    const projectId = "project-1";
    const legacyRoot = path.join(
      paperclipHome,
      "instances",
      "default",
      "workspaces",
      agentId,
    );

    await fs.mkdir(path.join(legacyRoot, "life", "projects", "checkmymanuscript"), { recursive: true });
    await fs.mkdir(path.join(legacyRoot, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(legacyRoot, "life", "projects", "checkmymanuscript", "summary.md"),
      "Legacy project summary",
      "utf8",
    );
    await fs.writeFile(
      path.join(legacyRoot, "memory", "2026-03-21.md"),
      `# 2026-03-21

## Completed

- **CHE-18** — Recommended weekly operating review for CheckMyManuscript.

## Org Snapshot

Active direct reports: CFO, CPO 2, CMO 2.
`,
      "utf8",
    );
    await fs.writeFile(path.join(legacyRoot, "MEMORY.md"), "Tacit legacy note", "utf8");

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(new Error(`Collection not found: ${args[2]}`), "", `Collection not found: ${args[2]}`);
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        cb(null, "added", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    const result = await migrateLegacyManagedAgentMemory({
      db: makeDb({
        issueRows: [{ identifier: "CHE-18", projectId }],
        projectRows: [{ id: projectId, name: "CheckMyManuscript" }],
      }) as any,
      agentId,
      companyId,
      slug: "ceo",
    });

    expect(result).toMatchObject({
      status: "migrated",
      reason: null,
      projectIds: [projectId],
      quarantined: true,
    });

    const projectRoot = resolveManagedAgentProjectMemoryDir(agentId, projectId);
    const legacyReviewRoot = resolveManagedAgentLegacyReviewDir(agentId);
    const migratedSummary = await fs.readFile(
      path.join(projectRoot, "life", "projects", "checkmymanuscript", "summary.md"),
      "utf8",
    );
    const migratedDailyNote = await fs.readFile(path.join(projectRoot, "memory", "2026-03-21.md"), "utf8");
    const quarantinedDailyNote = await fs.readFile(path.join(legacyReviewRoot, "memory", "2026-03-21.md"), "utf8");
    const quarantinedTacit = await fs.readFile(path.join(legacyReviewRoot, "MEMORY.md"), "utf8");

    expect(migratedSummary).toContain("Legacy project summary");
    expect(migratedDailyNote).toContain("CHE-18");
    expect(quarantinedDailyNote).toContain("Org Snapshot");
    expect(quarantinedTacit).toContain("Tacit legacy note");
    expect(mockExecFile).toHaveBeenCalledWith(
      "qmd",
      ["collection", "add", projectRoot, "--name", "agent-ceo-project-project-1"],
      expect.any(Function),
    );
    expect(mockExecFile).toHaveBeenCalledWith(
      "qmd",
      ["collection", "add", legacyReviewRoot, "--name", "agent-ceo-legacy-review"],
      expect.any(Function),
    );
  });
});
