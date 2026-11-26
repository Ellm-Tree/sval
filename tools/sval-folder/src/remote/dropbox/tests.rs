// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The Dropbox client against a local HTTP server that answers as Dropbox's
//! API documentation says Dropbox does.

use super::*;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

/// One request the server took.
#[derive(Clone, Debug)]
struct Seen {
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

impl Seen {
    fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap()
    }

    fn arg(&self) -> Value {
        serde_json::from_str(&self.headers["dropbox-api-arg"]).unwrap()
    }

    fn form(&self) -> HashMap<String, String> {
        String::from_utf8_lossy(&self.body)
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect()
    }
}

/// An answer: the status, and a JSON body or raw bytes.
struct Answer {
    status: u16,
    body: Vec<u8>,
}

fn ok(body: Value) -> Answer {
    Answer {
        status: 200,
        body: body.to_string().into_bytes(),
    }
}

fn conflict(summary: &str) -> Answer {
    Answer {
        status: 409,
        body: json!({ "error_summary": summary, "error": {} })
            .to_string()
            .into_bytes(),
    }
}

fn status(code: u16) -> Answer {
    Answer {
        status: code,
        body: Vec::new(),
    }
}

type Handler = dyn Fn(&Seen) -> Answer + Send + Sync;

/// A server on loopback that hands each request to a handler and keeps
/// what it was asked. The token endpoint answers with `access-1` unless the
/// handler answers it first.
struct Server {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl Server {
    fn start(handler: impl Fn(&Seen) -> Option<Answer> + Send + Sync + 'static) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let handler: Arc<Handler> = Arc::new(move |request: &Seen| {
            handler(request).unwrap_or_else(|| {
                if request.path == "/oauth2/token" {
                    ok(json!({ "access_token": "access-1", "expires_in": 14400 }))
                } else {
                    status(500)
                }
            })
        });
        let kept = Arc::clone(&seen);
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let (handler, kept) = (Arc::clone(&handler), Arc::clone(&kept));
                std::thread::spawn(move || serve(stream, &*handler, &kept));
            }
        });
        Server { base, seen }
    }

    fn store(&self, root: &str) -> DropboxStore {
        DropboxStore::at(
            Endpoints {
                token: format!("{}/oauth2/token", self.base),
                rpc: format!("{}/2/files/", self.base),
                content: format!("{}/content/2/files/", self.base),
            },
            "refresh-1",
            root,
        )
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The requests made to `path`.
    fn to(&self, path: &str) -> Vec<Seen> {
        self.seen().into_iter().filter(|s| s.path == path).collect()
    }
}

/// Answers each request on one connection, as many as the client sends.
fn serve(stream: TcpStream, handler: &Handler, seen: &Mutex<Vec<Seen>>) {
    let mut writer = stream.try_clone().unwrap();
    let mut reader = BufReader::new(stream);
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).unwrap_or(0) == 0 {
            return;
        }
        let path = line.split(' ').nth(1).unwrap_or("").to_owned();
        let mut headers = HashMap::new();
        loop {
            let mut header = String::new();
            reader.read_line(&mut header).unwrap();
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((name, value)) = header.split_once(':') {
                headers.insert(name.trim().to_ascii_lowercase(), value.trim().to_owned());
            }
        }
        let length: usize = headers
            .get("content-length")
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        let mut body = vec![0; length];
        reader.read_exact(&mut body).unwrap();
        let request = Seen {
            path,
            headers,
            body,
        };
        seen.lock().unwrap().push(request.clone());
        let answer = handler(&request);
        let head = format!(
            "HTTP/1.1 {} X\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n",
            answer.status,
            answer.body.len()
        );
        if writer.write_all(head.as_bytes()).is_err() || writer.write_all(&answer.body).is_err() {
            return;
        }
    }
}

const LIST: &str = "/2/files/list_folder";

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

#[test]
fn a_listing_signs_in_once_and_reads_every_page() {
    let server = Server::start(|request| match request.path.as_str() {
        LIST => Some(ok(json!({
            "entries": [
                { ".tag": "file", "name": "a.json", "size": 12, "rev": "015a" },
                { ".tag": "deleted", "name": "gone.json" },
            ],
            "cursor": "c-1",
            "has_more": true,
        }))),
        "/2/files/list_folder/continue" => Some(ok(json!({
            "entries": [{ ".tag": "folder", "name": "ws" }],
            "cursor": "c-2",
            "has_more": false,
        }))),
        _ => None,
    });
    let mut store = server.store("Sval");
    let listed = store.list("sval").unwrap();
    assert_eq!(
        listed,
        vec![
            Child {
                name: "a.json".into(),
                kind: Kind::File,
                size: 12,
                version: "015a".into(),
            },
            Child {
                name: "ws".into(),
                kind: Kind::Dir,
                size: 0,
                version: String::new(),
            },
        ],
        "a deleted entry is passed over"
    );
    store.list("sval").unwrap();

    let refreshes = server.to("/oauth2/token");
    assert_eq!(
        refreshes.len(),
        1,
        "the access token is kept while it holds"
    );
    let form = refreshes[0].form();
    assert_eq!(form["grant_type"], "refresh_token");
    assert_eq!(form["refresh_token"], "refresh-1");
    assert_eq!(form["client_id"], APP_KEY);

    let listing = &server.to(LIST)[0];
    assert_eq!(listing.json(), json!({ "path": "/Sval/sval" }));
    assert_eq!(listing.headers["authorization"], "Bearer access-1");
    assert_eq!(
        server.to("/2/files/list_folder/continue")[0].json(),
        json!({ "cursor": "c-1" })
    );
}

#[test]
fn a_missing_folder_lists_nothing() {
    let server =
        Server::start(|request| (request.path == LIST).then(|| conflict("path/not_found/..")));
    assert_eq!(server.store("Sval").list("sval"), Ok(Vec::new()));
}

#[test]
fn a_lapsed_access_token_is_renewed_once() {
    let calls = Arc::new(Mutex::new(0));
    let counted = Arc::clone(&calls);
    let server = Server::start(move |request| {
        (request.path == LIST).then(|| {
            let mut calls = counted.lock().unwrap();
            *calls += 1;
            // The first call's token has lapsed; the renewed one works.
            if *calls == 1 {
                status(401)
            } else {
                ok(json!({ "entries": [], "cursor": "c", "has_more": false }))
            }
        })
    });
    assert_eq!(server.store("").list(""), Ok(Vec::new()));
    assert_eq!(server.to("/oauth2/token").len(), 2);

    let refused = Server::start(|request| (request.path == LIST).then(|| status(401)));
    assert_eq!(
        refused.store("").list(""),
        Err(RemoteError::SignIn),
        "a token refused again is a sign-in Dropbox no longer takes"
    );
    assert_eq!(refused.to(LIST).len(), 2, "and is tried once more only");
}

#[test]
fn a_revoked_refresh_token_is_a_refused_sign_in() {
    let server = Server::start(|request| {
        (request.path == "/oauth2/token").then(|| Answer {
            status: 400,
            body: br#"{"error":"invalid_grant"}"#.to_vec(),
        })
    });
    assert_eq!(server.store("Sval").kind("sval"), Err(RemoteError::SignIn));
    assert!(
        server.to(LIST).is_empty(),
        "nothing is asked without a token"
    );
}

#[test]
fn a_kind_is_read_from_metadata() {
    let server = Server::start(|request| match request.path.as_str() {
        "/2/files/get_metadata" => Some(match request.json()["path"].as_str() {
            Some("/Sval/dir") => ok(json!({ ".tag": "folder", "name": "dir" })),
            Some("/Sval/f.json") => ok(json!({ ".tag": "file", "name": "f.json" })),
            _ => conflict("path/not_found/.."),
        }),
        LIST => Some(ok(
            json!({ "entries": [], "cursor": "c", "has_more": false }),
        )),
        _ => None,
    });
    let mut store = server.store("Sval");
    assert_eq!(store.kind("dir"), Ok(Some(Kind::Dir)));
    assert_eq!(store.kind("f.json"), Ok(Some(Kind::File)));
    assert_eq!(store.kind("nothing"), Ok(None));

    let mut whole = server.store("");
    assert_eq!(whole.kind(""), Ok(Some(Kind::Dir)), "the Dropbox's root");
    assert_eq!(
        server.to(LIST)[0].json(),
        json!({ "path": "", "limit": 1 }),
        "which has no metadata, so is listed"
    );
}

#[test]
fn reads_are_bounded_and_name_a_missing_file() {
    let server = Server::start(|request| {
        (request.path == "/content/2/files/download").then(|| {
            match request.arg()["path"].as_str() {
                Some("/Sval/big.json") => Answer {
                    status: 200,
                    body: vec![b'x'; 100],
                },
                Some("/Sval/Caf\u{e9}.json") => Answer {
                    status: 200,
                    body: b"cafe".to_vec(),
                },
                _ => conflict("path/not_found/.."),
            }
        })
    });
    let mut store = server.store("Sval");
    let read = store.read_all(&[("big.json", 10), ("Caf\u{e9}.json", 50), ("gone.json", 10)]);
    assert_eq!(
        read[0],
        Ok(vec![b'x'; 10]),
        "no more than the limit is kept"
    );
    assert_eq!(
        read[1],
        Ok(b"cafe".to_vec()),
        "a name past ASCII is escaped"
    );
    assert_eq!(read[2], Err(RemoteError::NotFound));
    let header = &server
        .to("/content/2/files/download")
        .into_iter()
        .find(|s| s.headers["dropbox-api-arg"].contains("Caf"))
        .unwrap()
        .headers["dropbox-api-arg"];
    assert!(header.is_ascii(), "{header}");
    assert_eq!(
        server.to("/oauth2/token").len(),
        1,
        "every download shares one token"
    );
}

#[test]
fn a_write_uploads_over_what_is_there() {
    let server = Server::start(|request| {
        (request.path == "/content/2/files/upload").then(|| ok(json!({ "name": "me.json" })))
    });
    server
        .store("Sval")
        .write("sval/me.json", b"bytes")
        .unwrap();
    let upload = &server.to("/content/2/files/upload")[0];
    assert_eq!(
        upload.arg(),
        json!({ "path": "/Sval/sval/me.json", "mode": "overwrite", "mute": true })
    );
    assert_eq!(upload.body, b"bytes");
    assert_eq!(upload.headers["content-type"], "application/octet-stream");

    let full = Server::start(|request| {
        (request.path == "/content/2/files/upload").then(|| conflict("path/insufficient_space/"))
    });
    assert_eq!(
        full.store("Sval").write("sval/me.json", b"bytes"),
        Err(RemoteError::Other)
    );
}

#[test]
fn a_move_never_replaces() {
    let server = Server::start(|request| {
        (request.path == "/2/files/move_v2").then(|| match request.json()["to_path"].as_str() {
            Some("/Sval/taken") => conflict("to/conflict/file/.."),
            Some("/Sval/new") if request.json()["from_path"] == "/Sval/gone" => {
                conflict("from_lookup/not_found/..")
            }
            _ => ok(json!({ "metadata": {} })),
        })
    });
    let mut store = server.store("Sval");
    assert_eq!(store.rename_new("a", "b"), Ok(()));
    assert_eq!(
        server.to("/2/files/move_v2")[0].json(),
        json!({ "from_path": "/Sval/a", "to_path": "/Sval/b" }),
        "asking for no rename around a conflict"
    );
    assert_eq!(store.rename_new("a", "taken"), Err(RemoteError::Exists));
    assert_eq!(store.rename_new("gone", "new"), Err(RemoteError::NotFound));
}

#[test]
fn removing_leaves_a_folder_that_holds_anything() {
    let server = Server::start(|request| match request.path.as_str() {
        "/2/files/delete_v2" => Some(conflict("path_lookup/not_found/..")),
        LIST => Some(ok(json!({
            "entries": match request.json()["path"].as_str() {
                Some("/Sval/full") => json!([{ ".tag": "file", "name": "a", "size": 1, "rev": "1" }]),
                _ => json!([]),
            },
            "cursor": "c",
            "has_more": false,
        }))),
        _ => None,
    });
    let mut store = server.store("Sval");
    assert_eq!(
        store.remove_file("gone.json"),
        Ok(()),
        "a file already gone"
    );
    assert_eq!(store.remove_dir("full"), Err(RemoteError::Other));
    assert_eq!(
        server.to("/2/files/delete_v2").len(),
        1,
        "Dropbox is never asked to delete a folder with anything in it"
    );
    assert_eq!(store.remove_dir("empty"), Ok(()));
}

#[test]
fn making_a_folder_that_exists_is_done() {
    let server = Server::start(|request| {
        (request.path == "/2/files/create_folder_v2").then(|| {
            match request.json()["path"].as_str() {
                Some("/Sval/dir") => conflict("path/conflict/folder/.."),
                Some("/Sval/file") => conflict("path/conflict/file/.."),
                _ => ok(json!({ "metadata": {} })),
            }
        })
    });
    let mut store = server.store("Sval");
    assert_eq!(store.make_dirs("new/deep"), Ok(()));
    assert_eq!(
        server.to("/2/files/create_folder_v2")[0].json(),
        json!({ "path": "/Sval/new/deep" }),
        "Dropbox makes the folders on the way"
    );
    assert_eq!(store.make_dirs("dir"), Ok(()));
    assert_eq!(store.make_dirs("file"), Err(RemoteError::Exists));
    assert_eq!(store.make_dirs(""), Ok(()));
}

#[test]
fn a_busy_or_refusing_dropbox_says_so() {
    for (code, err) in [
        (429, RemoteError::Unreachable),
        (503, RemoteError::Unreachable),
        (403, RemoteError::Denied),
    ] {
        let server = Server::start(move |request| (request.path == LIST).then(|| status(code)));
        assert_eq!(server.store("").list(""), Err(err), "{code}");
    }
    // Nothing listens on loopback's port 9.
    let mut nowhere = DropboxStore::at(
        Endpoints {
            token: "http://127.0.0.1:9/oauth2/token".into(),
            rpc: "http://127.0.0.1:9/2/files/".into(),
            content: "http://127.0.0.1:9/content/2/files/".into(),
        },
        "refresh-1",
        "",
    );
    assert_eq!(nowhere.list(""), Err(RemoteError::Unreachable));
}
