// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The helper's life: the handshake, then one request at a time from stdin,
//! each answered on stdout, until stdin closes.
//!
//! A request can hang in the kernel on a network mount that has gone away,
//! and nothing in this process can interrupt it. Two threads end the process
//! from outside the stuck one: the stdin reader exits as soon as the browser
//! closes its end, whatever the main thread is doing, and the watchdog exits
//! when one request runs past its limit. Both use `exit_now`, which runs no
//! more of this program's code, so no late copy lands in a request directory
//! the next helper has emptied.

use crate::frame::{encode_frame, read_frame, TooLarge};
use crate::ops::{unreachable, Folder};
use serde_json::{json, Value};
use std::io::{self, Write};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

/// The protocol this helper speaks, the handshake's `hello`. The browser
/// accepts a helper that speaks its own version or the one before, whatever
/// its build, so the version moves only for a change an older helper cannot
/// speak, on both sides at once.
pub const HELLO: u64 = 2;

/// The build of Sval this helper was packaged with. The packaged build sets
/// `SVAL_BUILD_ID` to Sval's build id, and any other build reports the crate
/// version. The browser logs it and never matches it: `HELLO` decides whether
/// the two can talk.
pub const BUILD: &str = match option_env!("SVAL_BUILD_ID") {
    Some(build) => build,
    None => concat!(env!("CARGO_PKG_VERSION"), "-dev"),
};

/// How long one request may run before the helper ends itself. Just past the
/// browser's 20 s deadline, so no answer anyone still wants is cut short. It
/// covers a browser that is alive but has stopped killing helpers, such as
/// one whose main thread has hung. A read the kernel will not interrupt, on a
/// hard NFS mount, holds the process past even this; no exit can end it.
pub const HARD_EXIT_MS: u64 = 21_000;

/// What a helper exits with once its stdin has closed.
pub const EXIT_CLOSED: i32 = 0;
/// What a helper exits with when its command line, or the browser's first
/// frame, is not one it can work with.
pub const EXIT_USAGE: i32 = 2;
/// What a helper exits with when a frame from the browser does not parse, or
/// it cannot write to stdout.
pub const EXIT_PIPE: i32 = 3;
/// What a helper that ended itself during a request exits with.
pub const EXIT_HARD: i32 = 6;

/// Ends this process at once, running no more of its code: no destructor, no
/// buffered output, no thread waited for.
pub fn exit_now(code: i32) -> ! {
    #[cfg(unix)]
    // SAFETY: `_exit` takes any status and does not return.
    unsafe {
        libc::_exit(code)
    }
    #[cfg(windows)]
    // SAFETY: the pseudo-handle of this process, which needs no closing.
    unsafe {
        use windows_sys::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
        TerminateProcess(GetCurrentProcess(), code as u32);
        unreachable!("TerminateProcess on this process returns only on failure")
    }
}

/// The watchdog: ends the process when the request it is armed for passes
/// its deadline.
struct Watchdog {
    deadline: Mutex<Option<Instant>>,
    changed: Condvar,
}

impl Watchdog {
    fn start() -> Arc<Self> {
        let dog = Arc::new(Watchdog {
            deadline: Mutex::new(None),
            changed: Condvar::new(),
        });
        let watching = Arc::clone(&dog);
        std::thread::spawn(move || {
            let mut deadline = watching.deadline.lock().unwrap();
            loop {
                deadline = match *deadline {
                    None => watching.changed.wait(deadline).unwrap(),
                    Some(at) => {
                        let now = Instant::now();
                        if now >= at {
                            exit_now(EXIT_HARD);
                        }
                        watching.changed.wait_timeout(deadline, at - now).unwrap().0
                    }
                };
            }
        });
        dog
    }

    fn arm(&self, limit: Duration) {
        *self.deadline.lock().unwrap() = Some(Instant::now() + limit);
        self.changed.notify_one();
    }

    fn disarm(&self) {
        *self.deadline.lock().unwrap() = None;
        self.changed.notify_one();
    }
}

/// How long each request may run, from the browser's `hello`: its
/// `exitAfterMs`, which a test shortens, but never past `HARD_EXIT_MS`.
pub fn request_limit(hello: &Value) -> Duration {
    let ms = hello["exitAfterMs"]
        .as_f64()
        .filter(|ms| ms.is_finite() && *ms > 0.0)
        .map_or(HARD_EXIT_MS, |ms| (ms as u64).clamp(1, HARD_EXIT_MS));
    Duration::from_millis(ms)
}

/// Whether `frame` is a browser's `hello`.
pub fn is_hello(frame: &Value) -> bool {
    frame["hello"].as_u64().is_some_and(|version| version >= 1)
}

/// `answer` as a frame. An answer over the frame limit, which only a folder
/// holding a great many long names can cause, answers "too-large" in its
/// place.
pub fn answer_frame(answer: &Value) -> Vec<u8> {
    encode_frame(answer).unwrap_or_else(|TooLarge| {
        let mut refused = unreachable("too-large", Some("ResponseTooLarge"));
        refused["id"] = answer["id"].clone();
        encode_frame(&refused).expect("a refusal is small")
    })
}

fn send(out: &mut impl Write, frame: &[u8]) {
    if out.write_all(frame).and_then(|()| out.flush()).is_err() {
        exit_now(EXIT_PIPE);
    }
}

/// Serves the browser on stdin and stdout until stdin closes, against the
/// request directory `request_dir`. Returns only a failed handshake's code:
/// every other end is `exit_now`.
pub fn run(request_dir: PathBuf) -> i32 {
    let (frames, received) = mpsc::sync_channel::<Value>(1);
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        loop {
            match read_frame(&mut stdin) {
                Ok(Some(frame)) => {
                    if frames.send(frame).is_err() {
                        return;
                    }
                }
                Ok(None) => exit_now(EXIT_CLOSED),
                Err(_) => exit_now(EXIT_PIPE),
            }
        }
    });

    let Ok(hello) = received.recv() else {
        return EXIT_USAGE;
    };
    if !is_hello(&hello) {
        return EXIT_USAGE;
    }
    let limit = request_limit(&hello);
    let mut out = io::stdout().lock();
    send(
        &mut out,
        &encode_frame(&json!({ "hello": HELLO, "build": BUILD })).expect("a hello is small"),
    );

    let folder = Folder::new(request_dir);
    let watchdog = Watchdog::start();
    for request in received {
        watchdog.arm(limit);
        let answer = folder.answer(&request);
        send(&mut out, &answer_frame(&answer));
        watchdog.disarm();
    }
    EXIT_CLOSED
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::MAX_FRAME_BYTES;

    #[test]
    fn a_test_shortens_the_request_limit_and_never_lengthens_it() {
        let limit = |hello: Value| request_limit(&hello).as_millis();
        assert_eq!(limit(json!({ "hello": 1 })), HARD_EXIT_MS as u128);
        assert_eq!(
            limit(json!({ "hello": 1, "exitAfterMs": null })),
            HARD_EXIT_MS as u128
        );
        assert_eq!(limit(json!({ "hello": 1, "exitAfterMs": 500 })), 500);
        assert_eq!(
            limit(json!({ "hello": 1, "exitAfterMs": 99_000 })),
            HARD_EXIT_MS as u128
        );
        assert_eq!(
            limit(json!({ "hello": 1, "exitAfterMs": -5 })),
            HARD_EXIT_MS as u128
        );
        assert_eq!(
            limit(json!({ "hello": 1, "exitAfterMs": "5" })),
            HARD_EXIT_MS as u128
        );
    }

    #[test]
    fn a_hello_names_a_version() {
        assert!(is_hello(&json!({ "hello": 1, "build": "x" })));
        assert!(is_hello(&json!({ "hello": 7 })));
        assert!(!is_hello(&json!({ "hello": 0 })));
        assert!(!is_hello(&json!({ "hello": "1" })));
        assert!(!is_hello(&json!({ "id": "a", "op": "exists" })));
    }

    #[test]
    fn an_answer_over_the_frame_limit_answers_too_large() {
        let names: Vec<String> = (0..20_000).map(|i| format!("{i:0>60}")).collect();
        let answer = json!({ "id": "abc", "reachable": true, "names": names });
        let frame = answer_frame(&answer);
        assert!(frame.len() <= 4 + MAX_FRAME_BYTES);
        let refused: Value = serde_json::from_slice(&frame[4..]).unwrap();
        assert_eq!(
            refused,
            json!({ "id": "abc", "reachable": false, "reason": "too-large", "error": "ResponseTooLarge" })
        );
    }
}
