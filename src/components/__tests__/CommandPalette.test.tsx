import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const tauri = vi.hoisted(() => ({
  applies: [] as Record<string, unknown>[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    switch (command) {
      case "project_root":
        return String(args.path).replace(/\/src$/, "");
      case "project_setup_status":
        return { isGit: true, missing: [], needsImport: false, stacks: [] };
      case "project_setup_apply":
        tauri.applies.push(args);
        return { created: [], appendedImport: false, agents: 0 };
      default:
        throw new Error(`unexpected command: ${command}`);
    }
  }),
}));

// The palette asks the active pane for its folder; there is no terminal here.
const pane = vi.hoisted(() => ({ cwd: "/code/shop/src" as string | null, running: new Map<string, string>() }));
vi.mock("../../hooks/useTerminal", () => ({
  getPtyCwd: vi.fn(async () => pane.cwd),
  // For the guarded close: what each pane runs, and every pane has a terminal.
  paneBusy: vi.fn(async (paneId: string) => pane.running.get(paneId) ?? null),
  getTerminalDimensions: () => ({ cols: 80, rows: 24 }),
  destroyInstance: vi.fn(),
}));

// jsdom has no layout engine, so it doesn't implement scrollIntoView.
// The palette calls it to keep the selected row visible.
Element.prototype.scrollIntoView = vi.fn();

import CommandPalette from "../CommandPalette";
import { useSettingsStore } from "../../stores/settingsStore";
import { shownView, useTabStore } from "../../stores/tabStore";
import ConfirmDialog from "../ConfirmDialog";
import { useGuardedClose } from "../../hooks/useGuardedClose";

const COMMAND = "Project: Set up methodology and agents";
const renderPalette = () =>
  render(<CommandPalette onClose={vi.fn()} onToggleScratchpad={vi.fn()} onOpenAgentPicker={vi.fn()} />);

beforeEach(() => {
  localStorage.clear();
  tauri.applies.length = 0;
  pane.cwd = "/code/shop/src";
  useSettingsStore.getState().setAutoProjectSetup(true);
});

describe("Project: Set up methodology and agents", () => {
  it("sets up the project the pane is in, with no question first", async () => {
    const done = vi.fn();
    window.addEventListener("project-setup-done", done);
    renderPalette();
    fireEvent.click(screen.getByText(COMMAND));
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
    expect(tauri.applies[0]).toMatchObject({ root: "/code/shop", full: true });
    expect(tauri.applies[0]).not.toHaveProperty("methodology");
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(screen.queryByRole("dialog")).toBeNull();
    window.removeEventListener("project-setup-done", done);
  });

  it("sets up with automatic setup off, and for a project whose setup was undone", async () => {
    useSettingsStore.getState().setAutoProjectSetup(false);
    localStorage.setItem("ade-project-setup-declined", JSON.stringify(["/code/shop"]));
    renderPalette();
    fireEvent.click(screen.getByText(COMMAND));
    await waitFor(() => expect(tauri.applies).toHaveLength(1));
  });

  it("says a home folder isn't a project and writes nothing", async () => {
    pane.cwd = "/Users/testuser";
    const failed = vi.fn();
    window.addEventListener("project-setup-failed", failed);
    renderPalette();
    fireEvent.click(screen.getByText(COMMAND));
    await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect((failed.mock.calls[0][0] as CustomEvent<{ why: string }>).detail.why).toBe("This folder isn't a project.");
    expect(tauri.applies).toHaveLength(0);
    window.removeEventListener("project-setup-failed", failed);
  });

  it("says why when the active tab has no folder", async () => {
    pane.cwd = null;
    const failed = vi.fn();
    window.addEventListener("project-setup-failed", failed);
    renderPalette();
    fireEvent.click(screen.getByText(COMMAND));
    await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    expect((failed.mock.calls[0][0] as CustomEvent<{ why: string }>).detail.why).toContain("no folder");
    window.removeEventListener("project-setup-failed", failed);
  });
});

describe("Close Tab and Close Pane", () => {
  it("close actions go through the confirmation", () => {
    const { activeTabId, tabs } = useTabStore.getState();
    const paneId = shownView(tabs.find((t) => t.id === activeTabId)!).activePaneId;
    const closeTab = vi.spyOn(useTabStore.getState(), "closeTab");
    const closePane = vi.spyOn(useTabStore.getState(), "closePane");
    const tabRequests: unknown[] = [];
    const paneRequests: unknown[] = [];
    const onTab = (e: Event) => tabRequests.push((e as CustomEvent).detail);
    const onPane = (e: Event) => paneRequests.push((e as CustomEvent).detail);
    window.addEventListener("request-close-tab", onTab);
    window.addEventListener("request-close-pane", onPane);
    try {
      const first = renderPalette();
      fireEvent.click(screen.getByText("Close Tab"));
      first.unmount();
      renderPalette();
      fireEvent.click(screen.getByText("Close Pane"));

      expect(tabRequests).toEqual([{ tabId: activeTabId }]);
      expect(paneRequests).toEqual([{ tabId: activeTabId, paneId }]);
      expect(closeTab).not.toHaveBeenCalled();
      expect(closePane).not.toHaveBeenCalled();
      const source = readFileSync(resolve(__dirname, "../CommandPalette.tsx"), "utf8");
      expect(source).not.toMatch(/\.close(Tab|Pane)\(/);
    } finally {
      window.removeEventListener("request-close-tab", onTab);
      window.removeEventListener("request-close-pane", onPane);
      closeTab.mockRestore();
      closePane.mockRestore();
    }
  });
});

describe("Close Pane with sub-terminals", () => {
  /** App's guarded close and its dialog. */
  function Closer() {
    const { confirmDialog, setConfirmDialog } = useGuardedClose();
    return confirmDialog ? (
      <ConfirmDialog
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(null)}
      />
    ) : null;
  }

  it("Close Pane on a sub-terminal's last pane closes the view", async () => {
    const { activeTabId, addView } = useTabStore.getState();
    const viewId = addView(activeTabId, { name: "dev server", cwd: null, focus: true })!;
    const tab = () => useTabStore.getState().tabs.find((t) => t.id === activeTabId)!;
    const paneId = shownView(tab()).activePaneId;
    pane.running.set(paneId, "node");
    try {
      render(<><Closer /><CommandPalette onClose={vi.fn()} onToggleScratchpad={vi.fn()} onOpenAgentPicker={vi.fn()} /></>);
      fireEvent.click(screen.getByText("Close Pane"));

      // The same confirm as ⌘⇧W: the sub-terminal's.
      await waitFor(() => expect(screen.getByText("Close “dev server”?")).toBeTruthy());
      expect(screen.getByText("It is running a program (node). Closing ends it.")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Close" }));
      expect(tab().views[viewId]).toBeUndefined();
      expect(tab().shownView).toBe("own");
    } finally {
      pane.running.clear();
    }
  });
});
