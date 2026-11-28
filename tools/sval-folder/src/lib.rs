// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Sval's shared-folder helper: the one process that reads
//! and writes the shared folder, so that a read stuck on a hung network mount
//! stalls this process and never the browser. The browser
//! starts it beside its own binary and talks to it over stdin and stdout.

pub mod errors;
pub mod frame;
pub mod links;
pub mod ops;
pub mod paths;
pub mod remote;
pub mod serve;
#[cfg(test)]
mod test_dir;
