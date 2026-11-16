# Send Feedback: an anonymous report the user reads before sending

**Status:** Built: `SvalFeedback`, `SvalFeedbackForm`.
**Date:** 2026-10-22
**Author:** John Postlethwait
**Rests on:** decisions 0005 (Sval runs no servers), 0060 (every host is
named), 0061 (nothing logged describes browsing), 0076 (crash files stay
local) and 1199 (Sval's one server receives only the reports a user sends).

## Rules

- Send Feedback is for anything the user wants to say. It has a message
  field, an optional email address, and optional diagnostics such as the log.
- It is calm and everyday, without the critical dialog's red frame. A chat
  button in the workspace panel's footer opens it as a popover (§2).
- Every build sends, developer builds included. There is no Save a Copy.
- The log is sent at the level it was written.
- The report carries no user identity. Email is the only identifying field,
  and it is optional.
- Reports go to `feedback.sval.app`, the one collector Sval runs (§7,
  decision 1199).
- What is attached is enough to debug from, and the user sees exactly what
  is sent before sending it.
- No screenshot, of any kind.
- The browser console's messages from browser code go in, cleaned the way
  Sval's log is (§3.7).
- Gecko's crash dialogs send to the same collector (§10).

## 1. What this is

Send Feedback is:

- A form the user can open at any time (§2).
- A report with enough in it to debug from (§3), every part of which the
  user can read, and untick, before sending (§4).
- A collector that receives the report and keeps nothing about the sender
  (§7).

**Success looks like:** a user whose sync stopped presses the feedback button, writes "sync stopped after I moved my Dropbox folder", reads the
log lines and settings that will go with it, and presses Send. The
developer gets an issue with the build, the OS, the sync state, the log and
the changed settings. It holds no IP address, no profile path, no workspace
names and no URLs. Nothing in it identifies the sender unless the sender
typed an email address.

## 2. Where the form opens

| From | What the form starts with |
|---|---|
| The feedback button | Empty description |
| Help menu › Send Feedback… (menu bar and the app menu's Help) | Empty description |
| The critical dialog's Send Report (messages spec §4) | The dialog's title and cause as the report's context (§3.1) |
| An import failure's Send Report | "Import from <source> failed" and the failure's error name as context. The import dialog closes, because the form can't be reached behind it. |
| Settings › Sync's Send Report | The sync indicator's state as context |

The three Send Report buttons open the form. Once the form has sent a
report, the button that opened it says it was sent and is disabled
(`SvalReport.label`). If the form is closed without sending, the button is
unchanged.

**The feedback button** sits at the end of the workspace panel's footer
row, across from the sync indicator (messages spec §2): Lucide
`message-circle`. The footer row stays when no
sync folder is chosen, holding the button alone.

**The form is a popover** that opens out of that button to the right, one
per window, joined to it the way the notices popover is joined to its
button (messages spec §4). It is not modal: the page and the panel stay
usable. Esc, a click outside or the button again close it and keep the
draft, meaning the message, the email and the ticks, until Sval restarts.
Cancel closes it and drops the draft. Opened from the critical dialog, it
replaces that dialog, and closing it leaves the critical state in the
footer, as dismissing the critical dialog does. `sval-feedback.css` owns
its sizes and shape, and `SvalFeedbackForm.sys.mjs` its words.

## 3. What a report holds

Every part of the report is listed here, with its default. Anything not
listed is never sent. §3.3 lists what is left out on purpose.

### 3.1 Always sent

These lines can't be unticked. They are small, they describe the build and
not the person, and without them no report can be read. The preview (§4)
still shows them.

- The description the user typed. It is required, and must be at least 10
  characters.
- The context line, when one of the Send Report buttons opened the form.
- Sval's version, build id and update channel.
- The OS name and version, the CPU architecture, and whether Sval is running
  under Rosetta.
- Whether Sval is running in Troubleshoot Mode, Firefox's safe mode, which
  Sval keeps: started from Help › Troubleshoot Mode… or by holding Option
  (macOS) or Shift at launch, it runs with every extension off, the default
  theme and hardware acceleration off. A problem that persists there is
  Sval's, and one that goes away points at an extension or the GPU.
- The UI language.

### 3.2 Optional, each with its own checkbox

| Part | Default | What it is | Source |
|---|---|---|---|
| Sval's log | On | `sval-log-old.txt` then `sval-log.txt`, as `SvalReport.text` reads them. It holds Sval's own warnings and errors, and the browser code's console messages (§3.7). | `SvalLog`; decision 0061 keeps it free of browsing |
| Sval's state | On | A summary of Sval's state in counts and names (§3.4) | Sval's modules, read when the form opens |
| Changed settings | On | Every pref the user has changed, through the value rule (§3.5) | Firefox's `Troubleshoot` `modifiedPreferences`, plus `browser.sval.*` |
| Extensions | On | Each extension's name, id, version, whether it's on, and Sval's compatibility verdict | `Troubleshoot` `addons`, `SvalExtensionCompat` |
| Graphics | On | GPU vendor and device ids, driver version, compositor, WebRender and hardware video decoding status, number of displays and their scale factors | `Troubleshoot` `graphics`, cut down to those fields |
| Recent crashes | On, when there are any | The id and time of each crash in the last three days | `Troubleshoot` `crashes` (`CrashReports`) |
| A crash file | Off, one checkbox per recent crash | The minidump, plus its `.extra` file reduced as §3.6 says | `Crash Reports/pending` in Sval's application data directory (`UAppData`, as `CrashReports.sys.mjs` reads it), not the profile |

**How a crash file works.** The crash reporter stays compiled in (decision
0076), and every automatic submission is off. When a process crashes, Gecko
writes two files to `Crash Reports/pending`: a minidump (`<id>.dmp`) and its
annotations (`<id>.extra`). The minidump holds each thread's stack and
registers, the list of loaded libraries with their versions, and the memory
around each stack. The annotations are a JSON object: the build, the process
type, the crash reason, memory figures, and the URL being loaded, among
others. Nothing else reads these files, and they stay until the user
deletes them. The form lists each crash from the last three days. Ticking one
attaches its minidump and its annotations, cut down to §3.6.

A minidump includes raw memory, so it can contain fragments of pages that
were open. Its checkbox says so in one line. This is why the crash file is off by default. It is also the one
thing a developer can't reproduce a crash without, so the form offers it for
every recent crash.

A minidump names code by library and offset. Turning that into function
names and lines needs the symbol files of the exact build that crashed.
Without them a crash file shows only the library and offset of each stack
frame. §3.8 says where Sval's come from.

### 3.3 Never sent

- Console messages from pages and extensions: the console's Page and
  Extension filters. They are the site's and the extension's, and they
  describe what the user is browsing.
- Any screenshot.
- The full `about:support` snapshot. It includes the profile path,
  environment variables, `user.js`, and string prefs such as the home page.
- Workspace, group, tab, pin and favorite names, URLs, titles and history.
- Device names. The user sets them, and they often hold a person's name.
- The sync folder's path, and any file path.
- Pairing codes, keys and agent tokens.
- Any id that would link two reports: no install id, no profile id, no
  device id, no cookie.

### 3.4 Sval's state

Counts, enumerated values and error names only, so it falls under 0061's
rule. Each line comes from the function that already answers it. The form
uses the existing function. It doesn't compute its own answer.

- **Sync:** whether a folder is chosen; the indicator's state from the
  messages spec §3 table, by name, as the panel's footer reads it; minutes
  since the last sync; the last fault's error name. Nothing in Sval
  answers how many devices are paired, so the report doesn't say.
- **Tree:** the number of workspaces, groups, tabs, pins and favorites; open
  windows; whether a private window is open.
- **Protections:** the blocking level; each fingerprinting switch, on or off;
  the Secure DNS mode; whether page rules are on; the number of sites with
  their own settings. A setting whose name holds a site is left out of the
  changed settings (§3.5) for the same reason Firefox leaves such names
  out, and this count stands for them.
- **Agents:** the number of paired agents, and of tabs in agent workspaces
  in the tree.
- **Uptime:** minutes since launch.

### 3.5 The value rule for settings

A pref's name is always sent. Its value is sent when it is a boolean, an
integer, or a string that matches `^[A-Za-z0-9_-]{1,32}$`, which covers
enumerated values such as `balanced` or `Warn`. Any other string is sent as
`(changed)`. The dot is left out because every host name and address has
one. This rule removes URLs, paths, host names and free text without
keeping a list that would go out of date. A test checks it (§9).
Firefox's own denylist (`PREF_REGEXES_NOT_TO_DISPLAY`) applies first. The
device's name (`browser.sval.device.name`) is always `(changed)`: a
one-word name would pass the rule, and it often names a person.

### 3.6 A crash file's annotations

The `.extra` file is JSON. A key is kept only when Gecko allows it in a
crash report: `Services.appinfo.isAnnotationAllowedForReport(key)`, which
answers from the `scope` each annotation has in `CrashAnnotations.yaml`
(`report` or `ping`). It is the list `CrashSubmit.submit` already applies,
so the form keeps no list of its own. `URL` and `Comments` are on Gecko's
list and are removed even so: one is the page being loaded, and the other
is free text the form already asks for. `Email`, `ServerURL` and every
`client`-scope key are off Gecko's list.

### 3.7 Browser code's console messages

The console's Sval filter (`console-origin.js`) labels a message Sval when
the engine marked it as coming from system code (`chromeContext`). That
covers Sval's own code and Firefox's browser code. Pages and extensions
can't set the mark. Without more, an uncaught exception in Sval's code, and
every error from Firefox's browser code, would appear in the console and be
lost when it closes. So Sval's log file also keeps the console's system-code
warnings and errors:

- A listener in the parent process takes every `nsIScriptError` whose
  `isFromChromeContext` is true and whose flag is warning or error, and
  every console API call at `warn` or `error` from a chrome context. A
  message from a private window (`isFromPrivateWindow`, a console event's
  `private`) is left out.
  Content processes forward their script errors to the parent's console
  service (`ContentParent::RecvScriptError`), so one listener sees every
  process.
- Calls made through `SvalLog` are skipped by their `sval` prefix, because
  `SvalLog` already records them.
- Each message goes through `forTheFile`, the same scrubbing as Sval's own
  lines: one line, with file paths, URLs and host names replaced. Its source
  file and line go with it, as the file's name and line, because those are
  what point at the bug. `forTheFile` replaces every address, browser
  code's own included, so the source is written by name after it.
- Each line is marked `console` after its level, so it reads apart from
  Sval's own: `2026-10-22T09:14:03Z error console: TypeError: … (SvalPins.sys.mjs:212)`.

Firefox's code is not held to 0061's rule at the call site the way Sval's
is, so the scrubbing is the only guard on these lines. The scrubbing takes
out addresses, host names and paths; it can't recognise a plain word, so a
workspace or device name that browser code wrote into a message would stay.
No browser code is known to do that. The "nothing private
leaves" test (§9) covers them: it makes browser code log the seeded
markers, and none of them may reach the report. Decision 0061 says the file
holds these lines and why they are safe to keep.

### 3.8 Symbols for crash files

Every compile keeps symbols at line tables, so a crash file can be read.
A release's symbols are published under its build id, below. A development
or CI compile's go in its Gecko package under its key, where artifact builds
install them for the test harnesses.

- Release compiles run apart from branch compiles: Linux and
  Windows in a clean environment (`scripts/release-compile.sh`), macOS in
  `gecko.yml`'s release step. They turn debug symbols on as every compile
  does, at line tables only (`--enable-debug-symbols=-gline-tables-only`, and
  `RUSTFLAGS=-Cdebuginfo=line-tables-only`, since `--enable-debug-symbols`
  alone gives Rust full debug information), in `mozconfig.gecko`. That gives function names, files and lines at a
  fraction of full debug information's memory and size.
- Each release compile runs `mach buildsymbols` and publishes the symbol
  archive as `sval-symbols` under the build id (`scripts/publish-symbols.sh`),
  dry runs included. The shipped binaries are stripped
  (`mozpack.executables.strip`), so nothing about the
  symbols reaches users. This is Mozilla's arrangement, which uploads the
  same archive to its own symbol server.
- `scripts/read-crash.sh <dump>` reads a crash file: it takes the build id
  from the crash's annotations (`BuildID`; a minidump names its libraries
  by debug id and carries no build id), fetches that build's
  `sval-symbols`, and prints the symbolicated stacks with Mozilla's
  `minidump-stackwalk`.
- **The check that it works:** crash a `dry-run-*` release on purpose
  (`about:crashparent`), attach the crash file through the form, and run
  `read-crash.sh` on what the collector filed. The crashing thread's stack
  names its functions, files and lines.

## 4. Seeing what is sent

The user can read every byte before it leaves.

- The form has two columns: the message and email on the left, and on the
  right the list "Sent with your feedback", always shown, headed by the
  count and total size.
- Each part in §3.2 is a row: a checkbox, its name, a line saying what it
  holds, its size, and **View**.
  View opens the part's text exactly as it will be sent. A minidump is
  binary, so its View shows its size, the crash's time and process type, and
  the libraries it lists.
- The always-sent lines (§3.1) appear as one row with no checkbox, and View
  works on it too.
- The report is built once, when the form opens, and rebuilt only when a
  checkbox changes. View reads that build, and Send posts that build. There
  is one copy, so the preview can't differ from the post.

Under the email field, the form tells the user that Sval sends only what is
listed, that Sval's server keeps no IP address or anything that identifies
them, and that email is only for a reply.

## 5. Sending

- Send posts one `multipart/form-data` request to
  `browser.sval.support.reportURL`, which is `https://feedback.sval.app/report`
  in every build. Tests point it at a local `HttpServer`. Its parts:
  `description`; `email` and `context` when there are any; `report`, the file
  `report.json`; `log`, the file `log.txt`, when the log is ticked; and a
  `file` part for each ticked crash file and its annotations.
- `report.json` is §3.1, §3.4 to §3.6 as JSON. The collector refuses one
  without this much: `{"product": "Sval", "build": {"version": "…",
  "buildID": "<14 digits>", …}, …}`.
- The request carries `credentials: "omit"`, no cookies, no `Referer`, and a
  User-Agent of `Sval/<version>`. It goes through the same proxy and Secure
  DNS settings as every other request.
- Sending disables the form. On success the form thanks the user and shows
  the reference the collector returned (§7) as selectable text the user can
  quote if they write in later, with Close. On failure the form keeps
  everything the user entered, offers Send Again, and names one of four
  causes: the server could not be reached (DNS, a refused or reset
  connection, a proxy or TLS error), the device is offline, the server
  failed (HTTP 5xx, or no answer within 60 s of connecting), or the server
  refused the report (HTTP 4xx). `SvalFeedbackForm.sys.mjs` holds the words.

- Nothing is queued to send later, because
  a report sent without the user present is one they didn't send.
- The whole request is capped at 25 MB. Only a crash file can come near it.
  If one would take the report past the cap, its row says "Too large to
  send" and its checkbox is disabled. View still works on
  it, and Send is never disabled for size.

## 6. Private windows

The form works from a private window, and is the same there. Sval's state
reports whether a private window is open and nothing of what is in it. Nothing in §3
reads a private window's content.

## 7. The collector

`https://feedback.sval.app` is a Cloudflare Worker on a subdomain of the
domain that serves sval.app. It answers two paths:

- `/report` accepts only a `POST` of the multipart shape in §5, with a
  description of at least 10 characters and a `report.json` of the shape
  §5 gives.
- `/submit` accepts Gecko's crash reports (§10) whose annotations say
  `ProductName` `Sval` with a build, and whose every minidump starts with
  `MDMP`. It drops a `memory_report` part unread, because a memory report
  names the pages that were open.
- These checks turn away generic form spam. They prove nothing about a
  sender who copies the shape.
- It rejects anything over 25 MB.
- It reads no request header but the body's length and type. Workers Logs,
  traces and Logpush are off for it, and the zone has no Logpush job.
- It files each report as an issue in Sval's issue tracker, labelled
  `feedback`, or `crash` for `/submit`. The title is the description's first
  80 characters, with every `@`, `#` and `!` split from what follows so it
  mentions and references nothing. The body holds the description, the email
  and the context in code fences, so nothing in them acts, and `report.json`.
  The log and files are the issue's attachments, under names cut to
  `[A-Za-z0-9._-]`. The tracker receives the report from the Worker, never
  from the sender.
- It answers `/report` with `{"reference": "F-<number>"}`.
- A Cloudflare rate limit per address applies at the edge. The Worker
  doesn't see the address, and Sval doesn't keep it.

**What Cloudflare sees.** Cloudflare carries the request, so it sees the
sender's IP address, as it does for any site behind it. The form's wording
(§4) promises what Sval's server keeps, and nothing more.

`scripts/network-contact/allowed-hosts.txt` lists `feedback.sval.app` as
`opt-in`: it is contacted only when the user presses Send, or ticks a crash
dialog's box (§10).

## 8. The decision

Decision 1199. Decisions 0005, 0061 (§3.7) and 0076 point at it.

## 9. Tests

Each one asserts what the user gets:

- **The preview is the post.** A browser test opens the form against a
  local `HttpServer`, views every part, sends, and compares the received
  body with the viewed text byte for byte.
- **An unticked part is not sent.** Untick each optional part in turn. Its
  content is absent from the received request.
- **Nothing private leaves.** Seed a profile with a workspace name, a tab
  URL and title, a device name, a sync-folder path and a string home page,
  each a unique marker. Make browser code throw, and warn through the
  console, with each marker in the message. Build a report with every part
  ticked. No marker appears anywhere in it.
- **A browser-code error reaches the log.** An uncaught exception in a
  chrome script, and one in a content process's actor, each appear in the
  report's log once, marked `console`, with their file and line.
- **The value rule.** `browser.startup.homepage` becomes `(changed)`;
  `browser.sval.adblock.level` keeps `strict`.
- **A crash file's annotations.** An `.extra` with `URL` and `Email` set
  comes out without them, and with every allowlisted key it had.
- **A crash dialog's report reaches the collector.** about:tabcrashed with
  its box ticked, against a local `HttpServer` as `MOZ_CRASHREPORTER_URL`,
  posts one report to `/submit` that holds no `URL` and no key outside
  Gecko's list.
- **A failed send keeps the form.** The server answers 500. The description
  and checkboxes are as the user left them, and Send Again works.
- **The collector** (Worker unit tests, `vitest`, in its repository): rejects
  oversize, short and wrongly shaped reports; the issue body it builds
  contains no request header value; nothing a sender writes mentions,
  references or links from the issue.

## 10. Crash reports from Gecko's dialogs

Gecko's crash reporting is built and kept compiled in (0076), and every
part of it that sends is off. It has three places a user sends from:

- **The crash reporter window**, Gecko's native app, after the whole
  browser crashes ("We're Sorry…"). Its box "Tell … about this crash" starts
  unticked (`crashreporter-submit-off-by-default.patch`). It also has
  "Include the address of the page I was on", which upstream starts ticked
  (`settings.rs`, `include_url`), and a comment field.
- **`about:tabcrashed`**, after a tab's process crashes. Its "Send crash
  report" box follows `browser.tabs.crashReporting.sendReport`, which Sval
  sets false, and Restore submits whatever the box is left at
  (`TabCrashHandler`). Its include-URL box follows
  `browser.tabs.crashReporting.includeURL`, false upstream.
- **`about:crashes`**, which lists the crash files and offers Submit.

Each posts a `multipart/form-data` request to the `ServerURL` written into
`application.ini`, `<crash URL>/submit?id=…&version=…&buildid=…`: an `extra`
part, `extra.json`, holding the annotations, and an `upload_file_minidump`
part (`client/app/src/net/report.rs`; `CrashSubmit.sys.mjs`). Both send
only the annotations Gecko allows in a report, so neither needs a patch:

- The JS path (`CrashSubmit.sys.mjs`, `Submitter.submitForm`) keeps a key
  when `Services.appinfo.isAnnotationValid` and
  `isAnnotationAllowedForReport` both pass. The latter
  (`CrashAnnotations.cpp`, `IsAnnotationAllowedForReport`) is true for an
  annotation whose `scope` in `CrashAnnotations.yaml` is `ping` or `report`.
- The native window (`client/app/src/logic.rs`, `modify_extra_for_report`)
  runs `map.retain(|k, _| annotations::send_in_report(k))` on the extra
  before it builds the request (`try_send`), and before the details window
  shows the annotations (`update_details`). `send_in_report`
  (`logic/annotations.rs`) looks the key up in `ALL_REPORT_ANNOTATIONS`,
  which `client/app/build.rs` (`crash_annotations`) generates from the same
  `CrashAnnotations.yaml`,
  taking every entry whose `scope` is `ping` or `report`, under its
  `altname` where it has one. It is the same list. It then adds
  `SubmittedFrom` and `Throttleable`, both `report` scope.
- The `.extra` file on disk holds every annotation Gecko recorded,
  `client`-scope ones such as `ServerURL` included. Both paths filter only
  when they send.
- `URL` is `report` scope, so both paths send it when its box is ticked: the
  native window drops it unless `include_url` is set
  (`ReportCrash::current_extra_data`), and `TabCrashHandler` unless the
  crashed tab's include-URL box is ticked. `Comments` is `report` scope and
  carries the comment field.

The client's unit tests (`client/app/src/test.rs`, `include_url`,
`include_annotation_altname`) cover the URL and altname handling. A success
is answered `CrashID=bp-<uuid>` on its own line, which both check.

Sval's side:

- `mozconfig`'s `--with-crashreporter-url` is `https://feedback.sval.app`.
- The window's include-URL box starts unticked: `include_url: false` in
  `crashreporter-submit-off-by-default.patch`. A report is sent only when the
  user ticks a box.
- The collector's `/submit` (§7) files a crash report as an issue in
  `Sval/feedback`, labelled `crash`, with the `extra` JSON in the body, less
  `URL` and `Comments` if they arrive, and the minidump attached. The
  comment, if any, goes in the body. It answers `CrashID=bp-<uuid>`, with
  a fresh uuid that the issue records.
- The form's Recent crashes rows (§3.2) and these dialogs reach the same
  collector. A crash the user already sent from a dialog is listed in
  `Crash Reports/submitted`, and its row says "Sent".

These dialogs are Gecko's and are not redesigned here.

## Out of scope

- Automatic crash upload (main spec §10.6).
- Replying to users from Sval. A reply goes to the email address, if the
  user gave one.
- A public list of reports or votes.
