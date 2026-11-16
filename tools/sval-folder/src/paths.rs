// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! What a request may name: a root the user chose, and paths below it.

use std::path::{Path, PathBuf};

/// Whether `relative` is a `/`-separated path that stays below the directory
/// it is joined to: no empty, `.` or `..` segment, no backslash, colon or NUL,
/// and not absolute on any platform (no leading `/`, and no drive letter,
/// which the colon rule already refuses). A string check, the same on every
/// platform, so a path a request carries means one thing wherever it runs.
pub fn is_contained(relative: &str) -> bool {
    !relative.is_empty()
        && !relative.contains(['\\', ':', '\0'])
        && !relative.starts_with('/')
        && relative
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

/// Whether `root` can be the shared folder: an absolute native path with no
/// NUL. On Windows a `/` in it is refused: the browser passes the path the
/// folder picker returned, which is backslash-separated.
pub fn is_root(root: &str) -> bool {
    !root.is_empty()
        && !root.contains('\0')
        && !(cfg!(windows) && root.contains('/'))
        && Path::new(root).is_absolute()
}

/// `root` with each of `parts` joined on, one segment at a time.
pub fn join(root: &Path, parts: &[&str]) -> PathBuf {
    let mut at = root.to_path_buf();
    for part in parts {
        at.push(part);
    }
    at
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_relative_path_is_judged_as_a_string() {
        for path in ["sval", "sval/ws/abc/me.json", "sval/pair/0a1b.json"] {
            assert!(is_contained(path), "{path:?} is contained");
        }
        for path in [
            "",
            "/sval/me.json",
            "//server/share/me.json",
            "\\\\server\\share\\me.json",
            "C:/Users/me.json",
            "C:me.json",
            "c:\\Users\\me.json",
            "sval/a:b.json",
            "sval\\me.json",
            "sval/me\0.json",
            "sval//me.json",
            "sval/./me.json",
            "sval/../me.json",
            "../me.json",
            "sval/",
        ] {
            assert!(!is_contained(path), "{path:?} is refused");
        }
    }

    #[test]
    fn a_root_is_an_absolute_native_path() {
        assert!(!is_root(""));
        assert!(!is_root("relative/dir"));
        if cfg!(windows) {
            assert!(is_root("C:\\Users\\me\\Shared"));
            assert!(is_root("\\\\server\\share"));
            assert!(!is_root("C:/Users/me"), "a slash is refused");
        } else {
            assert!(is_root("/Volumes/share"));
            assert!(!is_root("/Volumes/sh\0are"));
        }
    }
}
