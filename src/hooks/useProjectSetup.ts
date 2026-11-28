import { useEffect } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { GuardToast } from "./useContextGuard";
import { STACK_LABELS } from "../lib/projectMethodology";
import {
  addStackAgents, foldersUpTo, isComplete, isSettingUp, isSetupCandidate, setUpProject, setupDeclined, setupRootOf,
  setupStatus, summarize, undoSetup, wasSetUp,
  type SetupFailure, type SetupResult,
} from "../lib/projectSetup";

/** "/code/shop" → "shop", on either separator. */
export const projectName = (root: string) => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

/** Show what a setup wrote, with Undo. */
export function announceSetup(r: SetupResult, show: (t: GuardToast) => void, stackOnly = false) {
  const what = summarize(r.report);
  const failed = r.report.settingsError ? `AI attribution is still on: ${r.report.settingsError}.` : "";
  if (!what && !failed) return;
  const stacks = r.stacks.map((s) => STACK_LABELS[s]).join(", ");
  const added = !what ? "" : stackOnly
    ? `Added ${what} for it. Remove any in Integrations > Agents.`
    : `Added ${what}${stacks ? ` (${stacks} project)` : ""}. Existing files were left as they were.`;
  show({
    title: stackOnly ? `${stacks} detected in ${projectName(r.root)}` : `Set up ${projectName(r.root)}`,
    body: [added, failed].filter(Boolean).join(" "),
    // Undo only what there is to undo: it also marks the project declined.
    ...(what ? { action: { label: "Undo", run: () => { void undoSetup(r); } } } : {}),
  });
}

/** Say why a setup didn't happen. */
export function announceFailure(failed: SetupFailure, show: (t: GuardToast) => void) {
  show({ title: failed.title ?? "Project setup", body: failed.why });
}

/**
 * Every git project a terminal opens in is set up once: the ADE methodology,
 * the core roles and the agents for its stack. On later opens, agents for a
 * stack the project has gained since are added.
 */
export function useProjectSetup(cwd: string | null, show: (t: GuardToast) => void) {
  const enabled = useSettingsStore((s) => s.autoProjectSetup);
  useEffect(() => {
    if (!enabled || !cwd) return;
    let cancelled = false;
    const run = async (root: string) => {
      // Skip projects whose setup the user undid.
      if (!isSetupCandidate(root) || setupDeclined(root)) return;
      // And ones the new-tab dialog is setting up right now. That project can
      // be a folder below `root`: New tab sets up the folder that was picked.
      if (foldersUpTo(cwd, root).some(isSettingUp)) return;
      const status = await setupStatus(root).catch(() => null);
      if (!status || cancelled) return;
      if (wasSetUp(root)) {
        if (!status.stacks.length) return;
        const r = await addStackAgents(root, status.stacks).catch(() => null);
        if (r && !cancelled) announceSetup(r, show, true);
        return;
      }
      if (!status.isGit) return;
      const quiet = isComplete(status);
      // Not asked for, so a failure stays quiet: the next cd tries again.
      const result = await setUpProject(root, status.stacks).catch(() => null);
      if (result && !cancelled && !quiet) announceSetup(result, show);
    };
    (async () => {
      const root = await setupRootOf(cwd);
      if (cancelled) return;
      await run(root);
    })();
    return () => {
      cancelled = true;
    };
  }, [cwd, enabled, show]);
}
