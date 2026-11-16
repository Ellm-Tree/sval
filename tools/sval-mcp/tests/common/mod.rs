// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The fake Sval and the bridge runners that `bridge.rs` and `live_claim.rs`
//! share.

use serde_json::{json, Value};
use std::io::{Cursor, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use sval_mcp::bridge::{run_with, Launch, Starter};
use sval_mcp::frame::{read_frame, write_frame};
use sval_mcp::proof::{fresh_nonce, is_hex64, proof_for, verify, Side};
use sval_mcp::secrets::SecretStore;

/// A starter that finds no Sval to start, as with no browser installed beside
/// the shim. A tool call that finds the profile unlocked starts Sval, and a
/// fake Sval holds no lock, so every bridge a test runs gets this unless the
/// test is about starting Sval.
pub fn no_sval_beside() -> Starter {
    Arc::new(|_: &std::path::Path| Err(std::io::Error::other("no sval beside the test")))
}

/// `bridge::run_launched`, with [`no_sval_beside`].
pub fn run_launched<R, W>(
    input: R,
    output: W,
    profile: &std::path::Path,
    launch: Launch,
    store: Arc<dyn SecretStore>,
) -> Result<(), sval_mcp::bridge::BridgeError>
where
    R: std::io::BufRead + Send + 'static,
    W: Write,
{
    run_with(input, output, profile, launch, store, no_sval_beside())
}

/// Waits until `found` answers, checking every 20 ms, and fails with `what`
/// once `limit` has passed without an answer.
pub fn wait_until<T>(
    limit: Duration,
    what: impl Fn() -> String,
    mut found: impl FnMut() -> Option<T>,
) -> T {
    let deadline = Instant::now() + limit;
    loop {
        if let Some(value) = found() {
            return value;
        }
        assert!(Instant::now() < deadline, "{}", what());
        thread::sleep(Duration::from_millis(20));
    }
}

#[derive(Clone, Default)]
pub struct Captured(pub Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

/// Where Sval writes its port file: inside the profile's private `sval-agents`
/// directory.
pub fn port_file(profile: &std::path::Path) -> PathBuf {
    profile.join("sval-agents").join("port.json")
}

/// A profile directory, made and removed as `src/test_dir.rs`'s `TempDir` is.
pub struct TempProfile(pub PathBuf);

impl TempProfile {
    pub fn new(name: String) -> Self {
        let dir = std::env::temp_dir().join(name);
        let _ = std::fs::remove_dir_all(&dir);
        TempProfile(dir)
    }
}

impl std::ops::Deref for TempProfile {
    type Target = PathBuf;
    fn deref(&self) -> &PathBuf {
        &self.0
    }
}

impl Drop for TempProfile {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

pub fn profile_with_port(port: u16) -> TempProfile {
    let dir = TempProfile::new(format!("sval-mcp-test-{}-{}", std::process::id(), port));
    std::fs::create_dir_all(dir.join("sval-agents")).unwrap();
    std::fs::write(
        port_file(&dir),
        json!({ "port": port, "token": TOKEN }).to_string(),
    )
    .unwrap();
    dir
}

/// What Sval writes beside its port. Only Sval and a process that can read the
/// profile know it.
pub const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

/// Reads the bridge's challenge and returns its nonce.
pub fn read_challenge(stream: &mut std::net::TcpStream) -> String {
    let challenge = read_frame(stream).unwrap().unwrap();
    let nonce = challenge["challenge"].as_str().unwrap().to_owned();
    assert!(is_hex64(&nonce), "the challenge is 64 hex characters");
    assert_eq!(nonce, nonce.to_lowercase());
    nonce
}

/// What Sval answers to `nonce`, carrying Sval's own challenge `server_nonce`.
pub fn proof_frame(nonce: &str, server_nonce: &str) -> Value {
    json!({ "ctl": { "sval": proof_for(TOKEN, Side::Sval, nonce), "challenge": server_nonce } })
}

pub const INIT: &str = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"Test Agent"}}}"#;

/// Something a fake Sval records for the test to read.
pub type Shared<T> = Arc<Mutex<Vec<T>>>;

/// A Sval that pairs every agent that asks as a new one, `a0`, `a1` and so
/// on, takes back any secret it issued, and records each handshake whole but
/// for its proof.
pub fn pairing_sval() -> (u16, Shared<Value>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handshakes: Shared<Value> = Arc::default();
    let seen = handshakes.clone();
    thread::spawn(move || {
        for (n, stream) in listener.incoming().enumerate() {
            let mut stream = stream.unwrap();
            let seen = seen.clone();
            thread::spawn(move || {
                let nonce = read_challenge(&mut stream);
                let server_nonce = fresh_nonce().unwrap();
                write_frame(&mut stream, &proof_frame(&nonce, &server_nonce)).unwrap();
                let mut hello = read_frame(&mut stream).unwrap().unwrap();
                let proof = hello["proof"].as_str().unwrap().to_owned();
                assert!(verify(TOKEN, Side::Agent, &server_nonce, &proof));
                hello.as_object_mut().unwrap().remove("proof");
                seen.lock().unwrap().push(hello.clone());
                if hello["pair"] == true {
                    write_frame(&mut stream, &json!({ "ctl": { "ready": "unpaired" } })).unwrap();
                    let paired = json!({ "agent_id": format!("a{n}"), "secret": format!("s{n}") });
                    write_frame(&mut stream, &json!({ "ctl": { "paired": paired } })).unwrap();
                } else {
                    write_frame(&mut stream, &json!({ "ctl": { "ready": "paired" } })).unwrap();
                }
                while let Ok(Some(_)) = read_frame(&mut stream) {}
            });
        }
    });
    (port, handshakes)
}

pub fn launched_in(dir: &str) -> Launch {
    Launch {
        dir: PathBuf::from(dir),
        started: 1_700_000_000_000,
        ..Launch::current()
    }
}

/// Runs one bridge as `launch` until the agent, which sends only `INIT`,
/// is done.
pub fn run_once(profile: &std::path::Path, store: Arc<dyn SecretStore>, launch: Launch) {
    run_launched(
        Cursor::new(format!("{INIT}\n")),
        Captured::default(),
        profile,
        launch,
        store,
    )
    .unwrap();
}
