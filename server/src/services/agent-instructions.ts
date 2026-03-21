import fs from "node:fs/promises";
import path from "node:path";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, inArray } from "drizzle-orm";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  SUPPORTED_MANAGED_AGENT_MEMORY_ADAPTER_TYPES,
  supportsManagedAgentMemoryAdapter,
} from "./managed-agent-memory.js";

const ENTRY_FILE_DEFAULT = "AGENTS.md";
const MODE_KEY = "instructionsBundleMode";
const ROOT_KEY = "instructionsRootPath";
const ENTRY_KEY = "instructionsEntryFile";
const FILE_KEY = "instructionsFilePath";
const PROMPT_KEY = "promptTemplate";
/** @deprecated Use the managed instructions bundle system instead. */
const BOOTSTRAP_PROMPT_KEY = "bootstrapPromptTemplate";
const LEGACY_PROMPT_TEMPLATE_PATH = "promptTemplate.legacy.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

type BundleMode = "managed" | "external";

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

type AgentInstructionsFileSummary = {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
};

type AgentInstructionsFileDetail = AgentInstructionsFileSummary & {
  content: string;
  editable: boolean;
};

type AgentInstructionsBundle = {
  agentId: string;
  companyId: string;
  mode: BundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
};

type BundleState = {
  config: Record<string, unknown>;
  mode: BundleMode | null;
  rootPath: string | null;
  entryFile: string;
  resolvedEntryPath: string | null;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundleMode(value: unknown): value is BundleMode {
  return value === "managed" || value === "external";
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

function resolveManagedInstructionsRoot(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "instructions",
  );
}

function resolveLegacyInstructionsPath(candidatePath: string, config: Record<string, unknown>): string {
  if (path.isAbsolute(candidatePath)) return candidatePath;
  const cwd = asString(config.cwd);
  if (!cwd || !path.isAbsolute(cwd)) {
    throw unprocessable(
      "Legacy relative instructionsFilePath requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  return path.resolve(cwd, candidatePath);
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

function shouldIgnoreInstructionsEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<AgentInstructionsFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
  };
}

async function readLegacyInstructions(agent: AgentLike, config: Record<string, unknown>): Promise<string> {
  const instructionsFilePath = asString(config[FILE_KEY]);
  if (instructionsFilePath) {
    try {
      const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, config);
      return await fs.readFile(resolvedPath, "utf8");
    } catch {
      // Fall back to promptTemplate below.
    }
  }
  return asString(config[PROMPT_KEY]) ?? "";
}

function deriveBundleState(agent: AgentLike): BundleState {
  const config = asRecord(agent.adapterConfig);
  const warnings: string[] = [];
  const storedModeRaw = config[MODE_KEY];
  const storedRootRaw = asString(config[ROOT_KEY]);
  const legacyInstructionsPath = asString(config[FILE_KEY]);

  let mode: BundleMode | null = isBundleMode(storedModeRaw) ? storedModeRaw : null;
  let rootPath = storedRootRaw ? resolveHomeAwarePath(storedRootRaw) : null;
  let entryFile = ENTRY_FILE_DEFAULT;

  const storedEntryRaw = asString(config[ENTRY_KEY]);
  if (storedEntryRaw) {
    try {
      entryFile = normalizeRelativeFilePath(storedEntryRaw);
    } catch {
      warnings.push(`Ignored invalid instructions entry file "${storedEntryRaw}".`);
    }
  }

  if (!rootPath && legacyInstructionsPath) {
    try {
      const resolvedLegacyPath = resolveLegacyInstructionsPath(legacyInstructionsPath, config);
      rootPath = path.dirname(resolvedLegacyPath);
      entryFile = path.basename(resolvedLegacyPath);
      mode = resolvedLegacyPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
        || resolvedLegacyPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
        ? "managed"
        : "external";
      if (!path.isAbsolute(legacyInstructionsPath)) {
        warnings.push("Using legacy relative instructionsFilePath; migrate this agent to a managed or absolute external bundle.");
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedEntryPath = rootPath ? path.resolve(rootPath, entryFile) : null;

  return {
    config,
    mode,
    rootPath,
    entryFile,
    resolvedEntryPath,
    warnings,
    legacyPromptTemplateActive: Boolean(asString(config[PROMPT_KEY])),
    legacyBootstrapPromptTemplateActive: Boolean(asString(config[BOOTSTRAP_PROMPT_KEY])),
  };
}

async function recoverManagedBundleState(agent: AgentLike, state: BundleState): Promise<BundleState> {
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const stat = await statIfExists(managedRootPath);
  if (!stat?.isDirectory()) return state;

  const files = await listFilesRecursive(managedRootPath);
  if (files.length === 0) return state;

  const recoveredEntryFile = files.includes(state.entryFile)
    ? state.entryFile
    : files.includes(ENTRY_FILE_DEFAULT)
      ? ENTRY_FILE_DEFAULT
      : files[0]!;

  if (!state.rootPath) {
    return {
      ...state,
      mode: "managed",
      rootPath: managedRootPath,
      entryFile: recoveredEntryFile,
      resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    };
  }

  if (state.mode === "external") return state;

  const resolvedConfiguredRoot = path.resolve(state.rootPath);
  const configuredRootMatchesManaged = resolvedConfiguredRoot === managedRootPath;
  const hasEntryMismatch = recoveredEntryFile !== state.entryFile;

  if (configuredRootMatchesManaged && !hasEntryMismatch) {
    return state;
  }

  const warnings = [...state.warnings];
  if (!configuredRootMatchesManaged) {
    warnings.push(
      `Recovered managed instructions from disk at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
    );
  }
  if (hasEntryMismatch) {
    warnings.push(
      `Recovered managed instructions entry file from disk as ${recoveredEntryFile}; previous entry ${state.entryFile} was missing.`,
    );
  }

  return {
    ...state,
    mode: "managed",
    rootPath: managedRootPath,
    entryFile: recoveredEntryFile,
    resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    warnings,
  };
}

function toBundle(agent: AgentLike, state: BundleState, files: AgentInstructionsFileSummary[]): AgentInstructionsBundle {
  const nextFiles = [...files];
  if (state.legacyPromptTemplateActive && !nextFiles.some((file) => file.path === LEGACY_PROMPT_TEMPLATE_PATH)) {
    const legacyPromptTemplate = asString(state.config[PROMPT_KEY]) ?? "";
    nextFiles.push({
      path: LEGACY_PROMPT_TEMPLATE_PATH,
      size: legacyPromptTemplate.length,
      language: "markdown",
      markdown: true,
      isEntryFile: false,
      editable: true,
      deprecated: true,
      virtual: true,
    });
  }
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    mode: state.mode,
    rootPath: state.rootPath,
    managedRootPath: resolveManagedInstructionsRoot(agent),
    entryFile: state.entryFile,
    resolvedEntryPath: state.resolvedEntryPath,
    editable: Boolean(state.rootPath),
    warnings: state.warnings,
    legacyPromptTemplateActive: state.legacyPromptTemplateActive,
    legacyBootstrapPromptTemplateActive: state.legacyBootstrapPromptTemplateActive,
    files: nextFiles,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: {
    mode: BundleMode;
    rootPath: string;
    entryFile: string;
    clearLegacyPromptTemplate?: boolean;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    [MODE_KEY]: input.mode,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
    [FILE_KEY]: path.resolve(input.rootPath, input.entryFile),
  };
  if (input.clearLegacyPromptTemplate) {
    delete next[PROMPT_KEY];
    delete next[BOOTSTRAP_PROMPT_KEY];
  }
  return next;
}

function buildPersistedBundleConfig(
  derived: BundleState,
  current: BundleState,
  options?: { clearLegacyPromptTemplate?: boolean },
): Record<string, unknown> {
  const currentRootPath = current.rootPath ? path.resolve(current.rootPath) : null;
  const derivedRootPath = derived.rootPath ? path.resolve(derived.rootPath) : null;
  const configMatchesRecoveredState =
    derived.mode === current.mode
    && derivedRootPath !== null
    && currentRootPath !== null
    && derivedRootPath === currentRootPath
    && derived.entryFile === current.entryFile;

  if (configMatchesRecoveredState && !options?.clearLegacyPromptTemplate) {
    return current.config;
  }

  if (!current.rootPath || !current.mode) {
    return current.config;
  }

  return applyBundleConfig(current.config, {
    mode: current.mode,
    rootPath: current.rootPath,
    entryFile: current.entryFile,
    clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
  });
}

async function writeBundleFiles(
  rootPath: string,
  files: Record<string, string>,
  options?: { overwriteExisting?: boolean },
) {
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    const existingStat = await statIfExists(absolutePath);
    if (existingStat?.isFile() && !options?.overwriteExisting) continue;
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
  }
}

export function syncInstructionsBundleConfigFromFilePath(
  agent: AgentLike,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const instructionsFilePath = asString(adapterConfig[FILE_KEY]);
  const next = { ...adapterConfig };
  if (!instructionsFilePath) {
    delete next[MODE_KEY];
    delete next[ROOT_KEY];
    delete next[ENTRY_KEY];
    return next;
  }
  const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, adapterConfig);
  const rootPath = path.dirname(resolvedPath);
  const entryFile = path.basename(resolvedPath);
  const mode: BundleMode = resolvedPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
    || resolvedPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
    ? "managed"
    : "external";
  return applyBundleConfig(next, { mode, rootPath, entryFile });
}

export function agentInstructionsService() {
  async function getBundle(agent: AgentLike): Promise<AgentInstructionsBundle> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (!state.rootPath) return toBundle(agent, state, []);
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return toBundle(agent, {
        ...state,
        warnings: [...state.warnings, `Instructions root does not exist: ${state.rootPath}`],
      }, []);
    }
    const files = await listFilesRecursive(state.rootPath);
    const summaries = await Promise.all(files.map((relativePath) => readFileSummary(state.rootPath!, relativePath, state.entryFile)));
    return toBundle(agent, state, summaries);
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentInstructionsFileDetail> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const content = asString(state.config[PROMPT_KEY]);
      if (content === null) throw notFound("Instructions file not found");
      return {
        path: LEGACY_PROMPT_TEMPLATE_PATH,
        size: content.length,
        language: "markdown",
        markdown: true,
        isEntryFile: false,
        editable: true,
        deprecated: true,
        virtual: true,
        content,
      };
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8").catch(() => null),
      fs.stat(absolutePath).catch(() => null),
    ]);
    if (content === null || !stat?.isFile()) throw notFound("Instructions file not found");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      markdown: isMarkdown(normalizedPath),
      isEntryFile: normalizedPath === state.entryFile,
      editable: true,
      deprecated: false,
      virtual: false,
      content,
    };
  }

  async function ensureWritableBundle(
    agent: AgentLike,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{ adapterConfig: Record<string, unknown>; state: BundleState }> {
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived);
    if (current.rootPath && current.mode) {
      const adapterConfig = buildPersistedBundleConfig(derived, current, options);
      return {
        adapterConfig,
        state: deriveBundleState({ ...agent, adapterConfig }),
      };
    }

    const managedRoot = resolveManagedInstructionsRoot(agent);
    const entryFile = current.entryFile || ENTRY_FILE_DEFAULT;
    const nextConfig = applyBundleConfig(current.config, {
      mode: "managed",
      rootPath: managedRoot,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    await fs.mkdir(managedRoot, { recursive: true });

    const entryPath = resolvePathWithinRoot(managedRoot, entryFile);
    const entryStat = await statIfExists(entryPath);
    if (!entryStat?.isFile()) {
      const legacyInstructions = await readLegacyInstructions(agent, current.config);
      if (legacyInstructions.trim().length > 0) {
        await fs.mkdir(path.dirname(entryPath), { recursive: true });
        await fs.writeFile(entryPath, legacyInstructions, "utf8");
      }
    }

    return {
      adapterConfig: nextConfig,
      state: deriveBundleState({ ...agent, adapterConfig: nextConfig }),
    };
  }

  async function updateBundle(
    agent: AgentLike,
    input: {
      mode?: BundleMode;
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    const nextMode = input.mode ?? state.mode ?? "managed";
    const nextEntryFile = input.entryFile ? normalizeRelativeFilePath(input.entryFile) : state.entryFile;
    let nextRootPath: string;

    if (nextMode === "managed") {
      nextRootPath = resolveManagedInstructionsRoot(agent);
    } else {
      const rootPath = asString(input.rootPath) ?? state.rootPath;
      if (!rootPath) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      const resolvedRoot = resolveHomeAwarePath(rootPath);
      if (!path.isAbsolute(resolvedRoot)) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      nextRootPath = resolvedRoot;
    }

    await fs.mkdir(nextRootPath, { recursive: true });

    const existingFiles = await listFilesRecursive(nextRootPath);
    const exported = await exportFiles(agent);
    if (existingFiles.length === 0) {
      await writeBundleFiles(nextRootPath, exported.files);
    }
    const refreshedFiles = existingFiles.length === 0 ? await listFilesRecursive(nextRootPath) : existingFiles;
    if (!refreshedFiles.includes(nextEntryFile)) {
      const nextEntryContent = exported.files[nextEntryFile] ?? exported.files[exported.entryFile] ?? "";
      await writeBundleFiles(nextRootPath, { [nextEntryFile]: nextEntryContent });
    }

    const nextConfig = applyBundleConfig(state.config, {
      mode: nextMode,
      rootPath: nextRootPath,
      entryFile: nextEntryFile,
      clearLegacyPromptTemplate: input.clearLegacyPromptTemplate,
    });
    const nextBundle = await getBundle({ ...agent, adapterConfig: nextConfig });
    return { bundle: nextBundle, adapterConfig: nextConfig };
  }

  async function writeFile(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{
    bundle: AgentInstructionsBundle;
    file: AgentInstructionsFileDetail;
    adapterConfig: Record<string, unknown>;
  }> {
    const current = deriveBundleState(agent);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const adapterConfig: Record<string, unknown> = {
        ...current.config,
        [PROMPT_KEY]: content,
      };
      const nextAgent = { ...agent, adapterConfig };
      const [bundle, file] = await Promise.all([
        getBundle(nextAgent),
        readFile(nextAgent, LEGACY_PROMPT_TEMPLATE_PATH),
      ]);
      return { bundle, file, adapterConfig };
    }

    const prepared = await ensureWritableBundle(agent, options);
    const absolutePath = resolvePathWithinRoot(prepared.state.rootPath!, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    const nextAgent = { ...agent, adapterConfig: prepared.adapterConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, adapterConfig: prepared.adapterConfig };
  }

  async function deleteFile(agent: AgentLike, relativePath: string): Promise<{
    bundle: AgentInstructionsBundle;
    adapterConfig: Record<string, unknown>;
  }> {
    const derived = deriveBundleState(agent);
    const state = await recoverManagedBundleState(agent, derived);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw unprocessable("Cannot delete the legacy promptTemplate pseudo-file");
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalizedPath === state.entryFile) {
      throw unprocessable("Cannot delete the bundle entry file");
    }
    const absolutePath = resolvePathWithinRoot(state.rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    const adapterConfig = buildPersistedBundleConfig(derived, state);
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  async function exportFiles(agent: AgentLike): Promise<{
    files: Record<string, string>;
    entryFile: string;
    warnings: string[];
  }> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (state.rootPath) {
      const stat = await statIfExists(state.rootPath);
      if (stat?.isDirectory()) {
        const relativePaths = await listFilesRecursive(state.rootPath);
        const files = Object.fromEntries(await Promise.all(relativePaths.map(async (relativePath) => {
          const absolutePath = resolvePathWithinRoot(state.rootPath!, relativePath);
          const content = await fs.readFile(absolutePath, "utf8");
          return [relativePath, content] as const;
        })));
        if (Object.keys(files).length > 0) {
          return { files, entryFile: state.entryFile, warnings: state.warnings };
        }
      }
    }

    const legacyBody = await readLegacyInstructions(agent, state.config);
    return {
      files: { [state.entryFile]: legacyBody || "_No AGENTS instructions were resolved from current agent config._" },
      entryFile: state.entryFile,
      warnings: state.warnings,
    };
  }

  async function materializeManagedBundle(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      replaceExisting?: boolean;
      entryFile?: string;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    const rootPath = resolveManagedInstructionsRoot(agent);
    const entryFile = options?.entryFile ? normalizeRelativeFilePath(options.entryFile) : ENTRY_FILE_DEFAULT;

    if (options?.replaceExisting) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
    await fs.mkdir(rootPath, { recursive: true });

    const normalizedEntries = Object.entries(files).map(([relativePath, content]) => [
      normalizeRelativeFilePath(relativePath),
      content,
    ] as const);
    for (const [relativePath, content] of normalizedEntries) {
      const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }
    if (!normalizedEntries.some(([relativePath]) => relativePath === entryFile)) {
      await fs.writeFile(resolvePathWithinRoot(rootPath, entryFile), "", "utf8");
    }

    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), {
      mode: "managed",
      rootPath,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  return {
    getBundle,
    readFile,
    updateBundle,
    writeFile,
    deleteFile,
    exportFiles,
    ensureManagedBundle: ensureWritableBundle,
    materializeManagedBundle,
  };
}

const DEFAULT_INSTRUCTIONS_CONFIG_KEY = "instructionsFilePath";
const KNOWN_INSTRUCTIONS_PATH_KEYS = ["instructionsFilePath", "agentsMdPath"] as const;

export const MANAGED_MEMORY_BEGIN_MARKER = "<!-- PAPERCLIP:BEGIN MEMORY -->";
export const MANAGED_MEMORY_END_MARKER = "<!-- PAPERCLIP:END MEMORY -->";

const LEGACY_MEMORY_HEADING = /^## Memory\s*$/m;
const GUIDELINES_HEADING = /^## Guidelines\s*$/m;

function asNonEmptyString(value: unknown): string | null {
  return asString(value);
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
