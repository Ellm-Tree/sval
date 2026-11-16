# The shared-folder helper, `sval-folder`

**Status:** Built. Decision 1437.
**Date:** 2026-10-26
**Author:** John Postlethwait
**Builds on:** `2026-10-06-local-copy-shared-folder-design.md` §3, §4.2 and
§5, decisions 0031 (only a helper touches the shared folder, pairing
included), 0033 (at most one helper is alive), and `2026-10-06-agent-control-design.md` §3.1 (sval-mcp, the
native program whose pipeline this reuses).

## 1. What this is

The shared-folder helper is a small Rust program, `sval-folder`, built,
staged, signed and packaged beside the browser binary as `tools/sval-mcp` is
(decision 1437). Decision 0031's rule is why it exists: a read on a hung NFS
or SMB mount can block in the kernel without end, and a process can be
abandoned where a thread cannot.

The browser starts it through `Subprocess` and talks to it over its stdin and
stdout, in sval-mcp's frames. File contents travel through the private
request directory in the profile. One helper serves the browser run for as
long as the run uses a shared folder. It exits when its stdin closes.

The browser never calls `IOUtils` on a shared path, each request has its own
20 s deadline, a request past it has its helper killed and abandoned, at
most one helper is alive (0033), and the helper never sees the key.

Sources: `tools/sval-folder/` (the helper), `SvalSharedFolder.sys.mjs` (the
browser's side), and their callers `SvalEngine.sys.mjs` and
`SvalPairing.sys.mjs`.

## 2. Operations, checks and limits

### 2.1 Operations

| Operation | Browser call | What the helper does |
| --- | --- | --- |
| `readDir` | `readDir` | Lists `path` and copies each file whose name ends in `suffix`, this device's file (`mine`) first, under `files-<id>/`; the browser reads the copies and answers with their contents as base64url. For directories of small files: `maxBytes` bounds each file. |
| `readDirs` | `readDirs` | As `readDir` for up to `MAX_BATCH` (64) directories; each file copied raw to `files-<id>/<dir index>/<copy number>` in the request directory, the entry naming its copy. The engine's worker reads the copies. |
| `write` | `writeFile` | Atomic write: exclusive random-named temporary in the same directory, then rename over the target; sweeps its own temporaries older than 10 minutes. |
| `writeFiles` | `writeFiles` | `write` for up to 64 files, stopping at the first failure. |
| `move` | `moveFile` | Rename that never replaces anything at `to`. |
| `remove` | `remove` | Removes one file. |
| `exists` | `exists` | Whether a path exists. |
| `removeDir` | `removeDir` | Removes a key's directory: its files and links, never a subdirectory; the directory only if emptied. |
| `listNames` | `listNames` | Names in a directory, at most 1000, optionally which children hold a named entry. Reads nothing. |
| `makeDir` | `makeDir` | Makes a directory below the root, never the root. |

Pairing (0031) uses `readDir`, `write` and `remove` on `sval/pair/`
(`SvalPairing.sys.mjs`). The engine uses all ten.

### 2.2 Checks and limits

- **Paths.** `is_contained` (`paths.rs`): a relative path is `/`-separated with no empty,
  `.` or `..` segment, no `\`, `:` or NUL, and no leading `/`. `is_root`: the
  root is absolute and has no NUL, and on Windows no `/`.
- **Mount check.** `requireTop` names a directory below the root that must
  exist (`no-sval-dir` otherwise), so an unmounted mount point is never
  written into.
- **Links.** No directory below the root may be a link, nor a file read, nor
  a write's target. On Windows a link is any reparse point except the
  cloud-files family and dedup (§4.6).
- **Sizes.** `MAX_FILE_BYTES` 32 MiB per file, `MAX_TOTAL_BYTES` 128 MiB per
  listing, `MAX_STEP_BYTES` 256 MiB per `readDirs` (decision 0032),
  `MAX_ENTRIES` 1000 per listing, 100 unreadable entries listed, 64 per batch.
  A regular file is read to its size plus one byte, to see a file that grew.
- **This device's own file.** An entry named `mine` that fails for a passing
  reason answers `own-file-unreadable` with the directory's index (decision
  1144). A link, a directory, an entry that is not a regular file or an
  oversized file is listed as unreadable, a lasting problem.
- **Error names.** The helper reports `IOUtils`' DOMException names, never a
  path (§4.6). The browser tells only `NotAllowedError` apart
  (`folderProblem`: "denied"); the rest are logged.

### 2.3 Deadlines

- `SHARED_STEP_TIMEOUT_MS`: each request has 20 s, counting its wait in the
  queue. A request whose turn has not come answers `busy`; one that overruns
  kills the helper, never awaited, and answers `timeout`.
- `HARD_EXIT_MS` 21 s: the helper ends itself when one request runs past it.
- One helper at a time; a killed one is waited for, within the next request's
  deadline, before another starts (0033).
- At `quit-application` the live helper is killed without waiting and every
  queued request answers `busy`.

### 2.4 How often the folder is reached

A background shared step runs at most every 30 s (`SHARED_INTERVAL_MS` in
`SvalEngine.sys.mjs`). A pairing look claims every 5 s (`CLAIM_POLL_MS`).
"Sync now", settings and pairing actions add their own. The tab poll
(`SvalTabs`' 5 s `DEFAULT_POLL_MS`) runs the local pass, and reaches the
folder only when a shared step is due.

## 3. Measurements

Decision 1437 holds what the native helper costs against a background-task
Firefox.

## 4. The design

### 4.1 One program, beside the browser

`sval-folder` is a Rust crate in `tools/sval-folder/`, built to one binary
that sits beside the browser binary, as `sval-mcp` does
(`patches/package-sval-mcp.patch`). The browser finds it as `shimPath()` in
`SvalAgentClients.sys.mjs` finds sval-mcp: `XREExeF`'s directory.

It does the ten operations of §2.1 with the checks and limits of §2.2. It
moves bytes and nothing else, and the key never reaches it.

### 4.2 The channel: pipes, with files for contents

`toolkit/modules/subprocess` runs every child's pipes on one ChromeWorker,
non-blocking: `O_NONBLOCK` and `poll()` on Unix
(`subprocess_unix.worker.js`, `subprocess_unix.sys.mjs`), overlapped I/O on
an I/O completion port on Windows (`subprocess_win.worker.js`,
`FILE_FLAG_OVERLAPPED`). A helper that stops answering leaves a read pending
on that worker and nothing blocked anywhere; the browser's deadline timer
fires on its own.

- An answer arrives as it is written, with no poll.
- The pipe belongs to one helper and one browser, so no session id or claim
  is needed. Each request carries a random id, so an answer is checked
  against the request it answers.
- When the browser goes, by quit, crash or kill, the operating system closes
  its end, and the helper reads end of file on stdin and exits.

**File contents stay in files.** The pipe carries only control frames in
sval-mcp's format, a 4-byte big-endian length and UTF-8 JSON
(`tools/sval-folder/src/frame.rs`), refused over 1 MiB (`MAX_FRAME_BYTES`)
on both sides. A write's bytes go to `payload-<id>-<i>.bin` in the request
directory, and every file read lands as a raw copy under `files-<id>/`; the
answer names the copies. No base64 and no file contents cross the pipe, and
the engine's worker reads `readDirs`' copies (`SvalSync.worker.mjs`), so no
large response is parsed on the main thread
(`docs/audits/2026-10-24-security-audit.md`, SC5). The 1 MiB cap is a bound
chosen well above the largest answer: a listing's answer is names and copy
numbers, at most 1000 entries.

**Handshake.** The first frame each way is `hello`, with the protocol version
(`HELPER_HELLO`) and the build id (`SVAL_BUILD_ID`, which
`scripts/stage-program.py` passes to cargo). The rule is sval-mcp's: the
browser accepts a helper that speaks its own protocol version or the one
before, whatever its build, and the version is bumped only for a change an
older helper cannot speak, on both sides at once. A Linux package upgrade
replaces files under a running browser, so a helper started after it can be
another build. One with an incompatible version is refused: every shared
request answers `helper-failed` with the error `HelperOutdated`, logged with
the build id, until Sval restarts.

### 4.3 A request

1. The request waits its turn in `SvalSerialQueue`, within its deadline.
2. With no live helper, the browser empties the request directory, starts
   one, and exchanges `hello`.
3. It writes the payload files, then sends
   `{ id, op, root, path, ..., payloads: [names] }`.
4. The helper reads every payload before touching the shared folder, performs
   the operation, and answers `{ id, reachable, ... }` with a reason from
   `REASONS` when the folder is not reachable.
5. The browser checks the frame, hands `readDirs`' copies to `consume`, and
   removes the request's files.

A deadline that passes at step 4 kills the helper, closes the browser's ends
of its pipes, marks it abandoned, and answers `timeout`. The next request
waits for that helper's exit within its own deadline, and answers `busy` if
it has not gone (0033).

### 4.4 Hangs, kills and abandonment

The browser never waits on the helper: it waits on a timer, and takes the
answer if one comes first. What the operating system does with a killed
helper decides only whether the next request can start one.

- **macOS.** `mount_nfs(8)`: a mount is interruptible only with `intr`, "file
  system calls that are delayed due to an unresponsive server will fail with
  EINTR when a termination signal is posted". A default hard mount is not, so
  a helper stuck on it does not die on SIGKILL until the server answers or
  the mount is forced off (`deadtimeout`, default 60 s only for soft
  read-only mounts). The browser abandons it; its pipes stay open until it
  exits. macOS's SMB client is no different for SIGKILL: a process stuck on
  a request the server does not answer is reaped only when the request fails
  with `ETIMEDOUT` at the client's `max_resp_timeout`, 30 s by default
  (`nsmb.conf(5)`). In a CI guest on macOS 27.0.1, a `cat` killed 5 s into a
  pf-made hang was reaped 25 s later. The nightly `shares-macos` job's
  `a_hung_smb_share_never_holds_up_the_profile` checks the helper there.
- **Linux.** The nightly `shares-linux` job hangs a hard NFS 4 mount
  (`hard,timeo=50,retrans=2`) and waits
  for the killed helper to be reaped before the next step: SIGKILL ends a
  helper stuck on a hard NFS mount there. The `nfs(5)` page says only that
  `intr` is ignored after 2.6.25.
- **Windows.** `Subprocess` kills with `TerminateJobObject`. Microsoft's
  `TerminateProcess` page: it "requests cancellation of all pending I/O. The
  terminated process cannot exit until all pending I/O has been completed or
  canceled." The SMB redirector does not cancel it promptly on a hung share.
  On the Windows runner (build 26300, `SessionTimeout` 60), with the share
  hung through CI's SMB relay, a process terminated 6 s
  into a write exited 63 s later, once the client gave up on the connection;
  one that nothing killed was still waiting 159 s in, while the client's
  reconnects met the same hung server. Once the relay forwarded again, the
  share answered at once, with none of the 30 s a dropped share costs after
  a restore. The nightly `shares-windows` job's
  `a_hung_smb_share_never_holds_up_the_profile` checks the helper there. A
  Windows Firewall rule cannot make the hang: its policy change makes WFP
  reauthorize the established flow and tear it down
  ([ALE reauthorization](https://learn.microsoft.com/en-us/windows/win32/fwp/ale-re-authorization)),
  so the runner's switch resets the connection. The
  client fails a dropped share within seconds and keeps failing for about
  30 s after a restore.
- **A killed helper that has not exited.** `proc.wait()` never resolves, so it
  is never awaited (`_kill`). The browser closes the pipes' ends it holds.
  `Subprocess`' worker keeps the process in its table and goes on polling it;
  its shutdown (`AsyncShutdown.webWorkersShutdown`, `shutdown()` in both
  workers) closes the worker without waiting for children.
- **An orphan.** A helper whose browser died reads end of file on stdin. A
  reader thread in the helper sees it while the main thread is in an operation,
  and calls `_exit` on Unix or `TerminateProcess` on itself on Windows. A helper stuck in the kernel runs no more of its own
  code after that: no late copy lands in a request directory a new helper has
  emptied.
- **The per-request hard exit.** The helper ends itself 21 s into
  one request (`HARD_EXIT_MS`). It covers a browser that is alive but has
  stopped killing, for example a main thread that has hung.
- **No console window.** `Subprocess` creates every Windows child with
  `CREATE_NO_WINDOW` (`subprocess_win.worker.js`), so a console-subsystem
  binary flashes nothing.

### 4.5 Lifetime

- The browser starts the helper at the first shared request of its run, not
  at startup, so a user without a shared folder never runs it.
- It stays alive between requests for as long as the run lasts, with no idle
  exit and no lifetime cap (decision 1437). A live helper costs about 2 MiB
  and no CPU: it blocks on reading stdin.
- It ends when its stdin closes: the browser closes it when the user clears
  the shared folder or chooses none, and the operating system closes it when
  the browser exits for any reason. The browser kills it at a deadline and at
  quit.
- Between requests it holds no handle in the shared folder and its working
  directory is not in it, so it never keeps a share from being unmounted or
  ejected. Every directory and file handle is closed before the answer is
  written.

### 4.6 Behaviour the helper keeps

Each rule of §2.2 has its test in the crate (`tools/sval-folder/src/ops/tests.rs`,
`tools/sval-folder/tests/`) or in xpcshell where it checks the browser's
answer. Four need care:

- **Error names.** The browser reads only names. The helper maps an
  `io::Error` to the DOMException name `IOUtils` gives the same failure
  (`RejectJSPromise` in `xpcom/ioutils/IOUtils.cpp`), in `errors.rs`: not
  found to `NotFoundError`, access denied or locked to `NotAllowedError`,
  already exists to `NoModificationAllowedError`, read-only to
  `ReadOnlyError`, not a directory or is a directory to `InvalidAccessError`,
  no space or device failure to `NotReadableError`, anything else
  `UnknownError`. Its own names (`Symlink`, `IsDirectory`, `TooLarge`,
  `Changed`, `Exists`, `TooManyEntries`, `ListingTooLarge`,
  `InvalidRequest`) are kept.
- **Windows links.** Any reparse point counts as a link except
  `IO_REPARSE_TAG_DEDUP` and the cloud-files family. The tag is read without
  following the point.
- **Size reads.** A regular file is read to its measured size plus one byte,
  through `Read::take`, which does not allocate the cap first.
- **Entries that are not files.** Opening a FIFO waits for a writer, so a
  FIFO in the folder could stall every listing until its deadline. The
  helper lists such an entry as unreadable, `NotAFile`, a lasting problem,
  and never opens it. It opens a file with `O_NOFOLLOW | O_NONBLOCK` on Unix
  and checks the open handle is a regular file, so an entry swapped between
  the look and the open is refused too. The Rust tests hang on a FIFO in the
  request directory instead, which only the browser writes.

Two windows stay open: a directory swapped for a link between the check and
a write's rename, and between a move's check and the move (`ops.rs`).
`openat` with `O_NOFOLLOW` on Unix, and handle-relative opens on Windows,
would close them.

## 5. Build, sign, package, update

### 5.1 A separate binary

`sval-folder` is a program of its own, and not a subcommand of sval-mcp
(decision 1437). It does one thing, with no network, MCP, HMAC or account
code in it, and its name in a process list says what it is. The agents'
shim, which agents run under their own rights, stays apart from a program the
browser runs on every shared step. It uses the same crates as sval-mcp:
serde, serde_json, libc and windows-sys.

### 5.2 Build and stage

`scripts/stage-program.py` builds either program with the tree's Rust target
and toolchain, the browser's build id, and the win64 cross linker, and copies
it into `dist/bin` or the bundle's `Contents/MacOS`.
`scripts/stage-sval-mcp.sh` and `scripts/stage-sval-folder.sh` run it through
mach. Each program keeps its own `Cargo.lock`.

Unlike sval-mcp, the browser needs `sval-folder` to sync at all. So
`scripts/build.sh` stages it after the build, and every test job's staging
step (`ci.yml`, Linux, Windows, macOS) stages both. A tree without it answers
every shared request `helper-failed`, with an error saying it is not staged.
The `sval-folder` job in `ci.yml` runs the crate's tests.

### 5.3 Sign, package and update

- **Windows.** `scripts/sign-windows.sh` signs every executable and DLL in the
  zip that carries no signature, `sval-folder.exe` among them.
- **macOS.** Releases carry an ad-hoc signature: `gecko.yml` runs
  `codesign --force --deep --sign -` over the bundle (design spec §8.6). With
  Developer ID signing, every Mach-O in the bundle is signed with the
  hardened runtime, this one included.
- **Linux.** `scripts/package-linux.sh` repacks the build's tarball as the
  .deb and .rpm, so the binary goes wherever the tarball carries it.
- **Update.** The binary is in the package, so the MAR carries it and Sval's
  updater replaces it with the browser.
- **Package check.** `scripts/check-package.sh` fails a package that lacks
  sval-mcp or `sval-folder` beside the browser binary.

### 5.4 Notices

`scripts/generate-app-license.py` reads `tools/sval-folder`'s `Cargo.lock`
with the others, and the `sval-folder` job runs it with `--check`.

## 6. Security

- **Rights.** The helper runs as the user, on a root the user chose, and can
  do only its ten operations.
- **The key.** Never sent. Requests carry a root, relative paths and payload
  file names. Payloads are sealed by the engine.
- **What it writes is checked.** The browser checks each frame: size, id,
  shape, reasons, copy names that are decimal numbers (`_withFiles`). Copies
  are named by number, so no name from the folder becomes a path on this
  machine.
- **The request directory** is in the profile, mode 0700, emptied when a
  helper starts.
- **The environment** is the passed list (`PASSED_ENV`), the variables the
  operating system's file clients may read.
- **Logs.** The helper logs nothing, and reports error names, never paths.
  Its stderr is drained and discarded. Rule 11 holds.
- **Network.** The helper links no network code. Reaching a share is the
  operating system's file client.
- **macOS privacy prompts name Sval, and one grant covers the helper.** tccd
  judges each request by its responsible process, Sval's bundle
  (`app.sval.sval`), whatever binary makes the read, so a "Documents" or
  "network volume" prompt reads "“Sval” would like to access files…", and a
  grant Sval holds covers `sval-folder`. This was checked in a macOS guest
  with System Integrity Protection on, through tccd's `AttributionChain`
  lines in the unified log; with SIP off tccd is never asked. While a prompt
  is up, sandboxd holds every further request for the same app and service
  until the user answers it, so the helper's requests wait behind it and
  answer `timeout` at their 20 s deadline.

## Out of scope

- Changing the 20 s deadline, the batch and size limits, or the 30 s shared
  interval.
- Any change to what a folder writer can do (§4.6's races).
- A file-system watcher in place of the 5 s and 30 s polls.
