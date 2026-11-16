# sval-mcp: rules for contributors

`tools/sval-mcp` builds `sval-mcp`, a standalone Rust program: a stdio MCP
server that an agent runs to drive Sval. It finds Sval through
`<profile>/sval-agents/port.json` and proves both ends hold the port file's
token before anything else is sent.

    cd tools/sval-mcp && cargo build --release
    tools/sval-mcp/target/release/sval-mcp --profile <sval profile directory>

Without `--profile`, the shim uses Sval's data directory, the one every
install starts on (`src/install.rs`). A shim staged into a macOS dev build
uses that worktree's `build/dev-profile`, the profile `run.sh` starts it on,
and starts it with `run.sh`'s data directories. A tool call that finds Sval
closed starts the Sval the shim came with in the background and waits for its
port (`src/launch.rs`); one that finds Sval holding the profile with no port
file answers `access_off`.

An MCP client runs that command itself. CI tests it in the `sval-mcp` job,
and `browser_sval_mcp_end_to_end.js` runs the shim against a real Sval on
every platform, through the listener, the handshake and the pairing alert.
Each test job stages the shim first; locally, run `stage-sval-mcp.sh` before
that file.

On macOS, AI apps run Sval's copy of the shim in its application data
directory, which Sval writes on every start with `sval-mcp.install` beside
it naming the bundle to start (decision 2052, `src/install.rs`). It starts a
packaged Sval only once `codesign` verifies the bundle, and answers
`sval_installing` when it never does (`src/launch.rs`).

Every package carries it beside the browser binary: `scripts/check-package.sh`
(`mach package`, then a check that Sval's files are in the package) runs
`scripts/stage-sval-mcp.sh`, which builds it for the tree's target with the
browser's build id (`sval-mcp --version` prints it) and puts it in `dist/bin`,
where the package manifest names it.

The handshake's `hello` is the wire protocol's version; Sval accepts its own
and the one before, and refuses an older shim as `outdated`. Bump it only for
a change an older shim cannot speak, on both sides at once.

On macOS and Linux a shim whose own file an update replaces with another
build executes that build in its place between requests, handing it the
agent's session (`src/update.rs`); on Windows it runs until the agent
restarts it.
