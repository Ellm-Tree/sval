// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The app bundle nmhproxy belongs to, which it opens by path.
//!
//! An app opened by bundle identifier is whichever copy Launch Services
//! picks among those registered under it. The compiled-in identifier is the
//! release's, and a dev build carries another one in its Info.plist, so the
//! identifier can name a different Sval from the one this proxy ships in.

use std::io;
use std::path::{Path, PathBuf};

/// The `.app` directory that holds `exe` at `<app>/Contents/MacOS/<exe>`.
pub fn enclosing_app(exe: &Path) -> Option<PathBuf> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let app = contents.parent()?;
    let named = |dir: &Path, name: &str| dir.file_name().is_some_and(|n| n == name);
    let is_app = app.extension().is_some_and(|e| e == "app");
    (named(macos, "MacOS") && named(contents, "Contents") && is_app).then(|| app.to_owned())
}

/// The bundle this process runs from, with links resolved.
#[cfg(not(test))]
pub fn own_app() -> io::Result<PathBuf> {
    let exe = std::env::current_exe()?;
    let exe = std::fs::canonicalize(&exe).unwrap_or(exe);
    enclosing_app(&exe).ok_or_else(|| io::Error::other("nmhproxy is not inside an app bundle"))
}

/// A test binary is in no bundle, so the command it builds names this one.
#[cfg(test)]
pub fn own_app() -> io::Result<PathBuf> {
    Ok(PathBuf::from("/Applications/Sval.app"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundle_holding_the_proxy_is_found() {
        assert_eq!(
            enclosing_app(Path::new("/w/dist/Sval.app/Contents/MacOS/nmhproxy")),
            Some(PathBuf::from("/w/dist/Sval.app"))
        );
    }

    #[test]
    fn a_proxy_outside_a_bundle_has_none() {
        assert_eq!(enclosing_app(Path::new("/w/dist/bin/nmhproxy")), None);
        assert_eq!(enclosing_app(Path::new("/w/Sval/Contents/MacOS/nmhproxy")), None);
        assert_eq!(enclosing_app(Path::new("nmhproxy")), None);
    }
}
