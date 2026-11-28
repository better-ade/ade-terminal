//! Project setup: every project ADE opens gets the ADE methodology and the
//! role sub-agents. The frontend owns the content (src/lib/projectMethodology.ts);
//! this writes only what's missing, never overwrites, and can undo its own writes.

use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

#[derive(Deserialize, Clone, Debug)]
pub struct SetupFile {
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub is_git: bool,
    /** Methodology files the project doesn't have yet. */
    pub missing: Vec<String>,
    /** CLAUDE.md exists but doesn't load the methodology. */
    pub needs_import: bool,
    /// Detected stacks: "evm", "solana", "go", "rust".
    pub stacks: Vec<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SetupReport {
    /** Absolute paths of every file created. */
    pub created: Vec<String>,
    /** The import block was appended to an existing CLAUDE.md. */
    pub appended_import: bool,
    pub agents: usize,
    /// AI attribution was turned off in `.claude/settings.json` by this setup.
    pub attribution_off: bool,
    /// `.claude/settings.json` couldn't be updated; the rest of setup still ran.
    pub settings_error: Option<String>,
    /// Folders this setup created, outermost first. Only Rust reads it: a
    /// failed setup removes the ones still empty.
    #[serde(skip)]
    pub created_dirs: Vec<PathBuf>,
}

/// A relative path that stays inside the project.
fn inside(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let p = Path::new(rel);
    if rel.is_empty() || p.is_absolute() || p.components().any(|c| !matches!(c, Component::Normal(_))) {
        return Err(format!("Refusing to write outside the project: {rel}"));
    }
    Ok(root.join(p))
}

fn project(root: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(root);
    if !p.is_dir() {
        return Err(format!("{root} isn't a folder."));
    }
    Ok(p)
}

/// Create `path` and any missing parents, recording each level created,
/// outermost first. A folder that holds no file is otherwise unknown to
/// whoever has to take a setup back.
fn mkdirs(path: &Path, created: &mut Vec<PathBuf>) -> Result<(), String> {
    if path.is_dir() {
        return Ok(());
    }
    if path.exists() {
        return Err(format!("{}: exists and is not a folder", path.display()));
    }
    let mut missing = Vec::new();
    let mut at = Some(path);
    while let Some(p) = at {
        if p.as_os_str().is_empty() || p.exists() {
            break;
        }
        missing.push(p.to_path_buf());
        at = p.parent();
    }
    for p in missing.into_iter().rev() {
        match std::fs::create_dir(&p) {
            Ok(()) => created.push(p),
            // Someone else made it first: it isn't this setup's to remove.
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && p.is_dir() => {}
            Err(e) => return Err(format!("{}: {e}", p.display())),
        }
    }
    Ok(())
}

/// Create the file at `dst` and let `write` fill it. The create is the check:
/// `create_new` refuses a destination that exists (a file that appeared since
/// the caller looked, a dangling symlink) without touching it, and that is
/// `Ok(false)`, "kept". `Ok(true)` means written.
///
/// A write that fails partway (a full disk, a lost volume) leaves a file no
/// report names, so nothing would ever take it back: the file this call
/// created is removed here, and only that file. A removal that fails is part
/// of the returned error.
fn write_or_clean(dst: &Path, write: impl FnOnce(&mut std::fs::File) -> std::io::Result<()>) -> std::io::Result<bool> {
    let mut file = match std::fs::OpenOptions::new().write(true).create_new(true).open(dst) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => return Ok(false),
        Err(e) => return Err(e),
    };
    match write(&mut file) {
        Ok(()) => Ok(true),
        Err(e) => {
            drop(file);
            Err(match std::fs::remove_file(dst) {
                Ok(()) => e,
                Err(r) => std::io::Error::new(e.kind(), format!("{e} (and {} could not be removed: {r})", dst.display())),
            })
        }
    }
}

fn has_import(root: &Path, marker: &str) -> bool {
    std::fs::read_to_string(root.join("CLAUDE.md")).map(|s| s.contains(marker) || s.contains("@.ade/rules.md")).unwrap_or(false)
}

fn mentions(path: &Path, needles: &[&str]) -> bool {
    std::fs::read_to_string(path).map(|s| needles.iter().any(|n| s.contains(n))).unwrap_or(false)
}

/// What the project is built with, from its manifest files.
pub fn detect_stacks(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let hardhat = ["hardhat.config.ts", "hardhat.config.js", "hardhat.config.cjs", "hardhat.config.mjs"];
    if dir.join("foundry.toml").is_file() || hardhat.iter().any(|f| dir.join(f).is_file()) {
        out.push("evm".to_string());
    }
    let solana_crates = ["anchor-lang", "solana-program", "solana-sdk", "pinocchio"];
    let solana_program = std::fs::read_dir(dir.join("programs"))
        .map(|rd| rd.flatten().any(|e| mentions(&e.path().join("Cargo.toml"), &solana_crates)))
        .unwrap_or(false);
    if dir.join("Anchor.toml").is_file() || mentions(&dir.join("Cargo.toml"), &solana_crates) || solana_program {
        out.push("solana".to_string());
    }
    if dir.join("go.mod").is_file() {
        out.push("go".to_string());
    }
    if dir.join("Cargo.toml").is_file() || out.iter().any(|s| s == "solana") {
        out.push("rust".to_string());
    }
    out
}

/// Remove one agent from a project's .claude/agents/.
#[tauri::command]
pub fn project_agent_remove(root: String, name: String) -> Result<bool, String> {
    let dir = project(&root)?;
    if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("Not an agent name: {name}"));
    }
    let path = dir.join(".claude").join("agents").join(format!("{name}.md"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn project_setup_status(root: String, paths: Vec<String>, marker: String) -> Result<SetupStatus, String> {
    let dir = project(&root)?;
    let missing = paths
        .into_iter()
        .filter(|rel| inside(&dir, rel).map(|p| !p.exists()).unwrap_or(false))
        .collect();
    Ok(SetupStatus {
        is_git: dir.join(".git").exists(),
        missing,
        needs_import: dir.join("CLAUDE.md").is_file() && !has_import(&dir, &marker),
        stacks: detect_stacks(&dir),
    })
}

/// Write the files the project is missing and load the methodology from an
/// existing CLAUDE.md. Nothing that exists is overwritten.
///
/// The report is the caller's, so what was written before an error is still
/// known and can be taken back.
pub fn apply(
    dir: &Path,
    files: &[SetupFile],
    import: Option<&str>,
    marker: &str,
    report: &mut SetupReport,
) -> Result<(), String> {
    // Decide the import before writing, so a CLAUDE.md we create isn't appended to.
    let append = import.is_some() && dir.join("CLAUDE.md").is_file() && !has_import(dir, marker);
    for f in files {
        let dst = inside(dir, &f.path)?;
        if dst.exists() {
            continue;
        }
        if let Some(parent) = dst.parent() {
            mkdirs(parent, &mut report.created_dirs)?;
        }
        let wrote = write_or_clean(&dst, |to| std::io::Write::write_all(to, f.content.as_bytes()))
            .map_err(|e| format!("{}: {e}", f.path))?;
        if !wrote {
            // Appeared since the check above: the person's, left as it is.
            continue;
        }
        if f.path.starts_with(".claude/agents/") {
            report.agents += 1;
        }
        report.created.push(dst.to_string_lossy().into_owned());
    }
    if append {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().append(true).open(dir.join("CLAUDE.md")).map_err(|e| format!("CLAUDE.md: {e}"))?;
        file.write_all(import.unwrap_or_default().as_bytes()).map_err(|e| format!("CLAUDE.md: {e}"))?;
        report.appended_import = true;
    }
    // A full setup also has agents commit as the user: no AI co-author trailer
    // or "Generated with" line. A broken settings file is reported, not fatal.
    // Last, because nothing after it can fail: a setup that fails has then
    // never edited a settings file the project already had.
    if import.is_some() {
        let settings = dir.join(".claude").join("settings.json");
        let existed = settings.exists();
        let hidden = mkdirs(&dir.join(".claude"), &mut report.created_dirs).and_then(|()| crate::usage::hide_attribution(dir));
        match hidden {
            Ok(changed) => {
                report.attribution_off = changed;
                if changed && !existed {
                    report.created.push(settings.to_string_lossy().into_owned());
                }
            }
            Err(e) => report.settings_error = Some(e),
        }
    }
    Ok(())
}

/// apply(), and on an error take back what it wrote: a failed setup leaves
/// nothing behind.
fn apply_or_clean(
    dir: &Path,
    files: &[SetupFile],
    import: Option<&str>,
    marker: &str,
) -> Result<SetupReport, String> {
    let mut report = SetupReport::default();
    match apply(dir, files, import, marker, &mut report) {
        Ok(()) => Ok(report),
        Err(e) => {
            let failed = take_back(dir, &report, files, import);
            Err(if failed.is_empty() { e } else { format!("{e} (not taken back: {})", failed.join("; ")) })
        }
    }
}

/// Take back what a setup wrote, as its report records it: the files still as
/// setup wrote them, the import it appended, then the folders it created that
/// are empty.
///
/// "Still as setup wrote them" is by content for the files in `files`; for
/// any other it is only "still a file". Returns what it could not undo, each
/// naming its path; a folder that is not empty, or is already gone, is not a
/// failure.
fn take_back(dir: &Path, report: &SetupReport, files: &[SetupFile], import: Option<&str>) -> Vec<String> {
    let mut failed = Vec::new();
    remove_unchanged_noting(dir, &report.created, files, &mut failed);
    if let (true, Some(import)) = (report.appended_import, import) {
        if let Err(e) = strip_import(dir, import) {
            failed.push(format!("CLAUDE.md: {e}"));
        }
    }
    // Innermost first. A folder something else has written into since stays.
    for d in report.created_dirs.iter().rev() {
        if let Err(e) = std::fs::remove_dir(d) {
            if !matches!(e.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty) {
                failed.push(format!("{}: {e}", d.display()));
            }
        }
    }
    failed
}

/// Remove the files in `created` that are still as setup wrote them (by
/// content for `files`; any other, if still a file). Returns the ones
/// removed; anything edited since is left.
fn remove_unchanged(dir: &Path, created: &[String], files: &[SetupFile]) -> Vec<PathBuf> {
    remove_unchanged_noting(dir, created, files, &mut Vec::new())
}

/// remove_unchanged(), noting each removal that failed in `failed`.
fn remove_unchanged_noting(dir: &Path, created: &[String], files: &[SetupFile], failed: &mut Vec<String>) -> Vec<PathBuf> {
    let ours: std::collections::HashMap<PathBuf, &str> =
        files.iter().filter_map(|f| inside(dir, &f.path).ok().map(|p| (p, f.content.as_str()))).collect();
    let mut removed = Vec::new();
    for path in created.iter().map(PathBuf::from) {
        if !path.starts_with(dir) {
            continue;
        }
        let unchanged = match ours.get(&path) {
            Some(content) => std::fs::read_to_string(&path).map(|s| s == *content).unwrap_or(false),
            // Not one of `files` (the settings file): removed only if it's still a file.
            None => path.is_file(),
        };
        if unchanged {
            match std::fs::remove_file(&path) {
                Ok(()) => removed.push(path),
                Err(e) => failed.push(format!("{}: {e}", path.display())),
            }
        }
    }
    removed
}

/// Take the import block setup appended back off the end of CLAUDE.md.
fn strip_import(dir: &Path, import: &str) -> Result<(), String> {
    let claude = dir.join("CLAUDE.md");
    if let Ok(text) = std::fs::read_to_string(&claude) {
        if let Some(stripped) = text.strip_suffix(import) {
            std::fs::write(&claude, stripped).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// One setup at a time: two at once could both see CLAUDE.md without the
/// import and append it twice.
static APPLY: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[tauri::command(async)]
pub fn project_setup_apply(root: String, files: Vec<SetupFile>, import: String, marker: String, full: bool) -> Result<SetupReport, String> {
    let dir = project(&root)?;
    set_up(&dir, &files, &import, &marker, full)
}

/// What `project_setup_apply` runs once it has the project's folder. Every
/// setup comes through here: a full one, and an agent or a stack's agents
/// added on their own.
pub fn set_up(dir: &Path, files: &[SetupFile], import: &str, marker: &str, full: bool) -> Result<SetupReport, String> {
    let _one = APPLY.lock().unwrap_or_else(|e| e.into_inner());
    // A full setup also loads the methodology from CLAUDE.md and turns AI
    // attribution off; adding agents on their own touches nothing else.
    apply_or_clean(dir, files, full.then_some(import), marker)
}

/// Remove what a setup created (files still unchanged since, by content) and
/// the import block it appended. Leaves anything the user has edited.
#[tauri::command(async)]
pub fn project_setup_undo(root: String, created: Vec<String>, files: Vec<SetupFile>, import: Option<String>) -> Result<usize, String> {
    let dir = project(&root)?;
    // As a setup: one at a time.
    let _one = APPLY.lock().unwrap_or_else(|e| e.into_inner());
    let removed = remove_unchanged(&dir, &created, &files);
    for path in &removed {
        // Tidy directories setup created that are now empty.
        let mut parent = path.parent();
        while let Some(p) = parent {
            if p == dir || std::fs::remove_dir(p).is_err() {
                break;
            }
            parent = p.parent();
        }
    }
    if let Some(import) = import {
        strip_import(&dir, &import)?;
    }
    Ok(removed.len())
}

/// `git init` a new project folder (no commit: the first commit is the owner's).
#[tauri::command(async)]
pub fn project_git_init(root: String) -> Result<bool, String> {
    let dir = project(&root)?;
    if dir.join(".git").exists() {
        return Ok(false);
    }
    let out = std::process::Command::new("git").arg("init").arg("-q").current_dir(&dir).output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp() -> PathBuf {
        // A counter, not the clock: the clock's resolution is coarse enough that
        // parallel tests drew the same folder and deleted each other's tree.
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let d = std::env::temp_dir().join(format!(
            "ade-setup-{}-{}",
            std::process::id(),
            N.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn files() -> Vec<SetupFile> {
        vec![
            SetupFile { path: "CLAUDE.md".into(), content: "# new\n@.ade/rules.md\n".into() },
            SetupFile { path: ".ade/rules.md".into(), content: "rules".into() },
            SetupFile { path: ".claude/agents/qa.md".into(), content: "qa".into() },
        ]
    }

    /// files(), then one that can't be written: `blocked` is a file the project
    /// has, where this needs a folder. The setup fails after writing the rest.
    fn files_then_a_failure(dir: &Path) -> Vec<SetupFile> {
        std::fs::write(dir.join("blocked"), "mine").unwrap();
        let mut all = files();
        all.push(SetupFile { path: "blocked/x.md".into(), content: "x".into() });
        all
    }

    /// apply() into a fresh report, as project_setup_apply does, without the cleanup.
    fn run(dir: &Path, files: &[SetupFile], import: Option<&str>, marker: &str) -> Result<SetupReport, String> {
        let mut report = SetupReport::default();
        apply(dir, files, import, marker, &mut report).map(|()| report)
    }

    fn names(d: &Path) -> Vec<String> {
        let mut v: Vec<String> =
            std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn a_failed_setup_leaves_what_the_project_had_alone() {
        let dir = temp();
        std::fs::create_dir_all(dir.join(".claude/agents")).unwrap();
        std::fs::write(dir.join(".claude/agents/mine.md"), "my agent").unwrap();
        std::fs::write(dir.join(".claude/settings.json"), "{\"model\":\"sonnet\"}").unwrap();
        let all = files_then_a_failure(&dir);

        assert!(apply_or_clean(&dir, &all, Some("\nIMPORT\n"), "<!-- m -->").is_err());

        assert_eq!(names(&dir), [".claude", "blocked"]);
        assert_eq!(names(&dir.join(".claude")), ["agents", "settings.json"]);
        assert_eq!(names(&dir.join(".claude/agents")), ["mine.md"], "the role file setup wrote is gone, the folder stays");
        assert_eq!(std::fs::read_to_string(dir.join(".claude/settings.json")).unwrap(), "{\"model\":\"sonnet\"}");
        assert_eq!(std::fs::read_to_string(dir.join("blocked")).unwrap(), "mine");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_half_written_file_is_removed() {
        use std::io::Write;
        let dir = temp();
        let dst = dir.join("half.md");
        let err = write_or_clean(&dst, |f| {
            f.write_all(b"half")?;
            Err(std::io::Error::other("disk full"))
        })
        .unwrap_err();
        assert_eq!(err.to_string(), "disk full");
        assert!(!dst.exists(), "the half-written file is gone");

        // A write that succeeds keeps its file.
        assert!(write_or_clean(&dst, |f| f.write_all(b"whole")).unwrap());
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "whole");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_destination_that_exists_is_kept_and_not_truncated() {
        use std::io::Write;
        let dir = temp();
        let dst = dir.join("mine.md");
        std::fs::write(&dst, "mine").unwrap();
        // The caller never checked: the create itself refuses.
        let wrote = write_or_clean(&dst, |f| {
            f.write_all(b"theirs")?;
            Err(std::io::Error::other("never reached"))
        })
        .unwrap();
        assert!(!wrote);
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "mine");
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_dangling_symlink_at_the_destination_is_left_alone() {
        let dir = temp();
        let dst = dir.join("link.md");
        std::os::unix::fs::symlink(dir.join("missing.md"), &dst).unwrap();
        assert!(!write_or_clean(&dst, |_| Ok(())).unwrap());
        assert!(std::fs::symlink_metadata(&dst).unwrap().file_type().is_symlink());
        assert!(!dir.join("missing.md").exists(), "nothing was written through the link");
        std::fs::remove_dir_all(dir).ok();
    }

    // Unix only: the closure deletes the file while its handle is open, which Windows refuses.
    #[cfg(unix)]
    #[test]
    fn a_failed_removal_is_part_of_the_error() {
        let dir = temp();
        let dst = dir.join("stuck.md");
        // The write fails and leaves a folder where the file was: it can't be removed as a file.
        let err = write_or_clean(&dst, |_| {
            std::fs::remove_file(&dst)?;
            std::fs::create_dir(&dst)?;
            Err(std::io::Error::other("disk full"))
        })
        .unwrap_err();
        assert!(err.to_string().starts_with("disk full"), "{err}");
        assert!(err.to_string().contains("stuck.md"), "{err}");
        std::fs::remove_dir_all(dir).ok();
    }

    /// Source text as the tests below match it. A Windows checkout has `\r\n`
    /// line ends, which a `\n}\n` would never find.
    fn lf(text: &str) -> String {
        text.replace("\r\n", "\n")
    }

    /// Slice a function's source out of a file: from its `fn` line to the next top-level item.
    fn body<'a>(src: &'a str, sig: &str) -> &'a str {
        let at = src.find(sig).unwrap_or_else(|| panic!("{sig} not found"));
        let rest = &src[at..];
        let end = rest.find("\n}\n").unwrap_or(rest.len());
        &rest[..end]
    }

    #[test]
    fn a_function_is_sliced_the_same_from_a_windows_checkout() {
        let unix = include_str!("projectsetup.rs").replace("\r\n", "\n");
        let windows = lf(&unix.replace('\n', "\r\n"));
        let sliced = body(&windows, "fn apply(");
        // Not assert_eq: a failure would print the whole function twice.
        assert!(sliced == body(&unix, "fn apply("), "the slice of a \\r\\n checkout is not the function's own lines");
        assert!(!sliced.contains("fn apply_or_clean("), "the slice ends where the function does");
    }

    #[test]
    fn files_are_only_written_through_write_or_clean() {
        let setup = lf(include_str!("projectsetup.rs"));
        let text = body(&setup, "fn apply(");
        assert!(text.contains("write_or_clean("), "apply must create files through write_or_clean");
        for bare in ["fs::copy(", "fs::write("] {
            assert!(!text.contains(bare), "apply writes with a bare {bare}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn take_back_reports_what_it_could_not_undo() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp();
        let sub = dir.join("sub");
        std::fs::create_dir(&sub).unwrap();
        let stuck = sub.join("a.md");
        std::fs::write(&stuck, "x").unwrap();
        // A folder that can't be written to: its file can't be unlinked.
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o500)).unwrap();
        if std::fs::write(sub.join("probe"), "x").is_ok() {
            eprintln!("skipped: the mode does not bite here (running as root)");
            return;
        }
        let report = SetupReport { created: vec![stuck.to_string_lossy().into_owned()], ..Default::default() };
        let failed = take_back(&dir, &report, &[], None);
        std::fs::set_permissions(&sub, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(failed.len(), 1, "{failed:?}");
        assert!(failed[0].contains("a.md"), "{failed:?}");
        assert!(stuck.exists());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_clean_take_back_reports_nothing() {
        let dir = temp();
        let report = run(&dir, &files(), None, "<!-- m -->").unwrap();
        assert!(take_back(&dir, &report, &files(), None).is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn take_back_removes_what_a_setup_made_and_keeps_what_changed() {
        let dir = temp();
        std::fs::write(dir.join("CLAUDE.md"), "# mine\n").unwrap();
        let report = run(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap();
        assert!(report.appended_import);
        // The person edits one of the files setup wrote: it stays.
        std::fs::write(dir.join(".claude/agents/qa.md"), "edited").unwrap();

        assert!(take_back(&dir, &report, &files(), Some("\nIMPORT\n")).is_empty());

        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "# mine\n", "the import is stripped");
        assert!(!dir.join(".ade").exists(), "an unchanged file and the folder setup made are gone");
        assert_eq!(std::fs::read_to_string(dir.join(".claude/agents/qa.md")).unwrap(), "edited");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn writes_missing_files_and_never_overwrites() {
        let dir = temp();
        std::fs::create_dir_all(dir.join(".claude/agents")).unwrap();
        std::fs::write(dir.join(".claude/agents/qa.md"), "mine").unwrap();
        let r = run(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap();
        assert_eq!(std::fs::read_to_string(dir.join(".claude/agents/qa.md")).unwrap(), "mine");
        assert_eq!(std::fs::read_to_string(dir.join(".ade/rules.md")).unwrap(), "rules");
        // CLAUDE.md, .ade/rules.md and .claude/settings.json.
        assert_eq!(r.created.len(), 3);
        assert!(!r.appended_import, "a CLAUDE.md we created already imports the rules");
        // Running again changes nothing.
        let again = run(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap();
        assert!(again.created.is_empty() && !again.appended_import);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn existing_claude_md_gets_the_import_once_and_undo_restores_it() {
        let dir = temp();
        std::fs::write(dir.join("CLAUDE.md"), "# Mine\n").unwrap();
        let import = "\n<!-- m -->\n@.ade/rules.md\n";
        let r = run(&dir, &files(), Some(import), "<!-- m -->").unwrap();
        assert!(r.appended_import);
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), format!("# Mine\n{import}"));
        let status = project_setup_status(dir.to_string_lossy().into(), vec!["CLAUDE.md".into()], "<!-- m -->".into()).unwrap();
        assert!(!status.needs_import);

        // Edit one created file: undo keeps it.
        std::fs::write(dir.join(".ade/rules.md"), "edited").unwrap();
        let removed = project_setup_undo(dir.to_string_lossy().into(), r.created.clone(), files(), Some(import.into())).unwrap();
        // The agent file and the settings file setup created.
        assert_eq!(removed, 2);
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "# Mine\n");
        assert_eq!(std::fs::read_to_string(dir.join(".ade/rules.md")).unwrap(), "edited");
        assert!(!dir.join(".claude").exists(), "empty folders setup created are removed");
        std::fs::remove_dir_all(dir).ok();
    }

    /// Story ST1: the app ships no BMAD. A full setup writes the methodology
    /// and the agents, installs no BMAD, and leaves the BMAD lines a
    /// CLAUDE.md already has as they are: only the import is added.
    #[test]
    fn a_full_setup_installs_no_bmad_and_leaves_claude_md_bmad_lines_alone() {
        let dir = temp();
        let mine = "# Mine\n\n- **BMAD v4** is how work is done here.\n";
        std::fs::write(dir.join("CLAUDE.md"), mine).unwrap();
        let import = "\n<!-- m -->\n@.ade/rules.md\n";
        let r = set_up(&dir, &files(), import, "<!-- m -->", true).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), format!("{mine}{import}"));
        for bmad in [".bmad-core", "_bmad", "_bmad-output", ".claude/skills", ".ade/methodology"] {
            assert!(!dir.join(bmad).exists(), "{bmad} was installed");
        }
        assert!(r.created.iter().all(|p| !p.contains("bmad")), "{:?}", r.created);
        let json = serde_json::to_value(&r).unwrap();
        for gone in ["bmadFiles", "bmadv6Files", "claudeMd"] {
            assert!(json.get(gone).is_none(), "the report still has {gone}");
        }
        let status = serde_json::to_value(project_setup_status(dir.to_string_lossy().into(), vec![], "<!-- m -->".into()).unwrap()).unwrap();
        for gone in ["bmadInstalled", "methodology"] {
            assert!(status.get(gone).is_none(), "the status still has {gone}");
        }
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn adding_agents_never_touches_claude_md() {
        let dir = temp();
        std::fs::write(dir.join("CLAUDE.md"), "# Mine\n").unwrap();
        let r = set_up(&dir, &files(), "\nIMPORT\n", "<!-- m -->", false).unwrap();
        assert!(!r.appended_import && !r.attribution_off);
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "# Mine\n");
        assert!(dir.join(".claude/agents/qa.md").is_file());
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_claude_md_that_cannot_be_appended_to_is_named_in_the_error() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp();
        let claude = dir.join("CLAUDE.md");
        std::fs::write(&claude, "# Mine\n").unwrap();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o444)).unwrap();
        if std::fs::OpenOptions::new().append(true).open(&claude).is_ok() {
            eprintln!("skipped: the mode does not bite here (running as root)");
            return;
        }
        let err = run(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap_err();
        std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(err.starts_with("CLAUDE.md: "), "{err}");
        assert_eq!(std::fs::read_to_string(&claude).unwrap(), "# Mine\n");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_full_setup_turns_ai_attribution_off_and_agents_alone_do_not() {
        let dir = temp();
        let r = run(&dir, &files(), None, "<!-- m -->").unwrap();
        assert!(!r.attribution_off && !dir.join(".claude/settings.json").exists());
        let r = run(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap();
        assert!(r.attribution_off && r.settings_error.is_none());
        let settings = dir.join(".claude").join("settings.json");
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["attribution"]["commit"], "");
        assert_eq!(v["attribution"]["pr"], "");
        assert_eq!(v["includeCoAuthoredBy"], false);
        // Setup created the file, so Undo removes it with the rest.
        assert!(r.created.contains(&settings.to_string_lossy().into_owned()));
        // A later setup is safe: nothing new to write.
        let again = run(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap();
        assert!(!again.attribution_off && again.created.is_empty());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_malformed_settings_file_is_reported_and_setup_carries_on() {
        let dir = temp();
        std::fs::create_dir_all(dir.join(".claude")).unwrap();
        std::fs::write(dir.join(".claude/settings.json"), "{ not json").unwrap();
        let r = run(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap();
        assert!(!r.attribution_off);
        assert!(r.settings_error.as_deref().unwrap_or_default().contains("not valid JSON"));
        assert_eq!(std::fs::read_to_string(dir.join(".ade/rules.md")).unwrap(), "rules");
        assert_eq!(std::fs::read_to_string(dir.join(".claude/settings.json")).unwrap(), "{ not json");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn detects_stacks_from_manifests() {
        let dir = temp();
        assert!(detect_stacks(&dir).is_empty());
        std::fs::write(dir.join("foundry.toml"), "").unwrap();
        std::fs::write(dir.join("go.mod"), "module x").unwrap();
        std::fs::create_dir_all(dir.join("programs/vault")).unwrap();
        std::fs::write(dir.join("programs/vault/Cargo.toml"), "[dependencies]\nanchor-lang = \"0.30\"").unwrap();
        assert_eq!(detect_stacks(&dir), ["evm", "solana", "go", "rust"]);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn removes_only_agent_files() {
        let dir = temp();
        std::fs::create_dir_all(dir.join(".claude/agents")).unwrap();
        std::fs::write(dir.join(".claude/agents/qa.md"), "x").unwrap();
        let root: String = dir.to_string_lossy().into();
        assert!(project_agent_remove(root.clone(), "qa".into()).unwrap());
        assert!(!project_agent_remove(root.clone(), "qa".into()).unwrap());
        assert!(project_agent_remove(root, "../CLAUDE".into()).is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn refuses_paths_outside_the_project() {
        let dir = temp();
        let bad = vec![SetupFile { path: "../evil".into(), content: "x".into() }];
        assert!(run(&dir, &bad, None, "m").is_err());
        let abs = vec![SetupFile { path: "/tmp/evil".into(), content: "x".into() }];
        assert!(run(&dir, &abs, None, "m").is_err());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn mkdirs_records_each_level_it_creates() {
        let dir = temp();
        std::fs::create_dir_all(dir.join("a")).unwrap();
        let mut made = Vec::new();
        mkdirs(&dir.join("a/b/c"), &mut made).unwrap();
        assert_eq!(made, [dir.join("a/b"), dir.join("a/b/c")]);
        // Again: nothing to create, nothing recorded.
        mkdirs(&dir.join("a/b/c"), &mut made).unwrap();
        assert_eq!(made.len(), 2);
        // A file in the way is an error, not a silent skip.
        std::fs::write(dir.join("a/f"), "x").unwrap();
        assert!(mkdirs(&dir.join("a/f"), &mut made).is_err());
        assert!(mkdirs(&dir.join("a/f/g"), &mut made).is_err());
        assert_eq!(made.len(), 2);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn apply_keeps_its_partial_report_when_a_write_fails() {
        let dir = temp();
        let all = files_then_a_failure(&dir);
        let mut report = SetupReport::default();
        let err = apply(&dir, &all, Some("\nIMPORT\n"), "<!-- m -->", &mut report).unwrap_err();
        assert!(err.contains("blocked"), "{err}");
        assert!(report.created.contains(&dir.join(".ade/rules.md").to_string_lossy().into_owned()), "{:?}", report.created);
        assert!(report.created_dirs.contains(&dir.join(".ade")), "{:?}", report.created_dirs);
        assert!(!dir.join(".claude/settings.json").exists(), "settings are written last, so a failed setup never edits them");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_failed_setup_leaves_nothing_behind() {
        let dir = temp();
        std::fs::write(dir.join("CLAUDE.md"), "# Mine\n").unwrap();
        let import = "\n<!-- m -->\n@.ade/rules.md\n";
        let all = files_then_a_failure(&dir);

        assert!(apply_or_clean(&dir, &all, Some(import), "<!-- m -->").is_err());

        // The files come before the import: a setup that failed never appended it.
        assert_eq!(std::fs::read_to_string(dir.join("CLAUDE.md")).unwrap(), "# Mine\n");
        assert_eq!(names(&dir), ["CLAUDE.md", "blocked"], "created files and the folders made for them are gone");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn a_setup_that_succeeds_keeps_what_it_wrote() {
        let dir = temp();
        let r = apply_or_clean(&dir, &files(), Some("\nIMPORT\n"), "<!-- m -->").unwrap();
        assert!(dir.join(".ade/rules.md").is_file());
        assert!(dir.join(".claude/agents/qa.md").is_file());
        assert!(r.created_dirs.contains(&dir.join(".claude").join("agents")), "{:?}", r.created_dirs);
        std::fs::remove_dir_all(dir).ok();
    }
}
