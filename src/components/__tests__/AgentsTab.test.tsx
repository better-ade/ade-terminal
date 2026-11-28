import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const tauri = vi.hoisted(() => ({
  /** What `project_root` resolves a folder to (default: the folder itself). */
  roots: {} as Record<string, string>,
  applies: [] as Record<string, unknown>[],
  /** None of the files asked about is on disk: no agent is installed. */
  noFiles: false,
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "project_root":
        return tauri.roots[args.path as string] ?? args.path;
      case "project_setup_status":
        return { isGit: true, missing: tauri.noFiles ? args.paths : [], needsImport: false, stacks: [] };
      case "project_setup_apply":
        tauri.applies.push(args);
        tauri.noFiles = false;
        return { created: [], appendedImport: false, agents: 0 };
      case "mcp_list":
        return {};
      case "vault_list":
        return [];
      case "check_command_exists":
        throw new Error("not installed");
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  }),
}));

import AgentsTab from "../AgentsTab";
import IntegrationsPanel from "../IntegrationsPanel";

const renderTab = (root: string) => render(<AgentsTab root={root} onNotice={vi.fn()} onError={vi.fn()} />);

beforeEach(() => {
  localStorage.clear();
  tauri.roots = {};
  tauri.applies.length = 0;
  tauri.noFiles = false;
});

describe("Set up now on the Agents tab", () => {
  it("sets the project up, with no question first", async () => {
    tauri.noFiles = true;
    renderTab("/code/shop");
    fireEvent.click(await screen.findByRole("button", { name: "Set up now" }));
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    expect(tauri.applies[0]).toMatchObject({ root: "/code/shop", full: true });
    expect(tauri.applies[0]).not.toHaveProperty("methodology");
    expect(document.querySelector(".new-tab-ask")).toBeNull();
    expect(await screen.findByText("Set up")).toBeTruthy();
  });
});

describe("Set up now in a folder that isn't a project", () => {
  it("says so and writes nothing", async () => {
    tauri.noFiles = true;
    const onError = vi.fn();
    render(<AgentsTab root="/Users/testuser" onNotice={vi.fn()} onError={onError} />);
    fireEvent.click(await screen.findByRole("button", { name: "Set up now" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("This folder isn't a project."));
    expect(tauri.applies).toHaveLength(0);
  });
});

describe("the Agents tab's project", () => {
  it("is the project root the pane is in", async () => {
    tauri.roots = { "/code/mono/app/src": "/code/mono" };
    render(<IntegrationsPanel cwd="/code/mono/app/src" initialTab="agents" onClose={vi.fn()} />);
    await waitFor(() => expect(document.querySelector(".contracts-panel__root")?.textContent).toBe("/code/mono"));
  });
});

describe("the Project setup card", () => {
  it("shows a project with every file as set up, and says nothing of BMAD", async () => {
    renderTab("/code/shop");
    expect(await screen.findByText("Set up")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Re-check" })).toBeTruthy();
    expect(screen.queryByText("Incomplete")).toBeNull();
    expect(document.body.textContent).not.toMatch(/BMAD/);
  });

  it("shows a project with files missing as incomplete", async () => {
    tauri.noFiles = true;
    renderTab("/code/shop");
    expect(await screen.findByText("Incomplete")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up now" })).toBeTruthy();
  });

  it("adds one agent with no BMAD version", async () => {
    tauri.noFiles = true;
    renderTab("/code/shop");
    const [add] = await screen.findAllByRole("button", { name: "Add" });
    fireEvent.click(add);
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    expect(tauri.applies[0]).toMatchObject({ root: "/code/shop", full: false });
    expect(tauri.applies[0]).not.toHaveProperty("methodology");
  });
});
