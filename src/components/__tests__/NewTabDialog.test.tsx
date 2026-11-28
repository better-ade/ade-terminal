import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewTabDialog from "../NewTabDialog";
import { recentProjects } from "../../lib/newTab";
import { useSettingsStore } from "../../stores/settingsStore";
import { useTabStore } from "../../stores/tabStore";

// Setup is IPC only: the apply calls record the root a picked folder led to.
const tauri = vi.hoisted(() => ({
  /** What `project_root` resolves a folder to (default: the folder itself). */
  roots: {} as Record<string, string>,
  applies: [] as Record<string, unknown>[],
  applyError: null as string | null,
  gitInit: [] as string[],
  gitInitError: null as string | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "project_root":
        return tauri.roots[args.path as string] ?? args.path;
      case "project_setup_status":
        return { isGit: true, missing: [], needsImport: false, stacks: [] };
      case "project_setup_apply":
        tauri.applies.push(args);
        if (tauri.applyError) throw new Error(tauri.applyError);
        return { created: [], appendedImport: false, agents: 0 };
      case "project_git_init":
        if (tauri.gitInitError) throw new Error(tauri.gitInitError);
        tauri.gitInit.push(String(args.root));
        return true;
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  }),
}));

// The folder picker is native: the test answers it with the path under test.
const picker = vi.hoisted(() => ({ picked: null as string | null }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(async () => picker.picked) }));

vi.mock("../../hooks/useTerminal", () => ({ getPtyCwd: vi.fn(async () => null), destroyInstance: vi.fn(), detachInstance: vi.fn() }));

const NEWAPP = "/Users/testuser/code/newapp";

const lastApply = () => tauri.applies[tauri.applies.length - 1];
const open = (label: RegExp) => fireEvent.click(screen.getByRole("option", { name: label }));
const tabs = () => useTabStore.getState().tabs.length;
const renderDialog = (onClose = vi.fn()) => {
  render(<NewTabDialog onClose={onClose} />);
  return onClose;
};

beforeEach(() => {
  localStorage.clear();
  tauri.roots = {};
  tauri.applies.length = 0;
  tauri.applyError = null;
  tauri.gitInit.length = 0;
  tauri.gitInitError = null;
  useSettingsStore.getState().setAutoProjectSetup(true);
});

describe("opening a project", () => {
  it("runs git init for a new project, opens it and sets it up, with no BMAD question", async () => {
    picker.picked = NEWAPP;
    const onClose = renderDialog();
    const before = tabs();

    open(/New project/);
    await waitFor(() => expect(lastApply()?.root).toBe(NEWAPP));
    expect(tauri.gitInit).toEqual([NEWAPP]);
    expect(onClose).toHaveBeenCalledOnce();
    expect(lastApply().full).toBe(true);
    expect(lastApply()).not.toHaveProperty("methodology");
    expect(tabs()).toBe(before + 1);
    expect(recentProjects()).toEqual([NEWAPP]);
    expect(document.querySelector(".new-tab-ask")).toBeNull();
  });

  it("opens an existing project and sets it up, with no git init", async () => {
    picker.picked = NEWAPP;
    renderDialog();

    open(/Open project/);
    await waitFor(() => expect(lastApply()?.root).toBe(NEWAPP));
    expect(tauri.gitInit).toEqual([]);
  });

  it("sets up the picked folder, not the repository above it", async () => {
    const MONO = "/Users/testuser/code/mono";
    tauri.roots = { [`${MONO}/app`]: MONO };
    picker.picked = `${MONO}/app`;
    renderDialog();

    open(/Open project/);
    await waitFor(() => expect(lastApply()?.root).toBe(`${MONO}/app`));
  });

  it("does not set up when automatic setup is off", async () => {
    useSettingsStore.getState().setAutoProjectSetup(false);
    picker.picked = NEWAPP;
    renderDialog();
    const before = tabs();

    open(/Open project/);
    await waitFor(() => expect(tabs()).toBe(before + 1));
    expect(tauri.applies).toHaveLength(0);
  });

  it("does not set up a project whose setup was undone", async () => {
    localStorage.setItem("ade-project-setup-declined", JSON.stringify([NEWAPP]));
    picker.picked = NEWAPP;
    renderDialog();
    const before = tabs();

    open(/Open project/);
    await waitFor(() => expect(tabs()).toBe(before + 1));
    expect(tauri.applies).toHaveLength(0);
  });
});

describe("when something fails", () => {
  it("shows a git init error in the dialog and keeps it open", async () => {
    tauri.gitInitError = "git is not installed";
    picker.picked = NEWAPP;
    const onClose = renderDialog();
    const before = tabs();

    open(/New project/);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("git is not installed"));
    expect(onClose).not.toHaveBeenCalled();
    expect(tabs()).toBe(before);
  });

  it("reports a setup that fails, and the folder is open all the same", async () => {
    tauri.applyError = "disk full";
    const failed = vi.fn();
    window.addEventListener("project-setup-failed", failed);
    picker.picked = NEWAPP;
    renderDialog();
    const before = tabs();

    open(/Open project/);
    await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect((failed.mock.calls[0][0] as CustomEvent<{ why: string }>).detail.why).toContain("disk full");
    expect(tabs()).toBe(before + 1);
    window.removeEventListener("project-setup-failed", failed);
  });
});
