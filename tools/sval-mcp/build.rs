// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Takes `SERVER_INSTRUCTIONS` and the MCP versions Sval speaks from Sval's own
//! source, so what the bridge answers `initialize` and `server/discover` with
//! is Sval's, from one copy.

use std::path::Path;

const SOURCE: &str = "../../chrome/browser/components/sval/SvalAgentSession.sys.mjs";
const START: &str = "export const SERVER_INSTRUCTIONS = `";
const LEGACY: &str = "const LEGACY_PROTOCOL_VERSIONS = [";
const MODERN: &str = "const MODERN_PROTOCOL_VERSIONS = [";
const LATEST: &str = "const LATEST_LEGACY_PROTOCOL_VERSION = \"";

fn main() {
    println!("cargo:rerun-if-changed={SOURCE}");
    let source = std::fs::read_to_string(SOURCE)
        .unwrap_or_else(|err| panic!("sval-mcp builds inside the sval tree: {SOURCE}: {err}"));
    let from = source
        .find(START)
        .unwrap_or_else(|| panic!("{SOURCE} declares SERVER_INSTRUCTIONS"))
        + START.len();
    let len = source[from..]
        .find("`;")
        .unwrap_or_else(|| panic!("{SOURCE}: SERVER_INSTRUCTIONS is one template literal"));
    let text = &source[from..from + len];
    assert!(
        !text.contains("${") && !text.contains('\\'),
        "{SOURCE}: SERVER_INSTRUCTIONS has no substitutions or escapes, so its source is its text"
    );
    let out = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR");
    std::fs::write(Path::new(&out).join("server_instructions.txt"), text).unwrap();
    std::fs::write(
        Path::new(&out).join("protocol_versions.rs"),
        protocol_versions(&source),
    )
    .unwrap();
}

/// `LEGACY_PROTOCOL_VERSIONS`, `MODERN_PROTOCOL_VERSIONS` and
/// `LATEST_LEGACY_PROTOCOL_VERSION` as Rust constants. Each list is plain
/// string literals in the source.
fn protocol_versions(source: &str) -> String {
    let after = |start: &str, end: &str| {
        let from = source
            .find(start)
            .unwrap_or_else(|| panic!("{SOURCE} declares `{start}`"))
            + start.len();
        let len = source[from..]
            .find(end)
            .unwrap_or_else(|| panic!("{SOURCE}: `{start}` ends with `{end}`"));
        &source[from..from + len]
    };
    let list = |start: &str| -> Vec<&str> {
        after(start, "];")
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(|v| {
                v.strip_prefix('"')
                    .and_then(|v| v.strip_suffix('"'))
                    .unwrap_or_else(|| {
                        panic!("{SOURCE}: a protocol version is a plain string: {v}")
                    })
            })
            .collect()
    };
    let (legacy, modern) = (list(LEGACY), list(MODERN));
    let latest = after(LATEST, "\";");
    assert!(
        legacy.contains(&latest),
        "{SOURCE}: LATEST_LEGACY_PROTOCOL_VERSION is one of LEGACY_PROTOCOL_VERSIONS"
    );
    format!(
        "const LEGACY_PROTOCOL_VERSIONS: &[&str] = &{legacy:?};\nconst MODERN_PROTOCOL_VERSIONS: &[&str] = &{modern:?};\nconst LATEST_LEGACY_PROTOCOL_VERSION: &str = {latest:?};\n"
    )
}
