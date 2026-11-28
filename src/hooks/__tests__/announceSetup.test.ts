import { describe, it, expect, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { announceSetup } from "../useProjectSetup";
import type { SetupResult } from "../../lib/projectSetup";
import { CLAUDE_MD_IMPORT } from "../../lib/projectMethodology";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => 0) }));

const result = (report: Partial<SetupResult["report"]>): SetupResult => ({
  root: "/code/app",
  report: { created: [], appendedImport: false, agents: 0, ...report },
  files: [],
  stacks: [],
});

describe("announceSetup", () => {
  it("says when the settings file couldn't be updated, even if nothing else was written", () => {
    const show = vi.fn();
    announceSetup(result({ settingsError: "/code/app/.claude/settings.json is not valid JSON; fix it first" }), show);
    expect(show).toHaveBeenCalledOnce();
    expect(show.mock.calls[0][0].body).toMatch(/AI attribution is still on: .*not valid JSON/);
    expect(show.mock.calls[0][0].action, "nothing was written, so there is nothing to undo").toBeUndefined();
  });

  it("says what was added, and Undo removes it", () => {
    const show = vi.fn();
    announceSetup(result({ agents: 8, created: new Array(8).fill("x"), appendedImport: true }), show);
    expect(show).toHaveBeenCalledOnce();
    const toast = show.mock.calls[0][0];
    expect(toast.title).toBe("Set up app");
    expect(toast.body).toBe("Added 8 agents and a line in CLAUDE.md. Existing files were left as they were.");
    expect(toast.action.label).toBe("Undo");
    toast.action.run();
    expect(invoke).toHaveBeenCalledWith("project_setup_undo", {
      root: "/code/app", created: new Array(8).fill("x"), files: [], import: CLAUDE_MD_IMPORT,
    });
  });

  it("stays quiet when a setup wrote nothing and nothing failed", () => {
    const show = vi.fn();
    announceSetup(result({}), show);
    expect(show).not.toHaveBeenCalled();
  });
});
