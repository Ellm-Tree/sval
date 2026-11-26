// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! A folder in the user's Dropbox, reached through Dropbox's HTTP API, so no
//! Dropbox client needs to run on this computer. The browser signs in and
//! holds the refresh token (desktop connectors spec §3); this helper turns it
//! into access tokens and never writes it down.
//!
//! The calls are Dropbox's v2 API as its documentation gives them: JSON
//! arguments in the body for an RPC call, in the `Dropbox-API-Arg` header
//! for a content call, and a 409 whose `error_summary` names the failure.

use super::{join, Child, Kind, RemoteError, Result, Store};
use serde_json::{json, Value};
use std::io::Read;
use std::time::{Duration, Instant};

/// Sval's app on Dropbox, the one the iPhone app signs in to
/// (`DropboxApp` in `mobile/ios/Sval/Shared.swift`). The key is public: the
/// app signs in with PKCE and holds no secret.
pub const APP_KEY: &str = "94ncbej3k9vjzo7";

const TOKEN_URL: &str = "https://api.dropboxapi.com/oauth2/token";
const RPC_URL: &str = "https://api.dropboxapi.com/2/files/";
const CONTENT_URL: &str = "https://content.dropboxapi.com/2/files/";

/// How long one call may take. Under the request's own 20 s deadline, so a
/// Dropbox that has stopped answering fails the request with an answer.
const TIMEOUT: Duration = Duration::from_secs(15);

/// How many downloads one `read_all` runs at once. Dropbox has no call that
/// downloads several files, and a step's first read of a folder downloads
/// every document in it, which one at a time could run past the request's
/// deadline.
const PARALLEL_DOWNLOADS: usize = 8;

/// An access token is renewed this long before Dropbox says it expires.
const TOKEN_MARGIN: Duration = Duration::from_secs(60);

/// The largest JSON answer read, a listing page included.
const MAX_JSON_BYTES: u64 = 16 * 1024 * 1024;

pub struct DropboxStore {
    agent: ureq::Agent,
    refresh_token: String,
    /// The access token and when to renew it, once one is had.
    access: Option<(String, Instant)>,
    /// The folder, as a Dropbox path without its leading `/`. Empty for the
    /// root of the user's Dropbox.
    root: String,
}

/// How a call failed: Dropbox's answer for a 409, or the failure it maps to.
enum CallError {
    /// The `error_summary` of a 409, which says which failure of the call's
    /// own this is, such as `path/not_found/..`.
    Api(String),
    Remote(RemoteError),
}

impl From<RemoteError> for CallError {
    fn from(err: RemoteError) -> Self {
        CallError::Remote(err)
    }
}

/// `err` with an API failure the caller did not expect as `Other`.
fn plain(err: CallError) -> RemoteError {
    match err {
        CallError::Api(_) => RemoteError::Other,
        CallError::Remote(err) => err,
    }
}

fn agent() -> ureq::Agent {
    let tls = ureq::tls::TlsConfig::builder();
    // SChannel with the roots Windows trusts; elsewhere rustls with
    // Mozilla's, ureq's defaults.
    #[cfg(windows)]
    let tls = tls
        .provider(ureq::tls::TlsProvider::NativeTls)
        .root_certs(ureq::tls::RootCerts::PlatformVerifier);
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .tls_config(tls.build())
        .build()
        .new_agent()
}

/// `value` as JSON for an HTTP header, which carries ASCII alone: every other
/// character is escaped, as Dropbox's documentation asks of
/// `Dropbox-API-Arg`.
fn header_json(value: &Value) -> String {
    let mut out = String::new();
    for ch in value.to_string().chars() {
        if ch.is_ascii() {
            out.push(ch);
        } else {
            let mut units = [0u16; 2];
            for unit in ch.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{unit:04x}"));
            }
        }
    }
    out
}

/// The failure a status other than 200 or 409 means.
fn status_error(status: u16) -> RemoteError {
    match status {
        401 => RemoteError::SignIn,
        403 => RemoteError::Denied,
        429 | 500..=599 => RemoteError::Unreachable,
        _ => RemoteError::Other,
    }
}

fn transport_error(_: ureq::Error) -> RemoteError {
    RemoteError::Unreachable
}

fn read_json(response: &mut ureq::http::Response<ureq::Body>) -> Result<Value> {
    let mut bytes = Vec::new();
    response
        .body_mut()
        .with_config()
        .limit(u64::MAX)
        .reader()
        .take(MAX_JSON_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|_| RemoteError::Unreachable)?;
    serde_json::from_slice(&bytes).map_err(|_| RemoteError::Other)
}

/// The `error_summary` of a 409's body.
fn summary(response: &mut ureq::http::Response<ureq::Body>) -> CallError {
    match read_json(response) {
        Ok(body) => CallError::Api(
            body.get("error_summary")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
        ),
        Err(err) => CallError::Remote(err),
    }
}

/// The access token for `refresh_token`, and how long it holds.
fn refresh(agent: &ureq::Agent, refresh_token: &str) -> Result<(String, Duration)> {
    let mut response = agent
        .post(TOKEN_URL)
        .send_form([
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", APP_KEY),
        ])
        .map_err(transport_error)?;
    match response.status().as_u16() {
        200 => {}
        // `invalid_grant`: the user took Sval's access away.
        400 => return Err(RemoteError::SignIn),
        status => return Err(status_error(status)),
    }
    let body = read_json(&mut response)?;
    let token = body
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or(RemoteError::Other)?;
    let lasts = body.get("expires_in").and_then(Value::as_u64).unwrap_or(0);
    Ok((token.to_owned(), Duration::from_secs(lasts)))
}

fn download(agent: &ureq::Agent, token: &str, path: &str, limit: u64) -> Result<Vec<u8>> {
    let mut response = agent
        .post(format!("{CONTENT_URL}download"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Dropbox-API-Arg", header_json(&json!({ "path": path })))
        .send_empty()
        .map_err(transport_error)?;
    match response.status().as_u16() {
        200 => {}
        409 => {
            return Err(match summary(&mut response) {
                CallError::Api(s) if s.starts_with("path/not_found") => RemoteError::NotFound,
                other => plain(other),
            });
        }
        status => return Err(status_error(status)),
    }
    let mut bytes = Vec::new();
    response
        .body_mut()
        .with_config()
        .limit(u64::MAX)
        .reader()
        .take(limit)
        .read_to_end(&mut bytes)
        .map_err(|_| RemoteError::Unreachable)?;
    Ok(bytes)
}

impl DropboxStore {
    pub fn new(refresh_token: &str, root: &str) -> Self {
        DropboxStore {
            agent: agent(),
            refresh_token: refresh_token.to_owned(),
            access: None,
            root: root.to_owned(),
        }
    }

    /// `path` as Dropbox writes it: from a leading `/`, or empty for the
    /// root of the user's Dropbox.
    fn full(&self, path: &str) -> String {
        let joined = join(&self.root, path);
        if joined.is_empty() {
            joined
        } else {
            format!("/{joined}")
        }
    }

    /// An access token, renewed when it is about to lapse or `stale` says
    /// Dropbox refused it.
    fn token(&mut self, stale: bool) -> Result<String> {
        match &self.access {
            Some((token, until)) if !stale && Instant::now() < *until => Ok(token.clone()),
            _ => {
                let (token, lasts) = refresh(&self.agent, &self.refresh_token)?;
                let until = Instant::now() + lasts.saturating_sub(TOKEN_MARGIN);
                self.access = Some((token.clone(), until));
                Ok(token)
            }
        }
    }

    /// Calls the RPC endpoint `name` with `arg`, signing in again once if
    /// Dropbox says the access token has lapsed.
    fn rpc(&mut self, name: &str, arg: &Value) -> std::result::Result<Value, CallError> {
        let mut stale = false;
        loop {
            let token = self.token(stale)?;
            let mut response = self
                .agent
                .post(format!("{RPC_URL}{name}"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Content-Type", "application/json")
                .send(arg.to_string())
                .map_err(transport_error)?;
            match response.status().as_u16() {
                200 => return Ok(read_json(&mut response)?),
                409 => return Err(summary(&mut response)),
                401 if !stale => stale = true,
                status => return Err(status_error(status).into()),
            }
        }
    }

    fn entries(&mut self, at: String) -> Result<Vec<Value>> {
        let mut page = match self.rpc("list_folder", &json!({ "path": at })) {
            Ok(page) => page,
            Err(CallError::Api(s)) if s.starts_with("path/not_found") => return Ok(Vec::new()),
            Err(err) => return Err(plain(err)),
        };
        let mut entries = Vec::new();
        loop {
            if let Some(Value::Array(more)) = page.get_mut("entries").map(Value::take) {
                entries.extend(more);
            }
            if page.get("has_more") != Some(&Value::Bool(true)) {
                return Ok(entries);
            }
            let cursor = page.get("cursor").cloned().unwrap_or(Value::Null);
            page = self
                .rpc("list_folder/continue", &json!({ "cursor": cursor }))
                .map_err(plain)?;
        }
    }
}

fn str_of<'a>(entry: &'a Value, key: &str) -> &'a str {
    entry.get(key).and_then(Value::as_str).unwrap_or("")
}

impl Store for DropboxStore {
    fn kind(&mut self, path: &str) -> Result<Option<Kind>> {
        let full = self.full(path);
        if full.is_empty() {
            // The root of a Dropbox has no metadata; listing it says the
            // sign-in works.
            self.rpc("list_folder", &json!({ "path": "", "limit": 1 }))
                .map_err(plain)?;
            return Ok(Some(Kind::Dir));
        }
        match self.rpc("get_metadata", &json!({ "path": full })) {
            Ok(entry) => Ok(match str_of(&entry, ".tag") {
                "folder" => Some(Kind::Dir),
                "file" => Some(Kind::File),
                _ => None,
            }),
            Err(CallError::Api(s)) if s.starts_with("path/not_found") => Ok(None),
            Err(err) => Err(plain(err)),
        }
    }

    fn list(&mut self, dir: &str) -> Result<Vec<Child>> {
        let at = self.full(dir);
        Ok(self
            .entries(at)?
            .iter()
            .filter_map(|entry| {
                let name = str_of(entry, "name").to_owned();
                match str_of(entry, ".tag") {
                    "file" => Some(Child {
                        name,
                        kind: Kind::File,
                        size: entry.get("size").and_then(Value::as_u64).unwrap_or(0),
                        // Dropbox gives each revision of a file its own `rev`.
                        version: str_of(entry, "rev").to_owned(),
                    }),
                    "folder" => Some(Child {
                        name,
                        kind: Kind::Dir,
                        size: 0,
                        version: String::new(),
                    }),
                    _ => None,
                }
            })
            .collect())
    }

    fn read_all(&mut self, paths: &[(&str, u64)]) -> Vec<Result<Vec<u8>>> {
        let token = match self.token(false) {
            Ok(token) => token,
            Err(err) => return paths.iter().map(|_| Err(err.clone())).collect(),
        };
        let full: Vec<(String, u64)> = paths
            .iter()
            .map(|&(path, limit)| (self.full(path), limit))
            .collect();
        let (agent, token) = (&self.agent, token.as_str());
        let mut out = Vec::with_capacity(full.len());
        for chunk in full.chunks(PARALLEL_DOWNLOADS) {
            std::thread::scope(|scope| {
                let running: Vec<_> = chunk
                    .iter()
                    .map(|(path, limit)| scope.spawn(move || download(agent, token, path, *limit)))
                    .collect();
                for thread in running {
                    out.push(thread.join().unwrap_or(Err(RemoteError::Other)));
                }
            });
        }
        out
    }

    /// Dropbox commits an upload whole, so no reader sees half of it, and
    /// makes the folders on the way.
    fn write(&mut self, path: &str, bytes: &[u8]) -> Result<()> {
        let arg = json!({ "path": self.full(path), "mode": "overwrite", "mute": true });
        let mut stale = false;
        loop {
            let token = self.token(stale)?;
            let response = self
                .agent
                .post(format!("{CONTENT_URL}upload"))
                .header("Authorization", format!("Bearer {token}"))
                .header("Dropbox-API-Arg", header_json(&arg))
                .header("Content-Type", "application/octet-stream")
                .send(bytes)
                .map_err(transport_error)?;
            match response.status().as_u16() {
                200 => return Ok(()),
                401 if !stale => stale = true,
                409 => return Err(RemoteError::Other),
                status => return Err(status_error(status)),
            }
        }
    }

    /// Dropbox refuses a move onto anything already at `to` unless asked to
    /// rename around it, which this never asks.
    fn rename_new(&mut self, from: &str, to: &str) -> Result<()> {
        let arg = json!({ "from_path": self.full(from), "to_path": self.full(to) });
        match self.rpc("move_v2", &arg) {
            Ok(_) => Ok(()),
            Err(CallError::Api(s)) if s.starts_with("from_lookup/not_found") => {
                Err(RemoteError::NotFound)
            }
            Err(CallError::Api(s)) if s.starts_with("to/conflict") => Err(RemoteError::Exists),
            Err(err) => Err(plain(err)),
        }
    }

    fn remove_file(&mut self, path: &str) -> Result<()> {
        match self.rpc("delete_v2", &json!({ "path": self.full(path) })) {
            Ok(_) => Ok(()),
            Err(CallError::Api(s)) if s.starts_with("path_lookup/not_found") => Ok(()),
            Err(err) => Err(plain(err)),
        }
    }

    /// Dropbox deletes a folder with everything in it, so a folder that
    /// still holds anything is refused here, as a local `rmdir` refuses it.
    fn remove_dir(&mut self, path: &str) -> Result<()> {
        if !self.list(path)?.is_empty() {
            return Err(RemoteError::Other);
        }
        self.remove_file(path)
    }

    fn make_dirs(&mut self, path: &str) -> Result<()> {
        if path.is_empty() {
            return Ok(());
        }
        // Dropbox makes the folders on the way to the one it is asked for.
        match self.rpc("create_folder_v2", &json!({ "path": self.full(path) })) {
            Ok(_) => Ok(()),
            Err(CallError::Api(s)) if s.starts_with("path/conflict/folder") => Ok(()),
            Err(CallError::Api(s)) if s.starts_with("path/conflict") => Err(RemoteError::Exists),
            Err(err) => Err(plain(err)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_paths_as_dropbox_does() {
        let at = |root: &str, path: &str| DropboxStore::new("t", root).full(path);
        assert_eq!(at("", ""), "");
        assert_eq!(at("Sval", "sval/ws"), "/Sval/sval/ws");
        assert_eq!(at("", "sval"), "/sval");
    }

    #[test]
    fn a_header_argument_is_ascii() {
        assert_eq!(
            header_json(&json!({ "path": "/Café 🐱" })),
            "{\"path\":\"/Caf\\u00e9 \\ud83d\\udc31\"}"
        );
    }

    #[test]
    fn a_status_names_its_failure() {
        assert_eq!(status_error(401), RemoteError::SignIn);
        assert_eq!(status_error(403), RemoteError::Denied);
        assert_eq!(status_error(429), RemoteError::Unreachable);
        assert_eq!(status_error(503), RemoteError::Unreachable);
    }
}
