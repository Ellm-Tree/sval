// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! A directory for one unit test, and the programs a test runs from it.

use std::path::PathBuf;

/// A fresh directory in the temporary directory, removed when the test that
/// made it ends, whether it passes or panics.
pub(crate) struct TempDir(pub(crate) PathBuf);

impl TempDir {
    pub(crate) fn new(name: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("sval-mcp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Writes `contents` to `path` as an executable a test then starts.
///
/// A child `sh` writes the file, so this process never holds a writable
/// descriptor on it. If it did, a process another test thread forks
/// meanwhile would inherit that descriptor until it execs, and Linux refuses
/// to execute a file open for writing (`ETXTBSY`, rust-lang/rust#114554).
/// Writing another name and renaming it into place does not help: the
/// inherited descriptor holds the same inode.
#[cfg(unix)]
pub(crate) fn write_executable(path: &std::path::Path, contents: &str) {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut sh = Command::new("sh")
        .arg("-c")
        .arg(r#"cat > "$1" && chmod 755 "$1""#)
        .arg("sh")
        .arg(path)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    sh.stdin
        .take()
        .unwrap()
        .write_all(contents.as_bytes())
        .unwrap();
    assert!(sh.wait().unwrap().success(), "sh wrote {}", path.display());
}
