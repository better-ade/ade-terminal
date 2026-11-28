import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const tauri = vi.hoisted(() => ({
  /** What `project_root` resolves a folder to (default: the folder itself). */
  roots: {} as Record<string, string>,
  /** Folders with no `.git`. */
  notGit: new Set<string>(),
  /** Folders that already have every methodology file. */
  complete: new Set<string>(),
  /** The stacks `project_setup_status` detects. */
  stacks: [] as string[],
  /** When set, project_setup_status fails. */
  statusError: null as string | null,
  applies: [] as Record<string, unknown>[],
  applyError: null as string | null,
  /** When set, project_setup_apply waits for it: the setup is still running. */
  applyGate: null as Promise<void> | null,
  /** What a setup reports: by default one rules file created. */
  report: null as Record<string, unknown> | null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "project_root":
        return tauri.roots[args.path as string] ?? args.path;
      case "project_setup_status": {
        if (tauri.statusError) throw new Error(tauri.statusError);
        const root = args.root as string;
        return {
          isGit: !tauri.notGit.has(root),
          missing: tauri.complete.has(root) ? [] : [".ade/rules.md"],
          needsImport: false,
          stacks: tauri.stacks,
        };
      }
      case "project_setup_apply":
        tauri.applies.push(args);
        if (tauri.applyGate) await tauri.applyGate;
        if (tauri.applyError) throw new Error(tauri.applyError);
        return tauri.report ?? { created: [`${args.root}/.ade/rules.md`], appendedImport: false, agents: 0 };
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  }),
}));

import { announceFailure, useProjectSetup } from "../useProjectSetup";
import type { GuardToast } from "../useContextGuard";
import { openProjectTab } from "../../lib/newTab";
import { useSettingsStore } from "../../stores/settingsStore";

const show = vi.fn<(t: GuardToast) => void>();
const mount = (cwd: string | null) =>
  renderHook(({ cwd }: { cwd: string | null }) => useProjectSetup(cwd, show), { initialProps: { cwd } });
const toasts = () => show.mock.calls.map(([t]) => t);
/** Let the hook's chain of awaits run out, to assert that nothing happened. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });

beforeEach(() => {
  localStorage.clear();
  tauri.roots = {};
  tauri.notGit = new Set();
  tauri.complete = new Set();
  tauri.stacks = [];
  tauri.statusError = null;
  tauri.applies.length = 0;
  tauri.applyError = null;
  tauri.applyGate = null;
  tauri.report = null;
  show.mockClear();
  useSettingsStore.getState().setAutoProjectSetup(true);
});

describe("a git project not yet set up", () => {
  it("is set up directly, with no question, and the setup is announced with Undo", async () => {
    mount("/code/shop");
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    expect(tauri.applies[0]).toMatchObject({ root: "/code/shop", full: true });
    expect(tauri.applies[0]).not.toHaveProperty("methodology");
    await waitFor(() => expect(toasts()).toHaveLength(1));
    expect(toasts()[0].title).toBe("Set up shop");
    expect(toasts()[0].body).toContain("the methodology");
    expect(toasts()[0].body).not.toMatch(/BMAD/);
    expect(toasts()[0].action!.label).toBe("Undo");
  });

  it("is set up at its repository root when the terminal is in a folder below it", async () => {
    tauri.roots = { "/code/mono/app/src": "/code/mono" };
    mount("/code/mono/app/src");
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    expect(tauri.applies[0]).toMatchObject({ root: "/code/mono" });
  });

  it("is set up quietly when it already had everything", async () => {
    tauri.complete.add("/code/shop");
    tauri.report = { created: [], appendedImport: false, agents: 0 };
    mount("/code/shop");
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    await settle();
    expect(toasts()).toHaveLength(0);
  });

  it("stays quiet when a setup nobody asked for fails", async () => {
    tauri.applyError = "disk full";
    mount("/code/shop");
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    await settle();
    expect(show).not.toHaveBeenCalled();
  });

  it("is not announced by a run the terminal has already left", async () => {
    let release!: () => void;
    tauri.applyGate = new Promise<void>((r) => { release = r; });
    const hook = mount("/code/shop");
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    hook.rerender({ cwd: null });
    tauri.applyGate = null;
    await act(async () => { release(); });
    await settle();
    expect(toasts()).toHaveLength(0);
  });

  it("is left alone outside a git repository", async () => {
    tauri.notGit.add("/code/notes");
    mount("/code/notes");
    await settle();
    expect(tauri.applies).toHaveLength(0);
    expect(show).not.toHaveBeenCalled();
  });
});

describe("when automatic setup doesn't apply", () => {
  it("does nothing with automatic setup off", async () => {
    useSettingsStore.getState().setAutoProjectSetup(false);
    mount("/code/shop");
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(tauri.applies).toHaveLength(0);
  });

  it("does nothing for a project whose setup was undone", async () => {
    localStorage.setItem("ade-project-setup-declined", JSON.stringify(["/code/shop/"]));
    mount("/code/shop");
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(tauri.applies).toHaveLength(0);
  });

  it("does not set up a project already set up again", async () => {
    localStorage.setItem("ade-project-setup-done", JSON.stringify(["/code/shop"]));
    mount("/code/shop");
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(tauri.applies).toHaveLength(0);
  });

  it("does nothing for a home folder", async () => {
    mount("/Users/someone");
    await settle();
    expect(tauri.applies).toHaveLength(0);
  });

  it("stays quiet about a project it couldn't check", async () => {
    tauri.statusError = "no access";
    mount("/code/shop");
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(tauri.applies).toHaveLength(0);
  });
});

describe("a project already set up, which has gained a stack", () => {
  beforeEach(() => {
    localStorage.setItem("ade-project-setup-done", JSON.stringify(["/code/shop"]));
    tauri.stacks = ["evm"];
  });

  it("gets that stack's agents", async () => {
    mount("/code/shop");
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    expect(tauri.applies[0]).toMatchObject({ root: "/code/shop", full: false });
  });
});

describe("after the New tab dialog", () => {
  it("does not set up the repository while New tab is setting up a folder inside it", async () => {
    let release!: () => void;
    tauri.applyGate = new Promise<void>((r) => { release = r; });
    tauri.roots = { "/code/mono/app": "/code/mono" };
    await openProjectTab("/code/mono/app");
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    expect(tauri.applies[0]).toMatchObject({ root: "/code/mono/app" });

    // The marker isn't written yet, so the hook resolves the repository above.
    mount("/code/mono/app");
    await settle();
    expect(tauri.applies).toHaveLength(1);
    expect(show).not.toHaveBeenCalled();
    release();
    await settle();
  });
});

describe("announceFailure", () => {
  it("shows the reason under the given title, or under Project setup", () => {
    announceFailure({ why: "disk full" }, show);
    announceFailure({ why: "no access", title: "Setup stopped" }, show);
    expect(toasts()).toEqual([
      { title: "Project setup", body: "disk full" },
      { title: "Setup stopped", body: "no access" },
    ]);
  });
});
