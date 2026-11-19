// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

mod common;

use common::*;
use serde_json::{json, Value};
use std::io::{BufReader, Cursor, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use sval_mcp::bridge::{run_with, Launch, Starter};
use sval_mcp::frame::{read_frame, write_frame};
use sval_mcp::proof::{fresh_nonce, proof_for, verify, Side};
use sval_mcp::secrets::{Credentials, MemoryStore, SecretStore};

/// `bridge::run`, with [`no_sval_beside`].
fn run<R, W>(
    input: R,
    output: W,
    profile: &std::path::Path,
    store: Arc<dyn SecretStore>,
) -> Result<(), sval_mcp::bridge::BridgeError>
where
    R: std::io::BufRead + Send + 'static,
    W: Write,
{
    run_launched(input, output, profile, Launch::current(), store)
}

/// The handshake deadline the tests of a listener that stalls are run with,
/// short so each sits out only this.
const SHORT_HANDSHAKE: Duration = Duration::from_secs(1);

/// This launch, with the handshake held to [`SHORT_HANDSHAKE`].
fn short_handshake() -> Launch {
    Launch {
        handshake_timeout: SHORT_HANDSHAKE,
        ..Launch::current()
    }
}

impl Captured {
    /// Every line written in full so far.
    fn complete_lines(&self) -> Vec<Value> {
        let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
        let complete = text.rfind('\n').map_or("", |end| &text[..end]);
        complete
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
    fn lines(&self) -> Vec<Value> {
        String::from_utf8(self.0.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect()
    }
}

/// Checks a handshake's `proof` against Sval's challenge as Sval does, and
/// returns the handshake without it, or None when the proof fails. The launch
/// it describes is left out too: the tests that read it say so.
fn proven(hello: &Value, server_nonce: &str) -> Option<Value> {
    let proof = hello["proof"].as_str()?;
    if !verify(TOKEN, Side::Agent, server_nonce, proof) {
        return None;
    }
    let mut rest = hello.clone();
    rest.as_object_mut()?.remove("proof");
    rest.as_object_mut()?.remove("launch");
    Some(rest)
}

/// The account `run` uses for `client`.
fn account(profile: &std::path::Path, client: &str) -> String {
    sval_mcp::bridge::account_for(profile, client)
}

/// A fake Sval that records each connection's handshake, answers per `script`,
/// and echoes one MCP reply for each MCP request. Like Sval, it sends its own
/// challenge with its proof, and closes without a word on a handshake whose
/// proof does not answer it. A recorded handshake has had its proof checked
/// and removed.
fn fake_sval(
    script: impl Fn(usize, &Value) -> Vec<Value> + Send + 'static,
) -> (u16, Shared<Value>) {
    let (port, handshakes, _) = fake_sval_recording_nonces(script);
    (port, handshakes)
}

/// `fake_sval`, which also reports each connection's challenge nonce.
fn fake_sval_recording_nonces(
    script: impl Fn(usize, &Value) -> Vec<Value> + Send + 'static,
) -> (u16, Shared<Value>, Shared<String>) {
    fake_sval_answering(script, echo)
}

/// The reply `fake_sval` gives an MCP request: its method, echoed.
fn echo(request: &Value) -> Vec<Value> {
    vec![
        json!({ "mcp": { "jsonrpc": "2.0", "id": request["id"], "result": { "echo": request["method"] } } }),
    ]
}

/// `fake_sval_recording_nonces`, which sends what `answer` gives for each MCP
/// request.
fn fake_sval_answering(
    script: impl Fn(usize, &Value) -> Vec<Value> + Send + 'static,
    answer: impl Fn(&Value) -> Vec<Value> + Send + 'static,
) -> (u16, Shared<Value>, Shared<String>) {
    let nonces = Arc::new(Mutex::new(Vec::new()));
    let seen_nonces = nonces.clone();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handshakes = Arc::new(Mutex::new(Vec::new()));
    let seen = handshakes.clone();
    thread::spawn(move || {
        for (n, stream) in listener.incoming().enumerate() {
            let mut stream = stream.unwrap();
            let nonce = read_challenge(&mut stream);
            seen_nonces.lock().unwrap().push(nonce.clone());
            let server_nonce = fresh_nonce().unwrap();
            write_frame(&mut stream, &proof_frame(&nonce, &server_nonce)).unwrap();
            let hello = read_frame(&mut stream).unwrap().unwrap();
            let Some(hello) = proven(&hello, &server_nonce) else {
                continue;
            };
            seen.lock().unwrap().push(hello.clone());
            let replies = script(n, &hello);
            let refused = replies.iter().any(|r| r["ctl"]["refused"].is_string());
            for r in replies {
                write_frame(&mut stream, &r).unwrap();
            }
            if refused {
                continue;
            }
            while let Ok(Some(frame)) = read_frame(&mut stream) {
                if frame["mcp"]["id"].is_null() {
                    continue;
                }
                for reply in answer(&frame["mcp"]) {
                    write_frame(&mut stream, &reply).unwrap();
                }
            }
        }
    });
    (port, handshakes, nonces)
}

#[test]
fn pairs_when_no_secret_is_stored_and_saves_the_secret_sval_issues() {
    let (port, handshakes) = fake_sval(|_, _| {
        vec![
            json!({ "ctl": { "ready": "unpaired" } }),
            json!({ "ctl": { "paired": { "agent_id": "a1", "secret": "s1" } } }),
        ]
    });
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    let out = Captured::default();
    run(
        Cursor::new(format!("{INIT}\n")),
        out.clone(),
        &profile,
        store.clone(),
    )
    .unwrap();

    assert_eq!(
        handshakes.lock().unwrap()[0],
        json!({ "hello": 3, "pair": true })
    );
    let account = account(&profile, "Test Agent");
    assert_eq!(
        store.load(&account),
        Some(Credentials {
            agent_id: "a1".into(),
            secret: "s1".into()
        })
    );
    assert!(
        out.lines().iter().all(|l| !l.to_string().contains("s1")),
        "the secret never reaches stdout"
    );
}

#[test]
fn a_server_discover_probe_names_the_account_for_the_secret_sval_issues() {
    let probe = r#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.292"}}}}"#;
    let (port, handshakes) = fake_sval(|_, _| {
        vec![
            json!({ "ctl": { "ready": "unpaired" } }),
            json!({ "ctl": { "paired": { "agent_id": "a1", "secret": "s1" } } }),
        ]
    });
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    let out = Captured::default();
    let unnamed = r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#;
    run(
        Cursor::new(format!("{probe}\n{unnamed}\n")),
        out.clone(),
        &profile,
        store.clone(),
    )
    .unwrap();

    assert_eq!(
        handshakes.lock().unwrap()[0],
        json!({ "hello": 3, "pair": true })
    );
    let saved = Some(Credentials {
        agent_id: "a1".into(),
        secret: "s1".into(),
    });
    assert_eq!(store.load(&account(&profile, "claude-code")), saved);
    assert_eq!(store.load(&account(&profile, "Agent")), None);
}

#[test]
fn uses_the_stored_secret_and_relays_both_directions() {
    let (port, handshakes) = fake_sval(|_, _| vec![json!({ "ctl": { "ready": "paired" } })]);
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    let account = account(&profile, "Test Agent");
    store
        .save(
            &account,
            &Credentials {
                agent_id: "a1".into(),
                secret: "s1".into(),
            },
        )
        .unwrap();
    let out = Captured::default();
    let input = format!(
        "{INIT}\n{}\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#
    );
    run(Cursor::new(input), out.clone(), &profile, store).unwrap();

    assert_eq!(
        handshakes.lock().unwrap()[0],
        json!({ "hello": 3, "agent_id": "a1", "secret": "s1" })
    );
    let lines = out.lines();
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[1]["result"]["echo"], "tools/list");
}

/// The progress notification Sval sends a waiting call, numbered `progress`.
fn progress_notification(progress: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "method": "notifications/progress",
        "params": {
            "progressToken": "tok-7",
            "progress": progress,
            "message": "Waiting for you to answer Sval's alert"
        }
    })
}

#[test]
fn relays_a_progress_token_to_sval_and_svals_progress_to_the_agent_unchanged() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (calls, seen_calls) = mpsc::channel();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let nonce = read_challenge(&mut stream);
        let server_nonce = fresh_nonce().unwrap();
        write_frame(&mut stream, &proof_frame(&nonce, &server_nonce)).unwrap();
        let hello = read_frame(&mut stream).unwrap().unwrap();
        proven(&hello, &server_nonce).unwrap();
        write_frame(&mut stream, &json!({ "ctl": { "ready": "unpaired" } })).unwrap();
        while let Ok(Some(frame)) = read_frame(&mut stream) {
            let message = frame["mcp"].clone();
            let Some(id) = message["id"].as_i64() else {
                continue;
            };
            if message["method"] == "tools/call" {
                calls.send(message.clone()).unwrap();
                for progress in [1, 2] {
                    write_frame(
                        &mut stream,
                        &json!({ "mcp": progress_notification(progress) }),
                    )
                    .unwrap();
                }
            }
            write_frame(
                &mut stream,
                &json!({ "mcp": { "jsonrpc": "2.0", "id": id, "result": {} } }),
            )
            .unwrap();
        }
    });
    let profile = profile_with_port(port);
    let call = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "request_shared_pairing",
            "arguments": {},
            "_meta": { "progressToken": "tok-7" }
        }
    });
    let out = Captured::default();
    run(
        Cursor::new(format!("{INIT}\n{call}\n")),
        out.clone(),
        &profile,
        Arc::new(MemoryStore::default()),
    )
    .unwrap();

    assert_eq!(
        seen_calls.recv_timeout(Duration::from_secs(5)).unwrap(),
        call,
        "the call reaches sval with its progress token"
    );
    let lines = out.lines();
    let answered = lines.iter().position(|l| l["id"] == 2).unwrap();
    assert_eq!(
        lines[..answered]
            .iter()
            .filter(|l| l["method"] == "notifications/progress")
            .cloned()
            .collect::<Vec<_>>(),
        vec![progress_notification(1), progress_notification(2)],
        "sval's progress reaches the agent unchanged, before the answer"
    );
}

#[test]
fn falls_back_to_pairing_when_sval_refuses_the_stored_secret() {
    let (port, handshakes, nonces) = fake_sval_recording_nonces(|n, _| {
        if n == 0 {
            vec![json!({ "ctl": { "refused": "unknown_agent" } })]
        } else {
            vec![json!({ "ctl": { "ready": "unpaired" } })]
        }
    });
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    let account = account(&profile, "Test Agent");
    store
        .save(
            &account,
            &Credentials {
                agent_id: "old".into(),
                secret: "stale".into(),
            },
        )
        .unwrap();
    run(
        Cursor::new(format!("{INIT}\n")),
        Captured::default(),
        &profile,
        store.clone(),
    )
    .unwrap();

    let hs = handshakes.lock().unwrap();
    assert_eq!(
        hs[1],
        json!({ "hello": 3, "pair": true }),
        "second connection pairs"
    );
    assert_eq!(store.load(&account), None, "the stale secret is forgotten");
    let nonces = nonces.lock().unwrap();
    assert_eq!(nonces.len(), 2);
    assert_ne!(nonces[0], nonces[1], "every attempt gets a fresh challenge");
}

/// Sval refuses a handshake older than any it speaks. The secret is kept, since
/// it is still good, the shim does not pair instead, and the agent is told
/// to restart rather than that Sval is missing.
#[test]
fn an_outdated_refusal_keeps_the_secret_and_tells_the_agent_to_restart() {
    let (port, handshakes) = fake_sval(|_, _| vec![json!({ "ctl": { "refused": "outdated" } })]);
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    let account = account(&profile, "Test Agent");
    store.save(&account, &stored_secret()).unwrap();
    let out = Captured::default();
    run(
        Cursor::new(format!("{INIT}\n{CALL}\n")),
        out.clone(),
        &profile,
        store.clone(),
    )
    .unwrap();

    let lines = out.lines();
    assert_initialized(&lines[0]);
    assert_tool_error(&lines[1], "sval_mcp_outdated");
    assert_eq!(
        store.load(&account),
        Some(stored_secret()),
        "the secret is kept"
    );
    assert!(
        handshakes
            .lock()
            .unwrap()
            .iter()
            .all(|h| h["pair"].is_null()),
        "the shim never pairs in place of its secret"
    );
}

const CALL: &str = r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_tabs","arguments":{}}}"#;
const LIST: &str = r#"{"jsonrpc":"2.0","id":3,"method":"tools/list"}"#;

/// Checks that `reply` is a tool result reporting `code`, in the JSON shape
/// every tool error has.
fn assert_tool_error(reply: &Value, code: &str) {
    assert_eq!(reply["result"]["isError"], true, "{reply}");
    let text = reply["result"]["content"][0]["text"].as_str().unwrap();
    let error: Value = serde_json::from_str(text).unwrap();
    assert_eq!(error["error"], code, "{text}");
    let message = error["message"].as_str().unwrap();
    assert!(message.starts_with(&format!("{code}: ")), "{text}");
}

/// A fake Sval that answers the agent's `tools/call` with `reply`'s frames,
/// each given the call's id, and echoes every other request.
fn sval_answering_calls_with(reply: Vec<Value>) -> u16 {
    let (port, _, _) = fake_sval_answering(
        |_, _| vec![json!({ "ctl": { "ready": "paired" } })],
        move |request| {
            if request["method"] != "tools/call" {
                return echo(request);
            }
            reply
                .iter()
                .map(|frame| {
                    let mut frame = frame.clone();
                    if frame["mcp"].get("method").is_none() {
                        frame["mcp"]["id"] = request["id"].clone();
                    }
                    frame
                })
                .collect()
        },
    );
    port
}

/// Runs a paired agent that sends `initialize` and then `CALL`, and returns
/// every line the agent read.
fn call_paired(port: u16) -> Vec<Value> {
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    store
        .save(
            &account(&profile, "Test Agent"),
            &Credentials {
                agent_id: "a1".into(),
                secret: "s1".into(),
            },
        )
        .unwrap();
    let out = Captured::default();
    run(
        Cursor::new(format!("{INIT}\n{CALL}\n")),
        out.clone(),
        &profile,
        store,
    )
    .unwrap();
    out.lines()
}

#[test]
fn relays_svals_tool_errors_unchanged() {
    let result = json!({
        "content": [{ "type": "text", "text": r#"{"error":"human_verification_required","message":"human_verification_required: Tell the user.","tab":"t1","kind":"interstitial","vendor":"cloudflare"}"# }],
        "isError": true
    });
    let port = sval_answering_calls_with(vec![
        json!({ "mcp": { "jsonrpc": "2.0", "id": null, "result": result } }),
    ]);
    let lines = call_paired(port);
    let reply = lines
        .iter()
        .find(|l| l["id"] == 2)
        .expect("the call's answer");
    assert_eq!(
        reply,
        &json!({ "jsonrpc": "2.0", "id": 2, "result": result }),
        "sval's error reaches the agent as sval sent it"
    );
    assert_tool_error(reply, "human_verification_required");
}

/// Be polite: Sval's refusal of an action over the rate, with when to try
/// again, and its notice that the rules changed, reach the agent unchanged.
#[test]
fn relays_svals_rate_limit_and_its_notice_of_new_rules_unchanged() {
    let result = json!({
        "content": [{ "type": "text", "text": r#"{"tab":"t1","retry_after_ms":1000,"error":"rate_limited","message":"rate_limited: Be polite: 4 actions are already waiting their turn on this site."}"# }],
        "isError": true
    });
    let notice = json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" });
    let port = sval_answering_calls_with(vec![
        json!({ "mcp": { "jsonrpc": "2.0", "id": null, "result": result } }),
        json!({ "mcp": notice }),
    ]);
    let lines = call_paired(port);
    let reply = lines.iter().find(|l| l["id"] == 2).expect("the refusal");
    assert_eq!(
        reply,
        &json!({ "jsonrpc": "2.0", "id": 2, "result": result })
    );
    assert_tool_error(reply, "rate_limited");
    let text: Value =
        serde_json::from_str(reply["result"]["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(text["retry_after_ms"], 1000);
    assert!(lines.contains(&notice), "the notice: {lines:?}");
}

#[test]
fn answers_initialize_itself_and_a_call_fails_with_sval_not_running_when_there_is_no_port_file() {
    let profile = TempProfile::new(format!("sval-mcp-empty-{}", std::process::id()));
    std::fs::create_dir_all(&*profile).unwrap();
    let out = Captured::default();
    run(
        Cursor::new(format!("{INIT}\n{CALL}\n{LIST}\n")),
        out.clone(),
        &profile,
        Arc::new(MemoryStore::default()),
    )
    .unwrap();
    let lines = out.lines();
    assert_eq!(lines.len(), 3);
    assert_initialized(&lines[0]);
    assert_eq!(lines[1]["id"], 2);
    assert_tool_error(&lines[1], "sval_not_running");
    assert_eq!(lines[2]["id"], 3);
    assert_eq!(lines[2]["result"], json!({ "tools": [] }));
}

#[test]
fn a_call_fails_with_sval_not_running_when_the_port_file_is_stale() {
    let port = {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let profile = profile_with_port(port);
    let out = Captured::default();
    run(
        Cursor::new(format!("{INIT}\n{CALL}\n")),
        out.clone(),
        &profile,
        Arc::new(MemoryStore::default()),
    )
    .unwrap();
    let lines = out.lines();
    assert_eq!(lines.len(), 2);
    assert_initialized(&lines[0]);
    assert_tool_error(&lines[1], "sval_not_running");
}

#[derive(Default)]
struct UnsavableStore(MemoryStore);
impl SecretStore for UnsavableStore {
    fn load(&self, account: &str) -> Option<Credentials> {
        self.0.load(account)
    }
    fn save(&self, _: &str, _: &Credentials) -> Result<(), String> {
        Err("the disk is full".into())
    }
    fn forget(&self, account: &str) {
        self.0.forget(account)
    }
}

/// A store that cannot forget, as when the file system refuses a delete.
#[derive(Default)]
struct UnforgettingStore(MemoryStore);
impl SecretStore for UnforgettingStore {
    fn load(&self, account: &str) -> Option<Credentials> {
        self.0.load(account)
    }
    fn save(&self, account: &str, credentials: &Credentials) -> Result<(), String> {
        self.0.save(account, credentials)
    }
    fn forget(&self, _: &str) {}
}

fn stored_secret() -> Credentials {
    Credentials {
        agent_id: "a1".into(),
        secret: "s1".into(),
    }
}

/// A listener that is not Sval, or not quite: it reads the bridge's challenge,
/// answers with what `answer` makes of its nonce (if anything), then collects
/// whatever else the bridge sends until the bridge closes the connection. The
/// handle gives the challenge's nonce and the frames received after it.
fn impostor(
    answer: impl FnOnce(&str) -> Option<Value> + Send + 'static,
) -> (u16, thread::JoinHandle<(String, Vec<Value>)>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let handle = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let nonce = read_challenge(&mut stream);
        if let Some(answer) = answer(&nonce) {
            write_frame(&mut stream, &answer).unwrap();
        }
        let mut received = Vec::new();
        while let Ok(Some(frame)) = read_frame(&mut stream) {
            received.push(frame);
        }
        (nonce, received)
    });
    (port, handle)
}

/// The bridge's own answer to `INIT`, which needs no Sval.
fn assert_initialized(reply: &Value) {
    assert_eq!(reply["id"], 1);
    assert_eq!(reply["result"]["protocolVersion"], "2025-11-25");
    assert_eq!(
        reply["result"]["capabilities"]["tools"]["listChanged"],
        true
    );
    assert_eq!(
        reply["result"]["instructions"],
        sval_mcp::mcp::SERVER_INSTRUCTIONS
    );
}

/// The agent was answered by the bridge alone.
fn assert_unavailable(out: &Captured) {
    let lines = out.lines();
    assert_eq!(lines.len(), 1);
    assert_initialized(&lines[0]);
}

/// Runs the bridge, with a stored secret, against `port`, and checks that the
/// secret was kept and the agent was told Sval is unavailable.
fn assert_secret_withheld_from(port: u16) {
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    let account = account(&profile, "Test Agent");
    store.save(&account, &stored_secret()).unwrap();
    let out = Captured::default();
    run(
        Cursor::new(format!("{INIT}\n")),
        out.clone(),
        &profile,
        store.clone(),
    )
    .unwrap();
    assert_eq!(
        store.load(&account),
        Some(stored_secret()),
        "the secret is kept"
    );
    assert_unavailable(&out);
}

#[test]
fn refuses_to_send_a_secret_to_a_listener_that_cannot_prove_it_is_sval() {
    let wrong_proof = json!({ "ctl": { "sval": "f".repeat(64) } });
    let token_itself = json!({ "ctl": { "sval": TOKEN } });
    let not_hex = json!({ "ctl": { "sval": "zz" } });
    let ready_without_proof = json!({ "ctl": { "ready": "paired" } });
    let cases = [
        impostor(move |_| Some(wrong_proof)),
        impostor(move |_| Some(token_itself)),
        impostor(move |_| Some(not_hex)),
        impostor(move |_| Some(ready_without_proof)),
        impostor(|_| None),
    ];
    for (port, handle) in cases {
        assert_secret_withheld_from(port);
        let (_, received) = handle.join().unwrap();
        assert_eq!(received, Vec::<Value>::new(), "nothing is sent");
    }
}

#[test]
fn answers_svals_challenge_with_an_agent_prefixed_proof() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let server_nonce = "fedcba9876543210".repeat(4);
    let sval_side = {
        let server_nonce = server_nonce.clone();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let nonce = read_challenge(&mut stream);
            write_frame(&mut stream, &proof_frame(&nonce, &server_nonce)).unwrap();
            let hello = read_frame(&mut stream).unwrap().unwrap();
            write_frame(&mut stream, &json!({ "ctl": { "ready": "paired" } })).unwrap();
            let _ = read_frame(&mut stream);
            hello
        })
    };
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    let account = account(&profile, "Test Agent");
    store.save(&account, &stored_secret()).unwrap();
    run(
        Cursor::new(format!("{INIT}\n")),
        Captured::default(),
        &profile,
        store,
    )
    .unwrap();

    let hello = sval_side.join().unwrap();
    // The vector from Python's hmac module, which Sval's WebCrypto checks too.
    assert_eq!(
        hello["proof"],
        "8250d82b0207bd5bf671b20aad92933ab149f5a1fdfa075771a9ba12fea34904"
    );
    assert!(!verify(
        TOKEN,
        Side::Sval,
        &server_nonce,
        hello["proof"].as_str().unwrap()
    ));
    assert_eq!(
        proven(&hello, &server_nonce),
        Some(json!({ "hello": 3, "agent_id": "a1", "secret": "s1" }))
    );
}

#[test]
fn proves_itself_when_pairing_too() {
    let (port, handshakes) = fake_sval(|_, _| vec![json!({ "ctl": { "ready": "unpaired" } })]);
    let profile = profile_with_port(port);
    run(
        Cursor::new(format!("{INIT}\n")),
        Captured::default(),
        &profile,
        Arc::new(MemoryStore::default()),
    )
    .unwrap();
    assert_eq!(
        handshakes.lock().unwrap().as_slice(),
        [json!({ "hello": 3, "pair": true })],
        "the fake sval accepted the proof"
    );
}

#[test]
fn refuses_to_sign_a_malformed_server_nonce() {
    let malformed = [
        None,
        Some(json!("A".repeat(64))),
        Some(json!("a".repeat(63))),
        Some(json!("a".repeat(65))),
        Some(json!("g".repeat(64))),
        Some(json!(7)),
    ];
    for challenge in malformed {
        let (port, handle) = impostor(move |nonce| {
            let mut answer = json!({ "ctl": { "sval": proof_for(TOKEN, Side::Sval, nonce) } });
            if let Some(challenge) = challenge {
                answer["ctl"]["challenge"] = challenge;
            }
            Some(answer)
        });
        assert_secret_withheld_from(port);
        let (_, received) = handle.join().unwrap();
        assert_eq!(received, Vec::<Value>::new(), "nothing is signed or sent");
    }
}

#[test]
fn a_replayed_proof_is_refused() {
    // A proof that was right, for some other connection's nonce.
    let (port, handle) = impostor(|_| Some(proof_frame(&"c".repeat(64), &"d".repeat(64))));
    assert_secret_withheld_from(port);
    let (nonce, received) = handle.join().unwrap();
    assert_ne!(nonce, "c".repeat(64));
    assert_eq!(received, Vec::<Value>::new(), "nothing is sent");
}

#[test]
fn a_port_file_with_no_usable_token_is_sval_unavailable() {
    for token in [None, Some(""), Some("short"), Some(&"g".repeat(64)[..])] {
        let (port, handshakes) = fake_sval(|_, _| vec![json!({ "ctl": { "ready": "paired" } })]);
        let profile = profile_with_port(port);
        let file = match token {
            Some(t) => json!({ "port": port, "token": t }),
            None => json!({ "port": port }),
        };
        std::fs::write(port_file(&profile), file.to_string()).unwrap();
        let out = Captured::default();
        run(
            Cursor::new(format!("{INIT}\n")),
            out.clone(),
            &profile,
            Arc::new(MemoryStore::default()),
        )
        .unwrap();
        assert_unavailable(&out);
        assert!(
            handshakes.lock().unwrap().is_empty(),
            "sval was never contacted"
        );
    }
}

#[test]
fn a_listener_that_never_speaks_does_not_hang_the_bridge() {
    let (port, handle) = impostor(|_| None);
    let profile = profile_with_port(port);
    let out = Captured::default();
    let started = Instant::now();
    run_launched(
        Cursor::new(format!("{INIT}\n")),
        out.clone(),
        &profile,
        short_handshake(),
        Arc::new(MemoryStore::default()),
    )
    .unwrap();
    assert!(started.elapsed() < SHORT_HANDSHAKE * 5);
    assert_unavailable(&out);
    handle.join().unwrap();
}

#[test]
fn a_trickling_listener_cannot_hold_the_handshake_past_the_deadline() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let trickler = thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        read_challenge(&mut stream);
        // Declares a 200 byte frame, then sends it a byte a tenth of the
        // deadline apart: every read finishes well inside any per-read
        // timeout, and the whole frame would take twenty deadlines.
        let mut bytes = 200u32.to_be_bytes().to_vec();
        bytes.extend_from_slice(&[b' '; 200]);
        for byte in bytes {
            if stream.write_all(&[byte]).is_err() {
                return;
            }
            thread::sleep(SHORT_HANDSHAKE / 10);
        }
    });
    let profile = profile_with_port(port);
    let out = Captured::default();
    let started = Instant::now();
    run_launched(
        Cursor::new(format!("{INIT}\n")),
        out.clone(),
        &profile,
        short_handshake(),
        Arc::new(MemoryStore::default()),
    )
    .unwrap();
    let took = started.elapsed();
    assert!(took < SHORT_HANDSHAKE * 5, "took {took:?}");
    assert_unavailable(&out);
    trickler.join().unwrap();
}

#[test]
fn a_failed_save_is_reported_and_the_relay_keeps_working() {
    let (port, _) = fake_sval(|_, _| {
        vec![
            json!({ "ctl": { "ready": "unpaired" } }),
            json!({ "ctl": { "paired": { "agent_id": "a1", "secret": "s1" } } }),
        ]
    });
    let profile = profile_with_port(port);
    let out = Captured::default();
    let input = format!(
        "{INIT}\n{}\n",
        r#"{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"request_shared_pairing"}}"#
    );
    run(
        Cursor::new(input),
        out.clone(),
        &profile,
        Arc::new(UnsavableStore::default()),
    )
    .unwrap();

    let lines = out.lines();
    assert_eq!(lines[0]["id"], 1);
    assert_eq!(lines[1]["result"]["echo"], "tools/call");
    assert!(out.lines().iter().all(|l| !l.to_string().contains("s1")));
}

#[test]
fn the_retry_after_a_refusal_pairs_even_when_the_store_cannot_forget() {
    let (port, handshakes) = fake_sval(|n, _| {
        if n == 0 {
            vec![json!({ "ctl": { "refused": "unknown_agent" } })]
        } else {
            vec![json!({ "ctl": { "ready": "unpaired" } })]
        }
    });
    let profile = profile_with_port(port);
    let store = Arc::new(UnforgettingStore::default());
    let account = account(&profile, "Test Agent");
    store.save(&account, &stored_secret()).unwrap();
    run(
        Cursor::new(format!("{INIT}\n")),
        Captured::default(),
        &profile,
        store,
    )
    .unwrap();

    let hs = handshakes.lock().unwrap();
    assert_eq!(hs[0]["secret"], "s1");
    assert_eq!(hs[1], json!({ "hello": 3, "pair": true }));
}

/// A second Sval's token, as a restarted Sval writes a new one.
const TOKEN_B: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
/// The token in a port file a crashed Sval left behind.
const TOKEN_LEFT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

fn write_port_file(profile: &std::path::Path, port: u16, token: &str) {
    std::fs::write(
        port_file(profile),
        json!({ "port": port, "token": token }).to_string(),
    )
    .unwrap();
}

/// What a test can see of, and do to, one run of `sval`.
struct Sval {
    port: u16,
    /// The handshake, its proof checked and removed, then each MCP message.
    received: Shared<Value>,
    /// The connection, for the test to close as a quitting Sval would.
    stream: Arc<Mutex<Option<std::net::TcpStream>>>,
}

impl Sval {
    fn quit(&self) {
        let stream = self.stream.lock().unwrap().take().unwrap();
        stream.shutdown(std::net::Shutdown::Both).unwrap();
    }
}

/// One run of Sval with port file token `token`: it takes one connection,
/// proves itself, answers the handshake with `replies`, and echoes every MCP
/// request.
fn sval_run(token: &'static str, replies: Vec<Value>) -> Sval {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let received: Shared<Value> = Arc::default();
    let stream_slot: Arc<Mutex<Option<std::net::TcpStream>>> = Arc::default();
    let (seen, slot) = (received.clone(), stream_slot.clone());
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let nonce = read_challenge(&mut stream);
        let server_nonce = fresh_nonce().unwrap();
        let answer = json!({ "ctl": {
            "sval": proof_for(token, Side::Sval, &nonce), "challenge": server_nonce
        } });
        write_frame(&mut stream, &answer).unwrap();
        let mut hello = read_frame(&mut stream).unwrap().unwrap();
        let proof = hello["proof"].as_str().unwrap().to_owned();
        assert!(verify(token, Side::Agent, &server_nonce, &proof));
        hello.as_object_mut().unwrap().remove("proof");
        hello.as_object_mut().unwrap().remove("launch");
        seen.lock().unwrap().push(hello);
        for reply in replies {
            write_frame(&mut stream, &reply).unwrap();
        }
        *slot.lock().unwrap() = Some(stream.try_clone().unwrap());
        while let Ok(Some(frame)) = read_frame(&mut stream) {
            let message = frame["mcp"].clone();
            seen.lock().unwrap().push(message.clone());
            if let (Some(id), Some(method)) = (message.get("id"), message.get("method")) {
                let echo =
                    json!({ "mcp": { "jsonrpc": "2.0", "id": id, "result": { "echo": method } } });
                if write_frame(&mut stream, &echo).is_err() {
                    break;
                }
            }
        }
        // Closes the connection as Sval does when the agent is done.
        slot.lock().unwrap().take();
    });
    Sval {
        port,
        received,
        stream: stream_slot,
    }
}

/// Waits for the agent's output to hold a line `wanted` accepts, and returns
/// it. Each line is read once, in order, from `from`.
fn wait_for(out: &Captured, from: &mut usize, wanted: impl Fn(&Value) -> bool) -> Value {
    wait_until(
        Duration::from_secs(5),
        || format!("no such line in {:?}", out.complete_lines()),
        || {
            let lines = out.complete_lines();
            while *from < lines.len() {
                let line = lines[*from].clone();
                *from += 1;
                if wanted(&line) {
                    return Some(line);
                }
            }
            None
        },
    )
}

fn is_list_changed(line: &Value) -> bool {
    line["method"] == "notifications/tools/list_changed"
}

/// Starts the bridge on a pipe the test writes the agent's side of.
fn start_bridge(
    profile: PathBuf,
    store: Arc<dyn SecretStore>,
) -> (std::io::PipeWriter, Captured, mpsc::Receiver<()>) {
    let (reader, writer) = std::io::pipe().unwrap();
    let out = Captured::default();
    let (done, finished) = mpsc::channel();
    let bridge_out = out.clone();
    thread::spawn(move || {
        run(BufReader::new(reader), bridge_out, &profile, store).unwrap();
        let _ = done.send(());
    });
    (writer, out, finished)
}

#[test]
fn connects_when_sval_starts_after_the_agent() {
    let profile = closed_profile("late-sval");
    let (mut agent, out, finished) =
        start_bridge(profile.clone(), Arc::new(MemoryStore::default()));
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    assert_initialized(&wait_for(&out, &mut seen, |l| l["id"] == 1));
    writeln!(agent, "{LIST}").unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 3)["result"],
        json!({ "tools": [] }),
        "with no sval yet there is no tool to list"
    );

    let sval = sval_run(TOKEN, vec![json!({ "ctl": { "ready": "unpaired" } })]);
    write_port_file(&profile, sval.port, TOKEN);
    wait_for(&out, &mut seen, is_list_changed);
    writeln!(agent, "{CALL}").unwrap();
    let reply = wait_for(&out, &mut seen, |l| l["id"] == 2);
    assert_eq!(reply["result"]["echo"], "tools/call");
    let received = sval.received.lock().unwrap().clone();
    assert_eq!(received[0], json!({ "hello": 3, "pair": true }));
    assert_eq!(
        received[1]["method"], "tools/call",
        "sval is sent the call alone: the agent's initialize is the bridge's to answer"
    );
    drop(agent);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn survives_a_sval_restart_and_reconnects_to_the_new_port_file_without_pairing_again() {
    let profile = closed_profile("restart");
    // The pairing secret cannot be stored, so only the bridge's memory keeps
    // the agent paired across the restart.
    let (mut agent, out, finished) =
        start_bridge(profile.clone(), Arc::new(UnsavableStore::default()));
    let first = sval_run(
        TOKEN,
        vec![
            json!({ "ctl": { "ready": "unpaired" } }),
            json!({ "ctl": { "paired": { "agent_id": "a1", "secret": "s1" } } }),
            json!({ "ctl": { "workspace": "w-1" } }),
        ],
    );
    write_port_file(&profile, first.port, TOKEN);
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    assert_initialized(&wait_for(&out, &mut seen, |l| l["id"] == 1));
    writeln!(
        agent,
        r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
    )
    .unwrap();
    writeln!(agent, "{LIST}").unwrap();
    let svals_list = wait_for(&out, &mut seen, |l| l["id"] == 3)["result"].clone();
    assert_eq!(svals_list, json!({ "echo": "tools/list" }));

    // Sval quits, leaving a port file for a port nothing listens on. The new
    // token is what tells the bridge to announce it, which it does only once
    // it has seen the old connection close.
    first.quit();
    let dead_port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    write_port_file(&profile, dead_port, TOKEN_LEFT);
    wait_for(&out, &mut seen, is_list_changed);
    writeln!(agent, "{CALL}").unwrap();
    assert_tool_error(
        &wait_for(&out, &mut seen, |l| l["id"] == 2),
        "sval_not_running",
    );
    writeln!(agent, r#"{{"jsonrpc":"2.0","id":4,"method":"tools/list"}}"#).unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 4)["result"],
        svals_list,
        "the agent keeps Sval's last tool list while sval is away"
    );

    // Sval starts again, with a new port and token.
    let second = sval_run(TOKEN_B, vec![json!({ "ctl": { "ready": "paired" } })]);
    write_port_file(&profile, second.port, TOKEN_B);
    writeln!(
        agent,
        r#"{{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{{"name":"list_tabs"}}}}"#
    )
    .unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 5)["result"]["echo"],
        "tools/call"
    );
    let received = second.received.lock().unwrap().clone();
    assert_eq!(
        received[0],
        json!({ "hello": 3, "agent_id": "a1", "secret": "s1", "workspace": "w-1" }),
        "the agent stays paired, and asks for the workspace it held"
    );
    assert_eq!(
        received[1]["id"], 5,
        "sval is sent the call, and nothing before it"
    );
    assert!(
        out.complete_lines()
            .iter()
            .all(|l| !l.to_string().contains("s1")),
        "the secret never reaches the agent"
    );
    drop(agent);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn a_call_in_flight_when_sval_quits_is_answered() {
    let profile = closed_profile("in-flight");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    write_port_file(&profile, listener.local_addr().unwrap().port(), TOKEN);
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let nonce = read_challenge(&mut stream);
        write_frame(&mut stream, &proof_frame(&nonce, &"d".repeat(64))).unwrap();
        read_frame(&mut stream).unwrap().unwrap();
        write_frame(&mut stream, &json!({ "ctl": { "ready": "paired" } })).unwrap();
        // The call, which Sval never answers.
        read_frame(&mut stream).unwrap().unwrap();
    });
    let (mut agent, out, finished) =
        start_bridge(profile.to_path_buf(), Arc::new(MemoryStore::default()));
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    writeln!(agent, "{CALL}").unwrap();
    assert_tool_error(
        &wait_for(&out, &mut seen, |l| l["id"] == 2),
        "sval_disconnected",
    );
    assert_eq!(
        finished.recv_timeout(Duration::from_millis(300)),
        Err(mpsc::RecvTimeoutError::Timeout),
        "the bridge outlives sval"
    );
    drop(agent);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
}

/// Only the bridge reads the agent's MCP session, so it tells Sval who the
/// agent's client is with each request, asks Sval for tool lists and calls
/// alone, and gives a modern client Sval's result in the shape a modern
/// result has.
#[test]
fn sval_is_sent_the_client_with_each_request_and_nothing_of_the_protocol() {
    let profile = closed_profile("client-info");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    write_port_file(&profile, listener.local_addr().unwrap().port(), TOKEN);
    let frames: Shared<Value> = Arc::default();
    let seen = frames.clone();
    thread::spawn(move || {
        let (mut stream, _) = listener.accept().unwrap();
        let nonce = read_challenge(&mut stream);
        write_frame(&mut stream, &proof_frame(&nonce, &"d".repeat(64))).unwrap();
        read_frame(&mut stream).unwrap().unwrap();
        write_frame(&mut stream, &json!({ "ctl": { "ready": "paired" } })).unwrap();
        while let Ok(Some(frame)) = read_frame(&mut stream) {
            let reply = json!({ "mcp": {
                "jsonrpc": "2.0", "id": frame["mcp"]["id"], "result": { "content": [] }
            } });
            seen.lock().unwrap().push(frame);
            if write_frame(&mut stream, &reply).is_err() {
                break;
            }
        }
    });
    let (mut agent, out, finished) =
        start_bridge(profile.to_path_buf(), Arc::new(MemoryStore::default()));
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    writeln!(agent, "{CALL}").unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 2)["result"],
        json!({ "content": [] }),
        "a legacy client gets Sval's result as it is"
    );
    writeln!(agent, r#"{{"jsonrpc":"2.0","id":7,"method":"ping"}}"#).unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 7)["result"],
        json!({})
    );
    writeln!(
        agent,
        r#"{{"jsonrpc":"2.0","id":8,"method":"resources/list"}}"#
    )
    .unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 8)["error"]["code"],
        -32601
    );
    let call = modern(
        json!(5),
        "tools/call",
        json!({ "name": "list_tabs", "arguments": {} }),
    );
    writeln!(agent, "{call}").unwrap();
    assert_modern_result(&wait_for(&out, &mut seen, |l| l["id"] == 5));
    drop(agent);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();

    let frames = frames.lock().unwrap();
    assert_eq!(frames.len(), 2, "sval is asked for the two calls alone");
    let init: Value = serde_json::from_str(INIT).unwrap();
    assert_eq!(
        frames[0]["client"], init["params"]["clientInfo"],
        "a legacy client is who its initialize said"
    );
    assert_eq!(
        frames[1]["client"]["name"], "Modern Agent",
        "a modern client is who the request says"
    );
}

/// Sval never sees the large call, and a call already in flight is answered
/// by Sval.
#[test]
fn a_call_too_large_for_sval_fails_alone_and_the_connection_carries_on() {
    let profile = closed_profile("too-large");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    write_port_file(&profile, listener.local_addr().unwrap().port(), TOKEN);
    let received: Shared<Value> = Arc::default();
    let seen_by_sval = received.clone();
    let connections = Arc::new(Mutex::new(0));
    let accepted = connections.clone();
    thread::spawn(move || {
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            *accepted.lock().unwrap() += 1;
            let nonce = read_challenge(&mut stream);
            let server_nonce = fresh_nonce().unwrap();
            let answer = json!({ "ctl": {
                "sval": proof_for(TOKEN, Side::Sval, &nonce), "challenge": server_nonce
            } });
            write_frame(&mut stream, &answer).unwrap();
            read_frame(&mut stream).unwrap().unwrap();
            write_frame(&mut stream, &json!({ "ctl": { "ready": "paired" } })).unwrap();
            // Every call waits for the next one, so the first is still owed
            // when the large one comes; the last is answered when the agent
            // is done.
            let mut owed: Vec<Value> = Vec::new();
            while let Ok(Some(frame)) = read_frame(&mut stream) {
                let message = frame["mcp"].clone();
                seen_by_sval.lock().unwrap().push(message.clone());
                if message["method"] == "initialize" {
                    continue;
                }
                for earlier in owed.drain(..) {
                    let echo = json!({ "mcp": { "jsonrpc": "2.0", "id": earlier["id"], "result": { "echo": earlier["method"] } } });
                    write_frame(&mut stream, &echo).unwrap();
                }
                owed.push(message);
            }
        }
    });
    let (mut agent, out, finished) =
        start_bridge(profile.to_path_buf(), Arc::new(MemoryStore::default()));
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    writeln!(agent, "{CALL}").unwrap();
    let large = json!({
        "jsonrpc": "2.0", "id": 6, "method": "tools/call",
        "params": { "name": "fill_form", "arguments": { "text": "é".repeat(600_000) } }
    });
    writeln!(agent, "{large}").unwrap();
    assert_tool_error(
        &wait_for(&out, &mut seen, |l| l["id"] == 6),
        "invalid_arguments",
    );
    writeln!(agent, "{LIST}").unwrap();
    let mut seen = 0;
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 2)["result"]["echo"],
        "tools/call",
        "the call in flight is answered by sval"
    );
    drop(agent);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
    let ids: Vec<Value> = received
        .lock()
        .unwrap()
        .iter()
        .map(|m| m["id"].clone())
        .collect();
    assert_eq!(ids, [json!(2), json!(3)], "sval never saw the large call");
    assert_eq!(*connections.lock().unwrap(), 1, "one connection throughout");
}

/// What every handshake tells Sval of the launch: the directory, the start
/// time, and the id that tells its account from every other.
#[test]
fn the_handshake_says_where_and_when_the_bridge_was_launched() {
    let (port, handshakes) = pairing_sval();
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    run_once(&profile, store, launched_in("/work/sval"));
    let launch = handshakes.lock().unwrap()[0]["launch"].clone();
    let account = sval_mcp::bridge::account_for(&profile, "Test Agent");
    assert_eq!(
        launch,
        json!({
            "dir": "/work/sval",
            "started": 1_700_000_000_000u64,
            "id": sval_mcp::bridge::launch_id(&account),
            "build": sval_mcp::bridge::BUILD,
        })
    );
    let id = launch["id"].as_str().unwrap();
    assert!(id.len() == 16 && id.chars().all(|c| matches!(c, '0'..='9' | 'a'..='f')));
}

/// A client name cannot spell another app's account: each field stays one
/// JSON string, whatever it holds.
#[test]
fn a_client_name_cannot_spell_another_apps_account() {
    let profile = std::path::Path::new("/p");
    let spelled = sval_mcp::bridge::account_for(profile, r#"a","b"#);
    let fields: Vec<String> = serde_json::from_str(&spelled).unwrap();
    assert_eq!(fields, ["/p".to_owned(), r#"a","b"#.to_owned()]);
}

/// A Sval that completes its first handshake and then reads nothing more,
/// holding that connection open, and closes every later connection unread.
fn deaf_sval() -> (u16, Arc<Mutex<usize>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let connections = Arc::new(Mutex::new(0));
    let accepted = connections.clone();
    thread::spawn(move || {
        let mut held = Vec::new();
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            if !held.is_empty() {
                continue;
            }
            let nonce = read_challenge(&mut stream);
            let server_nonce = fresh_nonce().unwrap();
            write_frame(&mut stream, &proof_frame(&nonce, &server_nonce)).unwrap();
            read_frame(&mut stream).unwrap().unwrap();
            write_frame(&mut stream, &json!({ "ctl": { "ready": "unpaired" } })).unwrap();
            *accepted.lock().unwrap() += 1;
            held.push(stream);
        }
    });
    (port, connections)
}

/// A Sval that stops reading its socket while keeping it open cannot stall
/// the bridge: a write to it times out and drops the connection, each call
/// is answered, and the agent's `ping` with it.
#[test]
fn a_sval_that_stops_reading_does_not_stall_the_bridge() {
    let (port, connections) = deaf_sval();
    let profile = profile_with_port(port);
    let (reader, mut agent) = std::io::pipe().unwrap();
    let out = Captured::default();
    let (bridge_out, bridge_profile) = (out.clone(), profile.to_path_buf());
    let launch = Launch {
        write_timeout: Duration::from_millis(200),
        ..Launch::current()
    };
    thread::spawn(move || {
        let _ = run_launched(
            BufReader::new(reader),
            bridge_out,
            &bridge_profile,
            launch,
            Arc::new(MemoryStore::default()),
        );
    });
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    assert_initialized(&wait_for(&out, &mut seen, |l| l["id"] == 1));
    // More than the socket buffers of either end hold, so a write blocks.
    let filler = "x".repeat(900 * 1024);
    let calls = 40;
    for id in 0..calls {
        let call = json!({
            "jsonrpc": "2.0", "id": 10 + id, "method": "tools/call",
            "params": { "name": "echo", "arguments": { "text": filler } }
        });
        writeln!(agent, "{call}").unwrap();
    }
    writeln!(agent, r#"{{"jsonrpc":"2.0","id":99,"method":"ping"}}"#).unwrap();
    let answered = wait_until(
        Duration::from_secs(20),
        || format!("unanswered: {:?}", out.complete_lines()),
        || {
            let lines = out.complete_lines();
            let ids: Vec<Value> = lines.iter().map(|l| l["id"].clone()).collect();
            let all =
                (0..calls).all(|id| ids.contains(&json!(10 + id))) && ids.contains(&json!(99));
            all.then_some(lines)
        },
    );
    for id in 0..calls {
        let reply = answered.iter().find(|l| l["id"] == 10 + id).unwrap();
        assert_eq!(reply["result"]["isError"], true, "{reply}");
    }
    assert_eq!(*connections.lock().unwrap(), 1);
    drop(agent);
    let _ = seen;
}

/// A profile with its `sval-agents` directory and no port file, as one Sval is
/// not running on.
fn closed_profile(name: &str) -> TempProfile {
    let dir = TempProfile::new(format!("sval-mcp-{name}-{}", std::process::id()));
    std::fs::create_dir_all(dir.join("sval-agents")).unwrap();
    dir
}

/// A starter that counts its calls and does what `start` says to the
/// profile it is given.
fn counting_starter(
    start: impl Fn(&std::path::Path) -> std::io::Result<()> + Send + Sync + 'static,
) -> (Starter, Arc<Mutex<Vec<PathBuf>>>) {
    let calls = Arc::new(Mutex::new(Vec::new()));
    let seen = calls.clone();
    let starter: Starter = Arc::new(move |profile: &std::path::Path| {
        seen.lock().unwrap().push(profile.to_owned());
        start(profile)
    });
    (starter, calls)
}

/// A tool call while Sval is closed starts the Sval beside the shim on the
/// shim's profile, waits for it to listen, and is answered by it.
#[test]
fn a_tool_call_starts_sval_when_it_is_closed() {
    let profile = closed_profile("starts");
    let (port, _) = fake_sval(|_, _| vec![json!({ "ctl": { "ready": "unpaired" } })]);
    let (starter, calls) = counting_starter(move |profile| {
        // Sval writes its port file a moment after it starts.
        let profile = profile.to_owned();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            write_port_file(&profile, port, TOKEN);
        });
        Ok(())
    });
    let out = Captured::default();
    run_with(
        Cursor::new(format!("{INIT}\n{CALL}\n")),
        out.clone(),
        &profile,
        Launch::current(),
        Arc::new(MemoryStore::default()),
        starter,
    )
    .unwrap();
    assert_eq!(*calls.lock().unwrap(), vec![profile.to_path_buf()]);
    let lines = out.lines();
    assert_initialized(&lines[0]);
    assert_eq!(lines[1]["id"], 2);
    assert_eq!(
        lines[1]["result"]["echo"], "tools/call",
        "the call reaches the sval that started: {:?}",
        lines[1]
    );
}

/// While a started Sval has not yet listened, the agent is still served: its
/// ping is answered at once, and the call is answered once Sval listens.
#[test]
fn the_agent_is_served_while_sval_starts() {
    let profile = closed_profile("serves-while-starting");
    let (port, _) = fake_sval(|_, _| vec![json!({ "ctl": { "ready": "unpaired" } })]);
    // Sval writes its port file when the test says it has started.
    let (go, ready) = mpsc::channel::<()>();
    let ready = Mutex::new(Some(ready));
    let (starter, calls) = counting_starter(move |profile| {
        let (profile, ready) = (profile.to_owned(), ready.lock().unwrap().take().unwrap());
        thread::spawn(move || {
            ready.recv().unwrap();
            write_port_file(&profile, port, TOKEN);
        });
        Ok(())
    });
    let (reader, mut agent) = std::io::pipe().unwrap();
    let out = Captured::default();
    let (done, finished) = mpsc::channel();
    let bridge_out = out.clone();
    let bridge_profile = profile.to_path_buf();
    thread::spawn(move || {
        run_with(
            BufReader::new(reader),
            bridge_out,
            &bridge_profile,
            Launch::current(),
            Arc::new(MemoryStore::default()),
            starter,
        )
        .unwrap();
        let _ = done.send(());
    });
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    writeln!(agent, "{CALL}").unwrap();
    writeln!(agent, r#"{{"jsonrpc":"2.0","id":9,"method":"ping"}}"#).unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 9)["result"],
        json!({})
    );
    assert!(
        out.complete_lines().iter().all(|l| l["id"] != 2),
        "the call waits for sval"
    );
    assert_eq!(calls.lock().unwrap().len(), 1, "sval was started");
    go.send(()).unwrap();
    let mut seen = 0;
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 2)["result"]["echo"],
        "tools/call"
    );
    drop(agent);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
}

#[test]
fn initialize_alone_starts_no_sval() {
    let profile = closed_profile("no-start");
    let (starter, calls) = counting_starter(|_| Ok(()));
    run_with(
        Cursor::new(format!("{INIT}\n{LIST}\n")),
        Captured::default(),
        &profile,
        Launch::current(),
        Arc::new(MemoryStore::default()),
        starter,
    )
    .unwrap();
    assert!(calls.lock().unwrap().is_empty());
}

/// A Sval that cannot be started is reported as not running, and is not
/// started again for the next call straight after.
#[test]
fn a_sval_that_will_not_start_is_not_running() {
    let profile = closed_profile("will-not-start");
    let (starter, calls) = counting_starter(|_| Err(std::io::Error::other("no browser here")));
    let out = Captured::default();
    let second = CALL.replace("\"id\":2", "\"id\":4");
    run_with(
        Cursor::new(format!("{INIT}\n{CALL}\n{second}\n")),
        out.clone(),
        &profile,
        Launch::current(),
        Arc::new(MemoryStore::default()),
        starter,
    )
    .unwrap();
    let lines = out.lines();
    assert_tool_error(&lines[1], "sval_not_running");
    assert_tool_error(&lines[2], "sval_not_running");
    assert_eq!(calls.lock().unwrap().len(), 1, "it is tried once");
}

/// A Sval.app that never verifies is not started, and the call says it is
/// being installed or is damaged. The agent is served while the starter
/// waits on it.
#[test]
fn a_sval_that_does_not_verify_is_being_installed() {
    let profile = closed_profile("unverified");
    let (go, ready) = mpsc::channel::<()>();
    let ready = Mutex::new(ready);
    let (starter, calls) = counting_starter(move |_| {
        ready.lock().unwrap().recv().unwrap();
        Err(std::io::Error::other(sval_mcp::launch::Unverified))
    });
    let (reader, mut agent) = std::io::pipe().unwrap();
    let out = Captured::default();
    let (done, finished) = mpsc::channel();
    let bridge_out = out.clone();
    let bridge_profile = profile.to_path_buf();
    thread::spawn(move || {
        run_with(
            BufReader::new(reader),
            bridge_out,
            &bridge_profile,
            Launch::current(),
            Arc::new(MemoryStore::default()),
            starter,
        )
        .unwrap();
        let _ = done.send(());
    });
    let mut seen = 0;
    writeln!(agent, "{INIT}").unwrap();
    writeln!(agent, "{CALL}").unwrap();
    writeln!(agent, r#"{{"jsonrpc":"2.0","id":9,"method":"ping"}}"#).unwrap();
    assert_eq!(
        wait_for(&out, &mut seen, |l| l["id"] == 9)["result"],
        json!({})
    );
    assert!(
        out.complete_lines().iter().all(|l| l["id"] != 2),
        "the call waits for the starter"
    );
    go.send(()).unwrap();
    let mut seen = 0;
    assert_tool_error(
        &wait_for(&out, &mut seen, |l| l["id"] == 2),
        "sval_installing",
    );
    assert_eq!(calls.lock().unwrap().len(), 1);
    drop(agent);
    finished.recv_timeout(Duration::from_secs(5)).unwrap();
}

/// A Sval that holds the profile and has written no port file has agent access
/// off: the call says so, and no second Sval is started.
#[cfg(unix)]
#[test]
fn a_running_sval_with_access_off_is_told_apart_from_none() {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    let profile = closed_profile("access-off");
    let lock = profile.join(".parentlock");
    std::fs::write(&lock, b"").unwrap();
    // The POSIX write lock Firefox takes on a profile it runs on.
    let mut sval = Command::new("python3")
        .arg("-c")
        .arg("import fcntl,sys;f=open(sys.argv[1],'w');fcntl.lockf(f,fcntl.LOCK_EX);print('held',flush=True);sys.stdin.read()")
        .arg(&lock)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("python3 runs");
    let mut line = String::new();
    std::io::BufReader::new(sval.stdout.as_mut().unwrap())
        .read_line(&mut line)
        .unwrap();
    let (starter, calls) = counting_starter(|_| Ok(()));
    let out = Captured::default();
    run_with(
        Cursor::new(format!("{INIT}\n{CALL}\n")),
        out.clone(),
        &profile,
        Launch::current(),
        Arc::new(MemoryStore::default()),
        starter,
    )
    .unwrap();
    drop(sval.stdin.take());
    sval.wait().unwrap();
    assert_tool_error(&out.lines()[1], "access_off");
    assert!(
        calls.lock().unwrap().is_empty(),
        "no second sval is started"
    );
}

/// The real `sval-mcp`, run as an agent runs it, from a copy at `exe`, with
/// the agent's side of its pipes kept by the test. It is killed when dropped.
#[cfg(unix)]
struct Shim {
    child: std::process::Child,
    agent: std::process::ChildStdin,
    out: Captured,
}

#[cfg(unix)]
impl Shim {
    fn start(exe: &std::path::Path, profile: &std::path::Path) -> Shim {
        use std::io::BufRead;
        use std::process::{Command, Stdio};
        let mut child = Command::new(exe)
            .arg("--profile")
            .arg(profile)
            .current_dir(exe.parent().unwrap())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let agent = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let out = Captured::default();
        let mut sink = out.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { return };
                writeln!(sink, "{line}").unwrap();
            }
        });
        Shim { child, agent, out }
    }
}

#[cfg(unix)]
impl Drop for Shim {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// Puts `contents` at `path` as an update does: a new file renamed over it.
///
/// A child `sh` writes the new file, so this process never holds a writable
/// descriptor on a file a test then executes. If it did, a process another
/// test thread forks meanwhile would inherit that descriptor until it execs,
/// and Linux refuses to execute a file open for writing (`ETXTBSY`,
/// rust-lang/rust#114554).
#[cfg(unix)]
fn replace_file(path: &std::path::Path, contents: &[u8]) {
    use std::process::{Command, Stdio};
    let new = path.with_extension("new");
    let mut sh = Command::new("sh")
        .arg("-c")
        .arg(r#"cat > "$1" && chmod 755 "$1""#)
        .arg("sh")
        .arg(&new)
        .stdin(Stdio::piped())
        .spawn()
        .unwrap();
    sh.stdin.take().unwrap().write_all(contents).unwrap();
    assert!(sh.wait().unwrap().success(), "sh wrote {}", new.display());
    std::fs::rename(&new, path).unwrap();
}

#[cfg(unix)]
#[test]
fn an_updated_shim_takes_over_between_requests_without_the_agent_seeing_a_restart() {
    let profile = closed_profile("self-update");
    let install = TempProfile::new(format!("sval-mcp-install-{}", std::process::id()));
    std::fs::create_dir_all(&*install).unwrap();
    let exe = install.join("sval-mcp");
    let built = std::fs::read(env!("CARGO_BIN_EXE_sval-mcp")).unwrap();
    replace_file(&exe, &built);

    let first = sval_run(
        TOKEN,
        vec![
            json!({ "ctl": { "ready": "unpaired" } }),
            json!({ "ctl": { "paired": { "agent_id": "a1", "secret": "s1" } } }),
        ],
    );
    write_port_file(&profile, first.port, TOKEN);
    let mut shim = Shim::start(&exe, &profile);
    let mut seen = 0;
    writeln!(shim.agent, "{INIT}").unwrap();
    assert_initialized(&wait_for(&shim.out, &mut seen, |l| l["id"] == 1));
    writeln!(
        shim.agent,
        r#"{{"jsonrpc":"2.0","method":"notifications/initialized"}}"#
    )
    .unwrap();
    writeln!(shim.agent, "{LIST}").unwrap();
    assert_eq!(
        wait_for(&shim.out, &mut seen, |l| l["id"] == 3)["result"],
        json!({ "echo": "tools/list" })
    );

    // A new file of the same build is no update: the shim stays, and its
    // connection with it. The file records that the shim asked its build,
    // and answers with the running one.
    let running = std::process::Command::new(env!("CARGO_BIN_EXE_sval-mcp"))
        .arg("--version")
        .output()
        .unwrap()
        .stdout;
    let asked = install.join("asked");
    let same = format!(
        "#!/bin/sh\n\
         [ \"$1\" = --version ] && {{ touch '{}'; printf '%s' '{}'; exit 0; }}\n\
         exit 1\n",
        asked.display(),
        String::from_utf8(running).unwrap()
    );
    replace_file(&exe, same.as_bytes());
    wait_until(
        Duration::from_secs(10),
        || "the shim never asked the new file its build".into(),
        || asked.exists().then_some(()),
    );
    writeln!(
        shim.agent,
        r#"{{"jsonrpc":"2.0","id":4,"method":"tools/list"}}"#
    )
    .unwrap();
    assert_eq!(
        wait_for(&shim.out, &mut seen, |l| l["id"] == 4)["result"],
        json!({ "echo": "tools/list" }),
        "the first sval still answers"
    );

    // An update brings another build, which records its arguments and runs
    // the real shim. Sval restarts with the update, on a new port.
    let real = install.join("real-sval-mcp");
    replace_file(&real, &built);
    let args = install.join("args");
    let script = format!(
        "#!/bin/sh\n\
         [ \"$1\" = --version ] && {{ echo 'sval-mcp test-update'; exit 0; }}\n\
         echo \"$@\" > '{}'\n\
         exec '{}' \"$@\"\n",
        args.display(),
        real.display()
    );
    let second = sval_run(TOKEN_B, vec![json!({ "ctl": { "ready": "paired" } })]);
    write_port_file(&profile, second.port, TOKEN_B);
    replace_file(&exe, script.as_bytes());

    wait_until(
        Duration::from_secs(10),
        || "the updated shim never reached sval".into(),
        || (!second.received.lock().unwrap().is_empty()).then_some(()),
    );
    assert_eq!(
        std::fs::read_to_string(&args).unwrap().trim(),
        format!("--profile {}", profile.display()),
        "the update runs with the shim's own arguments"
    );
    let received = second.received.lock().unwrap().clone();
    assert_eq!(
        received[0],
        json!({ "hello": 3, "agent_id": "a1", "secret": "s1" }),
        "the same account, still paired"
    );

    writeln!(
        shim.agent,
        r#"{{"jsonrpc":"2.0","id":5,"method":"tools/list"}}"#
    )
    .unwrap();
    assert_eq!(
        wait_for(&shim.out, &mut seen, |l| l["id"] == 5)["result"],
        json!({ "echo": "tools/list" }),
        "the agent's next request reaches the restarted sval"
    );
    let ids: Vec<Value> = shim
        .out
        .complete_lines()
        .iter()
        .map(|l| l["id"].clone())
        .collect();
    assert_eq!(
        ids,
        [1, 3, 4, 5].map(Value::from),
        "the agent is answered once each, and told nothing of the restart"
    );
}

/// Real `sval-mcp` processes sharing one profile, as two agent sessions are:
/// which account each takes, by the launch id each handshake carries.
mod live_processes {
    use super::*;
    use std::process::{Child, Command, Stdio};

    /// A `sval-mcp` process on `profile`, launched in `dir`, that has sent
    /// `INIT`. It is killed when this is dropped, so a failing test leaves no
    /// process behind.
    struct Shim(Child);

    impl Shim {
        fn start(profile: &std::path::Path, dir: &std::path::Path) -> Shim {
            std::fs::create_dir_all(dir).unwrap();
            let mut child = Command::new(env!("CARGO_BIN_EXE_sval-mcp"))
                .arg("--profile")
                .arg(profile)
                .current_dir(dir)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            writeln!(child.stdin.as_mut().unwrap(), "{INIT}").unwrap();
            Shim(child)
        }

        /// Ends the session as an agent does, by closing its input.
        fn end(mut self) {
            drop(self.0.stdin.take());
            self.0.wait().unwrap();
        }
    }

    impl Drop for Shim {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    /// The launch id of the `count`th handshake, once it has arrived.
    fn launch_id(handshakes: &Shared<Value>, count: usize) -> Value {
        wait_until(
            Duration::from_secs(10),
            || format!("no handshake {count}"),
            || (handshakes.lock().unwrap().len() >= count).then_some(()),
        );
        handshakes.lock().unwrap()[count - 1]["launch"]["id"].clone()
    }

    /// Live processes of one app, in any directories, are one agent, and
    /// leave nothing in the profile but the port file and the app's secret.
    #[test]
    fn live_processes_of_one_app_share_its_account() {
        let (port, handshakes) = pairing_sval();
        let profile = profile_with_port(port);
        let shims: Vec<Shim> = ["one", "one", "two"]
            .iter()
            .enumerate()
            .map(|(n, dir)| {
                let shim = Shim::start(&profile, &profile.join(dir));
                launch_id(&handshakes, n + 1);
                shim
            })
            .collect();
        let ids: Vec<Value> = (1..=3).map(|n| launch_id(&handshakes, n)).collect();
        assert!(ids.iter().all(|id| *id == ids[0]), "{ids:?}");
        let names: Vec<String> = std::fs::read_dir(profile.join("sval-agents"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != "port.json" && !name.starts_with("secret-"))
            .collect();
        assert!(names.is_empty(), "{names:?}");
        for shim in shims {
            shim.end();
        }
    }
}

/// What a modern request carries in its `_meta` (MCP 2026-07-28).
fn modern_meta() -> Value {
    json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { "name": "Modern Agent", "version": "1" },
        "io.modelcontextprotocol/clientCapabilities": {}
    })
}

/// A modern request of `method`, with `params` beside its `_meta`.
fn modern(id: Value, method: &str, params: Value) -> String {
    let mut params = params;
    params["_meta"] = modern_meta();
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }).to_string()
}

fn assert_modern_result(reply: &Value) {
    assert_eq!(reply["result"]["resultType"], "complete", "{reply}");
    assert_eq!(
        reply["result"]["_meta"]["io.modelcontextprotocol/serverInfo"]["name"], "sval",
        "{reply}"
    );
}

/// A modern client sends no `initialize`: the bridge answers its discovery
/// itself, and serves its requests without Sval as it serves a legacy
/// client's, in the shape a modern result has.
#[test]
fn serves_a_modern_client_with_no_initialize_while_sval_is_away() {
    let profile = TempProfile::new(format!("sval-mcp-modern-{}", std::process::id()));
    std::fs::create_dir_all(&*profile).unwrap();
    let out = Captured::default();
    let input = [
        modern(json!("d"), "server/discover", json!({})),
        modern(json!(2), "tools/list", json!({})),
        modern(
            json!(3),
            "tools/call",
            json!({ "name": "list_tabs", "arguments": {} }),
        ),
        json!({ "jsonrpc": "2.0", "id": 4, "method": "tools/list", "params": { "_meta": {
            "io.modelcontextprotocol/protocolVersion": "2099-01-01",
            "io.modelcontextprotocol/clientCapabilities": {}
        } } })
        .to_string(),
    ]
    .join("\n");
    run(
        Cursor::new(format!("{input}\n")),
        out.clone(),
        &profile,
        Arc::new(MemoryStore::default()),
    )
    .unwrap();
    let lines = out.lines();
    assert_eq!(lines.len(), 4, "{lines:?}");
    assert_eq!(lines[0]["id"], "d");
    assert_eq!(
        lines[0]["result"]["instructions"],
        sval_mcp::mcp::SERVER_INSTRUCTIONS
    );
    assert_eq!(
        lines[0]["result"]["supportedVersions"],
        json!(["2026-07-28", "2025-11-25", "2025-06-18"])
    );
    assert_modern_result(&lines[0]);
    assert_eq!(lines[1]["result"]["tools"], json!([]));
    assert_eq!(lines[1]["result"]["ttlMs"], 0);
    assert_eq!(lines[1]["result"]["cacheScope"], "private");
    assert_modern_result(&lines[1]);
    // The call waits for the start to fail, so the refusal can come first.
    let answer = |id: i64| lines.iter().find(|l| l["id"] == id).unwrap();
    assert_tool_error(answer(3), "sval_not_running");
    assert_modern_result(answer(3));
    assert_eq!(answer(4)["error"]["code"], -32022);
    assert_eq!(answer(4)["error"]["data"]["requested"], "2099-01-01");
}

/// A modern client's requests reach Sval as it sent them, with nothing
/// replayed before them, and a change of tools Sval reports reaches each
/// stream that asked to hear of one, by its id, and no other.
#[test]
fn relays_a_modern_clients_requests_and_tells_its_subscriptions_of_new_tools() {
    let received: Shared<Value> = Arc::new(Mutex::new(Vec::new()));
    let seen = received.clone();
    let (port, _, _) = fake_sval_answering(
        |_, _| vec![json!({ "ctl": { "ready": "paired" } })],
        move |request| {
            seen.lock().unwrap().push(request.clone());
            let mut replies = echo(request);
            if request["method"] == "tools/call" {
                replies.push(json!({ "mcp": { "jsonrpc": "2.0", "method": "notifications/tools/list_changed" } }));
            }
            replies
        },
    );
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    store
        .save(&account(&profile, "Modern Agent"), &stored_secret())
        .unwrap();
    let out = Captured::default();
    let call = modern(
        json!(5),
        "tools/call",
        json!({ "name": "list_tabs", "arguments": {} }),
    );
    let input = [
        modern(json!("tools"), "subscriptions/listen", json!({ "notifications": { "toolsListChanged": true } })),
        modern(json!("other"), "subscriptions/listen", json!({ "notifications": { "promptsListChanged": true } })),
        modern(json!("gone"), "subscriptions/listen", json!({ "notifications": { "toolsListChanged": true } })),
        json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": "gone" } })
            .to_string(),
        call.clone(),
    ]
    .join("\n");
    run(
        Cursor::new(format!("{input}\n")),
        out.clone(),
        &profile,
        store,
    )
    .unwrap();

    let lines = out.lines();
    let acks: Vec<&Value> = lines
        .iter()
        .filter(|l| l["method"] == "notifications/subscriptions/acknowledged")
        .collect();
    assert_eq!(acks.len(), 3, "{lines:?}");
    assert_eq!(
        acks[0]["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"],
        "tools"
    );
    assert_eq!(
        acks[0]["params"]["notifications"],
        json!({ "toolsListChanged": true })
    );
    assert_eq!(
        acks[1]["params"]["notifications"],
        json!({}),
        "prompts are not Sval's to tell of"
    );
    let changed: Vec<&Value> = lines
        .iter()
        .filter(|l| l["method"] == "notifications/tools/list_changed")
        .collect();
    assert_eq!(changed.len(), 1, "{lines:?}");
    assert_eq!(
        changed[0]["params"]["_meta"]["io.modelcontextprotocol/subscriptionId"],
        "tools"
    );
    assert!(lines.iter().any(|l| l["id"] == 5), "the call is answered");
    assert!(
        lines
            .iter()
            .all(|l| l["id"] != "tools" && l["id"] != "other"),
        "an open stream is not answered: {lines:?}"
    );
    let received = received.lock().unwrap();
    let call: Value = serde_json::from_str(&call).unwrap();
    assert_eq!(*received, vec![call], "Sval gets the call alone, as sent");
}
