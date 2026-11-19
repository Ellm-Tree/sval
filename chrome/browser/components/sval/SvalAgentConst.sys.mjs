/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The names the agent modules share: where agent access keeps its files, and
 * the pref and the topic more than one of them reads. `SvalAgents` puts the
 * modules together, so none of them imports it for a name.
 */

/** Sval's private directory in the profile, and the files it holds. */
export const AGENT_DIR = "sval-agents";
export const PORT_FILE = "port.json";
export const AGENTS_FILE = "agents.json";

/**
 * Gecko's own switch for WebMCP, which `SvalAgents` derives from agent
 * access and "Let sites offer tools to agents" (site-tools spec §4.1).
 */
export const MODEL_CONTEXT_PREF = "dom.modelcontext.enabled";

/**
 * Told whenever `SvalAgents.problem` may have changed, or the paired agents
 * and their policies have.
 */
export const STATE_TOPIC = "sval-agents-state";
