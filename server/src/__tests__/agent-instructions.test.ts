import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockExecFile = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFile: mockExecFile,
}));

import {
  MANAGED_MEMORY_BEGIN_MARKER,
  MANAGED_MEMORY_END_MARKER,
  generateInstructionsFile,
  initQmdCollection,
  renderInstructionsTemplate,
  resolveManagedInstructionsTarget,
  shouldAutoGenerateInstructions,
} from "../services/agent-instructions.js";
import {
  initManagedAgentProjectQmdCollection,
  refreshManagedAgentProjectQmdCollection,
  resolveManagedAgentProjectMemoryDir,
} from "../services/managed-agent-memory.js";

const cleanupDirs = new Set<string>();
const originalPaperclipHome = process.env.PAPERCLIP_HOME;

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

afterEach(async () => {
  process.env.PAPERCLIP_HOME = originalPaperclipHome;
  await Promise.all(Array.from(cleanupDirs).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  cleanupDirs.clear();
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shouldAutoGenerateInstructions", () => {
  it("returns true for supported adapter with absolute cwd", () => {
    expect(
      shouldAutoGenerateInstructions("claude_local", { cwd: "/home/user/project" }),
    ).toBe(true);
  });

  it("returns true when a supported adapter already has an absolute instructions path", () => {
    expect(
      shouldAutoGenerateInstructions("codex_local", {
        instructionsFilePath: "/repo/.agents/founding-engineer/AGENTS.md",
      }),
    ).toBe(true);
  });

  it("returns true when a supported adapter has a relative instructions path and absolute cwd", () => {
    expect(
      shouldAutoGenerateInstructions("cursor", {
        cwd: "/repo",
        instructionsFilePath: ".agents/cmo/AGENTS.md",
      }),
    ).toBe(true);
  });

  it("returns false for unsupported adapter types", () => {
    expect(
      shouldAutoGenerateInstructions("openclaw_gateway", { cwd: "/home/user/project" }),
    ).toBe(false);
  });

  it("returns false when only a relative instructions path is present without an absolute cwd", () => {
    expect(
      shouldAutoGenerateInstructions("claude_local", {
        instructionsFilePath: ".agents/cmo/AGENTS.md",
      }),
    ).toBe(false);
  });
});

describe("resolveManagedInstructionsTarget", () => {
  it("uses the existing configured instructions path when present", () => {
    const result = resolveManagedInstructionsTarget(
      "claude_local",
      { cwd: "/repo", instructionsFilePath: ".agents/cmo/AGENTS.md" },
      "cmo",
    );

    expect(result).toEqual({
      absolutePath: "/repo/.agents/cmo/AGENTS.md",
      relativePath: ".agents/cmo/AGENTS.md",
      configKey: "instructionsFilePath",
      shouldPersistConfig: false,
    });
  });

  it("falls back to the default .agents path when no instructions path is configured", () => {
    const result = resolveManagedInstructionsTarget(
      "codex_local",
      { cwd: "/repo" },
      "founding-engineer",
    );

    expect(result).toEqual({
      absolutePath: "/repo/.agents/founding-engineer/AGENTS.md",
      relativePath: ".agents/founding-engineer/AGENTS.md",
      configKey: "instructionsFilePath",
      shouldPersistConfig: true,
    });
  });
});

describe("renderInstructionsTemplate", () => {
  it("renders the managed memory block with collection access details", () => {
    const content = renderInstructionsTemplate({
      agentName: "Founding Engineer",
      role: "engineer",
      title: "Senior Software Engineer",
      slug: "founding-engineer",
      capabilities: "Full-stack development with TypeScript and React.",
      parentName: "CEO",
      childCollections: ["agent-product-designer", "agent-growth-engineer"],
    });

    expect(content).toContain(MANAGED_MEMORY_BEGIN_MARKER);
    expect(content).toContain(MANAGED_MEMORY_END_MARKER);
    expect(content).toContain("# Founding Engineer");
    expect(content).toContain("**Role:** engineer");
    expect(content).toContain("**Title:** Senior Software Engineer");
    expect(content).toContain("You MUST use the `para-memory-files` skill for all memory operations");
    expect(content).toContain("Invoke it whenever you need to remember, retrieve, or organize anything.");
    expect(content).toContain("Managed local memory is project-scoped.");
    expect(content).toContain(
      "After loading issue context for a task, build a compact recall brief from the issue title, description, goal, project, ancestor titles, and wake comment if present.",
    );
    expect(content).toContain("Search the current project's QMD collection with that recall brief before doing domain work.");
    expect(content).toContain(
      "If you manage direct reports, search each same-project direct-report collection listed in `$PAPERCLIP_DIRECT_REPORT_MEMORY_COLLECTIONS_JSON`.",
    );
    expect(content).toContain("Write meaningful task progress and outcomes to `$AGENT_HOME/memory/YYYY-MM-DD.md`.");
    expect(content).toContain("Extract durable facts, decisions, and references to the relevant files under `$AGENT_HOME/life/`.");
    expect(content).toContain("Before considering a task complete, write the outcome to memory:");
    expect(content).toContain("Append progress and outcomes to `$AGENT_HOME/memory/YYYY-MM-DD.md`.");
    expect(content).toContain(
      'Verify the memory is discoverable with `qmd query ... --collection "$PAPERCLIP_MEMORY_COLLECTION"` or `qmd search ... --collection "$PAPERCLIP_MEMORY_COLLECTION"`.',
    );
    expect(content).toContain('qmd collection add $AGENT_HOME --name "$PAPERCLIP_MEMORY_COLLECTION"');
    expect(content).toContain(
      "Your direct manager (CEO) may read and update the current project's collection when they are working on the same project.",
    );
    expect(content).toContain(
      "Same-project direct-report collections you may read and update are provided at runtime in `$PAPERCLIP_DIRECT_REPORT_MEMORY_COLLECTIONS_JSON`.",
    );
    expect(content).toContain(
      "Runs without a project do not participate in managed QMD memory. Assign the work to a project before relying on managed recall or managed writes.",
    );
  });

  it("renders root agents without a manager", () => {
    const content = renderInstructionsTemplate({
      agentName: "CEO",
      role: "ceo",
      slug: "ceo",
    });

    expect(content).toContain("You have no direct manager configured.");
    expect(content).toContain("Your current project collection: `$PAPERCLIP_MEMORY_COLLECTION`");
  });
});

describe("generateInstructionsFile", () => {
  it("creates a new instructions file with the managed memory block", async () => {
    const root = await makeTempDir("paperclip-agent-instructions-");
    const absolutePath = path.join(root, ".agents", "engineer", "AGENTS.md");

    const result = await generateInstructionsFile({
      absolutePath,
      relativePath: ".agents/engineer/AGENTS.md",
      agentName: "Engineer",
      role: "engineer",
      slug: "engineer",
      parentName: "CTO",
      childCollections: ["agent-qa"],
    });

    const content = await fs.readFile(absolutePath, "utf8");
    expect(result).toMatchObject({ written: true, created: true, updated: false, mode: "created" });
    expect(content).toContain(MANAGED_MEMORY_BEGIN_MARKER);
    expect(content).toContain("You MUST use the `para-memory-files` skill for all memory operations");
    expect(content).toContain("Search the current project's QMD collection with that recall brief before doing domain work.");
    expect(content).toContain("Write meaningful task progress and outcomes to `$AGENT_HOME/memory/YYYY-MM-DD.md`.");
    expect(content).toContain("Before considering a task complete, write the outcome to memory:");
    expect(content).toContain("Your current project collection: `$PAPERCLIP_MEMORY_COLLECTION`");
    expect(content).toContain("Same-project direct-report collections you may read and update are provided at runtime");
  });

  it("replaces an existing managed block without touching the rest of the file", async () => {
    const root = await makeTempDir("paperclip-agent-managed-block-");
    const absolutePath = path.join(root, "AGENTS.md");

    await fs.writeFile(
      absolutePath,
      `# Engineer

Custom intro

${MANAGED_MEMORY_BEGIN_MARKER}
old memory
${MANAGED_MEMORY_END_MARKER}

## Guidelines

Keep me
`,
      "utf8",
    );

    const result = await generateInstructionsFile({
      absolutePath,
      relativePath: "AGENTS.md",
      agentName: "Engineer",
      role: "engineer",
      slug: "engineer",
      childCollections: ["agent-qa", "agent-design"],
    });

    const content = await fs.readFile(absolutePath, "utf8");
    expect(result).toMatchObject({ written: true, created: false, updated: true, mode: "replaced" });
    expect(content).toContain("Custom intro");
    expect(content).toContain("Keep me");
    expect(content).not.toContain("old memory");
    expect(content).toContain(
      "If you manage direct reports, search each same-project direct-report collection listed in `$PAPERCLIP_DIRECT_REPORT_MEMORY_COLLECTIONS_JSON`.",
    );
    expect(content).toContain("Extract durable facts, decisions, and references to the relevant files under `$AGENT_HOME/life/`.");
    expect(content).toContain(
      'Verify the memory is discoverable with `qmd query ... --collection "$PAPERCLIP_MEMORY_COLLECTION"` or `qmd search ... --collection "$PAPERCLIP_MEMORY_COLLECTION"`.',
    );
    expect(content).toContain("Same-project direct-report collections you may read and update are provided at runtime");
  });

  it("replaces the legacy memory section in older generated files", async () => {
    const root = await makeTempDir("paperclip-agent-legacy-memory-");
    const absolutePath = path.join(root, "AGENTS.md");

    await fs.writeFile(
      absolutePath,
      `# Engineer

## Memory

legacy memory block

## Guidelines

Preserve this
`,
      "utf8",
    );

    const result = await generateInstructionsFile({
      absolutePath,
      relativePath: "AGENTS.md",
      agentName: "Engineer",
      role: "engineer",
      slug: "engineer",
    });

    const content = await fs.readFile(absolutePath, "utf8");
    expect(result).toMatchObject({
      written: true,
      created: false,
      updated: true,
      mode: "legacy_replaced",
    });
    expect(content).toContain(MANAGED_MEMORY_BEGIN_MARKER);
    expect(content).not.toContain("legacy memory block");
    expect(content).toContain("Preserve this");
    expect(content).toContain("You MUST use the `para-memory-files` skill for all memory operations");
  });
});

describe("initQmdCollection", () => {
  it("is a no-op because managed memory is now project-scoped", async () => {
    await expect(initQmdCollection("11111111-1111-4111-8111-111111111111", "engineer")).resolves.toBe(false);
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe("project-scoped qmd collections", () => {
  it("rebuilds an existing collection for the expected agent home", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "55555555-5555-4555-8555-555555555555";
    const projectId = "project-1";
    const expectedAgentHome = resolveManagedAgentProjectMemoryDir(agentId, projectId);

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(null, `Collection: agent-cpo-2-project-project-1\n  Path:     ${expectedAgentHome}\n`, "");
        return;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        expect(args).toEqual(["collection", "remove", "agent-cpo-2-project-project-1"]);
        cb(null, "removed", "");
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        expect(args).toEqual(["collection", "add", expectedAgentHome, "--name", "agent-cpo-2-project-project-1"]);
        cb(null, "added", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(refreshManagedAgentProjectQmdCollection(agentId, "cpo-2", projectId)).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("creates the project-scoped collection when it does not exist yet", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-add-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "66666666-6666-4666-8666-666666666666";
    const projectId = "project-2";
    const expectedAgentHome = resolveManagedAgentProjectMemoryDir(agentId, projectId);

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(
          new Error("Collection not found: agent-cfo-project-project-2"),
          "",
          "Collection not found: agent-cfo-project-project-2",
        );
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        expect(args).toEqual(["collection", "add", expectedAgentHome, "--name", "agent-cfo-project-project-2"]);
        cb(null, "added", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(initManagedAgentProjectQmdCollection(agentId, "cfo", projectId)).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("repairs a mismatched collection path by rebuilding it", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-repair-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "77777777-7777-4777-8777-777777777777";
    const projectId = "project-3";
    const expectedAgentHome = resolveManagedAgentProjectMemoryDir(agentId, projectId);

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(null, "Collection: agent-cmo-project-project-3\n  Path:     /tmp/other-agent-home\n", "");
        return;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        expect(args).toEqual(["collection", "remove", "agent-cmo-project-project-3"]);
        cb(null, "removed", "");
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        expect(args).toEqual(["collection", "add", expectedAgentHome, "--name", "agent-cmo-project-project-3"]);
        cb(null, "added", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(refreshManagedAgentProjectQmdCollection(agentId, "cmo", projectId)).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("returns false when rebuilding the collection fails", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-failure-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "88888888-8888-4888-8888-888888888888";
    const projectId = "project-4";
    const expectedAgentHome = resolveManagedAgentProjectMemoryDir(agentId, projectId);

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(null, `Collection: agent-ceo-project-project-4\n  Path:     ${expectedAgentHome}\n`, "");
        return;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        cb(new Error("remove failed"), "", "remove failed");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(refreshManagedAgentProjectQmdCollection(agentId, "ceo", projectId)).resolves.toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
