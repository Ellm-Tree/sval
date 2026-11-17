// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Converts filter lists as the iPhone does and prints the rules as JSON
//! lines, to inspect what WebKit is given:
//! `cargo run --example convert -- <list>...`

fn main() {
    let lists = std::env::args()
        .skip(1)
        .map(|path| std::fs::read_to_string(path).unwrap())
        .collect();
    let out = sval_mobile::blocking::content_rules(lists, true, vec![]);
    for list in out.lists {
        let rules: Vec<serde_json::Value> = serde_json::from_str(&list).unwrap();
        for rule in rules {
            println!("{rule}");
        }
    }
}
