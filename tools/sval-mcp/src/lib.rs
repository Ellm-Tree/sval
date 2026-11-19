// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Connects a local MCP agent to Sval (agent-control spec §3.1): finds Sval,
//! authenticates with this agent's secret, and relays the agent's tool lists
//! and tool calls. The bridge speaks MCP's versions itself: it answers
//! `initialize`, `server/discover` and `ping`, and while Sval is away it
//! answers `tools/list` from the list Sval last sent and every call with an
//! error (`bridge`).

pub mod bridge;
pub mod frame;
pub mod install;
pub mod launch;
pub mod mcp;
pub mod proof;
pub mod secrets;
#[cfg(test)]
mod test_dir;
#[cfg(unix)]
pub mod update;
