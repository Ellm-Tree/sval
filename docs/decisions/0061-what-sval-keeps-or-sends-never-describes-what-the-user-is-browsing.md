# 0061. What Sval keeps or sends never describes what the user is browsing

**Status:** Accepted on 2026-10-24.

## Context

Diagnostics need a severity, and a way to turn detail on while debugging.
What Sval writes to disk or sends can outlive the session and leave the
machine.

## Decision

One `ConsoleInstance` per context, prefix `sval`, level from
`browser.sval.loglevel`, defaulting to `Warn`. The worker has its own instance,
because `maxLogLevelPref` is inert off the main thread.

What Sval keeps or sends never says what the user is browsing: `sval-log.txt`,
crash and feedback reports, and anything else that leaves the process. The
Browser Console and stdout are exempt. They are the user's own live view, read
on the machine while it runs, and redacting them costs debugging more than it
protects anyone: an error's message can name a URL there.

A call site, at any level, never interpolates a workspace, group or tab
name, a URL, a key, a pairing code or an emoji: ids, counts and error names
only, with an error's message through `describeError`, which replaces file
paths. A warning or an error reaches both the console and the file, and the
file's scrubbing (below) replaces paths, URLs and hosts but cannot recognise a
name, an emoji or a secret. Secret material is barred from every sink, the console included. A
test reads Sval's source and fails when a line breaks the rule.

The main process's warnings and errors are also appended to `sval-log.txt` in
the profile, whatever the level, and rotated to `sval-log-old.txt` at 256 KB.
The call-site rule and the scrubbing together are what make keeping them on
disk safe, private windows included.

The file also keeps browser code's warnings and errors: every script error
the engine marks as coming from system code, from any process, and every
console API `warn` and `error` from a chrome context, marked `console` after
the level. Pages and extensions cannot set that mark, so their messages stay
out. Firefox's code is not held to the rule at its call sites, so each line
goes through the same scrubbing as Sval's own on its way to disk: one line,
with every file path, URL and host replaced, and its source named by file
name and line. That scrubbing is what makes keeping them safe, and the
feedback report's privacy test seeds browser code's messages with the
markers it checks for (feedback spec §3.7). Lines logged through `SvalLog`
are kept once, by their `sval` prefix.

## Consequences

A user who never opens the console sees nothing. The guard reads every
script in the directories Sval ships them from, so a new script is guarded
without being listed.
