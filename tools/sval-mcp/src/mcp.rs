// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! What Sval says of itself as an MCP server: the versions it speaks and the
//! instructions it gives an agent's model. Only this shim speaks MCP's
//! versions. Sval is sent each request with its version already checked, and
//! answers with a bare result (`bridge`).

/// The MCP versions Sval speaks, oldest first. A legacy version opens with
/// `initialize`, and a modern one carries its version and the client's
/// capabilities in every request's `_meta` (MCP 2026-07-28, "Versioning and
/// Compatibility").
pub const LEGACY_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-11-25"];
pub const MODERN_PROTOCOL_VERSIONS: &[&str] = &["2026-07-28"];
/// What `initialize` answers a version Sval does not speak with.
pub const LATEST_LEGACY_PROTOCOL_VERSION: &str = "2025-11-25";

/// What `initialize` and `server/discover` tell the agent's model about Sval.
pub const SERVER_INSTRUCTIONS: &str = r#"Sval is the user's own web browser, and you are signed in as them: your tabs
share their cookies and logins. Do only what the user asked, and ask them
before anything that spends money, sends messages, posts, deletes, or accepts
terms.

You work in a workspace of your own, in a window the user can watch. set_task
names it for your task, in a few words the user would recognise, and gives you
its id. Keep the id: in a later session, call use_workspace with it to get your
tabs back. When you finish a task, close the tabs you no longer need and call
close_window.

Act on elements by ref from your latest get_snapshot. Refs expire when the
page changes.

Unless the user has already decided, Sval asks them before you open a new
site, send what you typed, upload, or download. A failed call returns an error
code and a message that says what to do next: follow it. Never try to solve a
CAPTCHA or other check that a person is there, and never look for another way
into a site the user blocked. If you can't reach the user, stop and tell
whoever started you what Sval is waiting for. Don't add random delays or try to
look human.

Sval's documentation is at https://sval.app/docs/, in Markdown if you ask for
it."#;

#[cfg(test)]
mod tests {
    use super::{LATEST_LEGACY_PROTOCOL_VERSION, LEGACY_PROTOCOL_VERSIONS, SERVER_INSTRUCTIONS};

    /// Claude Code keeps only the first 4096 characters of a server's
    /// instructions.
    #[test]
    fn the_instructions_are_short() {
        assert!(SERVER_INSTRUCTIONS.len() <= 2048);
    }

    #[test]
    fn the_version_initialize_falls_back_to_is_one_it_speaks() {
        assert!(LEGACY_PROTOCOL_VERSIONS.contains(&LATEST_LEGACY_PROTOCOL_VERSION));
    }
}
