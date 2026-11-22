// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! A folder in the user's Dropbox, reached through Dropbox's API (mobile spec
//! §8.1). Paths are relative to the folder, as the engine names them
//! (`sval/ws/...`). Any folder can be the Sval folder, because a desktop
//! picks any folder its Dropbox client keeps on disk.
//!
//! Sign-in is OAuth 2 with PKCE: the app holds no secret, only Dropbox's
//! refresh token, which it keeps with the sync key. Every call blocks until
//! Dropbox answers, so an app calls in from a thread of its own.

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dropbox_sdk::default_client::{NoauthDefaultClient, UserAuthDefaultClient};
use dropbox_sdk::files::{self, LookupError, Metadata, WriteMode};
use dropbox_sdk::oauth2::{Authorization, AuthorizeUrlBuilder, Oauth2Type, PkceCode};

use crate::{ConnectorError, FileEntry, Stop};

/// A sign-in begun: the page to open, and what finishing it needs.
#[derive(uniffi::Record)]
pub struct DropboxSignIn {
    /// Dropbox's sign-in page, which sends the user back to `redirect`.
    pub url: String,
    /// The PKCE verifier, handed back to [`dropbox_finish_sign_in`].
    pub verifier: String,
}

/// The page that signs the user in to Dropbox and asks them to let Sval in,
/// for an app whose key is `app_key`.
#[uniffi::export]
pub fn dropbox_sign_in(app_key: String, redirect: String) -> DropboxSignIn {
    let code = PkceCode::new();
    let flow = Oauth2Type::PKCE(code.clone());
    let url = AuthorizeUrlBuilder::new(&app_key, &flow)
        .redirect_uri(&redirect)
        .build();
    DropboxSignIn {
        url: url.to_string(),
        verifier: code.code,
    }
}

/// Trades the code Dropbox sent back for a refresh token, which the app
/// keeps and passes to [`DropboxFolder::connect`].
#[uniffi::export]
pub fn dropbox_finish_sign_in(
    app_key: String,
    verifier: String,
    code: String,
    redirect: String,
) -> Result<String, ConnectorError> {
    let mut auth = Authorization::from_auth_code(
        app_key,
        Oauth2Type::PKCE(PkceCode { code: verifier }),
        code,
        Some(redirect),
    );
    auth.obtain_access_token(NoauthDefaultClient::default())
        .map_err(|e| map_error(&e, |_: &dropbox_sdk::NoError| false))?;
    auth.save()
        .and_then(|saved| saved.strip_prefix("2&").map(str::to_owned))
        .ok_or(ConnectorError::Other {
            message: "Dropbox didn't send a sign-in that lasts.".into(),
        })
}

#[derive(uniffi::Object)]
pub struct DropboxFolder {
    client: UserAuthDefaultClient,
    /// The folder, as Dropbox writes a path: `/Sval`, or empty for the root.
    root: String,
}

#[uniffi::export]
impl DropboxFolder {
    /// Opens `root`, a folder in the user's Dropbox, with the refresh token
    /// sign-in gave. An expired or revoked token is reported here.
    #[uniffi::constructor]
    pub fn connect(
        app_key: String,
        refresh_token: String,
        root: String,
    ) -> Result<Arc<Self>, ConnectorError> {
        let folder = Self {
            client: client(app_key, refresh_token),
            root: dropbox_path(&root, ""),
        };
        if !folder.root.is_empty() {
            match files::get_metadata(
                &folder.client,
                &files::GetMetadataArg::new(folder.root.clone()),
            ) {
                Ok(Metadata::Folder(_)) => {}
                Ok(_) => return Err(ConnectorError::NotFound),
                Err(e) => {
                    return Err(map_error(&e, |e| {
                        matches!(e, files::GetMetadataError::Path(LookupError::NotFound))
                    }));
                }
            }
        } else {
            files::list_folder(
                &folder.client,
                &files::ListFolderArg::new(String::new()).with_limit(1),
            )
            .map_err(|e| map_error(&e, not_found_listing))?;
        }
        Ok(Arc::new(folder))
    }

    /// The entries directly in `directory`, by path relative to the folder.
    /// A directory that does not exist holds none.
    pub fn list(&self, directory: String) -> Result<Vec<String>, ConnectorError> {
        Ok(self
            .entries(&directory)?
            .into_iter()
            .filter_map(|entry| match entry {
                Metadata::File(file) => Some(file.name),
                Metadata::Folder(folder) => Some(folder.name),
                Metadata::Deleted(_) => None,
            })
            .map(|name| join(&directory, &name))
            .collect())
    }

    /// The files directly in `directory`, with their sizes and times. A
    /// directory that does not exist holds none.
    pub fn files(&self, directory: String) -> Result<Vec<FileEntry>, ConnectorError> {
        Ok(self
            .entries(&directory)?
            .into_iter()
            .filter_map(|entry| match entry {
                Metadata::File(file) => Some(FileEntry {
                    path: join(&directory, &file.name),
                    size: file.size,
                    modified_ms: timestamp_ms(&file.server_modified).unwrap_or(0),
                }),
                _ => None,
            })
            .collect())
    }

    pub fn exists(&self, path: String) -> Result<bool, ConnectorError> {
        match files::get_metadata(&self.client, &files::GetMetadataArg::new(self.full(&path))) {
            Ok(_) => Ok(true),
            Err(dropbox_sdk::Error::Api(files::GetMetadataError::Path(LookupError::NotFound))) => {
                Ok(false)
            }
            Err(e) => Err(map_error(&e, |_| false)),
        }
    }

    pub fn read(&self, path: String) -> Result<Vec<u8>, ConnectorError> {
        let response = files::download(
            &self.client,
            &files::DownloadArg::new(self.full(&path)),
            None,
            None,
        )
        .map_err(|e| {
            map_error(&e, |e| {
                matches!(e, files::DownloadError::Path(LookupError::NotFound))
            })
        })?;
        let mut bytes = Vec::new();
        if let Some(mut body) = response.body {
            body.read_to_end(&mut bytes)
                .map_err(|e| ConnectorError::Unreachable {
                    message: e.to_string(),
                })?;
        }
        Ok(bytes)
    }

    /// Writes `bytes` at `path`. Dropbox commits an upload whole, so no
    /// reader sees half of it, and makes the folders on the way.
    pub fn write(&self, path: String, bytes: Vec<u8>) -> Result<(), ConnectorError> {
        let arg = files::UploadArg::new(self.full(&path))
            .with_mode(WriteMode::Overwrite)
            .with_mute(true);
        files::upload(&self.client, &arg, &bytes)
            .map(|_| ())
            .map_err(|e| map_error(&e, |_| false))
    }

    pub fn delete(&self, path: String) -> Result<(), ConnectorError> {
        files::delete_v2(&self.client, &files::DeleteArg::new(self.full(&path)))
            .map(|_| ())
            .map_err(|e| {
                map_error(&e, |e| {
                    matches!(e, files::DeleteError::PathLookup(LookupError::NotFound))
                })
            })
    }

    /// Renames the file at `from` to `to`. Dropbox refuses a move onto
    /// anything already at `to` unless asked to rename around it, which
    /// this never asks, so nothing there is ever replaced.
    pub fn move_file(&self, from: String, to: String) -> Result<(), ConnectorError> {
        let arg = files::RelocationArg::new(self.full(&from), self.full(&to));
        files::move_v2(&self.client, &arg)
            .map(|_| ())
            .map_err(|e| {
                map_error(&e, |e| {
                    matches!(e, files::RelocationError::FromLookup(LookupError::NotFound))
                })
            })
    }

    /// The folders directly in `directory`, by Dropbox path, for choosing
    /// the Sval folder. Empty is the root.
    pub fn folders(&self, directory: String) -> Result<Vec<String>, ConnectorError> {
        let mut names: Vec<String> = self
            .entries_at(dropbox_path(&directory, ""))?
            .into_iter()
            .filter_map(|entry| match entry {
                Metadata::Folder(folder) => folder.path_display,
                _ => None,
            })
            .collect();
        names.sort_by_key(|name| name.to_lowercase());
        Ok(names)
    }
}

impl DropboxFolder {
    fn full(&self, path: &str) -> String {
        dropbox_path(&self.root, path)
    }

    fn entries(&self, directory: &str) -> Result<Vec<Metadata>, ConnectorError> {
        self.entries_at(self.full(directory))
    }

    /// Every entry of the folder at Dropbox path `at`, following Dropbox's
    /// pages. A folder that does not exist holds none.
    fn entries_at(&self, at: String) -> Result<Vec<Metadata>, ConnectorError> {
        let mut page = match files::list_folder(&self.client, &files::ListFolderArg::new(at)) {
            Ok(page) => page,
            Err(dropbox_sdk::Error::Api(files::ListFolderError::Path(LookupError::NotFound))) => {
                return Ok(Vec::new());
            }
            Err(e) => return Err(map_error(&e, |_| false)),
        };
        let mut entries = std::mem::take(&mut page.entries);
        while page.has_more {
            page = files::list_folder_continue(
                &self.client,
                &files::ListFolderContinueArg::new(page.cursor),
            )
            .map_err(|e| map_error(&e, |_| false))?;
            entries.append(&mut page.entries);
        }
        Ok(entries)
    }
}

/// A watch on a folder in the user's Dropbox and everything below it.
#[derive(uniffi::Object)]
pub struct DropboxWatcher {
    client: UserAuthDefaultClient,
    /// Where the next wait starts from: everything up to it is seen.
    cursor: Mutex<String>,
    stop: Stop,
}

/// What a wait ended with.
#[derive(Debug, PartialEq, uniffi::Enum)]
pub enum DropboxChange {
    /// Something in the folder changed. Dropbox doesn't say what.
    Changed,
    /// The long poll ran its time with no change.
    Unchanged,
    /// The watcher was cancelled, and watches no more.
    Cancelled,
}

/// How long a long poll waits for a change, in seconds: the least
/// `files/list_folder/longpoll` takes (`ListFolderLongpollArg.timeout` in
/// Dropbox's API spec, 30 to 480). ureq, the SDK's client, can't end a
/// request under way, so a cancelled watcher's thread waits out the poll it
/// is in, which Dropbox may hold up to 90 seconds past this.
const LONGPOLL_SECONDS: u64 = 30;

#[uniffi::export]
impl DropboxWatcher {
    #[uniffi::constructor]
    pub fn watch(
        app_key: String,
        refresh_token: String,
        root: String,
    ) -> Result<Arc<Self>, ConnectorError> {
        let client = client(app_key, refresh_token);
        let arg = files::ListFolderArg::new(dropbox_path(&root, "")).with_recursive(true);
        let cursor = files::list_folder_get_latest_cursor(&client, &arg)
            .map_err(|e| map_error(&e, not_found_listing))?
            .cursor;
        Ok(Arc::new(Self {
            client,
            cursor: Mutex::new(cursor),
            stop: Stop::new(),
        }))
    }

    /// Waits until something in the folder changes, for one long poll, and
    /// says whether anything did. An error means the watch is over, and the
    /// app makes a new one when it wants to go on watching.
    pub fn wait(&self) -> Result<DropboxChange, ConnectorError> {
        if self.stop.is_stopped() {
            return Ok(DropboxChange::Cancelled);
        }
        let mut cursor = self.cursor.lock().unwrap_or_else(|e| e.into_inner());
        let answer = files::list_folder_longpoll(
            &NoauthDefaultClient::default(),
            &files::ListFolderLongpollArg::new(cursor.clone()).with_timeout(LONGPOLL_SECONDS),
        )
        .map_err(|e| map_error(&e, |_| false))?;
        let stopped = match answer.backoff {
            Some(seconds) => self.stop.sleep(Duration::from_secs(seconds)),
            None => self.stop.is_stopped(),
        };
        if stopped {
            return Ok(DropboxChange::Cancelled);
        }
        if !answer.changes {
            return Ok(DropboxChange::Unchanged);
        }
        // Moves the cursor past what changed, so the next wait waits.
        loop {
            let page = files::list_folder_continue(
                &self.client,
                &files::ListFolderContinueArg::new(cursor.clone()),
            )
            .map_err(|e| map_error(&e, |_| false))?;
            *cursor = page.cursor;
            if !page.has_more {
                return Ok(DropboxChange::Changed);
            }
        }
    }

    /// Ends every wait after it, and a backoff under way, with
    /// [`DropboxChange::Cancelled`]. A long poll under way runs out first.
    pub fn cancel(&self) {
        self.stop.stop();
    }
}

fn client(app_key: String, refresh_token: String) -> UserAuthDefaultClient {
    UserAuthDefaultClient::new(Authorization::from_refresh_token(app_key, refresh_token))
}

fn not_found_listing(error: &files::ListFolderError) -> bool {
    matches!(error, files::ListFolderError::Path(LookupError::NotFound))
}

/// What a failed call means to the app. `not_found` says which of the
/// call's own errors means nothing is at the path.
fn map_error<E>(error: &dropbox_sdk::Error<E>, not_found: impl Fn(&E) -> bool) -> ConnectorError
where
    E: std::fmt::Display,
{
    match error {
        dropbox_sdk::Error::Api(e) if not_found(e) => ConnectorError::NotFound,
        dropbox_sdk::Error::Authentication(_) => ConnectorError::DropboxSignIn,
        dropbox_sdk::Error::AccessDenied(_) => ConnectorError::DropboxSignIn,
        dropbox_sdk::Error::HttpClient(e) => ConnectorError::DropboxUnreachable {
            message: e.to_string(),
        },
        other => ConnectorError::Other {
            message: other.to_string(),
        },
    }
}

/// `path` within `root`, as Dropbox writes a path: from a leading `/`, or
/// empty for the root of the user's Dropbox.
fn dropbox_path(root: &str, path: &str) -> String {
    let joined = join(root, path);
    if joined.is_empty() {
        joined
    } else {
        format!("/{joined}")
    }
}

/// `a/b` from `a` and `b`, either of which may be empty.
fn join(a: &str, b: &str) -> String {
    let (a, b) = (a.trim_matches('/'), b.trim_matches('/'));
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_owned(),
        (_, true) => a.to_owned(),
        _ => format!("{a}/{b}"),
    }
}

/// A Dropbox timestamp (`%Y-%m-%dT%H:%M:%SZ`, `DropboxTimestamp`) in
/// milliseconds since the Unix epoch.
fn timestamp_ms(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() != 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[19] != b'Z' {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (hour, minute, second) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
    // Days from the civil date (Howard Hinnant's `days_from_civil`).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(((days * 24 + hour) * 60 + minute) * 60_000 + second * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dropbox_timestamps() {
        assert_eq!(timestamp_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(timestamp_ms("2000-03-01T00:00:01Z"), Some(951_868_801_000));
        assert_eq!(
            timestamp_ms("2026-11-16T12:30:00Z"),
            Some(1_794_832_200_000)
        );
        assert_eq!(timestamp_ms("2026-11-16 12:30:00"), None);
    }

    #[test]
    fn writes_paths_as_dropbox_does() {
        assert_eq!(dropbox_path("", ""), "");
        assert_eq!(dropbox_path("/Sval/", "sval/ws"), "/Sval/sval/ws");
        assert_eq!(dropbox_path("", "sval"), "/sval");
    }

    #[test]
    fn a_sign_in_page_asks_for_a_lasting_sign_in_without_a_secret() {
        let begun = dropbox_sign_in("key".into(), "db-key://2/token".into());
        let url = url::Url::parse(&begun.url).unwrap();
        let query: std::collections::BTreeMap<_, _> = url.query_pairs().into_owned().collect();
        assert_eq!(url.host_str(), Some("www.dropbox.com"));
        assert_eq!(query["token_access_type"], "offline");
        assert_eq!(query["code_challenge_method"], "S256");
        assert_eq!(query["redirect_uri"], "db-key://2/token");
        assert!(!query.contains_key("client_secret"));
        assert!(begun.verifier.len() >= 43);
    }

    #[test]
    fn a_cancelled_watcher_waits_no_more() {
        // Built by hand, since `watch` asks Dropbox for the cursor. A wait
        // that polled would fail on the made-up token.
        let watcher = DropboxWatcher {
            client: client("key".into(), "token".into()),
            cursor: Mutex::new("cursor".into()),
            stop: Stop::new(),
        };
        watcher.cancel();
        assert_eq!(watcher.wait().ok(), Some(DropboxChange::Cancelled));
    }
}
