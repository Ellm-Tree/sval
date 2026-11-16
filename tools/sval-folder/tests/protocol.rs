// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The helper as the browser runs it: the program, over its stdin and stdout.
//! The handshake, a request's answer, the end of stdin, and a request that
//! hangs.

use serde_json::{json, Value};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};
use sval_folder::frame::{read_frame, write_frame, MAX_FRAME_BYTES};
#[cfg(unix)]
use sval_folder::serve::EXIT_HARD;
use sval_folder::serve::{EXIT_CLOSED, EXIT_PIPE, EXIT_USAGE, HELLO};

/// A fresh directory in the temporary directory, removed when the test ends.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        let dir =
            std::env::temp_dir().join(format!("sval-folder-it-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("shared")).unwrap();
        std::fs::create_dir_all(dir.join("requests")).unwrap();
        TempDir(dir)
    }

    fn shared(&self) -> PathBuf {
        self.0.join("shared")
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Helper {
    child: Child,
    stdin: Option<ChildStdin>,
    stdout: ChildStdout,
}

impl Helper {
    fn start(dir: &TempDir) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_sval-folder"))
            .arg(dir.0.join("requests"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = child.stdout.take().unwrap();
        Helper {
            child,
            stdin,
            stdout,
        }
    }

    fn send(&mut self, frame: &Value) {
        write_frame(self.stdin.as_mut().unwrap(), frame).unwrap();
    }

    fn receive(&mut self) -> Value {
        read_frame(&mut self.stdout).unwrap().expect("a frame")
    }

    /// Exchanges `hello`, with `exitAfterMs` when given.
    fn handshake(&mut self, exit_after_ms: Option<u64>) -> Value {
        self.send(&json!({ "hello": HELLO, "build": "test", "exitAfterMs": exit_after_ms }));
        self.receive()
    }

    fn close_stdin(&mut self) {
        self.stdin = None;
    }

    /// The helper's exit code once it exits, failing the test if it has not
    /// by `within`.
    fn exit_within(&mut self, within: Duration) -> i32 {
        let deadline = Instant::now() + within;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status.code().expect("the helper exited with a code");
            }
            assert!(
                Instant::now() < deadline,
                "the helper did not exit within {within:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn a_helper_says_hello_answers_and_exits_when_stdin_closes() {
    let dir = TempDir::new("hello");
    std::fs::create_dir_all(dir.shared().join("sval")).unwrap();
    let mut helper = Helper::start(&dir);
    let hello = helper.handshake(None);
    assert_eq!(hello["hello"], HELLO, "it speaks this protocol");
    assert!(hello["build"].is_string(), "and names its build");

    for (id, path, exists) in [("a-1", "sval", true), ("a-2", "nothing", false)] {
        helper.send(&json!({
            "id": id, "op": "exists", "root": dir.shared(), "path": path, "requireTop": null
        }));
        assert_eq!(
            helper.receive(),
            json!({ "id": id, "reachable": true, "exists": exists })
        );
    }

    helper.close_stdin();
    assert_eq!(helper.exit_within(Duration::from_secs(10)), EXIT_CLOSED);
}

#[test]
fn a_helper_whose_stdin_closes_before_the_handshake_exits() {
    let dir = TempDir::new("early-close");
    let mut helper = Helper::start(&dir);
    helper.close_stdin();
    assert_eq!(helper.exit_within(Duration::from_secs(10)), EXIT_CLOSED);
}

#[test]
fn a_first_frame_that_is_not_a_hello_ends_the_helper() {
    let dir = TempDir::new("no-hello");
    let mut helper = Helper::start(&dir);
    helper.send(&json!({ "id": "a", "op": "exists", "root": dir.shared(), "path": "sval", "requireTop": null }));
    assert_eq!(helper.exit_within(Duration::from_secs(10)), EXIT_USAGE);
}

#[test]
fn a_frame_over_the_limit_ends_the_helper() {
    let dir = TempDir::new("big-frame");
    let mut helper = Helper::start(&dir);
    helper.handshake(None);
    let stdin = helper.stdin.as_mut().unwrap();
    stdin
        .write_all(&((MAX_FRAME_BYTES as u32) + 1).to_be_bytes())
        .unwrap();
    stdin.flush().unwrap();
    assert_eq!(helper.exit_within(Duration::from_secs(10)), EXIT_PIPE);
}

#[test]
fn the_helper_names_its_build_and_refuses_a_bad_command_line() {
    let out = Command::new(env!("CARGO_BIN_EXE_sval-folder"))
        .arg("--version")
        .output()
        .unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8(out.stdout)
        .unwrap()
        .starts_with("sval-folder "));
    for args in [&[][..], &["relative/dir"][..], &["/a", "/b"][..]] {
        let status = Command::new(env!("CARGO_BIN_EXE_sval-folder"))
            .args(args)
            .stderr(Stdio::null())
            .status()
            .unwrap();
        assert_eq!(status.code(), Some(EXIT_USAGE), "{args:?} is refused");
    }
}

/// A write whose payload, in the request directory, is a FIFO nobody writes:
/// reading it blocks, as a read on a hung mount does. The helper never opens
/// a FIFO in the shared folder, so the hang is built where the browser alone
/// writes. Returns the request and the FIFO's path.
#[cfg(unix)]
fn hanging_request(dir: &TempDir) -> (Value, PathBuf) {
    let path = dir.0.join("requests/payload-hang-0.bin");
    let fifo = std::ffi::CString::new(path.to_str().unwrap()).unwrap();
    // SAFETY: a NUL-terminated path.
    assert_eq!(
        unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) },
        0,
        "mkfifo made the FIFO"
    );
    let request = json!({
        "id": "hang", "op": "write", "root": dir.shared(), "path": "sval/me.json",
        "payloads": ["payload-hang-0.bin"], "requireTop": null
    });
    (request, path)
}

#[cfg(unix)]
#[test]
fn a_request_that_hangs_past_its_limit_ends_the_helper() {
    let dir = TempDir::new("hang");
    let (request, _) = hanging_request(&dir);
    let mut helper = Helper::start(&dir);
    helper.handshake(Some(300));
    let started = Instant::now();
    helper.send(&request);
    assert_eq!(helper.exit_within(Duration::from_secs(10)), EXIT_HARD);
    assert!(
        started.elapsed() >= Duration::from_millis(300),
        "not before its limit"
    );
}

#[cfg(unix)]
#[test]
fn a_helper_stuck_in_a_request_exits_when_stdin_closes() {
    let dir = TempDir::new("hang-close");
    let (request, fifo) = hanging_request(&dir);
    let mut helper = Helper::start(&dir);
    helper.handshake(None);
    helper.send(&request);
    // A writer can open a FIFO without blocking only once a reader has it
    // open, so this waits for the helper to be inside the request. Held
    // open and never written, it leaves the helper blocked in its read.
    let deadline = Instant::now() + Duration::from_secs(10);
    let _writer = loop {
        use std::os::unix::fs::OpenOptionsExt;
        match std::fs::OpenOptions::new()
            .write(true)
            .custom_flags(libc::O_NONBLOCK)
            .open(&fifo)
        {
            Ok(writer) => break writer,
            Err(err) => assert_eq!(err.raw_os_error(), Some(libc::ENXIO), "no reader yet"),
        }
        assert!(
            Instant::now() < deadline,
            "the helper never opened the FIFO"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    assert!(
        helper.child.try_wait().unwrap().is_none(),
        "the helper is still in the request"
    );
    helper.close_stdin();
    assert_eq!(
        helper.exit_within(Duration::from_secs(5)),
        EXIT_CLOSED,
        "it exits on the end of stdin, long before its own limit"
    );
}
