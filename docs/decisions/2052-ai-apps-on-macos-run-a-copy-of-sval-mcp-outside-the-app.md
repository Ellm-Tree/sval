# 2052. AI apps on macOS run a copy of sval-mcp outside the app

**Status:** Accepted on 2026-11-06.

## Context

AI apps start `sval-mcp` on their own schedule, at their launch and on
retries, whether or not Sval is running. macOS assesses a quarantined app
with Gatekeeper the first time any program in its bundle runs. A user
updates Sval by dragging the new Sval.app over the old one, and Finder
writes the bundle file by file. An AI app that starts
`Sval.app/Contents/MacOS/sval-mcp` in that window has Gatekeeper read a
half-written `XUL`, fail strict validation, and record the rejection: every
later launch says "Sval.app is damaged and can't be opened", though the
finished app is signed, notarised and valid.

## Decision

- **On macOS an AI app's entry runs `sval-mcp` in Sval's application data
  directory** (`~/Library/Application Support/Sval/sval-mcp`), never a
  program inside Sval.app.
- **Sval copies its bundle's `sval-mcp` there on every start**, with
  `sval-mcp.install` beside it naming the bundle's `Contents/MacOS`
  directory, which the copy starts Sval from. Each file is written under a
  temporary name and moved into place, and only when its bytes differ, so an
  app finds a whole file and a running copy keeps its own.
- **The copy carries no quarantine attribute.** Sval's `Info.plist` sets
  `LSFileQuarantineEnabled`, so macOS quarantines every file Sval creates;
  Sval removes the attribute before the move.
- **Entries Sval wrote for the in-bundle path follow the copy** through the
  repair that rewrites an entry for an install that has moved.
- **The copy starts Sval only once `codesign --verify --deep --strict`
  passes on Sval.app.** A tool call that finds Sval closed can come while
  Finder replaces the bundle, since the user quits Sval to replace it. The
  check reads the bundle without Gatekeeper, so a failed one records nothing.
  The copy checks every 2 seconds for up to 60, each check killed after 20,
  then answers `sval_installing` and starts nothing. A dev build is started
  unchecked: the build signs no bundle as a whole, so it always fails.
- **Windows and Linux keep the shim beside the browser binary.** The
  assessment that records the rejection is Gatekeeper's, which is macOS's
  alone.

## Consequences

- The copy is replaced by the next start of whichever Sval ran last, and a
  running copy executes the new build in its place as it does after an
  update.
- A tool call during the copy waits for it, up to a minute, and a copy
  slower than that gets `sval_installing` and a retry from the agent. A
  bundle that is damaged gets the same answer on every call.
- A packaged build that is not signed, as one made by `mach package` without
  signing is, never starts from a tool call.
- A dev build keeps its copy in its own data directory, which `run.sh`
  sets, so a dev shim never replaces an installed Sval's.

### Rejected

- **A symbolic link to the bundle's shim.** Running it runs the program in
  the bundle, which starts the assessment.
