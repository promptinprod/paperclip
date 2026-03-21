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
import { refreshManagedAgentQmdCollection } from "../services/managed-agent-memory.js";

const cleanupDirs = new Set<string>();
const originalPaperclipHome = process.env.PAPERCLIP_HOME;

async function makeTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  cleanupDirs.add(dir);
  return dir;
}

function execSuccess(stdout = "", stderr = "") {
  return (command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    expect(command).toBe("qmd");
    cb(null, stdout, stderr);
  };
}

function execFailure(
  message: string,
  stdout = "",
  stderr = "",
) {
  return (_command: string, _args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    cb(new Error(message), stdout, stderr);
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
    expect(content).toContain("agent-founding-engineer");
    expect(content).toContain("You MUST use the `para-memory-files` skill for all memory operations");
    expect(content).toContain("Invoke it whenever you need to remember, retrieve, or organize anything.");
    expect(content).toContain(
      "After loading issue context for a task, build a compact recall brief from the issue title, description, goal, project, ancestor titles, and wake comment if present.",
    );
    expect(content).toContain("Search your own QMD collection with that recall brief before doing domain work.");
    expect(content).toContain(
      "If you manage direct reports, search each direct-report collection you are allowed to access with the same recall brief.",
    );
    expect(content).toContain("Write meaningful task progress and outcomes to `$AGENT_HOME/memory/YYYY-MM-DD.md`.");
    expect(content).toContain("Extract durable facts, decisions, and references to the relevant files under `$AGENT_HOME/life/`.");
    expect(content).toContain("Before considering a task complete, write the outcome to memory:");
    expect(content).toContain("Append progress and outcomes to `$AGENT_HOME/memory/YYYY-MM-DD.md`.");
    expect(content).toContain(
      "Verify the memory is discoverable with `qmd query ... --collection agent-founding-engineer` or `qmd search ... --collection agent-founding-engineer`.",
    );
    expect(content).toContain("qmd collection add $AGENT_HOME --name agent-founding-engineer");
    expect(content).toContain("Your direct manager (CEO) may read and update your collection.");
    expect(content).toContain(
      "Direct-report collections you may read and update: `agent-growth-engineer`, `agent-product-designer`",
    );
  });

  it("renders root agents without a manager", () => {
    const content = renderInstructionsTemplate({
      agentName: "CEO",
      role: "ceo",
      slug: "ceo",
    });

    expect(content).toContain("You have no direct manager configured.");
    expect(content).toContain("Direct-report collections you may read and update: none.");
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
    expect(content).toContain("Search your own QMD collection with that recall brief before doing domain work.");
    expect(content).toContain("Write meaningful task progress and outcomes to `$AGENT_HOME/memory/YYYY-MM-DD.md`.");
    expect(content).toContain("Before considering a task complete, write the outcome to memory:");
    expect(content).toContain("Your own collection: `agent-engineer`");
    expect(content).toContain("Direct-report collections you may read and update: `agent-qa`");
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
      "If you manage direct reports, search each direct-report collection you are allowed to access with the same recall brief.",
    );
    expect(content).toContain("Extract durable facts, decisions, and references to the relevant files under `$AGENT_HOME/life/`.");
    expect(content).toContain("Verify the memory is discoverable with `qmd query ... --collection agent-engineer` or `qmd search ... --collection agent-engineer`.");
    expect(content).toContain(
      "Direct-report collections you may read and update: `agent-design`, `agent-qa`",
    );
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
  it("returns true when the collection already exists for the expected agent home", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-home-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "11111111-1111-4111-8111-111111111111";
    const expectedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "workspaces",
      agentId,
    );

    mockExecFile.mockImplementation(
      execSuccess(`Collection: agent-engineer\n  Path:     ${expectedAgentHome}\n`, ""),
    );

    await expect(initQmdCollection(agentId, "engineer")).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
    expect(mockExecFile).toHaveBeenCalledWith(
      "qmd",
      ["collection", "show", "agent-engineer"],
      expect.any(Function),
    );
  });

  it("creates the collection when it does not exist yet", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-add-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "22222222-2222-4222-8222-222222222222";
    const expectedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "workspaces",
      agentId,
    );

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(new Error("Collection not found: agent-data"), "", "Collection not found: agent-data");
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        expect(args).toEqual(["collection", "add", expectedAgentHome, "--name", "agent-data"]);
        cb(null, "created", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(initQmdCollection(agentId, "data")).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("returns false when the collection name already exists for a different path", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-mismatch-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "33333333-3333-4333-8333-333333333333";

    mockExecFile.mockImplementation(
      execSuccess("Collection: agent-ops\n  Path:     /tmp/other-agent-home\n", ""),
    );

    await expect(initQmdCollection(agentId, "ops")).resolves.toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });

  it("returns false when qmd inspection fails for another reason", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-failure-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "44444444-4444-4444-8444-444444444444";

    mockExecFile.mockImplementation(execFailure("spawn qmd ENOENT"));

    await expect(initQmdCollection(agentId, "ops")).resolves.toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(1);
  });
});

describe("refreshManagedAgentQmdCollection", () => {
  it("rebuilds an existing collection for the expected agent home", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "55555555-5555-4555-8555-555555555555";
    const expectedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "workspaces",
      agentId,
    );

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(null, `Collection: agent-cpo-2\n  Path:     ${expectedAgentHome}\n`, "");
        return;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        expect(args).toEqual(["collection", "remove", "agent-cpo-2"]);
        cb(null, "removed", "");
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        expect(args).toEqual(["collection", "add", expectedAgentHome, "--name", "agent-cpo-2"]);
        cb(null, "added", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(refreshManagedAgentQmdCollection(agentId, "cpo-2")).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("creates the collection when refresh sees it is missing", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-add-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "66666666-6666-4666-8666-666666666666";
    const expectedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "workspaces",
      agentId,
    );

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(new Error("Collection not found: agent-cfo"), "", "Collection not found: agent-cfo");
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        expect(args).toEqual(["collection", "add", expectedAgentHome, "--name", "agent-cfo"]);
        cb(null, "added", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(refreshManagedAgentQmdCollection(agentId, "cfo")).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });

  it("repairs a mismatched collection path by rebuilding it", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-repair-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "77777777-7777-4777-8777-777777777777";
    const expectedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "workspaces",
      agentId,
    );

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(null, "Collection: agent-cmo\n  Path:     /tmp/other-agent-home\n", "");
        return;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        expect(args).toEqual(["collection", "remove", "agent-cmo"]);
        cb(null, "removed", "");
        return;
      }
      if (args[0] === "collection" && args[1] === "add") {
        expect(args).toEqual(["collection", "add", expectedAgentHome, "--name", "agent-cmo"]);
        cb(null, "added", "");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(refreshManagedAgentQmdCollection(agentId, "cmo")).resolves.toBe(true);
    expect(mockExecFile).toHaveBeenCalledTimes(3);
  });

  it("returns false when rebuilding the collection fails", async () => {
    const paperclipHome = await makeTempDir("paperclip-qmd-refresh-failure-");
    process.env.PAPERCLIP_HOME = paperclipHome;
    const agentId = "88888888-8888-4888-8888-888888888888";
    const expectedAgentHome = path.join(
      paperclipHome,
      "instances",
      "default",
      "workspaces",
      agentId,
    );

    mockExecFile.mockImplementation((command: string, args: string[], cb: (err: Error | null, stdout: string, stderr: string) => void) => {
      expect(command).toBe("qmd");
      if (args[0] === "collection" && args[1] === "show") {
        cb(null, `Collection: agent-ceo\n  Path:     ${expectedAgentHome}\n`, "");
        return;
      }
      if (args[0] === "collection" && args[1] === "remove") {
        cb(new Error("remove failed"), "", "remove failed");
        return;
      }
      cb(new Error(`Unexpected qmd args: ${args.join(" ")}`), "", "");
    });

    await expect(refreshManagedAgentQmdCollection(agentId, "ceo")).resolves.toBe(false);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});
