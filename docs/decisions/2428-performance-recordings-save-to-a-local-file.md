# 2428. Performance recordings save to a local file

**Status:** Accepted on 2026-11-18.

## Context

Gecko's profiler is the one tool that shows where a slow browser spends its
time, process by process and thread by thread. Firefox's ways into it, the
toolbar button, the devtools Performance panel, about:profiling and
about:processes' buttons, open the result on profiler.firefox.com, a host
Sval never contacts (spec §10.9). With those off, a slowdown on a user's
machine can be recorded only by restarting Sval with `MOZ_PROFILER_STARTUP`
set, and a slowdown a restart clears is never recorded. A slowdown that
lives in the GPU process, such as video presenting slowly on one machine's
graphics driver, shows in nothing else Sval collects.

## Decision

- **Sval records with Gecko's profiler in the running browser** and saves
  the result as a gzipped profile in the download folder, then shows it in
  the system's file manager. Help › Record Performance starts a recording
  and saves it, about:support has a button that does the same, and
  about:processes' button on a process records that process and saves it.
- **A recording keeps its last minute,** with the threads and features of
  Firefox's Graphics and Media presets, so a slowdown the user noticed is
  still in it when they reach for the menu.
- **Nothing is uploaded, and the feedback form never carries a profile.**
  A profile holds the addresses of the pages that were open, which
  `CONTRIBUTING.md` rule 10 keeps out of everything Sval sends. The user
  hands the file on by choice.
- **No recording holds a private window's pages.** Every control is
  disabled while a private window is open, and a recording that runs when
  one opens is stopped and dropped, with nothing written. Gecko's profiler
  has no feature that leaves private browsing out of a profile.
- **`scripts/read-profile.sh` reads a profile,** naming native frames from
  the recorded build's published symbols, as `scripts/read-crash.sh` does for
  a crash.
- The toolbar button, the devtools Performance panel and about:profiling
  stay off: each opens its result on profiler.firefox.com.

## Consequences

- A profile taken on a development build has no symbols to fetch, so its
  native frames stay as library offsets.
- A recording slows Sval a little while it runs, and stops once it is saved.
