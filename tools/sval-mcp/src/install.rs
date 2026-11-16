// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The profile Sval's own install starts with, so an agent configured
//! without `--profile` reaches the Sval its shim came with.
//!
//! Sval keeps its data in one directory, `Data` in its application data
//! directory, for every build and every install location
//! (`patches/one-data-directory.patch`). A macOS dev build, which
//! `scripts/run.sh` starts on a profile in its worktree, is the exception: its
//! shim starts on that profile, so it never reaches an installed Sval's data.

use std::io;
use std::path::{Path, PathBuf};

/// The directory Sval keeps its data directory in, as `MOZ_APP_PROFILE`
/// names it (patches/sval-app-vendor.patch): Application Support on macOS,
/// `%APPDATA%` on Windows, and on Linux `~/.sval` where it exists and the
/// XDG config directory's `sval` otherwise: Gecko lowercases the name on
/// Linux only (`nsXREDirProvider::AppendProfilePath`).
pub fn app_data_root() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    if cfg!(target_os = "macos") {
        return Some(home?.join("Library/Application Support/Sval"));
    }
    if cfg!(windows) {
        return std::env::var_os("APPDATA").map(|d| PathBuf::from(d).join("Sval"));
    }
    let legacy = home.as_ref().map(|h| h.join(".sval"));
    if let Some(legacy) = legacy.as_ref().filter(|d| d.is_dir()) {
        return Some(legacy.clone());
    }
    let config = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|d| d.is_absolute())
        .or_else(|| home.map(|h| h.join(".config")))?;
    Some(config.join("sval"))
}

/// The directory Sval starts on when it is given no `--profile`, or for a dev
/// build's shim, the profile `scripts/run.sh` starts that build on.
pub fn default_profile() -> Option<PathBuf> {
    default_profile_beside(&install_dir().ok()?)
}

/// [`default_profile`] for a shim in `dir`.
fn default_profile_beside(dir: &Path) -> Option<PathBuf> {
    if let Some(build) = dev_build_dir(dir) {
        return Some(build.join("dev-profile"));
    }
    Some(app_data_root()?.join("Data"))
}

/// The worktree's `build` directory of the macOS dev build whose bundle holds
/// `dir`, its `Contents/MacOS`, or None for a packaged Sval. A bundle the
/// build assembled names its source tree, the worktree's `build/firefox`, in
/// Info.plist's `MozillaDeveloperRepoPath`, which `mach package` removes
/// (`toolkit/mozapps/installer/packager.py`). `plutil` reads the plist in
/// either of its formats.
pub fn dev_build_dir(dir: &Path) -> Option<PathBuf> {
    if !cfg!(target_os = "macos") {
        return None;
    }
    let contents = dir.parent()?;
    let output = std::process::Command::new("/usr/bin/plutil")
        .args(["-extract", "MozillaDeveloperRepoPath", "raw", "-o", "-"])
        .arg(contents.join("Info.plist"))
        .stderr(std::process::Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let repo = String::from_utf8(output.stdout).ok()?;
    Some(Path::new(repo.trim_end_matches('\n')).parent()?.to_owned())
}

/// This shim's own file with links resolved, so the file an update
/// replaces is the one watched. `std::fs::canonicalize` gives a Windows path the `\\?\` prefix
/// of `GetFinalPathNameByHandleW`, which is taken off.
pub fn shim_path() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    Ok(without_verbatim_prefix(exe))
}

/// The file beside a shim that Sval copied out of its macOS bundle, naming
/// the bundle's `Contents/MacOS` directory it came from. Sval writes both on
/// every start (`SvalAgentClients.sys.mjs`, `installShim`), so AI apps never
/// run a program inside the bundle.
pub const INSTALL_FILE: &str = "sval-mcp.install";

/// The directory that holds the browser binary: the one [`INSTALL_FILE`]
/// beside this shim names, or else the one this shim runs from.
pub fn install_dir() -> io::Result<PathBuf> {
    let dir = shim_path()?
        .parent()
        .map(Path::to_owned)
        .ok_or_else(|| io::Error::other("sval-mcp has no directory"))?;
    install_dir_of(&dir)
}

/// [`install_dir`] for a shim in `dir`.
fn install_dir_of(dir: &Path) -> io::Result<PathBuf> {
    match std::fs::read_to_string(dir.join(INSTALL_FILE)) {
        Ok(named) => Ok(PathBuf::from(named)),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(dir.to_owned()),
        Err(err) => Err(err),
    }
}

/// The one spelling of the profile directory `profile` names, whether or not
/// it exists yet: absolute, its longest existing ancestor with links
/// resolved and the rest appended, without the verbatim prefix. An agent's
/// account is keyed by it and Sval is started on it, so the account a first
/// run saves, before Sval has made the directory, is the one every later
/// run finds.
pub fn profile_spelling(profile: &Path) -> PathBuf {
    let absolute = std::path::absolute(profile).unwrap_or_else(|_| profile.to_owned());
    let mut missing = Vec::new();
    let mut existing = absolute.as_path();
    let resolved = loop {
        if let Ok(resolved) = std::fs::canonicalize(existing) {
            break resolved;
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_owned());
                existing = parent;
            }
            _ => return without_verbatim_prefix(absolute),
        }
    };
    let mut spelling = without_verbatim_prefix(resolved);
    spelling.extend(missing.iter().rev());
    spelling
}

/// `path` without the Windows verbatim prefix, as
/// `WinUtils::ResolveJunctionPointsAndSymLinks` strips it: `\\?\UNC\`
/// becomes `\\`, and a bare `\\?\` goes.
pub(crate) fn without_verbatim_prefix(path: PathBuf) -> PathBuf {
    let Some(text) = path.to_str() else {
        return path;
    };
    if let Some(share) = text.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{share}"));
    }
    match text.strip_prefix(r"\\?\") {
        Some(local) => PathBuf::from(local),
        None => path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_copied_shim_finds_the_install_it_came_from() {
        let temp = crate::test_dir::TempDir::new("install-file");
        let install = temp.0.join("Sval.app/Contents/MacOS");
        let copy = temp.0.join("Application Support/Sval");
        std::fs::create_dir_all(&copy).unwrap();
        assert_eq!(install_dir_of(&copy).unwrap(), copy, "a shim in place");
        std::fs::write(copy.join(INSTALL_FILE), install.to_str().unwrap()).unwrap();
        assert_eq!(install_dir_of(&copy).unwrap(), install);
    }

    #[test]
    fn a_verbatim_windows_path_loses_its_prefix() {
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(r"\\?\C:\Program Files\Sval")),
            Path::new(r"C:\Program Files\Sval")
        );
        assert_eq!(
            without_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\sval")),
            Path::new(r"\\server\share\sval")
        );
        assert_eq!(
            without_verbatim_prefix(PathBuf::from("/usr/lib/sval")),
            Path::new("/usr/lib/sval")
        );
    }

    #[test]
    fn a_profile_is_spelled_the_same_before_and_after_it_exists() {
        let temp = crate::test_dir::TempDir::new("profile-spelling");
        let profile = temp.0.join("Sval").join("Data");
        let before = profile_spelling(&profile);
        std::fs::create_dir_all(&profile).unwrap();
        let after = profile_spelling(&profile);
        assert_eq!(before, after);
        assert_eq!(
            after,
            without_verbatim_prefix(std::fs::canonicalize(&profile).unwrap())
        );
        assert!(after.is_absolute());
        assert!(!after.to_string_lossy().starts_with(r"\\?\"));
        let roundabout = temp.0.join("Sval").join(".").join("Data");
        assert_eq!(profile_spelling(&roundabout), after);
    }

    /// A bundle with the plist keys a build writes, holding `repo` as its
    /// source tree when given one.
    #[cfg(target_os = "macos")]
    fn bundle(temp: &Path, repo: Option<&Path>) -> PathBuf {
        let macos = temp.join("Sval.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let repo = repo.map_or(String::new(), |repo| {
            format!(
                "<key>MozillaDeveloperRepoPath</key><string>{}</string>",
                repo.display()
            )
        });
        std::fs::write(
            macos.parent().unwrap().join("Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.sval.dev</string>
{repo}
</dict></plist>
"#
            ),
        )
        .unwrap();
        macos
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_dev_builds_shim_finds_its_worktrees_build_directory() {
        let temp = crate::test_dir::TempDir::new("dev-build");
        let build = temp.0.join("worktree/build");
        let macos = bundle(&temp.0, Some(&build.join("firefox")));
        assert_eq!(dev_build_dir(&macos), Some(build.clone()));
        assert_eq!(
            default_profile_beside(&macos),
            Some(build.join("dev-profile"))
        );
        let env = crate::launch::dev_env(&macos);
        assert!(env.contains(&("MOZ_APP_DATA".into(), build.join("dev-appdata").into())));
        assert!(env.contains(&("MOZ_CRASHREPORTER_DISABLE".into(), "1".into())));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_packaged_svals_shim_is_no_dev_build() {
        let temp = crate::test_dir::TempDir::new("packaged");
        let macos = bundle(&temp.0, None);
        assert_eq!(dev_build_dir(&macos), None);
        assert_eq!(dev_build_dir(&temp.0.join("bin")), None);
        assert_eq!(
            default_profile_beside(&macos),
            default_profile_beside(&temp.0)
        );
        assert!(crate::launch::dev_env(&macos).is_empty());
    }

    #[test]
    fn a_relative_profile_is_spelled_from_the_working_directory() {
        let cwd = profile_spelling(&std::env::current_dir().unwrap());
        assert_eq!(
            profile_spelling(Path::new("sval-mcp-no-such-profile")),
            cwd.join("sval-mcp-no-such-profile")
        );
    }
}
