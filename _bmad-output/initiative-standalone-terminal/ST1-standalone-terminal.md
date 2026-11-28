# ST1: ADE Terminal becomes a standalone terminal

Status: **Approved** (owner, 2026-11-28: "Approve as drafted"). Owner's words (2026-11-28): "for ade-terminal, let's remove the bmad
features to it since it will be forced by the ade", "so ade-terminal will be a standalone terminal", then scope "BMAD
and method layer".
Risk: **medium** (removal across the app; no secret, sign-in, data or money changes. The vault stays as it is). A
builder may raise it, never lower it.
Verification: the command in `docs/architecture.md`, "Verification command / In force" (all lines, each exit 0).

## The idea
How the work is done (BMAD, the roles, the team of agents, project setup) now belongs to **ade** and the hub, which
applies it the same way in any terminal. ADE Terminal stops shipping its own copy of the method and becomes a fast
terminal for running agents: tabs, panes, the editor, the browser and the views that watch agents work. A project
opened in it is left as it is: the app writes no method files into it.

## What goes
- **BMAD:** the board (`components/board/`, `BoardView`, `V6MapView`), the methodology prompt, the BMAD switch and its
  confirm dialog, the BMAD parts of settings, the command palette and the new-tab dialog; `lib/bmad*`, `lib/bmadRuntime/`,
  `lib/v6*`, `lib/projectMethodology`, `lib/methodologyPrompt`, `data/bmadPhases`; the Rust modules `bmad`, `bmadconfig`,
  `bmadswitch`, `bmadv6` and their commands, fixtures and e2e tests; the bundled `resources/bmad/`, `resources/bmad-v6/`
  and `ade-runtime.mjs` (about 4.7 MB off the installer).
- **The method layer:** the agent profiles and roles from ade-method (`data/curatedAgents`, `data/roles`, the profile
  side of `AgentPicker`, `lib/agentComposition`, `lib/agentSpec`, `~/.ade/roles/` writing, `resources/personas/`, the
  profile agents and skills in `claude-plugin/`, `scripts/syncAgents.mjs`); the orchestrator tab and its store;
  project setup (`projectsetup.rs`, `useProjectSetup`, `lib/projectSetup`).
- Their settings keys are ignored on load, so an existing user's saved settings still open cleanly.

## What stays
Tabs, split panes and sub-terminals; launching Claude Code, Codex or any CLI in a tab (a plain choice of CLI, no
profile); the editor, file browser, preview and viewers; the browser tab; the fleet view and its costs; tokens,
recording, the scratchpad, anti-slop and contracts panels; the vault; MCP and integrations; the phone remote and relay;
the blockchain tooling. The repo's own dev method (`_bmad/`, `_bmad-output/`, `.claude/skills/`, `.ade/`) stays: it is
how this repo is built, not what the app ships. Where a file serves both sides (for example `claude-plugin/` holds the
anti-slop hook as well as profiles), only the method part goes.

## Slices (one PR each, in order)
1. **No BMAD**: everything under "BMAD" above.
2. **No method layer**: everything under "The method layer" above.
3. **The words**: README, the in-app tour and help, and `docs/` describe a standalone terminal ("ade brings the method;
   open your hub in any terminal, this one included"); the "47 agent profiles", "methodology" and "project setup" claims
   go. The website's copy about the app is a separate ade-website story.

## Acceptance criteria (each named by its test)
1. **st_no_bmad_ui**: no BMAD board, methodology prompt, switch or BMAD item in settings, the palette or the new-tab
   dialog (a vitest that renders App and each of them).
2. **st_no_bmad_bundle**: `tauri.conf.json` bundles no `bmad`, `bmad-v6`, `ade-runtime.mjs` or `personas` resource, and
   those folders are gone (a script test).
3. **st_no_bmad_rust**: no BMAD or project-setup command is registered in `lib.rs` (a Rust test over the handler list).
4. **st_no_profiles**: the agent picker offers CLIs only; no profile, role or orchestrator is reachable (vitest).
5. **st_untouched_project**: opening a project folder writes nothing into it (a Rust or vitest test on a temp folder,
   comparing the file list before and after).
6. **st_old_settings**: settings saved by the last release, with BMAD, profile and orchestrator keys, load without error
   and the dropped keys are ignored (vitest, a fixture from v0.24.0).
7. **st_still_terminal**: a tab opens a shell, splits, and launches a CLI agent (the existing terminal_open e2e and
   tab tests, still green).
8. **st_words**: README and the tour make no "methodology", "BMAD", "agent profiles" or "project setup" claim, and say
   ade brings the method (a script test).

## Out of scope
Changes to ade, the hub or ade-method; the website (its own story); new terminal features; the repo's own dev method.
