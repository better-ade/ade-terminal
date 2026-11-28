import { beforeEach, describe, expect, it, vi } from "vitest";

// Setup is IPC only. Tauri binds the apply arguments by name, so the recorded
// call is the whole observable contract.
const tauri = vi.hoisted(() => ({
  applies: [] as Record<string, unknown>[],
  undos: [] as Record<string, unknown>[],
  /** What `project_root` resolves a folder to (default: the folder itself). */
  roots: {} as Record<string, string>,
  /** The stacks `project_setup_status` detects. */
  stacks: [] as string[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "project_root":
        return tauri.roots[args.path as string] ?? args.path;
      case "project_setup_status":
        return { isGit: true, missing: [], needsImport: false, stacks: tauri.stacks };
      case "project_setup_apply":
        tauri.applies.push(args);
        return { created: [], appendedImport: false, agents: 0 };
      case "project_setup_undo":
        tauri.undos.push(args);
        return 0;
      case "project_agent_remove":
        return true;
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  }),
}));

import { agentCatalog } from "../projectMethodology";
import {
  NOT_A_PROJECT, addAgent, addStackAgents, foldersUpTo, isComplete, isSettingUp, isWithin, normRoot, removeAgent,
  removedAgents, setUpOnRequest, setUpProject, setupDeclined, setupRootOf, summarize, undoSetup, wasSetUp,
  type SetupReport, type SetupStatus,
} from "../projectSetup";

const lastApply = () => tauri.applies[tauri.applies.length - 1];
const files = () => lastApply().files as { path: string; content: string }[];

beforeEach(() => {
  localStorage.clear();
  tauri.applies.length = 0;
  tauri.undos.length = 0;
  tauri.roots = {};
  tauri.stacks = [];
});

describe("project setup", () => {
  it("writes the methodology and the core roles, with no BMAD and no version", async () => {
    await setUpProject("/tmp/proj");
    expect(lastApply()).toMatchObject({ root: "/tmp/proj", full: true });
    expect(lastApply()).not.toHaveProperty("methodology");
    const paths = files().map((f) => f.path);
    expect(paths).toContain(".ade/rules.md");
    expect(paths).toContain(".claude/agents/qa.md");
    for (const f of files()) expect(f.path, f.path).not.toMatch(/bmad/i);
  });

  it("adds the agents for the stacks the project has", async () => {
    tauri.stacks = ["go"];
    const result = await setUpProject("/tmp/proj");
    expect(result.stacks).toEqual(["go"]);
    await setUpProject("/tmp/other", []);
    expect(files().length).toBeLessThan((tauri.applies[0].files as unknown[]).length);
  });

  it("adds stack agents and single agents without touching the rest", async () => {
    await addStackAgents("/tmp/proj", ["go"]);
    expect(lastApply()).toMatchObject({ root: "/tmp/proj", full: false });
    expect(lastApply()).not.toHaveProperty("methodology");
    const qa = agentCatalog().find((a) => a.id === "qa")!;
    await addAgent("/tmp/proj", qa);
    expect(lastApply()).toMatchObject({ full: false });
    expect(files().map((f) => f.path)).toEqual([".claude/agents/qa.md"]);
  });

  it("does not add back an agent the person removed", async () => {
    await removeAgent("/tmp/proj", "qa");
    await setUpProject("/tmp/proj");
    expect(files().map((f) => f.path)).not.toContain(".claude/agents/qa.md");
    // Adding it by hand clears that.
    await addAgent("/tmp/proj", agentCatalog().find((a) => a.id === "qa")!);
    expect(removedAgents("/tmp/proj")).toEqual([]);
  });

  it("hands Undo what it created and the import line, and marks the project declined", async () => {
    const result = await setUpProject("/tmp/proj");
    await undoSetup({ ...result, report: { created: ["/tmp/proj/.ade/rules.md"], appendedImport: true, agents: 0 } });
    expect(tauri.undos[0]).toMatchObject({ root: "/tmp/proj", created: ["/tmp/proj/.ade/rules.md"] });
    expect(tauri.undos[0].import).toBeTruthy();
    expect(tauri.undos[0]).not.toHaveProperty("claudeMd");
    expect(setupDeclined("/tmp/proj")).toBe(true);
    await undoSetup(result);
    expect(tauri.undos[1].import).toBeNull();
  });
});

describe("setting up on request", () => {
  it("sets up the folder and says it is done", async () => {
    const done = vi.fn();
    window.addEventListener("project-setup-done", done);
    const result = await setUpOnRequest("/code/shop/");
    window.removeEventListener("project-setup-done", done);
    expect(result.root).toBe("/code/shop");
    expect(lastApply()).toMatchObject({ root: "/code/shop", full: true });
    expect(done).toHaveBeenCalledOnce();
  });

  it("refuses a home folder or a filesystem root, with a reason to show as it is", async () => {
    await expect(setUpOnRequest("/Users/someone")).rejects.toBe(NOT_A_PROJECT);
    await expect(setUpOnRequest("/")).rejects.toBe(NOT_A_PROJECT);
    expect(tauri.applies).toHaveLength(0);
  });
});

describe("the normalised root", () => {
  it("strips trailing separators and leaves a bare root alone", () => {
    expect(normRoot("/code/shop/")).toBe("/code/shop");
    expect(normRoot("/code/shop//")).toBe("/code/shop");
    expect(normRoot("C:\\code\\shop\\")).toBe("C:\\code\\shop");
    expect(normRoot("/code/shop")).toBe("/code/shop");
    expect(normRoot("/")).toBe("/");
  });

  it("marks a project set up under one key, with or without a trailing slash", async () => {
    const result = await setUpProject("/code/shop/", []);
    expect(result.root).toBe("/code/shop");
    expect(lastApply().root).toBe("/code/shop");
    expect(wasSetUp("/code/shop")).toBe(true);
    expect(wasSetUp("/code/shop/")).toBe(true);
    expect(JSON.parse(localStorage.getItem("ade-project-setup-done")!)).toEqual(["/code/shop"]);
  });

  it("normalises keys written before, when it reads them", () => {
    localStorage.setItem("ade-project-setup-done", JSON.stringify(["/code/old/", "/code/old"]));
    localStorage.setItem("ade-project-setup-declined", JSON.stringify(["C:\\code\\old\\"]));
    expect(wasSetUp("/code/old")).toBe(true);
    expect(setupDeclined("C:\\code\\old")).toBe(true);
  });

  it("declines under the normalised root, and a later setup clears it", async () => {
    const result = await setUpProject("/code/shop", []);
    await undoSetup({ ...result, root: "/code/shop/" });
    expect(setupDeclined("/code/shop")).toBe(true);
    expect(JSON.parse(localStorage.getItem("ade-project-setup-declined")!)).toEqual(["/code/shop"]);
    await setUpProject("/code/shop/", []);
    expect(setupDeclined("/code/shop")).toBe(false);
  });

  it("keeps removed agents under the normalised root", async () => {
    await removeAgent("/code/shop/", "qa");
    expect(removedAgents("/code/shop")).toEqual(["qa"]);
    localStorage.setItem("ade-project-agents-removed", JSON.stringify({ "/code/old/": ["qa"], "/code/old": ["architect"] }));
    expect(removedAgents("/code/old").sort()).toEqual(["architect", "qa"]);
  });

  it("shares a running setup across spellings of the root", async () => {
    const first = setUpProject("/code/shop", []);
    expect(isSettingUp("/code/shop/")).toBe(true);
    expect(setUpProject("/code/shop/", [])).toBe(first);
    await first;
    expect(tauri.applies).toHaveLength(1);
    expect(isSettingUp("/code/shop")).toBe(false);
  });
});

describe("setupRootOf", () => {
  it("is the project root, normalised", async () => {
    tauri.roots = { "/mono/app/src": "/mono/" };
    expect(await setupRootOf("/mono/app/src")).toBe("/mono");
  });

  it("is the folder itself when it has no project root", async () => {
    expect(await setupRootOf("/scratch/")).toBe("/scratch");
  });
});

describe("foldersUpTo", () => {
  it("lists the folder and each one above it, up to the stop", () => {
    expect(foldersUpTo("/mono/app/src", "/mono")).toEqual(["/mono/app/src", "/mono/app", "/mono"]);
    expect(foldersUpTo("/mono/", "/mono")).toEqual(["/mono"]);
    expect(foldersUpTo("C:\\p\\src", "C:\\p")).toEqual(["C:\\p\\src", "C:\\p"]);
  });

  it("is just the folder when it isn't under the stop", () => {
    expect(foldersUpTo("/elsewhere/x", "/mono")).toEqual(["/elsewhere/x"]);
  });

  it("does not list a folder beside the stop with a longer name as above it", () => {
    expect(foldersUpTo("/mono2/app", "/mono")).toEqual(["/mono2/app"]);
  });
});

describe("isComplete", () => {
  const status = (over: Partial<SetupStatus>): SetupStatus => ({
    isGit: true, missing: [], needsImport: false, stacks: [], ...over,
  });

  it("is complete when nothing is missing and CLAUDE.md loads the rules", () => {
    expect(isComplete(status({}))).toBe(true);
  });

  it("is incomplete with a missing file, or a CLAUDE.md that doesn't load the rules", () => {
    expect(isComplete(status({ missing: [".ade/rules.md"] }))).toBe(false);
    expect(isComplete(status({ needsImport: true }))).toBe(false);
  });
});

describe("summarize", () => {
  const report = (over: Partial<SetupReport>): SetupReport => ({ created: [], appendedImport: false, agents: 0, ...over });

  it("names what a setup wrote, and nothing when it wrote nothing", () => {
    expect(summarize(report({}))).toBeNull();
    expect(summarize(report({ created: ["/p/.ade/rules.md", "/p/.claude/agents/qa.md"], agents: 1 })))
      .toBe("1 agent and the methodology");
    expect(summarize(report({ appendedImport: true }))).toBe("a line in CLAUDE.md");
    expect(summarize(report({ created: ["/p/.claude/settings.json"], attributionOff: true })))
      .toBe("settings that turn off AI attribution");
  });
});

describe("isWithin", () => {
  it("is true for the root and for folders inside it", () => {
    expect(isWithin("/mono", "/mono")).toBe(true);
    expect(isWithin("/mono/", "/mono")).toBe(true);
    expect(isWithin("/mono/app/src", "/mono/")).toBe(true);
    expect(isWithin("C:\\p\\src", "C:\\p")).toBe(true);
    expect(isWithin("/x", "/")).toBe(true);
  });

  it("needs a separator after the root", () => {
    expect(isWithin("/mono2", "/mono")).toBe(false);
    expect(isWithin("/mono2/app", "/mono")).toBe(false);
    expect(isWithin("C:\\p2\\src", "C:\\p")).toBe(false);
    expect(isWithin("/mon", "/mono")).toBe(false);
  });
});
