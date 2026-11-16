// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! stdio MCP on one side, Sval's loopback socket on the other.
//!
//! Sval is found through `<profile>/sval-agents/port.json`, which holds its
//! port and a token. Sval keeps it in a directory only its OS user can open, so
//! only that user's processes can read the token. That file survives a crash,
//! so the port may belong to another process. Before any handshake or secret
//! is sent, the listener must answer a fresh challenge with the HMAC proof only
//! the token can produce (see `proof`). Sval sends its own challenge with that
//! proof, and the handshake answers it, because Sval in turn only talks to a
//! process that can read the port file. The whole exchange has one deadline
//! (`HANDSHAKE_TIMEOUT`), after which Sval counts as unavailable.

use crate::frame::{encode_frame, read_frame, write_frame};
use crate::proof;
use crate::secrets::{digest_of, Credentials, SecretStore};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fmt;
use std::io::{BufRead, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub enum BridgeError {
    Io(std::io::Error),
    Protocol(String),
    /// Sval does not speak this shim's handshake, so the shim is older than
    /// the Sval that answered.
    Outdated,
}

impl fmt::Display for BridgeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            BridgeError::Io(e) => write!(f, "i/o: {e}"),
            BridgeError::Protocol(m) => write!(f, "protocol: {m}"),
            BridgeError::Outdated => write!(f, "Sval refused this sval-mcp as outdated"),
        }
    }
}

impl From<std::io::Error> for BridgeError {
    fn from(e: std::io::Error) -> Self {
        BridgeError::Io(e)
    }
}

/// One credential per AI app per profile: the user allows an app once, and
/// every session of it on this device connects as that one agent (decision
/// 1998). The fields are encoded as a JSON array, so no client name can spell
/// another app's account.
pub fn account_for(profile: &Path, client_name: &str) -> String {
    json!([profile.display().to_string(), client_name]).to_string()
}

/// The id that tells this app's launches from every other app's, the same
/// every time the account is used. Sval keys a pairing in flight on it, so
/// sessions of one app that ask at once share one alert.
pub fn launch_id(account: &str) -> String {
    digest_of(account)[..16].to_owned()
}

/// Where and when this `sval-mcp` was started, as the OS reports it. The agent
/// that launched it chose none of it, which is why Sval shows it beside the
/// name the agent gives.
#[derive(Clone, Debug)]
pub struct Launch {
    pub dir: PathBuf,
    /// Milliseconds since the Unix epoch.
    pub started: u64,
    /// How long each handshake has, from the first connect to `ready`.
    pub handshake_timeout: Duration,
    /// How long one write to Sval may wait once the handshake is done.
    pub write_timeout: Duration,
}

impl Launch {
    /// The process's working directory, which an MCP client sets to the one
    /// it was launched in, and the time now.
    pub fn current() -> Launch {
        // `current_dir` is absolute, and is kept as the OS gives it, so a
        // Windows path shows as the user knows it.
        Launch {
            dir: std::env::current_dir().unwrap_or_default(),
            started: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX)),
            handshake_timeout: HANDSHAKE_TIMEOUT,
            write_timeout: WRITE_TIMEOUT,
        }
    }
}

/// How much of the launch directory the handshake carries, as JSON text. Sval
/// reads at most 4 KiB before a handshake completes, so a deep path keeps its
/// end, which names the directory.
const MAX_DIR_JSON_BYTES: usize = 1024;

fn dir_for_handshake(dir: &Path) -> String {
    let full = dir.display().to_string();
    let mut used = 0;
    let mut tail = Vec::new();
    for c in full.chars().rev() {
        let escaped = serde_json::to_string(&c.to_string()).map_or(6, |t| t.len() - 2);
        if used + escaped > MAX_DIR_JSON_BYTES {
            tail.push('…');
            break;
        }
        used += escaped;
        tail.push(c);
    }
    tail.into_iter().rev().collect()
}

const AGENT_DIR: &str = "sval-agents";
const PORT_FILE: &str = "port.json";

/// The directory in `profile` that only its owner can open, where Sval keeps the
/// port file and `sval-mcp` keeps each agent's secret.
pub fn agent_dir(profile: &Path) -> PathBuf {
    profile.join(AGENT_DIR)
}

/// What Sval wrote beside its port: the token it must present before this
/// process sends it anything.
struct Listener {
    port: u16,
    token: String,
}

fn read_listener(profile: &Path) -> Option<Listener> {
    let text = std::fs::read_to_string(agent_dir(profile).join(PORT_FILE)).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let token = value["token"].as_str().filter(|t| proof::is_hex64(t))?;
    Some(Listener {
        port: u16::try_from(value["port"].as_u64()?).ok()?,
        token: token.to_owned(),
    })
}

fn write_line(out: &mut impl Write, message: &Value) -> std::io::Result<()> {
    serde_json::to_writer(&mut *out, message)?;
    out.write_all(b"\n")?;
    out.flush()
}

/// The wire protocol this shim speaks, the handshake's `hello`. Sval accepts
/// the one it speaks and the one before it, so a shim from the previous build
/// keeps working (sval-mcp-ships-with-sval spec §6).
const HELLO: u64 = 1;

/// The build of Sval this shim was packaged with. The release build sets
/// `SVAL_BUILD_ID` to Sval's build id, and any other build reports the crate
/// version. Sval logs it, and it is never matched: `HELLO` decides whether
/// the two can talk.
pub const BUILD: &str = match option_env!("SVAL_BUILD_ID") {
    Some(build) => build,
    None => concat!(env!("CARGO_PKG_VERSION"), "-dev"),
};

/// How long the whole handshake has, from the first connect to `ready`. A port
/// file left by a crashed Sval can name a port that something else now holds,
/// and that something can answer a byte at a time.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(5);

/// How long a write to Sval may wait after the handshake. Every write runs on
/// the bridge's one loop, so a Sval that stops reading its socket while
/// keeping it open would otherwise stall the agent's `ping`, its
/// cancellations and every other answer. A write that times out drops the
/// connection, as one Sval closed would.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);

fn timed_out() -> std::io::Error {
    std::io::ErrorKind::TimedOut.into()
}

/// A stream whose every read and write must finish before one deadline. Each
/// call is given only the time that remains, so a peer that trickles a byte at
/// a time cannot stretch the handshake.
struct Deadlined<'a> {
    stream: &'a mut TcpStream,
    deadline: Instant,
}

impl Deadlined<'_> {
    fn remaining(&self) -> std::io::Result<Duration> {
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(timed_out)
    }
}

impl Read for Deadlined<'_> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        self.stream.set_read_timeout(Some(self.remaining()?))?;
        self.stream.read(buf)
    }
}

impl Write for Deadlined<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.stream.set_write_timeout(Some(self.remaining()?))?;
        self.stream.write(buf)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.stream.flush()
    }
}

/// Connects, makes the listener prove it is Sval, and completes the handshake.
///
/// Sval's challenge must be 64 lowercase hex characters before it is signed,
/// and the stored secret is sent only after the listener's proof checks out.
/// `remembered` is the secret Sval issued
/// earlier in this run, used when the store has none, so a store that could
/// not save it does not make every reconnect pair again. A secret Sval refuses
/// is forgotten in both places, and the second attempt, with its own fresh
/// challenge, always pairs, whether or not the store managed to forget.
fn connect(
    listener: &Listener,
    store: &dyn SecretStore,
    account: &str,
    session: &Value,
    timeout: Duration,
    write_timeout: Duration,
    remembered: &mut Option<Credentials>,
) -> Result<TcpStream, BridgeError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, listener.port));
    let deadline = Instant::now() + timeout;
    for attempt in 0..2 {
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(timed_out)?;
        let mut stream = TcpStream::connect_timeout(&address, left)?;
        let mut io = Deadlined {
            stream: &mut stream,
            deadline,
        };

        let nonce = proof::fresh_nonce()
            .map_err(|e| BridgeError::Protocol(format!("no random bytes for a challenge: {e}")))?;
        write_frame(&mut io, &json!({ "challenge": nonce }))?;
        let answer = read_frame(&mut io)?
            .ok_or_else(|| BridgeError::Protocol("the listener closed before answering".into()))?;
        let proved = answer["ctl"]["sval"]
            .as_str()
            .is_some_and(|p| proof::verify(&listener.token, proof::Side::Sval, &nonce, p));
        if !proved {
            return Err(BridgeError::Protocol(
                "the listener did not prove it is Sval".into(),
            ));
        }
        let Some(server_nonce) = answer["ctl"]["challenge"]
            .as_str()
            .filter(|n| proof::is_hex64(n))
        else {
            return Err(BridgeError::Protocol(
                "Sval sent no usable challenge".into(),
            ));
        };
        let agent_proof = proof::proof_for(&listener.token, proof::Side::Agent, server_nonce);

        let stored = if attempt == 0 {
            store.load(account).or_else(|| remembered.clone())
        } else {
            None
        };
        let mut hello = match stored {
            Some(c) => json!({
                "hello": HELLO, "agent_id": c.agent_id, "secret": c.secret, "proof": agent_proof
            }),
            None => json!({ "hello": HELLO, "pair": true, "proof": agent_proof }),
        };
        if let (Some(hello), Some(session)) = (hello.as_object_mut(), session.as_object()) {
            hello.extend(session.clone());
        }
        write_frame(&mut io, &hello)?;
        let reply = read_frame(&mut io)?
            .ok_or_else(|| BridgeError::Protocol("Sval closed during the handshake".into()))?;
        if reply["ctl"]["ready"].is_string() {
            stream.set_read_timeout(None)?;
            stream.set_write_timeout(Some(write_timeout))?;
            return Ok(stream);
        }
        if reply["ctl"]["refused"] == "outdated" {
            // The secret is still good: a Sval that speaks this handshake
            // again, such as one rolled back, accepts it.
            return Err(BridgeError::Outdated);
        }
        if reply["ctl"]["refused"] == "unknown_agent" {
            store.forget(account);
            *remembered = None;
            continue;
        }
        return Err(BridgeError::Protocol("unexpected handshake reply".into()));
    }
    Err(BridgeError::Protocol(
        "Sval refused a fresh pairing handshake".into(),
    ))
}

/// The agent's name, from the first message it sends.
///
/// Older MCP clients open with `initialize`, which carries the name at
/// `params.clientInfo.name`. Newer ones open with a `server/discover` probe,
/// and every modern request carries the name at
/// `params._meta["io.modelcontextprotocol/clientInfo"].name`. The name
/// forms the secret store's account, so a client that sends the probe first
/// must not fall back to the generic name and share an account with every other
/// such client.
fn client_name_of(first: &Value) -> String {
    let params = &first["params"];
    params["clientInfo"]["name"]
        .as_str()
        .or_else(|| params["_meta"]["io.modelcontextprotocol/clientInfo"]["name"].as_str())
        .unwrap_or("Agent")
        .to_owned()
}

// The MCP versions Sval speaks, which `build.rs` takes from
// `SvalAgentSession.sys.mjs`. The bridge answers `initialize` and
// `server/discover` itself, and Sval checks each modern request's version as
// the bridge does, so the two agree.
include!(concat!(env!("OUT_DIR"), "/protocol_versions.rs"));

/// The `_meta` keys of a modern request, result and notification (MCP
/// 2026-07-28, "_meta").
const VERSION_KEY: &str = "io.modelcontextprotocol/protocolVersion";
const CAPABILITIES_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY: &str = "io.modelcontextprotocol/serverInfo";
const SUBSCRIPTION_KEY: &str = "io.modelcontextprotocol/subscriptionId";
/// MCP's `UNSUPPORTED_PROTOCOL_VERSION` error code.
const UNSUPPORTED_PROTOCOL_VERSION: i64 = -32022;

/// Every version Sval speaks, newest first, as `server/discover` and an
/// unsupported version are told.
fn supported_versions() -> Vec<&'static str> {
    LEGACY_PROTOCOL_VERSIONS
        .iter()
        .chain(MODERN_PROTOCOL_VERSIONS)
        .rev()
        .copied()
        .collect()
}

/// How one request of the agent's is served, by the version its `_meta` names.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Era {
    /// It names none, as a request after `initialize` does.
    Unversioned,
    /// It names a version that opens with `initialize`.
    Legacy,
    /// It names a version that carries its version and the client's
    /// capabilities on every request.
    Modern,
}

/// The era of `message`, or the error that refuses it: a version Sval does not
/// speak is told the ones it does, so the client picks one and asks again, and
/// a modern request without the client's capabilities is malformed.
fn era_of(message: &Value) -> Result<Era, Value> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    let meta = &message["params"]["_meta"];
    let Some(version) = meta.get(VERSION_KEY) else {
        return Ok(Era::Unversioned);
    };
    let Some(version) = version.as_str() else {
        return Err(failure(
            id,
            -32602,
            &format!("invalid params: {VERSION_KEY}"),
        ));
    };
    if MODERN_PROTOCOL_VERSIONS.contains(&version) {
        if !meta[CAPABILITIES_KEY].is_object() {
            return Err(failure(
                id,
                -32602,
                &format!("invalid params: {CAPABILITIES_KEY}"),
            ));
        }
        return Ok(Era::Modern);
    }
    if LEGACY_PROTOCOL_VERSIONS.contains(&version) {
        return Ok(Era::Legacy);
    }
    Err(json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": UNSUPPORTED_PROTOCOL_VERSION,
            "message": "Unsupported protocol version",
            "data": { "supported": supported_versions(), "requested": version }
        }
    }))
}

/// How often the port file is read while Sval is away, to tell the agent when
/// Sval is back.
const PORT_FILE_POLL: Duration = Duration::from_secs(1);

/// What `initialize` and `server/discover` tell the agent's model about Sval:
/// Sval's own `SERVER_INSTRUCTIONS` from `SvalAgentSession.sys.mjs`, which
/// `build.rs` takes from its source. The bridge answers both before Sval is
/// reached, and Sval's answer to a replayed `initialize` is dropped, so this is
/// the text the agent keeps.
pub const SERVER_INSTRUCTIONS: &str =
    include_str!(concat!(env!("OUT_DIR"), "/server_instructions.txt"));

/// A tool error the bridge makes itself, each a code and its message.
const NOT_RUNNING: (&str, &str) = (
    "sval_not_running",
    "Sval is not running, or agent access is off in Sval's settings. Ask the user to start Sval or turn agent access on in its settings, then try again.",
);
const ACCESS_OFF: (&str, &str) = (
    "access_off",
    "Sval is running, but agent access is off in its settings. Ask the user to turn agent access on in Sval's settings, then try again.",
);
const UNVERIFIED: (&str, &str) = (
    "sval_installing",
    "Sval was not started: its app is being installed or updated, or is damaged. Try again in a minute. If this keeps happening, ask the user to reinstall Sval.",
);
const OUTDATED: (&str, &str) = (
    "sval_mcp_outdated",
    "Sval has updated, and this sval-mcp is older than it. Ask the user to restart this agent, which loads the updated sval-mcp, then try again.",
);
/// A request Sval would refuse to read. It fails alone: the connection, and
/// every other call on it, carries on.
const TOO_LARGE: (&str, &str) = (
    "invalid_arguments",
    "The request is over 1 MiB, the most Sval reads in one message. Send less in one call, such as fewer or shorter fields.",
);
const DISCONNECTED: (&str, &str) = (
    "sval_disconnected",
    "Sval closed the connection before answering, so the call may or may not have run. Check before trying again.",
);

/// A request of the agent's that waits for an answer.
#[derive(Clone)]
struct Asked {
    method: String,
    /// Whether a modern request asked it, whose result carries what
    /// `dressed` adds.
    modern: bool,
}

/// What Sval owes an answer to on one connection.
enum Owed {
    /// A request of the agent's.
    Agent(Asked),
    /// The replayed `initialize`, which the agent already had answered.
    Replay,
}

/// One authenticated connection to Sval.
struct Connection {
    /// Tells this connection's events from those of one already closed.
    serial: u64,
    stream: TcpStream,
    /// Requests sent on this connection and not yet answered, keyed by the
    /// JSON of their id, with the id itself.
    owed: HashMap<String, (Value, Owed)>,
}

/// A Sval this shim started and has not yet seen listen, with the requests
/// that wait for it. The bridge keeps serving meanwhile, so the agent's
/// `ping` is answered while Sval starts.
struct Starting {
    /// Tells this start's [`Event::Launched`] from that of one already over.
    serial: u64,
    /// The token of a port file found before the start: a crashed Sval's,
    /// so only another one is waited for.
    stale: Option<String>,
    /// When the start is over: `START_WAIT` after the starter returns, and
    /// at the latest `LAUNCH_WAIT` after it is called, a bound that holds if
    /// the starter never returns.
    deadline: Instant,
    /// Each waiting request, its id and its frame, in the order sent.
    waiting: Vec<(Asked, Value, Vec<u8>)>,
}

enum Event {
    Agent(std::io::Result<String>),
    AgentClosed,
    Sval(u64, Value),
    SvalClosed(u64, Option<std::io::Error>),
    /// The starter of start `serial` has returned.
    Launched(u64, std::io::Result<()>),
}

fn result(id: Value, value: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": value })
}

fn failure(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// A failed tool call's result, in the one shape every tool error has, Sval's
/// included: JSON text carrying `error` and a `message` that starts with the
/// code. Sval's own tool results are relayed as Sval sent them.
fn tool_error((code, message): (&str, &str)) -> Value {
    let text = json!({ "error": code, "message": format!("{code}: {message}") }).to_string();
    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
}

fn list_changed() -> Value {
    json!({ "jsonrpc": "2.0", "method": "notifications/tools/list_changed" })
}

/// A result the bridge gives a modern request, with the fields a modern result
/// carries, as Sval's `#dressed` gives them: its `resultType`, the server's
/// name and version, and on a tool list the caching hints, which say a list is
/// the agent's own and stale at once.
fn dressed(method: &str, mut value: Value) -> Value {
    let Some(fields) = value.as_object_mut() else {
        return value;
    };
    fields.insert("resultType".into(), json!("complete"));
    let meta = fields.entry("_meta").or_insert_with(|| json!({}));
    if let Some(meta) = meta.as_object_mut() {
        meta.insert(
            SERVER_INFO_KEY.into(),
            json!({ "name": "sval", "version": SERVER_VERSION }),
        );
    }
    if method == "tools/list" {
        fields.insert("ttlMs".into(), json!(0));
        fields.insert("cacheScope".into(), json!("private"));
    }
    value
}

/// The bridge's answer to `server/discover` (MCP 2026-07-28, "Discovery").
/// It is the same for every user, and a shim updated in place may change any
/// of it, so it is public and stale at once.
fn discover_result() -> Value {
    let mut answer = dressed(
        "server/discover",
        json!({
            "supportedVersions": supported_versions(),
            "capabilities": { "tools": { "listChanged": true } },
            "instructions": SERVER_INSTRUCTIONS,
        }),
    );
    answer["ttlMs"] = json!(0);
    answer["cacheScope"] = json!("public");
    answer
}

/// The version `serverInfo` reports: Sval's display version, which a packaged
/// shim is built with, as Sval's own `initialize` answer reports it.
const SERVER_VERSION: &str = match option_env!("SVAL_APP_VERSION") {
    Some(version) => version,
    None => BUILD,
};

/// The bridge's own answer to `initialize`, the same Sval gives.
fn initialize_result(message: &Value) -> Value {
    let version = message["params"]["protocolVersion"]
        .as_str()
        .filter(|v| LEGACY_PROTOCOL_VERSIONS.contains(v))
        .unwrap_or(LATEST_LEGACY_PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": true } },
        "serverInfo": { "name": "sval", "version": SERVER_VERSION },
        "instructions": SERVER_INSTRUCTIONS
    })
}

/// Relays one connection's frames to the main loop until Sval closes it.
fn read_sval(mut stream: TcpStream, serial: u64, events: mpsc::Sender<Event>) {
    let error = loop {
        match read_frame(&mut stream) {
            Ok(Some(frame)) => {
                if events.send(Event::Sval(serial, frame)).is_err() {
                    return;
                }
            }
            Ok(None) => break None,
            Err(err) => break Some(err),
        }
    };
    let _ = events.send(Event::SvalClosed(serial, error));
}

/// The agent's session, which outlives any one connection to Sval.
struct Bridge<W> {
    output: W,
    profile: PathBuf,
    launch: Launch,
    store: Arc<dyn SecretStore>,
    events: mpsc::Sender<Event>,
    account: Option<String>,
    /// What every handshake tells Sval of this launch: the directory, the start
    /// time and the account's `launch_id`.
    launch_frame: Value,
    /// The workspace Sval last said this session holds, which the handshake
    /// names on every connection after, so a session gets its workspace back
    /// once Sval restarts.
    workspace: Option<String>,
    /// The agent's `initialize`, replayed to Sval on every connection, since
    /// Sval names an agent from it when pairing.
    initialize: Option<Value>,
    /// Whether the agent has sent `notifications/initialized`, which is
    /// replayed after it.
    initialized: bool,
    /// Whether the agent has sent a modern request, which carries all Sval
    /// needs of it, so there is nothing to replay.
    modern: bool,
    /// The client name `account` was claimed for.
    client: Option<String>,
    /// The ids of the agent's `subscriptions/listen` requests that asked to
    /// hear of tool list changes. The bridge holds them, since they outlive
    /// any one connection to Sval.
    subscriptions: Vec<Value>,
    connection: Option<Connection>,
    serial: u64,
    remembered: Option<Credentials>,
    /// The last `tools/list` result Sval gave.
    tools: Option<Value>,
    /// Whether the agent was given a tool list Sval did not just give.
    listed_without_sval: bool,
    /// Starts the Sval beside this shim on a profile (`launch::start`).
    starter: Starter,
    /// When this shim last started Sval.
    started: Option<Instant>,
    /// The serial of the last start.
    start_serial: u64,
    /// The Sval being started, while it has not yet listened.
    starting: Option<Starting>,
    /// Whether a Sval holds the profile with agent access off, which turns
    /// every answer given without Sval into `access_off`.
    access_off: bool,
    /// Whether the last start found Sval.app failing `codesign`'s check
    /// (`launch::Unverified`), which turns every answer given without Sval
    /// into `sval_installing`.
    unverified: bool,
    /// Whether the last Sval tried refused this shim as outdated, which turns
    /// every answer given without Sval into `sval_mcp_outdated`.
    outdated: bool,
    /// The token of the port file last tried or announced, so each new Sval is
    /// announced once.
    last_token: Option<String>,
    /// The shim's own file, watched for an update to execute in its place.
    #[cfg(unix)]
    update: Option<crate::update::SelfUpdate>,
}

impl<W: Write> Bridge<W> {
    fn send(&mut self, message: &Value) -> Result<(), BridgeError> {
        Ok(write_line(&mut self.output, message)?)
    }

    fn on_agent_line(&mut self, line: &str) -> Result<(), BridgeError> {
        let Ok(message) = serde_json::from_str::<Value>(line) else {
            return self.send(&failure(Value::Null, -32700, "parse error"));
        };
        if self.account.is_none() {
            self.claim(&client_name_of(&message));
        }
        let method = message["method"].as_str().map(str::to_owned);
        match (method.as_deref(), message.get("id").cloned()) {
            (Some("initialize"), Some(id)) => {
                self.send(&result(id, initialize_result(&message)))?;
                if self.initialize.is_none() {
                    self.initialize = Some(message);
                    self.ensure_connected()?;
                }
                Ok(())
            }
            (Some(method), Some(id)) => self.request(method, id, &message),
            (Some(method), None) => {
                if method == "notifications/initialized" {
                    self.initialized = true;
                }
                // Sval does not answer a cancelled call, and neither does the
                // bridge when the connection closes (MCP, "Cancellation").
                // A cancelled subscription hears no more.
                if method == "notifications/cancelled" {
                    if let Some(id) = message["params"].get("requestId") {
                        self.subscriptions.retain(|listening| listening != id);
                        if let Some(connection) = self.connection.as_mut() {
                            connection.owed.remove(&id.to_string());
                        }
                        if let Some(starting) = self.starting.as_mut() {
                            starting.waiting.retain(|(_, waiting, _)| waiting != id);
                        }
                    }
                }
                self.forward(&message)
            }
            // An answer to a request of Sval's: only Sval can use it.
            (None, _) => self.forward(&message),
        }
    }

    /// What every handshake says of this session: its launch, and the
    /// workspace Sval last said it holds, once it has held one.
    fn session_frame(&self) -> Value {
        match &self.workspace {
            Some(workspace) => json!({ "launch": self.launch_frame, "workspace": workspace }),
            None => json!({ "launch": self.launch_frame }),
        }
    }

    /// Takes this session's account, its app's (`account_for`).
    fn claim(&mut self, client_name: &str) {
        let account = account_for(&self.profile, client_name);
        self.launch_frame = json!({
            "dir": dir_for_handshake(&self.launch.dir),
            "started": self.launch.started,
            "id": launch_id(&account),
            "build": BUILD,
        });
        self.account = Some(account);
        self.client = Some(client_name.to_owned());
    }

    /// Takes up the session a replaced shim handed this one, and connects
    /// as that shim was, so Sval meets this build at once.
    #[cfg(unix)]
    fn resume(&mut self, resume: crate::update::Resume) -> Result<(), BridgeError> {
        if resume.initialize.is_none() && !resume.modern {
            return Ok(());
        }
        let client = match (&resume.client, &resume.initialize) {
            (Some(client), _) => client.clone(),
            (None, Some(initialize)) => client_name_of(initialize),
            (None, None) => client_name_of(&Value::Null),
        };
        self.claim(&client);
        self.workspace = resume.workspace;
        self.initialize = resume.initialize;
        self.initialized = resume.initialized;
        self.modern = resume.modern;
        self.subscriptions = resume.subscriptions;
        self.tools = resume.tools;
        self.listed_without_sval = resume.listed_without_sval;
        self.ensure_connected()?;
        Ok(())
    }

    /// Executes an updated shim in this one's place (`update`), between
    /// requests: when Sval owes no answer, the agent has written nothing
    /// unhandled, and no event waits in `incoming`. Checking the file can take
    /// a while (`update::VERSION_WAIT`), and a frame Sval sends meanwhile
    /// would go with this process, so an event found then is handed back for
    /// the loop to handle, and the update waits for the next idle moment. It
    /// returns only when there is no update, or it could not execute one.
    #[cfg(unix)]
    fn self_update(&mut self, incoming: &mpsc::Receiver<Event>) -> Option<Event> {
        if self.starting.is_some() || self.connection.as_ref().is_some_and(|c| !c.owed.is_empty()) {
            return None;
        }
        let update = self.update.as_mut()?;
        let gate = update.gate.clone();
        let _idle = gate.hold_if_idle()?;
        if !update.replaced(BUILD) {
            return None;
        }
        if let Ok(event) = incoming.try_recv() {
            update.retry();
            return Some(event);
        }
        let resume = crate::update::Resume {
            initialize: self.initialize.clone(),
            initialized: self.initialized,
            account: self.account.clone(),
            started: self.launch.started,
            tools: self.tools.clone(),
            listed_without_sval: self.listed_without_sval,
            modern: self.modern,
            client: self.client.clone(),
            subscriptions: self.subscriptions.clone(),
            workspace: self.workspace.clone(),
        };
        let err = update.exec(&resume);
        eprintln!("sval-mcp: could not execute the updated sval-mcp: {err}");
        None
    }

    /// Sends a message that wants no answer, if Sval is there to take it. A
    /// write that fails may have sent part of a frame, after which nothing
    /// more can be framed on that connection, so it is dropped.
    fn forward(&mut self, message: &Value) -> Result<(), BridgeError> {
        let Some(connection) = self.connection.as_mut() else {
            return Ok(());
        };
        if write_frame(&mut connection.stream, &json!({ "mcp": message })).is_err() {
            self.disconnected()?;
        }
        Ok(())
    }

    /// Whether the agent has opened its session, with `initialize` or a
    /// modern request.
    fn opened(&self) -> bool {
        self.initialize.is_some() || self.modern
    }

    /// Sends a result the bridge makes itself, as `asked` expects it.
    fn answer(&mut self, asked: &Asked, id: Value, value: Value) -> Result<(), BridgeError> {
        let value = if asked.modern {
            dressed(&asked.method, value)
        } else {
            value
        };
        self.send(&result(id, value))
    }

    fn request(&mut self, method: &str, id: Value, message: &Value) -> Result<(), BridgeError> {
        let era = match era_of(message) {
            Ok(era) => era,
            Err(refusal) => return self.send(&refusal),
        };
        match (method, era) {
            ("server/discover", Era::Unversioned) => {
                return self.send(&failure(
                    id,
                    -32602,
                    &format!("invalid params: {VERSION_KEY}"),
                ));
            }
            ("server/discover", _) => return self.send(&result(id, discover_result())),
            ("subscriptions/listen", Era::Modern) => return self.listen(id, message),
            (_, Era::Modern) => self.modern = true,
            // Sval answers no legacy request before `initialize`.
            _ if self.initialize.is_none() => {
                return self.send(&failure(id, -32601, "method not found"));
            }
            _ => {}
        }
        let asked = Asked {
            method: method.to_owned(),
            modern: era == Era::Modern,
        };
        if method == "ping" && self.connection.is_none() {
            return self.answer(&asked, id, json!({}));
        }
        let Ok(frame) = encode_frame(&json!({ "mcp": message })) else {
            return match method {
                "tools/call" => self.answer(&asked, id, tool_error(TOO_LARGE)),
                _ => self.send(&failure(
                    id,
                    -32000,
                    &format!("{}: {}", TOO_LARGE.0, TOO_LARGE.1),
                )),
            };
        };
        if method == "tools/call" {
            self.start_if_closed();
        }
        if let Some(starting) = self.starting.as_mut() {
            starting.waiting.push((asked, id, frame));
            return Ok(());
        }
        self.send_to_sval(asked, id, &frame)
    }

    /// Opens a `subscriptions/listen` stream (MCP 2026-07-28, "Subscriptions").
    /// Sval has only a tool list to tell of, so the acknowledgment agrees to
    /// that alone, and the stream stays open, unanswered, until the agent
    /// cancels it.
    fn listen(&mut self, id: Value, message: &Value) -> Result<(), BridgeError> {
        let tools = message["params"]["notifications"]["toolsListChanged"] == true;
        if tools {
            self.subscriptions.push(id.clone());
        }
        let agreed = if tools {
            json!({ "toolsListChanged": true })
        } else {
            json!({})
        };
        self.send(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/subscriptions/acknowledged",
            "params": { "_meta": { SUBSCRIPTION_KEY: id }, "notifications": agreed }
        }))
    }

    /// Tells the agent its tools changed: a legacy session plainly, and each
    /// modern stream that asked, by its id. A modern client that opened no
    /// stream asked to hear of nothing.
    fn tools_changed(&mut self) -> Result<(), BridgeError> {
        if self.initialize.is_some() {
            self.send(&list_changed())?;
        }
        for id in self.subscriptions.clone() {
            let mut notice = list_changed();
            notice["params"] = json!({ "_meta": { SUBSCRIPTION_KEY: id } });
            self.send(&notice)?;
        }
        Ok(())
    }

    /// Sends a request to Sval, connecting first if need be, or answers it
    /// without Sval when there is none to reach.
    fn send_to_sval(&mut self, asked: Asked, id: Value, frame: &[u8]) -> Result<(), BridgeError> {
        // A write that fails means Sval has gone and its reader has not said
        // so yet. Sval read no whole frame, so one fresh connection may take it.
        for _ in 0..2 {
            if !self.ensure_connected()? {
                break;
            }
            let connection = self.connection.as_mut().expect("just connected");
            if connection.stream.write_all(frame).is_ok() {
                connection
                    .owed
                    .insert(id.to_string(), (id, Owed::Agent(asked)));
                return Ok(());
            }
            self.disconnected()?;
        }
        self.answer_without_sval(&asked, id)
    }

    /// When there is no connection and no Sval holds the profile, starts the
    /// Sval beside this shim in the background (agent-control spec §7.1), at
    /// most once a `START_WAIT`, so an agent whose calls keep failing does not
    /// start a browser with each one. The starter runs on a thread of its own,
    /// since it can wait for Sval.app to verify (`launch::VERIFY_WAIT`).
    /// Requests then wait in `starting` until Sval listens or the start is
    /// over, and the bridge serves on meanwhile.
    fn start_if_closed(&mut self) {
        if self.connection.is_some()
            || self.starting.is_some()
            || !self.opened()
            || self.account.is_none()
            || crate::launch::profile_in_use(&self.profile)
            || self.started.is_some_and(|at| at.elapsed() < START_WAIT)
        {
            return;
        }
        let now = Instant::now();
        self.started = Some(now);
        self.start_serial += 1;
        let (serial, starter, profile, events) = (
            self.start_serial,
            self.starter.clone(),
            self.profile.clone(),
            self.events.clone(),
        );
        thread::spawn(move || {
            let _ = events.send(Event::Launched(serial, starter(&profile)));
        });
        self.starting = Some(Starting {
            serial,
            stale: read_listener(&self.profile).map(|l| l.token),
            deadline: now + LAUNCH_WAIT,
            waiting: Vec::new(),
        });
    }

    /// Gives a started Sval `START_WAIT` to listen once its starter has
    /// launched it, or ends the start at once when the starter failed.
    fn on_launched(&mut self, serial: u64, launched: std::io::Result<()>) {
        let Some(starting) = self.starting.as_mut().filter(|s| s.serial == serial) else {
            return;
        };
        self.unverified = false;
        let until = match launched {
            Ok(()) => Instant::now() + START_WAIT,
            Err(err) => {
                eprintln!("sval-mcp: could not start Sval: {err}");
                self.unverified = crate::launch::is_unverified(&err);
                Instant::now()
            }
        };
        starting.deadline = starting.deadline.min(until);
    }

    /// Sends the waiting requests on once the started Sval has written a new
    /// port file, or answers them without Sval once it has had `START_WAIT`.
    /// It reports whether the start is over.
    fn check_start(&mut self) -> Result<bool, BridgeError> {
        let Some(starting) = &self.starting else {
            return Ok(false);
        };
        let listening = read_listener(&self.profile)
            .is_some_and(|l| Some(l.token.as_str()) != starting.stale.as_deref());
        if !listening && Instant::now() < starting.deadline {
            return Ok(false);
        }
        let starting = self.starting.take().expect("checked above");
        for (asked, id, frame) in starting.waiting {
            self.send_to_sval(asked, id, &frame)?;
        }
        Ok(true)
    }

    /// Answers a request Sval cannot. A tool list is the last one Sval gave, so
    /// the agent keeps its tools across a restart and a call on one gets a
    /// clear error. When Sval has given none yet, the list is empty until Sval
    /// appears, and `watch_port_file` then tells the agent to list again.
    fn answer_without_sval(&mut self, asked: &Asked, id: Value) -> Result<(), BridgeError> {
        let why = if self.outdated {
            OUTDATED
        } else if self.access_off {
            ACCESS_OFF
        } else if self.unverified {
            UNVERIFIED
        } else {
            NOT_RUNNING
        };
        match asked.method.as_str() {
            "tools/list" => {
                self.listed_without_sval = true;
                let tools = self.tools.clone().unwrap_or_else(|| json!({ "tools": [] }));
                self.answer(asked, id, tools)
            }
            "tools/call" => self.answer(asked, id, tool_error(why)),
            "ping" => self.answer(asked, id, json!({})),
            _ => self.send(&failure(id, -32000, &format!("{}: {}", why.0, why.1))),
        }
    }

    /// Connects when there is no connection, and reports whether there is one.
    ///
    /// Every connection reads the port file afresh and goes through the whole
    /// handshake in `connect`, so a restarted Sval is proved with its new token
    /// and a stale file is refused as at startup. The agent's `initialize`, if
    /// it sent one, is then replayed, and Sval's answer to it dropped, since the
    /// agent has one. A modern request carries all Sval needs of the agent.
    /// Its id cannot meet another request's: MCP forbids a client to reuse an
    /// id within a session.
    ///
    /// A Sval that holds the profile and has written no port file has agent
    /// access off.
    fn ensure_connected(&mut self) -> Result<bool, BridgeError> {
        if self.connection.is_some() {
            return Ok(true);
        }
        if !self.opened() {
            return Ok(false);
        }
        let listener = read_listener(&self.profile);
        let held = crate::launch::profile_in_use(&self.profile);
        self.access_off = held && listener.is_none();
        let Some(account) = &self.account else {
            return Ok(false);
        };
        let Some(listener) = listener else {
            eprintln!(
                "sval-mcp: no usable {AGENT_DIR}/{PORT_FILE} in {}",
                self.profile.display()
            );
            return Ok(false);
        };
        self.last_token = Some(listener.token.clone());
        let mut stream = match connect(
            &listener,
            self.store.as_ref(),
            account,
            &self.session_frame(),
            self.launch.handshake_timeout,
            self.launch.write_timeout,
            &mut self.remembered,
        ) {
            Ok(stream) => {
                self.outdated = false;
                stream
            }
            Err(err) => {
                eprintln!("sval-mcp: could not reach Sval: {err}");
                self.outdated = matches!(err, BridgeError::Outdated);
                return Ok(false);
            }
        };
        let mut owed = HashMap::new();
        let initialize = self.initialize.as_ref();
        let started = (|| -> std::io::Result<TcpStream> {
            let Some(initialize) = initialize else {
                return stream.try_clone();
            };
            write_frame(&mut stream, &json!({ "mcp": initialize }))?;
            if self.initialized {
                write_frame(
                    &mut stream,
                    &json!({ "mcp": { "jsonrpc": "2.0", "method": "notifications/initialized" } }),
                )?;
            }
            stream.try_clone()
        })();
        let reader = match started {
            Ok(reader) => reader,
            Err(err) => {
                eprintln!("sval-mcp: Sval closed the connection on arrival: {err}");
                let _ = stream.shutdown(Shutdown::Both);
                return Ok(false);
            }
        };
        if let Some(id) = initialize.and_then(|i| i.get("id")) {
            owed.insert(id.to_string(), (id.clone(), Owed::Replay));
        }
        self.serial += 1;
        let (serial, events) = (self.serial, self.events.clone());
        thread::spawn(move || read_sval(reader, serial, events));
        self.connection = Some(Connection {
            serial,
            stream,
            owed,
        });
        if std::mem::take(&mut self.listed_without_sval) {
            self.tools_changed()?;
        }
        Ok(true)
    }

    fn on_sval_frame(&mut self, serial: u64, frame: Value) -> Result<(), BridgeError> {
        let Some(connection) = self.connection.as_mut().filter(|c| c.serial == serial) else {
            return Ok(());
        };
        if let Some(message) = frame.get("mcp") {
            if message["method"] == "notifications/tools/list_changed" {
                return self.tools_changed();
            }
            let answered = match (message.get("method"), message.get("id")) {
                (None, Some(id)) => connection.owed.remove(&id.to_string()),
                _ => None,
            };
            match answered {
                Some((_, Owed::Replay)) => return Ok(()),
                Some((_, Owed::Agent(asked))) if asked.method == "tools/list" => {
                    if let Some(tools) = message.get("result") {
                        self.tools = Some(tools.clone());
                    }
                }
                _ => {}
            }
            self.send(message)?;
        } else if let Some(paired) = frame["ctl"].get("paired") {
            match serde_json::from_value::<Credentials>(paired.clone()) {
                Ok(credentials) => {
                    let account = self.account.as_deref().unwrap_or_default();
                    // Losing the secret from the store means pairing again
                    // after sval-mcp restarts. Reconnects use `remembered`.
                    if let Err(reason) = self.store.save(account, &credentials) {
                        eprintln!("sval-mcp: could not store the pairing secret: {reason}");
                    }
                    self.remembered = Some(credentials);
                }
                Err(_) => eprintln!("sval-mcp: Sval sent a malformed pairing frame"),
            }
        } else if let Some(workspace) = frame["ctl"].get("workspace") {
            self.workspace = workspace.as_str().map(str::to_owned);
        }
        Ok(())
    }

    fn on_sval_closed(
        &mut self,
        serial: u64,
        error: Option<std::io::Error>,
        quietly: bool,
    ) -> Result<(), BridgeError> {
        if self.connection.as_ref().map(|c| c.serial) != Some(serial) {
            return Ok(());
        }
        if !quietly {
            match error {
                Some(err) => eprintln!("sval-mcp: lost Sval's connection: {err}"),
                None => eprintln!("sval-mcp: Sval closed the connection"),
            }
        }
        self.disconnected()
    }

    /// Drops the connection, and answers every request it still owed, since an
    /// agent left waiting cannot tell a slow answer from none.
    fn disconnected(&mut self) -> Result<(), BridgeError> {
        let Some(connection) = self.connection.take() else {
            return Ok(());
        };
        let _ = connection.stream.shutdown(Shutdown::Both);
        for (id, owed) in connection.owed.into_values() {
            match owed {
                Owed::Replay => {}
                Owed::Agent(asked) if asked.method == "tools/call" => {
                    self.answer(&asked, id, tool_error(DISCONNECTED))?;
                }
                Owed::Agent(asked) => self.answer_without_sval(&asked, id)?,
            }
        }
        Ok(())
    }

    /// Tells the agent to list its tools again when a new port file appears
    /// while Sval is away. Only the file is read: the agent's next request is
    /// what connects, so Sval never sees a connection the agent did not ask for.
    fn watch_port_file(&mut self) -> Result<(), BridgeError> {
        if self.connection.is_some() || !self.opened() {
            return Ok(());
        }
        let Some(listener) = read_listener(&self.profile) else {
            return Ok(());
        };
        if self.last_token.as_deref() == Some(listener.token.as_str()) {
            return Ok(());
        }
        self.last_token = Some(listener.token);
        self.tools_changed()
    }
}

/// Serves the agent for as long as it keeps stdin open, whether or not Sval is
/// running, and connects to Sval whenever a request needs it.
///
/// Sval decides the tool list: it differs before and after pairing, and the
/// tools come from Sval's own definitions. So the bridge answers only
/// `initialize`, `server/discover`, `subscriptions/listen`, `ping`, and while
/// Sval is away `tools/list` (see `answer_without_sval`), and every other
/// request goes to Sval. Sval advertises `tools.listChanged`, and the bridge
/// sends that notification when Sval reappears, so a list given without Sval
/// is replaced by Sval's own.
///
/// When the agent closes stdin, Sval is told, and `run` returns once Sval has
/// closed the connection, so Sval's answers already in flight are delivered.
pub fn run<R, W>(
    input: R,
    output: W,
    profile: &Path,
    store: Arc<dyn SecretStore>,
) -> Result<(), BridgeError>
where
    R: BufRead + Send + 'static,
    W: Write,
{
    run_launched(input, output, profile, Launch::current(), store)
}

/// `run`, for a bridge launched as `launch` says.
pub fn run_launched<R, W>(
    input: R,
    output: W,
    profile: &Path,
    launch: Launch,
    store: Arc<dyn SecretStore>,
) -> Result<(), BridgeError>
where
    R: BufRead + Send + 'static,
    W: Write,
{
    run_with(
        input,
        output,
        profile,
        launch,
        store,
        Arc::new(crate::launch::start),
    )
}

/// Starts Sval on a profile, returning once it is launched.
pub type Starter = Arc<dyn Fn(&Path) -> std::io::Result<()> + Send + Sync>;

/// How long a started Sval has to write its port file, and how often the
/// shim looks for it meanwhile.
const START_WAIT: Duration = Duration::from_secs(30);
/// The longest a start can take: the starter's wait for Sval.app to verify,
/// with its last check, then `START_WAIT`.
const LAUNCH_WAIT: Duration = Duration::from_secs(
    crate::launch::VERIFY_WAIT.as_secs()
        + crate::launch::CODESIGN_TIMEOUT.as_secs()
        + START_WAIT.as_secs(),
);
const START_POLL: Duration = Duration::from_millis(250);

/// `run_launched`, starting Sval with `starter` when a tool call finds it
/// closed.
pub fn run_with<R, W>(
    input: R,
    output: W,
    profile: &Path,
    launch: Launch,
    store: Arc<dyn SecretStore>,
    starter: Starter,
) -> Result<(), BridgeError>
where
    R: BufRead + Send + 'static,
    W: Write,
{
    let (events, incoming) = mpsc::channel();
    let agent = events.clone();
    thread::spawn(move || {
        for line in input.lines() {
            let failed = line.is_err();
            if agent.send(Event::Agent(line)).is_err() || failed {
                return;
            }
        }
        let _ = agent.send(Event::AgentClosed);
    });
    let bridge = Bridge::new(output, profile, launch, store, starter, events);
    serve(bridge, &incoming)
}

/// `run`, on this process's standard input and output. On macOS and Linux
/// the input is read under a `Gate`, so an update of the shim's own file
/// executes in its place (`update`), and a process executed so takes up the
/// session it was handed.
pub fn run_stdio(profile: &Path, store: Arc<dyn SecretStore>) -> Result<(), BridgeError> {
    #[cfg(unix)]
    {
        let resume = crate::update::take_resume();
        let mut launch = Launch::current();
        if let Some(resume) = &resume {
            launch.started = resume.started;
        }
        let (events, incoming) = mpsc::channel();
        let gate = Arc::new(crate::update::Gate::default());
        let (agent, ended, reading) = (events.clone(), events.clone(), gate.clone());
        thread::spawn(move || {
            crate::update::read_stdin(
                &reading,
                |line| agent.send(Event::Agent(line)).is_ok(),
                || {
                    let _ = ended.send(Event::AgentClosed);
                },
            );
        });
        let mut bridge = Bridge::new(
            std::io::stdout(),
            profile,
            launch,
            store,
            Arc::new(crate::launch::start),
            events,
        );
        bridge.update = crate::update::SelfUpdate::new(gate);
        if let Some(resume) = resume {
            bridge.resume(resume)?;
        }
        serve(bridge, &incoming)
    }
    #[cfg(not(unix))]
    run(
        std::io::BufReader::new(std::io::stdin()),
        std::io::stdout(),
        profile,
        store,
    )
}

impl<W: Write> Bridge<W> {
    fn new(
        output: W,
        profile: &Path,
        launch: Launch,
        store: Arc<dyn SecretStore>,
        starter: Starter,
        events: mpsc::Sender<Event>,
    ) -> Self {
        Bridge {
            output,
            profile: profile.to_owned(),
            launch,
            store,
            events,
            account: None,
            launch_frame: Value::Null,
            workspace: None,
            initialize: None,
            initialized: false,
            modern: false,
            client: None,
            subscriptions: Vec::new(),
            connection: None,
            serial: 0,
            remembered: None,
            tools: None,
            listed_without_sval: false,
            outdated: false,
            access_off: false,
            starter,
            started: None,
            start_serial: 0,
            unverified: false,
            starting: None,
            last_token: None,
            #[cfg(unix)]
            update: None,
        }
    }
}

/// The bridge's loop, until the agent and Sval are both done.
fn serve<W: Write>(
    mut bridge: Bridge<W>,
    incoming: &mpsc::Receiver<Event>,
) -> Result<(), BridgeError> {
    let mut agent_done = false;
    let mut pending = None;
    loop {
        if bridge.check_start()? && agent_done {
            match &bridge.connection {
                Some(connection) => {
                    let _ = connection.stream.shutdown(Shutdown::Write);
                }
                None => return Ok(()),
            }
        }
        let poll = if bridge.starting.is_some() {
            START_POLL
        } else {
            PORT_FILE_POLL
        };
        let event = match pending.take() {
            Some(event) => Ok(event),
            None => incoming.recv_timeout(poll),
        };
        match event {
            Ok(Event::Agent(Ok(line))) => {
                #[cfg(unix)]
                if let Some(update) = &bridge.update {
                    update.gate.taken();
                }
                if !line.trim().is_empty() {
                    bridge.on_agent_line(&line)?;
                }
            }
            Ok(Event::Agent(Err(err))) => {
                let _ = bridge.disconnected();
                return Err(err.into());
            }
            // Requests waiting for a starting Sval are still answered: the
            // check above closes once the start is over.
            Ok(Event::AgentClosed) if bridge.starting.is_some() => agent_done = true,
            Ok(Event::AgentClosed) => match &bridge.connection {
                // Sval answers by closing, which ends the loop.
                Some(connection) => {
                    let _ = connection.stream.shutdown(Shutdown::Write);
                    agent_done = true;
                }
                None => return Ok(()),
            },
            Ok(Event::Sval(serial, frame)) => bridge.on_sval_frame(serial, frame)?,
            Ok(Event::Launched(serial, launched)) => bridge.on_launched(serial, launched),
            Ok(Event::SvalClosed(serial, error)) => {
                bridge.on_sval_closed(serial, error, agent_done)?;
                if agent_done && bridge.connection.is_none() {
                    return Ok(());
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !agent_done {
                    #[cfg(unix)]
                    {
                        pending = bridge.self_update(incoming);
                    }
                    bridge.watch_port_file()?;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(BridgeError::Protocol("the agent's reader vanished".into()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        client_name_of, dir_for_handshake, discover_result, dressed, era_of, initialize_result,
        Era, MAX_DIR_JSON_BYTES, SERVER_INSTRUCTIONS, SERVER_VERSION,
    };
    use serde_json::{json, Value};

    #[test]
    fn initialize_carries_the_instructions() {
        let answer = initialize_result(&json!({ "params": { "protocolVersion": "2025-11-25" } }));
        assert_eq!(answer["instructions"], SERVER_INSTRUCTIONS);
    }

    /// `initialize` answers a legacy version it speaks with that version, and
    /// any other with the latest legacy one: a modern version cannot be
    /// spoken over `initialize`.
    #[test]
    fn initialize_negotiates_each_version() {
        for (asked, answered) in [
            (json!("2025-06-18"), "2025-06-18"),
            (json!("2025-11-25"), "2025-11-25"),
            (json!("2026-07-28"), "2025-11-25"),
            (json!("1900-01-01"), "2025-11-25"),
            (Value::Null, "2025-11-25"),
        ] {
            let answer = initialize_result(&json!({ "params": { "protocolVersion": asked } }));
            assert_eq!(answer["protocolVersion"], answered, "{asked}");
        }
    }

    #[test]
    fn discover_names_every_version_and_carries_the_instructions() {
        let answer = discover_result();
        assert_eq!(
            answer["supportedVersions"],
            json!(["2026-07-28", "2025-11-25", "2025-06-18"])
        );
        assert_eq!(answer["instructions"], SERVER_INSTRUCTIONS);
        assert_eq!(
            answer["capabilities"],
            json!({ "tools": { "listChanged": true } })
        );
        assert_eq!(answer["resultType"], "complete");
        assert_eq!(answer["ttlMs"], 0);
        assert_eq!(answer["cacheScope"], "public");
        assert_eq!(
            answer["_meta"]["io.modelcontextprotocol/serverInfo"],
            json!({ "name": "sval", "version": SERVER_VERSION })
        );
    }

    fn versioned(version: Value, capabilities: Option<Value>) -> Value {
        let mut meta = json!({ "io.modelcontextprotocol/protocolVersion": version });
        if let Some(capabilities) = capabilities {
            meta["io.modelcontextprotocol/clientCapabilities"] = capabilities;
        }
        json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": { "_meta": meta } })
    }

    #[test]
    fn a_request_is_served_by_the_version_its_meta_names() {
        let plain = json!({ "jsonrpc": "2.0", "id": 7, "method": "tools/list" });
        assert_eq!(era_of(&plain), Ok(Era::Unversioned));
        for legacy in ["2025-06-18", "2025-11-25"] {
            assert_eq!(era_of(&versioned(json!(legacy), None)), Ok(Era::Legacy));
        }
        assert_eq!(
            era_of(&versioned(json!("2026-07-28"), Some(json!({})))),
            Ok(Era::Modern)
        );
    }

    #[test]
    fn a_version_sval_does_not_speak_is_told_the_ones_it_does() {
        let refusal = era_of(&versioned(json!("1900-01-01"), Some(json!({})))).unwrap_err();
        assert_eq!(refusal["id"], 7);
        assert_eq!(refusal["error"]["code"], -32022);
        assert_eq!(
            refusal["error"]["data"],
            json!({ "supported": ["2026-07-28", "2025-11-25", "2025-06-18"], "requested": "1900-01-01" })
        );
    }

    #[test]
    fn a_modern_request_without_the_clients_capabilities_is_malformed() {
        for malformed in [
            versioned(json!("2026-07-28"), None),
            versioned(json!("2026-07-28"), Some(json!([]))),
            versioned(json!(20260728), Some(json!({}))),
        ] {
            let refusal = era_of(&malformed).unwrap_err();
            assert_eq!(refusal["error"]["code"], -32602, "{malformed}");
        }
    }

    #[test]
    fn a_modern_tool_list_is_private_and_stale_at_once() {
        let list = dressed("tools/list", json!({ "tools": [] }));
        assert_eq!(list["resultType"], "complete");
        assert_eq!(list["ttlMs"], 0);
        assert_eq!(list["cacheScope"], "private");
        assert_eq!(
            list["_meta"]["io.modelcontextprotocol/serverInfo"]["name"],
            "sval"
        );
        let call = dressed("tools/call", json!({ "content": [] }));
        assert_eq!(call["resultType"], "complete");
        assert!(call.get("ttlMs").is_none());
    }

    /// The first line Claude Code 2.1.292 sent, verbatim.
    const SERVER_DISCOVER: &str = r#"{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.292","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"},"io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}}}}}"#;

    /// The second line Claude Code 2.1.292 sent, verbatim.
    const INITIALIZE: &str = r#"{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.292","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"}},"jsonrpc":"2.0","id":0}"#;

    fn parse(line: &str) -> Value {
        serde_json::from_str(line).unwrap()
    }

    #[test]
    fn a_server_discover_probe_names_the_client_from_its_meta() {
        assert_eq!(client_name_of(&parse(SERVER_DISCOVER)), "claude-code");
    }

    #[test]
    fn an_initialize_names_the_client_from_its_client_info() {
        assert_eq!(client_name_of(&parse(INITIALIZE)), "claude-code");
    }

    #[test]
    fn a_message_with_no_name_is_a_generic_agent() {
        let message = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" });
        assert_eq!(client_name_of(&message), "Agent");
    }

    #[test]
    fn a_name_that_is_not_a_string_is_a_generic_agent() {
        let in_client_info = json!({ "params": { "clientInfo": { "name": 7 } } });
        let in_meta = json!({
            "params": { "_meta": { "io.modelcontextprotocol/clientInfo": { "name": ["x"] } } }
        });
        assert_eq!(client_name_of(&in_client_info), "Agent");
        assert_eq!(client_name_of(&in_meta), "Agent");
    }

    /// An event that arrives while an updated file is asked its build is
    /// handed back to the loop, and the update waits for the next idle
    /// moment, asking the file again then. The update exits 3 when run as the
    /// shim, so an exec here ends the test binary with a failure.
    #[cfg(unix)]
    #[test]
    fn an_event_waiting_puts_off_an_update_and_is_handed_back() {
        use super::{Bridge, Event, Launch, BUILD};
        use crate::secrets::MemoryStore;
        use crate::test_dir::{write_executable, TempDir};
        use std::sync::{mpsc, Arc};
        let temp = TempDir::new("update-pending");
        let exe = temp.0.join("sval-mcp");
        write_executable(
            &exe,
            "#!/bin/sh\n[ \"$1\" = --version ] && { echo 'sval-mcp other'; exit 0; }\nexit 3\n",
        );
        let (events, incoming) = mpsc::channel();
        let mut bridge = Bridge::new(
            Vec::new(),
            &temp.0,
            Launch::current(),
            Arc::new(MemoryStore::default()),
            Arc::new(|_: &std::path::Path| Ok(())),
            events.clone(),
        );
        bridge.update = Some(crate::update::SelfUpdate::watching(exe));
        let frame =
            json!({ "mcp": { "jsonrpc": "2.0", "method": "notifications/tools/list_changed" } });
        events.send(Event::Sval(1, frame.clone())).unwrap();
        match bridge.self_update(&incoming) {
            Some(Event::Sval(1, handed)) => assert_eq!(handed, frame),
            _ => panic!("the waiting event is handed back"),
        }
        assert!(
            bridge.update.as_mut().unwrap().replaced(BUILD),
            "the put-off update is asked again"
        );
    }

    #[test]
    fn a_deep_launch_directory_keeps_its_end_within_the_cap() {
        let deep = format!("/{}/sval", "a\\\"b".repeat(1000));
        let sent = dir_for_handshake(deep.as_ref());
        assert!(sent.starts_with('…'));
        assert!(sent.ends_with("/sval"));
        assert!(serde_json::to_string(&sent).unwrap().len() <= MAX_DIR_JSON_BYTES + 8);
        assert_eq!(dir_for_handshake("/work/sval".as_ref()), "/work/sval");
    }
}
