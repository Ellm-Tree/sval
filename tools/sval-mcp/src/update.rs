// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Re-executing the shim when Sval's update replaces it (sval-mcp-ships-with-sval
//! spec §6).
//!
//! On macOS and Linux an update replaces the file at the shim's path while the
//! running shim keeps its old image. Between requests the shim looks at the
//! file at its path, asks one that has changed for its build, and executes a
//! different build in its own place. `exec` keeps the agent's pipes, and the
//! new process is handed the agent's session (`Resume`), so the agent sees no
//! restart. Windows has no `exec`, so there the shim runs until the agent
//! restarts it.
//!
//! Nothing the agent wrote may be lost across `exec`. The agent's input is
//! read through a `Gate`: the reader reads only while holding it, and the
//! shim executes only while holding it with every line read already handled,
//! so whatever the agent wrote since is still in the pipe for the new process.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

/// The variable that carries a `Resume` to the process executed in place.
pub const RESUME_ENV: &str = "SVAL_MCP_RESUME";

/// The agent's session as the bridge holds it, which the new process takes
/// up. A field a build does not know is ignored, and one it lacks is empty,
/// so any build can take up any other's.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
pub struct Resume {
    pub initialize: Option<Value>,
    pub initialized: bool,
    pub account: Option<String>,
    pub started: u64,
    pub tools: Option<Value>,
    pub listed_without_sval: bool,
    /// Whether the agent has sent a modern request (MCP 2026-07-28), which
    /// opens the session as `initialize` does.
    pub modern: bool,
    /// The client name the account was claimed for.
    pub client: Option<String>,
    /// The ids of the agent's `subscriptions/listen` requests that asked to
    /// hear of tool list changes.
    pub subscriptions: Vec<Value>,
    /// The workspace Sval said the session holds.
    pub workspace: Option<String>,
}

/// The `Resume` this process was executed with, taken out of the environment
/// so nothing this process starts inherits it. Call it before any thread
/// starts, as setting the environment requires.
pub fn take_resume() -> Option<Resume> {
    let text = std::env::var(RESUME_ENV).ok()?;
    std::env::remove_var(RESUME_ENV);
    match serde_json::from_str(&text) {
        Ok(resume) => Some(resume),
        Err(err) => {
            eprintln!("sval-mcp: could not take up the session it was handed: {err}");
            None
        }
    }
}

/// What the agent has written that the bridge has not yet handled.
#[derive(Default)]
pub struct Unread {
    /// Lines sent to the bridge that it has not yet taken.
    pub sent: usize,
    /// The start of a line whose end has not arrived.
    pub partial: Vec<u8>,
    /// Whether the agent has closed its side or the read failed.
    pub ended: bool,
}

/// The lock the agent's input is read under.
#[derive(Default)]
pub struct Gate(pub Mutex<Unread>);

impl Gate {
    fn unread(&self) -> MutexGuard<'_, Unread> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The bridge has taken one line.
    pub fn taken(&self) {
        let mut unread = self.unread();
        unread.sent = unread.sent.saturating_sub(1);
    }

    /// The gate, held, when everything the agent wrote and the reader read
    /// has been handled. The reader reads nothing more while it is held.
    pub fn hold_if_idle(&self) -> Option<MutexGuard<'_, Unread>> {
        let unread = self.unread();
        (unread.sent == 0 && unread.partial.is_empty() && !unread.ended).then_some(unread)
    }
}

/// What tells one file at a path from the next: an update writes a new file,
/// so at least one of these changes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct FileId {
    dev: u64,
    ino: u64,
    mtime: i64,
    mtime_nsec: i64,
    size: u64,
}

pub fn file_id(path: &Path) -> Option<FileId> {
    use std::os::unix::fs::MetadataExt;
    let meta = std::fs::metadata(path).ok()?;
    Some(FileId {
        dev: meta.dev(),
        ino: meta.ino(),
        mtime: meta.mtime(),
        mtime_nsec: meta.mtime_nsec(),
        size: meta.size(),
    })
}

/// How long a replaced file has to say its build.
const VERSION_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// The build the shim at `exe` reports, as `sval-mcp --version` prints it,
/// or `None` when it says none. It fails only when `exe` cannot be started.
pub fn build_of(exe: &Path) -> std::io::Result<Option<String>> {
    let mut child = std::process::Command::new(exe)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()?;
    Ok(answer_of(&mut child))
}

fn answer_of(child: &mut std::process::Child) -> Option<String> {
    use std::io::Read;
    let deadline = std::time::Instant::now() + VERSION_WAIT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let mut text = String::new();
    child.stdout.take()?.read_to_string(&mut text).ok()?;
    let build = text.trim_end().strip_prefix("sval-mcp ")?;
    (status.success() && !build.is_empty()).then(|| build.to_owned())
}

/// The shim's own file, and the one last looked at there.
pub struct SelfUpdate {
    pub exe: PathBuf,
    seen: Option<FileId>,
    pub gate: std::sync::Arc<Gate>,
}

impl SelfUpdate {
    /// Watches the file this process was started from.
    pub fn new(gate: std::sync::Arc<Gate>) -> Option<SelfUpdate> {
        let exe = crate::install::shim_path().ok()?;
        let seen = Some(file_id(&exe)?);
        Some(SelfUpdate { exe, seen, gate })
    }

    /// Whether the file at the shim's path is a build other than `running`.
    /// Each file is asked once: one that cannot say, such as one an update
    /// is still writing, is asked again once it changes. One Linux will not
    /// start because a process holds it open for writing (`ETXTBSY`) is
    /// asked again at the next check whether or not it changes: Mozilla's
    /// updater writes a file in place and closes it after its last write
    /// (`ArchiveReader::ExtractFile`), so the whole new build can be found
    /// still open, and closing it changes nothing [`FileId`] sees.
    pub fn replaced(&mut self, running: &str) -> bool {
        let Some(id) = file_id(&self.exe) else {
            return false;
        };
        if self.seen == Some(id) {
            return false;
        }
        match build_of(&self.exe) {
            Err(err) if err.raw_os_error() == Some(libc::ETXTBSY) => false,
            answer => {
                self.seen = Some(id);
                answer.ok().flatten().is_some_and(|build| build != running)
            }
        }
    }

    /// Watches `exe`, as yet unasked, for a test.
    #[cfg(test)]
    pub(crate) fn watching(exe: PathBuf) -> SelfUpdate {
        SelfUpdate {
            exe,
            seen: None,
            gate: Default::default(),
        }
    }

    /// Has the next `replaced` ask the file at the shim's path again, though
    /// it has not changed, for an update put off after it was found.
    pub fn retry(&mut self) {
        self.seen = None;
    }

    /// Executes the file at the shim's path in this process's place, with its
    /// arguments, handing it `resume`. It returns only if that fails.
    pub fn exec(&self, resume: &Resume) -> std::io::Error {
        use std::os::unix::process::CommandExt;
        let text = match serde_json::to_string(resume) {
            Ok(text) => text,
            Err(err) => return std::io::Error::other(err),
        };
        std::process::Command::new(&self.exe)
            .args(std::env::args_os().skip(1))
            .env(RESUME_ENV, text)
            .exec()
    }
}

/// Reads the agent's lines from standard input under `gate`, sending each to
/// `line`, then `ended` once the agent closes its side. It waits for input
/// without the gate and reads only once there is some, so the gate is never
/// held across a wait.
pub fn read_stdin(
    gate: &Gate,
    line: impl Fn(std::io::Result<String>) -> bool,
    ended: impl FnOnce(),
) {
    let mut buf = [0u8; 8192];
    loop {
        let mut fd = libc::pollfd {
            fd: libc::STDIN_FILENO,
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: `fd` is one valid `pollfd` that outlives the call.
        if unsafe { libc::poll(&mut fd, 1, -1) } < 0 {
            let err = std::io::Error::last_os_error();
            if err.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            gate.unread().ended = true;
            line(Err(err));
            return;
        }
        let mut unread = gate.unread();
        // SAFETY: `buf` is writable for its whole length during the call.
        let n = unsafe { libc::read(libc::STDIN_FILENO, buf.as_mut_ptr().cast(), buf.len()) };
        let Ok(n) = usize::try_from(n) else {
            let err = std::io::Error::last_os_error();
            if matches!(
                err.kind(),
                std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
            ) {
                continue;
            }
            unread.ended = true;
            drop(unread);
            line(Err(err));
            return;
        };
        if n == 0 {
            // As `BufRead::lines` does, a last line with no newline is a line.
            let last = std::mem::take(&mut unread.partial);
            unread.ended = true;
            drop(unread);
            if !last.is_empty() && !line(text_of(last)) {
                return;
            }
            ended();
            return;
        }
        unread.partial.extend_from_slice(&buf[..n]);
        while let Some(end) = unread.partial.iter().position(|&b| b == b'\n') {
            let mut whole: Vec<u8> = unread.partial.drain(..=end).collect();
            whole.pop();
            if whole.last() == Some(&b'\r') {
                whole.pop();
            }
            let text = text_of(whole);
            let failed = text.is_err();
            unread.sent += 1;
            if !line(text) || failed {
                unread.ended = true;
                return;
            }
        }
    }
}

fn text_of(bytes: Vec<u8>) -> std::io::Result<String> {
    String::from_utf8(bytes)
        .map_err(|err| std::io::Error::new(std::io::ErrorKind::InvalidData, err))
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::test_dir::{write_executable, TempDir};

    /// Mozilla's updater writes a file in place and closes it once its last
    /// write is in (`ArchiveReader::ExtractFile`), so the shim can find the
    /// new build whole and still open for writing, which Linux will not
    /// execute. A child process holds it open, as the updater would.
    #[test]
    fn a_new_build_still_open_for_writing_is_asked_again_once_closed() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let temp = TempDir::new("busy-update");
        let exe = temp.0.join("sval-mcp");
        write_executable(&exe, "#!/bin/sh\necho 'sval-mcp old'\n");
        let mut update = SelfUpdate {
            seen: file_id(&exe),
            exe: exe.clone(),
            gate: Default::default(),
        };
        // Linux stamps a write with a clock that ticks every few milliseconds,
        // so a file rewritten in place within one tick keeps its mtime. The
        // new build differs in size, so the check sees the file change.
        write_executable(&exe, "#!/bin/sh\necho 'sval-mcp newer'\n");
        let mut writer = Command::new("python3")
            .arg("-c")
            .arg("import sys;f=open(sys.argv[1],'ab');print('held',flush=True);sys.stdin.read()")
            .arg(&exe)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("python3 runs");
        let mut line = String::new();
        BufReader::new(writer.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "held");
        let id = file_id(&exe);
        assert!(
            !update.replaced("old"),
            "a file open for writing cannot say"
        );
        drop(writer.stdin.take());
        writer.wait().unwrap();
        assert_eq!(file_id(&exe), id, "closing it changes nothing a check sees");
        assert!(update.replaced("old"), "once closed it is asked again");
        assert!(!update.replaced("old"), "and asked once");
    }
}
