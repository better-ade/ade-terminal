import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "../stores/settingsStore";
import { isSetupCandidate, normRoot, setUpProject, setupDeclined } from "./projectSetup";
import { useTabStore } from "../stores/tabStore";

const KEY = "ade-recent-projects";
const MAX = 8;

/** Open a new tab: ask "terminal or project?" first unless that's turned off. */
export function requestNewTab() {
  if (useSettingsStore.getState().askOnNewTab) window.dispatchEvent(new CustomEvent("request-new-tab"));
  else useTabStore.getState().addTab();
}

export function recentProjects(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function rememberProject(path: string) {
  const list = [path, ...recentProjects().filter((p) => p !== path)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: recents are a convenience.
  }
}

export function forgetProject(path: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify(recentProjects().filter((p) => p !== path)));
  } catch {
    // As above.
  }
}

/** The project that opening `path` sets up; null when it doesn't. */
function setupRootFor(path: string): string | null {
  if (!useSettingsStore.getState().autoProjectSetup) return null;
  // A folder picked to be a project is the project.
  const root = normRoot(path);
  return isSetupCandidate(root) && !setupDeclined(root) ? root : null;
}

/**
 * Open a terminal tab in a project folder, remember it, and set the project up
 * (the ADE methodology, the role agents) unless that's turned off or the
 * person undid an earlier setup there.
 */
export async function openProjectTab(path: string): Promise<void> {
  const root = setupRootFor(path);
  rememberProject(path);
  useTabStore.getState().addTab(undefined, path);
  if (!root) return;
  // Not awaited: the terminal is usable while the files are written.
  setUpProject(root)
    .then((result) => window.dispatchEvent(new CustomEvent("project-setup-done", { detail: result })))
    .catch((e) => window.dispatchEvent(new CustomEvent("project-setup-failed", { detail: { why: `Project setup failed: ${e}` } })));
}

/** Start a new project in a folder: git init. openProjectTab then opens it. */
export async function initProject(path: string): Promise<void> {
  await invoke("project_git_init", { root: path });
}
