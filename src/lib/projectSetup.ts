/**
 * Project setup: every project ADE opens gets the ADE methodology
 * (.ade/, CLAUDE.md, llms.txt) and the role sub-agents in .claude/agents/.
 * Only missing files are written; an existing CLAUDE.md gets one import line.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  CLAUDE_MD_IMPORT, CLAUDE_MD_IMPORT_MARKER, agentCatalog, methodologyFiles, stackAgentFiles,
  type AgentEntry, type MethodologyFile, type Stack,
} from "./projectMethodology";

export interface SetupStatus {
  isGit: boolean;
  missing: string[];
  needsImport: boolean;
  stacks: Stack[];
}

export interface SetupReport {
  created: string[];
  appendedImport: boolean;
  agents: number;
  /** AI attribution was turned off in .claude/settings.json. */
  attributionOff?: boolean;
  /** .claude/settings.json couldn't be updated; the rest of setup still ran. */
  settingsError?: string | null;
}

export interface SetupResult {
  root: string;
  report: SetupReport;
  files: MethodologyFile[];
  stacks: Stack[];
}

const DONE_KEY = "ade-project-setup-done";
const REMOVED_KEY = "ade-project-agents-removed";
const DECLINED_KEY = "ade-project-setup-declined";

/**
 * One spelling per project: no trailing separator. Every per-project list keys
 * on it, so `/code/shop/` and `/code/shop` are one project.
 */
export function normRoot(root: string): string {
  return root.replace(/[\\/]+$/, "") || root;
}

function readList(key: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    if (!Array.isArray(v)) return [];
    // Lists written before roots were normalised may hold a trailing separator.
    return [...new Set(v.filter((r): r is string => typeof r === "string").map(normRoot))];
  } catch {
    return [];
  }
}

function writeList(key: string, root: string, on: boolean) {
  const at = normRoot(root);
  const list = readList(key).filter((r) => r !== at);
  if (on) list.push(at);
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // Storage blocked: the choice lasts for this session only.
  }
}

/** The user undid setup here: automatic setup leaves this project alone. */
export function setupDeclined(root: string): boolean {
  return readList(DECLINED_KEY).includes(normRoot(root));
}

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

/** Home folders and the filesystem root are never projects. */
export function isSetupCandidate(root: string): boolean {
  return !/^(\/|[A-Za-z]:\\?|\/(Users|home)\/[^/]+\/?|[A-Za-z]:\\Users\\[^\\]+\\?)$/.test(root);
}

export function wasSetUp(root: string): boolean {
  return readList(DONE_KEY).includes(normRoot(root));
}

function markSetUp(root: string, done: boolean) {
  writeList(DONE_KEY, root, done);
}

/**
 * `dir` is `root` or a folder inside it. A separator has to follow the root:
 * `/mono2` is not inside `/mono`.
 */
export function isWithin(dir: string, root: string): boolean {
  const at = normRoot(dir);
  const top = normRoot(root);
  if (at === top) return true;
  if (!at.startsWith(top)) return false;
  // A filesystem root keeps its separator (`/`), so the next character is a name.
  return /[\\/]$/.test(top) || /[\\/]/.test(at[top.length]);
}

function readRemoved(): Record<string, string[]> {
  try {
    const v = JSON.parse(localStorage.getItem(REMOVED_KEY) ?? "{}");
    if (!v || typeof v !== "object") return {};
    // Two spellings of one root, from before roots were normalised, are merged.
    const out: Record<string, string[]> = {};
    for (const [root, ids] of Object.entries(v as Record<string, unknown>)) {
      if (!Array.isArray(ids)) continue;
      const at = normRoot(root);
      out[at] = [...new Set([...(out[at] ?? []), ...ids.filter((id): id is string => typeof id === "string")])];
    }
    return out;
  } catch {
    return {};
  }
}

/** Agents the user removed from a project, which setup won't bring back. */
export function removedAgents(root: string): string[] {
  return readRemoved()[normRoot(root)] ?? [];
}

function setRemoved(root: string, id: string, removed: boolean) {
  const at = normRoot(root);
  const all = readRemoved();
  const list = (all[at] ?? []).filter((x) => x !== id);
  if (removed) list.push(id);
  all[at] = list;
  try {
    localStorage.setItem(REMOVED_KEY, JSON.stringify(all));
  } catch {
    // Storage blocked: a removed agent may come back with the stack.
  }
}

const withoutRemoved = (root: string, files: MethodologyFile[]) => {
  const removed = new Set(removedAgents(root).map((id) => `.claude/agents/${id}.md`));
  return files.filter((f) => !removed.has(f.path));
};

/** What setup writes for a project, without the agents the person removed. */
export function setupFiles(root: string, stacks: Stack[]): MethodologyFile[] {
  const at = normRoot(root);
  return withoutRemoved(at, methodologyFiles(baseName(at), stacks));
}

function apply(root: string, files: MethodologyFile[]): Promise<SetupReport> {
  return invoke<SetupReport>("project_setup_apply", {
    root, files, import: CLAUDE_MD_IMPORT, marker: CLAUDE_MD_IMPORT_MARKER, full: true,
  });
}

export function setupStatus(root: string): Promise<SetupStatus> {
  const files = methodologyFiles(baseName(root));
  return invoke<SetupStatus>("project_setup_status", { root, paths: files.map((f) => f.path), marker: CLAUDE_MD_IMPORT_MARKER });
}

/** `dir`'s parent, or null at a filesystem root. Handles `/` and `\\`. */
function parentDir(dir: string): string | null {
  const trimmed = dir.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return cut > 0 ? trimmed.slice(0, cut) : null;
}

/** The folder a setup started from `cwd` works on: its project root (the nearest `.git` ancestor, or `cwd` itself). */
export async function setupRootOf(cwd: string): Promise<string> {
  return normRoot(await invoke<string>("project_root", { path: cwd }).catch(() => cwd));
}

/**
 * `dir` and each folder above it, up to and including `stop`. Just `dir` when
 * it isn't under `stop`.
 */
export function foldersUpTo(dir: string, stop: string): string[] {
  const end = normRoot(stop);
  const out: string[] = [];
  let at: string | null = normRoot(dir);
  // Bounded: a dir that is somehow not under its stop still ends.
  for (let i = 0; at && i < 64; i++) {
    out.push(at);
    if (at === end || !isWithin(at, end)) break;
    at = parentDir(at);
  }
  return out;
}

export function isComplete(s: SetupStatus): boolean {
  return s.missing.length === 0 && !s.needsImport;
}

const inFlight = new Map<string, Promise<SetupResult>>();

/**
 * The detail of `project-setup-failed`: a setup that didn't happen, reported
 * from outside the component that shows the toast.
 */
export interface SetupFailure {
  why: string;
  /** The toast's title; "Project setup" when unset. */
  title?: string;
}

/** A setup for this project is running right now. */
export function isSettingUp(root: string): boolean {
  return inFlight.has(normRoot(root));
}

/**
 * Set up a project: the methodology, the core roles and its stack's agents.
 * Safe to run again; a setup already running for the project is shared.
 * Running it by hand clears an earlier Undo.
 */
export function setUpProject(root: string, stacks?: Stack[]): Promise<SetupResult> {
  const at = normRoot(root);
  const running = inFlight.get(at);
  if (running) return running;
  const job = (async () => {
    const detected = stacks ?? (await setupStatus(at)).stacks ?? [];
    const files = withoutRemoved(at, methodologyFiles(baseName(at), detected));
    const report = await apply(at, files);
    markSetUp(at, true);
    writeList(DECLINED_KEY, at, false);
    return { root: at, report, files, stacks: detected };
  })().finally(() => inFlight.delete(at));
  inFlight.set(at, job);
  return job;
}

/**
 * Set up on request: what the palette's command and the "Set up now" buttons
 * run. These work on whatever folder the active pane is in, which can be the
 * home folder: that is refused, with a reason callers show as it is.
 */
export async function setUpOnRequest(root: string): Promise<SetupResult> {
  if (!isSetupCandidate(normRoot(root))) throw NOT_A_PROJECT;
  const result = await setUpProject(root);
  window.dispatchEvent(new CustomEvent("project-setup-done", { detail: result }));
  return result;
}

/** What `setUpOnRequest` rejects with for a home folder or a filesystem root. */
export const NOT_A_PROJECT = "This folder isn't a project.";

/** Agents for stacks a set-up project has gained since (e.g. a new foundry.toml). */
export async function addStackAgents(root: string, stacks: Stack[]): Promise<SetupResult> {
  const files = withoutRemoved(root, stackAgentFiles(stacks));
  const report = await invoke<SetupReport>("project_setup_apply", {
    root, files, import: CLAUDE_MD_IMPORT, marker: CLAUDE_MD_IMPORT_MARKER, full: false,
  });
  return { root, report, files, stacks };
}

/** Add one agent to a project now. */
export async function addAgent(root: string, agent: AgentEntry): Promise<void> {
  setRemoved(root, agent.id, false);
  const file = agentCatalog().find((a) => a.id === agent.id)?.file ?? agent.file;
  await invoke<SetupReport>("project_setup_apply", {
    root, files: [file], import: CLAUDE_MD_IMPORT, marker: CLAUDE_MD_IMPORT_MARKER, full: false,
  });
}

/** Remove one agent from a project; setup won't add it back. */
export async function removeAgent(root: string, id: string): Promise<void> {
  await invoke<boolean>("project_agent_remove", { root, name: id });
  setRemoved(root, id, true);
}

/** Remove what a setup wrote, keeping anything edited since. */
export async function undoSetup(r: SetupResult): Promise<number> {
  const removed = await invoke<number>("project_setup_undo", {
    root: r.root,
    created: r.report.created,
    files: r.files,
    import: r.report.appendedImport ? CLAUDE_MD_IMPORT : null,
  });
  // Stays "set up" so it isn't redone, and declined so stack agents aren't
  // added either. "Set up now" in Integrations > Agents undoes this.
  markSetUp(r.root, true);
  writeList(DECLINED_KEY, r.root, true);
  return removed;
}

/** A short summary of what a setup wrote, or null when it wrote nothing. */
export function summarize(r: SetupReport): string | null {
  const parts: string[] = [];
  if (r.agents) parts.push(r.agents === 1 ? "1 agent" : `${r.agents} agents`);
  // A settings file setup created is counted below, not as the methodology.
  const settings = r.created.filter((p) => /[\\/]\.claude[\\/]settings\.json$/.test(p)).length;
  const other = r.created.length - r.agents - settings;
  if (other > 0) parts.push("the methodology");
  if (r.appendedImport) parts.push("a line in CLAUDE.md");
  if (r.attributionOff) parts.push("settings that turn off AI attribution");
  if (!parts.length) return null;
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
