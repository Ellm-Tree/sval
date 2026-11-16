// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Connects a local MCP agent to Sval (agent-control spec §3.1): finds Sval,
//! authenticates with this agent's secret, and relays MCP messages. The
//! bridge answers `initialize` itself, and while Sval is away it answers
//! `ping`, `tools/list` from the list Sval last sent, and every other request
//! with an error (`bridge`).

pub mod bridge;
pub mod frame;
pub mod install;
pub mod launch;
pub mod proof;
pub mod secrets;
#[cfg(test)]
mod test_dir;
#[cfg(unix)]
pub mod update;
