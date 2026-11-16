# 1400. Sval keeps its data in one directory

**Status:** Accepted on 2026-10-25.

## Context

Firefox keeps a database of profiles in `profiles.ini` and `installs.ini`.
Built with `MOZ_DEDICATED_PROFILES`, as `browser/moz.configure` sets it, the
database gives each install location a default profile of its own, keyed by
a hash of the install path. A Sval run from a new path therefore starts with
an empty profile.

The database also holds the profile group flags. The first use of Firefox's
selectable profiles (`SelectableProfileService.maybeSetupDataStore`) sets
`ShowSelector=1` on the profile, and from then on `nsAppRunner.cpp` opens the
profile selector on every launch that picks the default profile. With
`StartWithLastProfile=0`, `-P` or `-ProfileManager` it opens the legacy
Profile Manager, which can create, rename and delete profiles. All of this
runs before any Sval code, so a pref or a closed page cannot reach it.

Sval's workspaces, devices and settings replace what profiles offer. Gecko
still needs a profile directory: prefs, history, cookies, caches and site
storage live there.

## Decision

- **One data directory per user**, `Data` in the application data directory
  `MOZ_APP_PROFILE` names. The profile service knows it as its only profile,
  `default`, the default of every install. Selecting it creates the
  directory.
- **No profile database.** The service never reads or writes `profiles.ini`
  or `installs.ini`. A leftover file is ignored.
- **No profile manager.** `ShowProfileManager` exits with a message, so `-P`,
  `-ProfileManager` and a restart to the profile manager open nothing.
- **`--profile <path>` stays** as the override for tests, development and
  sval-mcp. That directory is not the default profile.
- **Every build shares the directory.** A newer build opens what an older one
  left, as Firefox's per-profile downgrade check governs.
- **A background task's own profile** is named for its install and task in
  Gecko's background-tasks directory, with no salt and no database record.
- **sval-mcp without `--profile` uses the data directory.**

## Consequences

- One patch, `one-data-directory.patch`, with the logic in an added
  `SvalDataDirectory.cpp`, both inputs of the Gecko key.
- A Sval started with `--profile` on another directory is not the default
  profile, so `BackgroundUpdate` schedules no update task from it.
- Firefox's own profile tests (`toolkit/profile/`) describe behaviour Sval
  removes. Sval's suites do not run them.

### Rejected

- **Hiding the UI and keeping the database.** Every known entry point sits
  in `nsAppRunner.cpp` before any Sval code, and the database still ties
  the data to the install path.
- **Turning off `MOZ_DEDICATED_PROFILES`.** It ends per-install profiles but
  keeps the database, the selector and the Profile Manager.
- **Clearing `ShowSelector` at startup from Sval code.** It runs after the
  selector has opened.
- **A data directory per update channel.** Every build uses one directory.
