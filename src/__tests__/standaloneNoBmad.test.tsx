import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Story ST1, slice 1 ("No BMAD"): ADE Terminal is a standalone terminal and
 * ships no BMAD. ade brings the method; the app has no board, no BMAD version
 * question, no switch, and no BMAD item in settings, the palette or the
 * new-tab dialog (st_no_bmad_ui). Settings an older release saved, with its
 * BMAD keys, still load (the BMAD part of st_old_settings).
 */

// Every command answers "nothing here": a terminal with no folder, no project.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string) => (command.startsWith("state_list_") ? [] : null)),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onCloseRequested: async () => () => {}, destroy: async () => {} }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../hooks/useTerminal", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getPtyCwd: vi.fn(async () => null),
  paneBusy: vi.fn(async () => null),
  getTerminalDimensions: () => ({ cols: 80, rows: 24 }),
  destroyInstance: vi.fn(),
  stopIdlePolling: vi.fn(),
}));
// The terminal itself is not what these tests are about.
vi.mock("../components/PaneContainer", () => ({ default: () => null }));
vi.mock("../components/TerminalPane", () => ({ default: () => null }));
vi.mock("../components/Scratchpad", () => ({ default: () => null }));
vi.mock("../components/Tour", () => ({ default: () => null }));
vi.mock("../lib/terminalOpen", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startTerminalOpen: () => () => {},
}));
vi.mock("../stores/agentStatusStore", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  watchAgentStatus: () => () => {},
}));

// jsdom has no layout engine; the palette scrolls its selected row into view.
Element.prototype.scrollIntoView = vi.fn();

const SRC = resolve(__dirname, "..");
const BMAD = /\bBMAD\b|stage board|methodology prompt/i;

afterEach(cleanup);

describe("st_no_bmad_ui: no BMAD in the app", () => {
  beforeEach(() => localStorage.clear());

  it("App renders with no board and no BMAD question, and the board's event and key open nothing", async () => {
    const { default: App } = await import("../App");
    const { container } = render(<App />);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("toggle-board"));
      // ⌘⇧Y opened the stage board.
      fireEvent.keyDown(window, { key: "Y", code: "KeyY", metaKey: true, shiftKey: true });
      fireEvent.keyDown(window, { key: "Y", code: "KeyY", ctrlKey: true, shiftKey: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(container.textContent ?? "").not.toMatch(BMAD);
    expect(document.querySelector("[class*='board-panel'], [class*='stage-board'], .new-tab-ask")).toBeNull();
  });

  it("App has no board, methodology prompt or BMAD switch wired in", () => {
    const app = readFileSync(resolve(SRC, "App.tsx"), "utf8");
    expect(app).not.toMatch(/BoardPanel|MethodologyPrompt|methodologyPrompt|bmadSwitch|toggle-board|SWITCH_DONE/);
  });

  it("the command palette offers no BMAD, board or switch command", async () => {
    const { default: CommandPalette } = await import("../components/CommandPalette");
    render(<CommandPalette onClose={vi.fn()} onToggleScratchpad={vi.fn()} onOpenAgentPicker={vi.fn()} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const palette = document.body.textContent ?? "";
    // Not vacuous: the palette is on screen with its commands.
    expect(palette).toMatch(/New Tab/i);
    expect(palette).not.toMatch(BMAD);
    for (const query of ["bmad", "board", "switch to"]) {
      fireEvent.change(screen.getByPlaceholderText("Type a command..."), { target: { value: query } });
      expect(document.body.textContent ?? "").not.toMatch(/BMAD|Toggle stage board|Switch to v[46]/i);
    }
  });

  it("the new-tab dialog makes no BMAD promise", async () => {
    const { default: NewTabDialog } = await import("../components/NewTabDialog");
    render(<NewTabDialog onClose={vi.fn()} />);
    const dialog = document.body.textContent ?? "";
    expect(dialog).toMatch(/Terminal/);
    expect(dialog).not.toMatch(BMAD);
  });

  it("no settings tab has a BMAD item", async () => {
    const { default: SettingsPanel } = await import("../components/SettingsPanel");
    const { useSettingsStore } = await import("../stores/settingsStore");
    useSettingsStore.getState().setShowSettings(true);
    render(<SettingsPanel />);
    for (const tab of ["theme", "terminal", "workspace", "ai", "sync"] as const) {
      await act(async () => { useSettingsStore.getState().setSettingsTab(tab); });
      expect(document.body.textContent ?? "", `settings tab ${tab}`).not.toMatch(BMAD);
    }
    useSettingsStore.getState().setShowSettings(false);
  });

  it("the shortcut list has no stage board", async () => {
    const { SHORTCUT_GROUPS } = await import("../lib/shortcutList");
    // "Keyboard shortcuts" stays: it is the board as a word that must be gone.
    expect(JSON.stringify(SHORTCUT_GROUPS)).not.toMatch(/\bboard\b/i);
    const { SHORTCUTS } = await import("../lib/shortcuts");
    expect(Object.keys(SHORTCUTS)).not.toContain("board");
  });

  it("the BMAD code is gone from the app", () => {
    for (const gone of [
      "components/board",
      "components/MethodologyPrompt.tsx",
      "components/SwitchConfirm.tsx",
      "lib/bmadRuntime",
      "lib/bmadArtifacts.ts",
      "lib/bmadConfig.ts",
      "lib/bmadGates.ts",
      "lib/bmadStories.ts",
      "lib/bmadSwitch.ts",
      "lib/bmadTicketTree.ts",
      "lib/bmadWorkflow.ts",
      "lib/v6Kinds.ts",
      "lib/v6Map.ts",
      "lib/v6Tickets.ts",
      "lib/methodologyPrompt.ts",
      "data/bmadPhases.ts",
      "stores/boardPanelStore.ts",
      "stores/stageBoardStore.ts",
    ]) {
      expect(existsSync(resolve(SRC, gone)), gone).toBe(false);
    }
  });
});

describe("st_old_settings (BMAD part): an older release's saved state still loads", () => {
  // What v0.24.0 kept in localStorage, BMAD keys included.
  const V0_24_0 = {
    "better-terminal-settings": JSON.stringify({
      themeId: "precision-dark", fontSize: 15, askOnNewTab: true, autoProjectSetup: true, showBanner: true,
    }),
    "ade-bmad-kept": JSON.stringify(["/code/shop"]),
    "ade-bmad-reasked-v4": "1",
    "ade-bmad-dismissed": JSON.stringify(["/code/shop"]),
  };

  beforeEach(() => {
    localStorage.clear();
    for (const [k, v] of Object.entries(V0_24_0)) localStorage.setItem(k, v);
    vi.resetModules();
  });

  it("loads the settings, and the BMAD keys are not persisted or synced any more", async () => {
    const { useSettingsStore } = await import("../stores/settingsStore");
    expect(useSettingsStore.getState().fontSize).toBe(15);
    const { isPersistedKey } = await import("../lib/persistence");
    for (const key of ["ade-bmad-kept", "ade-bmad-reasked-v4", "ade-bmad-dismissed"]) {
      expect(isPersistedKey(key), key).toBe(false);
    }
    const sync = readFileSync(resolve(SRC, "../src-tauri/src/sync.rs"), "utf8");
    expect(sync).not.toMatch(/ade-bmad-/);
  });

  it("App renders over that saved state", async () => {
    const { default: App } = await import("../App");
    expect(() => render(<App />)).not.toThrow();
  });
});
