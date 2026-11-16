// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Every session of one AI app on a profile connects as the one agent the
//! user allowed (decision 1998), wherever it was launched and however many
//! run at once.

mod common;

use common::*;
use std::io::{BufReader, Write};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use sval_mcp::bridge::{account_for, run_launched};
use sval_mcp::secrets::{MemoryStore, SecretStore};

#[test]
fn a_session_launched_in_another_folder_is_the_same_agent() {
    let (port, handshakes) = pairing_sval();
    let profile = profile_with_port(port);
    let store = Arc::new(MemoryStore::default());
    run_once(&profile, store.clone(), launched_in("/work/sval"));
    run_once(&profile, store, launched_in("/home/someone"));
    let hs = handshakes.lock().unwrap().clone();
    assert_eq!(hs[0]["pair"], true);
    assert_eq!(
        hs[1]["agent_id"], "a0",
        "the second session is the app's agent"
    );
    assert_eq!(hs[1]["secret"], "s0");
    assert_eq!(hs[0]["launch"]["id"], hs[1]["launch"]["id"]);
    assert_eq!(hs[1]["launch"]["dir"], "/home/someone");
}

#[test]
fn two_live_sessions_of_one_app_share_its_pairing() {
    let (port, handshakes) = pairing_sval();
    let profile = profile_with_port(port);
    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::default());
    let start = |store: Arc<dyn SecretStore>| {
        let (reader, writer) = std::io::pipe().unwrap();
        let profile = profile.to_path_buf();
        let handle = thread::spawn(move || {
            run_launched(
                BufReader::new(reader),
                Captured::default(),
                &profile,
                launched_in("/work/sval"),
                store,
            )
            .unwrap();
        });
        (writer, handle)
    };
    let account = account_for(&profile, "Test Agent");

    let (mut first, first_done) = start(store.clone());
    writeln!(first, "{INIT}").unwrap();
    wait_until(
        Duration::from_secs(5),
        || "the first session never stored its secret".into(),
        || store.load(&account).map(|_| ()),
    );
    let (mut second, second_done) = start(store.clone());
    writeln!(second, "{INIT}").unwrap();
    wait_until(
        Duration::from_secs(5),
        || "no second handshake".into(),
        || (handshakes.lock().unwrap().len() >= 2).then_some(()),
    );
    let hs = handshakes.lock().unwrap().clone();
    assert_eq!(hs[0]["pair"], true);
    assert_eq!(
        hs[1]["agent_id"], "a0",
        "the second session presents the app's secret while the first runs"
    );
    assert_eq!(hs[0]["launch"]["id"], hs[1]["launch"]["id"]);
    drop(first);
    drop(second);
    first_done.join().unwrap();
    second_done.join().unwrap();
}
