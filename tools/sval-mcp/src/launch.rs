// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Whether Sval holds a profile, and starting the Sval this shim came with
//! on one in the background (agent-control spec §7.1).
//!
//! The shim only ever starts the browser binary of the install it was
//! packaged with (`install::install_dir`), never one an agent names.

use std::ffi::{OsStr, OsString};
use std::io;
use std::path::Path;
use std::time::{Duration, Instant};

/// Whether a running Sval holds `profile`.
///
/// Firefox locks a profile with an `fcntl` write lock over the whole of
/// `.parentlock` on macOS and Linux, and by opening `parent.lock` with no
/// sharing on Windows (`nsProfileLock::Lock`). Both are asked without taking
/// the lock, so the answer never gets in Sval's way.
pub fn profile_in_use(profile: &Path) -> bool {
    in_use(profile)
}

#[cfg(unix)]
fn in_use(profile: &Path) -> bool {
    use std::os::fd::AsRawFd;
    let Ok(file) = std::fs::File::open(profile.join(".parentlock")) else {
        return false;
    };
    // SAFETY: `flock` is plain data, and all zeros is a valid value of it.
    let mut lock: libc::flock = unsafe { std::mem::zeroed() };
    lock.l_type = libc::F_WRLCK as libc::c_short;
    lock.l_whence = libc::SEEK_SET as libc::c_short;
    // SAFETY: `file` is open for as long as the call, and `lock` outlives it.
    let rc = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETLK, &mut lock) };
    rc != -1 && lock.l_type != libc::F_UNLCK as libc::c_short
}

#[cfg(windows)]
fn in_use(profile: &Path) -> bool {
    const ERROR_SHARING_VIOLATION: i32 = 32;
    match std::fs::OpenOptions::new()
        .read(true)
        .open(profile.join("parent.lock"))
    {
        Err(err) => err.raw_os_error() == Some(ERROR_SHARING_VIOLATION),
        Ok(_) => false,
    }
}

/// Starts the Sval this shim came with on `profile`, without taking focus from
/// the app the user is in. It returns once Sval is launched, and the caller
/// waits for the port file.
pub fn start(profile: &Path) -> io::Result<()> {
    start_from(&crate::install::install_dir()?, profile)
}

/// Whether the Sval sval-mcp starts gets the agent's variable `name`. Gecko,
/// NSPR and NSS read these variables as switches with no check on who set
/// them, and the Sval started is the user's everyday browser for the rest of
/// its run:
///
/// - `MOZ_`: `MOZ_MARIONETTE` makes Marionette listen on a local port with no
///   authentication (`Marionette.sys.mjs`, `ENV_ENABLED`), so any local
///   process could drive the user's browser past every agent control;
///   `MOZ_DISABLE_CONTENT_SANDBOX` turns off the content sandbox
///   (`SandboxSettings.cpp`); `MOZ_LOG` and `MOZ_LOG_FILE` write network logs,
///   addresses included, to a file the agent names (`Logging.cpp`).
/// - `NSPR_`: `NSPR_LOG_MODULES` and `NSPR_LOG_FILE` are the same log under
///   older names (`LogModuleManager::Init`).
/// - `NSS_`: switches over NSS's algorithm policy, such as
///   `NSS_ALLOW_WEAK_SIGNATURE_ALG`, which lifts its ban on MD2, MD4 and MD5
///   signatures (`SECOID_Init`).
/// - `XRE_`: `XRE_PROFILE_PATH` starts Sval on a profile it names, over
///   `--profile` (`nsToolkitProfileService::SelectStartupProfile`), and
///   `XRE_CONSOLE_LOG` writes the console to a file it names
///   (`WriteConsoleLog`).
/// - `SSLKEYLOGFILE`: Sval's NSS is built to honour it
///   (`enable_sslkeylogfile` in `security/moz.build`), and appends every TLS
///   secret to the file it names (`ssl_SetDefaultsFromEnvironmentCallOnce`).
/// - `XUL_APP_FILE`: names an `application.ini` that Sval's binary runs as
///   its application in place of Sval's own (`do_main` in
///   `nsBrowserApp.cpp`), with chrome privilege, on the profile `--profile`
///   names.
///
/// None of them is the agent's to set on the user's browser, so none is
/// passed on but `MOZ_ENABLE_WAYLAND`, which only chooses GTK's display
/// backend (`nsAppRunner.cpp`). The rest of the environment passes, since a
/// desktop session's own variables differ by platform and desktop. Windows
/// reads variable names without regard to case.
fn passes_on(name: &OsStr) -> bool {
    const PREFIXES: [&[u8]; 4] = [b"MOZ_", b"NSPR_", b"NSS_", b"XRE_"];
    const NAMES: [&[u8]; 2] = [b"SSLKEYLOGFILE", b"XUL_APP_FILE"];
    const KEEP: &[u8] = b"MOZ_ENABLE_WAYLAND";
    let name = name.as_encoded_bytes();
    let same = |a: &[u8], b: &[u8]| {
        if cfg!(windows) {
            a.eq_ignore_ascii_case(b)
        } else {
            a == b
        }
    };
    same(name, KEEP)
        || !(PREFIXES.iter().any(|prefix| {
            name.get(..prefix.len())
                .is_some_and(|start| same(start, prefix))
        }) || NAMES.iter().any(|stripped| same(name, stripped)))
}

/// The environment the Sval sval-mcp starts gets: the agent's variables that
/// [`passes_on`] allows, and no others.
fn child_env(vars: impl IntoIterator<Item = (OsString, OsString)>) -> Vec<(OsString, OsString)> {
    vars.into_iter()
        .filter(|(name, _)| passes_on(name))
        .collect()
}

fn start_from(dir: &Path, profile: &Path) -> io::Result<()> {
    let mut env = child_env(std::env::vars_os());
    env.extend(dev_env(dir));
    #[cfg(target_os = "macos")]
    {
        let app = bundle_of(dir)?;
        // A Sval the user opened during the wait holds the profile, and a
        // second one on it would only say the profile is in use.
        launch_when_whole(
            crate::install::dev_build_dir(dir).is_some(),
            || verifies(app),
            Instant::now,
            std::thread::sleep,
            || {
                if in_use(profile) {
                    Ok(())
                } else {
                    start_with(dir, profile, env)
                }
            },
        )
    }
    #[cfg(not(target_os = "macos"))]
    start_with(dir, profile, env)
}

/// The error [`start`] gives when Sval.app failed `codesign`'s check for all
/// of [`VERIFY_WAIT`], so Sval was not started.
#[derive(Debug)]
pub struct Unverified;

impl std::fmt::Display for Unverified {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sval.app did not pass codesign's check")
    }
}

impl std::error::Error for Unverified {}

/// Whether `err` is [`Unverified`].
pub fn is_unverified(err: &io::Error) -> bool {
    err.get_ref().is_some_and(|inner| inner.is::<Unverified>())
}

/// How long [`start`] waits for Sval.app to verify, and how long it waits
/// between checks. Finder writes a dragged bundle file by file, and a user
/// replacing Sval quits it first, so a tool call can find it closed and half
/// written; the wait covers such a copy.
pub const VERIFY_WAIT: Duration = Duration::from_secs(60);
const VERIFY_RETRY: Duration = Duration::from_secs(2);

/// How long one `codesign` check may run before it counts as a failure. The
/// whole of Sval.app is hashed, so this leaves room for a slow disk.
pub const CODESIGN_TIMEOUT: Duration = Duration::from_secs(20);

/// Runs `launch` once `verify` passes, checking every [`VERIFY_RETRY`] for
/// [`VERIFY_WAIT`], or fails with [`Unverified`] without running it. A dev
/// build's bundle fails the check, since the build signs no bundle as a
/// whole, so it is launched unchecked.
///
/// macOS assesses a quarantined app with Gatekeeper the first time it runs,
/// and records a rejection of a half-written bundle for good, so Sval.app
/// is only started once it is whole.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn launch_when_whole(
    dev: bool,
    mut verify: impl FnMut() -> bool,
    now: impl Fn() -> Instant,
    mut sleep: impl FnMut(Duration),
    launch: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    if !dev {
        let deadline = now() + VERIFY_WAIT;
        while !verify() {
            if now() + VERIFY_RETRY > deadline {
                return Err(io::Error::other(Unverified));
            }
            sleep(VERIFY_RETRY);
        }
    }
    launch()
}

/// Whether `codesign` finds every file of `app` whole and signed. The check
/// is static: it reads the bundle and never asks Gatekeeper, so it records
/// nothing about it. One that outruns [`CODESIGN_TIMEOUT`] is killed and
/// counts as a failure.
#[cfg(target_os = "macos")]
fn verifies(app: &Path) -> bool {
    use std::process::{Command, Stdio};
    let Ok(mut child) = Command::new("/usr/bin/codesign")
        .args(["--verify", "--deep", "--strict"])
        .arg(app)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    else {
        return false;
    };
    let deadline = Instant::now() + CODESIGN_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(50));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

/// The app bundle whose `Contents/MacOS` is `dir`.
#[cfg(target_os = "macos")]
fn bundle_of(dir: &Path) -> io::Result<&Path> {
    dir.parent()
        .and_then(Path::parent)
        .filter(|app| app.extension().is_some_and(|e| e == "app"))
        .ok_or_else(|| io::Error::other("sval-mcp is not inside an app bundle"))
}

/// What a dev build gets from the shim beside it, as `scripts/run.sh` gives
/// it: the directories beside its profile for what Gecko keeps outside one
/// (`nsXREDirProvider::GetUserDataDirectory`), which would otherwise be an
/// installed Sval's, and no crash reporter. A packaged Sval gets nothing.
pub(crate) fn dev_env(dir: &Path) -> Vec<(OsString, OsString)> {
    let Some(build) = crate::install::dev_build_dir(dir) else {
        return Vec::new();
    };
    vec![
        ("MOZ_APP_DATA".into(), build.join("dev-appdata").into()),
        (
            "MOZ_LOCAL_APP_DATA".into(),
            build.join("dev-appdata-local").into(),
        ),
        ("MOZ_CRASHREPORTER_DISABLE".into(), "1".into()),
    ]
}

/// macOS starts the bundle with `open -g`, which leaves the active app active
/// (agent-control spec §7.1, measured 2026-10-06). `-n` starts it even while
/// another profile's Sval runs, which `open` would otherwise only activate.
/// `open` hands the app the environment it was given itself (measured
/// 2026-10-24, macOS 26), so `env` is all of `open`'s.
#[cfg(target_os = "macos")]
fn start_with(dir: &Path, profile: &Path, env: Vec<(OsString, OsString)>) -> io::Result<()> {
    let app = bundle_of(dir)?;
    let status = std::process::Command::new("/usr/bin/open")
        .env_clear()
        .envs(env)
        .arg("-g")
        .arg("-n")
        .arg(app)
        .arg("--args")
        .arg("--profile")
        .arg(profile)
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(io::Error::other(format!("open exited with {status}")))
    }
}

/// Linux starts the binary in a process group of its own, so it outlives the
/// agent.
///
/// A window manager gives a new window focus unless its launch says no user
/// action asked for it. On X11 that is the startup notification's timestamp,
/// which GTK reads from `DESKTOP_STARTUP_ID` (`gtk_window_set_startup_id`, as
/// `nsWindow::SetUserTimeAndStartupTokenForActivatedWindow` applies it):
/// one older than any input, `_TIME1`, keeps the user's window focused.
/// `_TIME0` would not, since GTK reads 0 as the current time (measured
/// 2026-10-17, Ubuntu 24.04, mutter on X11). An activation token left in
/// the environment is the agent's own launch's, and asks for focus on
/// Wayland, so it is not passed on.
#[cfg(all(unix, not(target_os = "macos")))]
fn start_with(dir: &Path, profile: &Path, env: Vec<(OsString, OsString)>) -> io::Result<()> {
    use std::os::unix::process::CommandExt;
    use std::process::Stdio;
    std::process::Command::new(dir.join("sval"))
        .env_clear()
        .envs(env)
        .arg("--profile")
        .arg(profile)
        .env(
            "DESKTOP_STARTUP_ID",
            format!("sval-mcp-{}_TIME1", std::process::id()),
        )
        .env_remove("XDG_ACTIVATION_TOKEN")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map(drop)
}

/// Windows starts the binary shown without activation (`SW_SHOWNOACTIVATE`
/// through `STARTUPINFO`, which `std` cannot set), detached from the agent's
/// console and in a process group of its own, with `env` as its whole
/// environment ([`environment_block`]).
#[cfg(windows)]
fn start_with(dir: &Path, profile: &Path, env: Vec<(OsString, OsString)>) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, CREATE_NEW_PROCESS_GROUP, CREATE_UNICODE_ENVIRONMENT, DETACHED_PROCESS,
        PROCESS_INFORMATION, STARTF_USESHOWWINDOW, STARTUPINFOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE;

    let exe = dir.join("sval.exe");
    let quoted = |s: &std::ffi::OsStr| {
        let mut out: Vec<u16> = vec![u16::from(b'"')];
        out.extend(s.encode_wide());
        out.push(u16::from(b'"'));
        out
    };
    let mut command = quoted(exe.as_os_str());
    command.extend(" --profile ".encode_utf16());
    command.extend(quoted(profile.as_os_str()));
    command.push(0);
    let application: Vec<u16> = exe.as_os_str().encode_wide().chain([0]).collect();
    let environment = environment_block(&env);

    // SAFETY: both structures are plain data, valid all zeros, and live
    // across the call; `command` is a writable, NUL-terminated buffer, as
    // CreateProcessW requires, and `environment` a UTF-16 block ended by two
    // NULs, as CREATE_UNICODE_ENVIRONMENT says it is.
    unsafe {
        let mut startup: STARTUPINFOW = std::mem::zeroed();
        startup.cb = u32::try_from(std::mem::size_of::<STARTUPINFOW>()).unwrap_or(0);
        startup.dwFlags = STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_SHOWNOACTIVATE as u16;
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        let ok = CreateProcessW(
            application.as_ptr(),
            command.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            0,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT,
            environment.as_ptr().cast(),
            std::ptr::null(),
            &startup,
            &mut info,
        );
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        CloseHandle(info.hThread);
        CloseHandle(info.hProcess);
    }
    Ok(())
}

/// `env` as `CreateProcessW` takes it with `CREATE_UNICODE_ENVIRONMENT`:
/// `name=value` strings, each ended by a NUL, and the block by another.
#[cfg(windows)]
fn environment_block(env: &[(OsString, OsString)]) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    let mut block: Vec<u16> = Vec::new();
    for (name, value) in env {
        block.extend(name.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    block
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_dir::TempDir;

    /// Variables Gecko reads as switches: the ones sval-mcp keeps from Sval,
    /// and one it passes on.
    const SWITCHES: [(&str, &str); 8] = [
        ("MOZ_MARIONETTE", "1"),
        ("MOZ_DISABLE_CONTENT_SANDBOX", "1"),
        ("MOZ_LOG", "nsHttp:5"),
        ("MOZ_ENABLE_WAYLAND", "1"),
        ("NSPR_LOG_MODULES", "nsHttp:5"),
        ("NSS_ALLOW_WEAK_SIGNATURE_ALG", "1"),
        ("XRE_PROFILE_PATH", "/elsewhere"),
        ("SSLKEYLOGFILE", "/elsewhere/keys"),
    ];

    /// The agent's environment with [`SWITCHES`] added, and a variable of
    /// no meaning to Gecko.
    fn agent_env() -> Vec<(OsString, OsString)> {
        std::env::vars_os()
            .chain(
                SWITCHES
                    .into_iter()
                    .chain([("SVAL_MCP_TEST_PASSED_ON", "1")])
                    .map(|(name, value)| (OsString::from(name), OsString::from(value))),
            )
            .collect()
    }

    /// Whether `name` is one of [`SWITCHES`], in any case.
    fn is_switch(name: &str) -> bool {
        SWITCHES
            .iter()
            .any(|(switch, _)| switch.eq_ignore_ascii_case(name))
    }

    #[test]
    fn only_mozillas_wayland_switch_is_passed_on() {
        for name in [
            "MOZ_MARIONETTE",
            "MOZ_DISABLE_CONTENT_SANDBOX",
            "MOZ_LOG",
            "MOZ_",
            "MOZ_ENABLE_WAYLAND_X",
            "NSPR_LOG_MODULES",
            "NSPR_LOG_FILE",
            "NSS_ALLOW_WEAK_SIGNATURE_ALG",
            "XRE_PROFILE_PATH",
            "XRE_CONSOLE_LOG",
            "SSLKEYLOGFILE",
            "XUL_APP_FILE",
        ] {
            assert!(!passes_on(OsStr::new(name)), "{name}");
        }
        for name in [
            "MOZ_ENABLE_WAYLAND",
            "PATH",
            "HOME",
            "DISPLAY",
            "XDG_RUNTIME_DIR",
            "MOZ",
            "XMOZ_LOG",
            "NSS",
            "SSLKEYLOGFILE_X",
            "XUL_APP_FILE_X",
        ] {
            assert!(passes_on(OsStr::new(name)), "{name}");
        }
        for name in [
            "moz_marionette",
            "nspr_log_modules",
            "Xre_Profile_Path",
            "SslKeyLogFile",
            "Xul_App_File",
        ] {
            assert_eq!(
                passes_on(OsStr::new(name)),
                !cfg!(windows),
                "Windows reads {name} without regard to case"
            );
        }
        assert!(
            passes_on(OsStr::new("moz_enable_wayland")),
            "Windows keeps the Wayland switch in any case"
        );
    }

    /// The names of [`SWITCHES`] in `env`'s `name=value` lines.
    #[cfg(unix)]
    fn switch_names(env: &str) -> Vec<&str> {
        env.lines()
            .filter_map(|line| line.split_once('=').map(|(name, _)| name))
            .filter(|name| is_switch(name))
            .collect()
    }

    /// Writes `sval`, a script that leaves the environment it was started
    /// with in `env` in the profile directory it is given, as Sval would be
    /// given it. The file is renamed into place once written, so a reader
    /// never sees half of it.
    #[cfg(unix)]
    fn write_env_recorder(dir: &Path) {
        crate::test_dir::write_executable(
            &dir.join("sval"),
            "#!/bin/sh\nenv > \"$2/env.part\" && mv \"$2/env.part\" \"$2/env\"\n",
        );
    }

    /// The environment the recorder left in `profile`, waiting for it.
    #[cfg(unix)]
    fn recorded_env(profile: &Path) -> String {
        let file = profile.join("env");
        let until = std::time::Instant::now() + std::time::Duration::from_secs(20);
        loop {
            if let Ok(env) = std::fs::read_to_string(&file) {
                return env;
            }
            assert!(
                std::time::Instant::now() < until,
                "the started program never wrote its environment"
            );
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn the_started_sval_gets_no_gecko_switches() {
        let temp = TempDir::new("childenv");
        let dir = temp.0.as_path();
        write_env_recorder(dir);
        start_with(dir, dir, child_env(agent_env())).unwrap();
        let env = recorded_env(dir);
        assert_eq!(switch_names(&env), ["MOZ_ENABLE_WAYLAND"], "{env}");
        assert!(env.contains("SVAL_MCP_TEST_PASSED_ON=1\n"), "{env}");
    }

    /// The bundle `open` starts is a real one LaunchServices registers, so it
    /// is unregistered once the test ends.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_started_sval_gets_no_gecko_switches() {
        let temp = TempDir::new("childenv");
        let app = temp.0.join("Recorder.app");
        let macos = app.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>sval</string>
<key>CFBundleIdentifier</key><string>ai.ellmtree.sval-mcp-test.{}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>
"#,
                std::process::id()
            ),
        )
        .unwrap();
        write_env_recorder(&macos);
        let profile = temp.0.join("profile");
        std::fs::create_dir(&profile).unwrap();
        let started = start_with(&macos, &profile, child_env(agent_env()));
        let env = started.as_ref().ok().map(|()| recorded_env(&profile));
        let _ = std::process::Command::new(
            "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
        )
        .arg("-u")
        .arg(&app)
        .status();
        started.unwrap();
        let env = env.unwrap();
        assert_eq!(switch_names(&env), ["MOZ_ENABLE_WAYLAND"], "{env}");
        assert!(env.contains("SVAL_MCP_TEST_PASSED_ON=1\n"), "{env}");
    }

    /// `CreateProcessW` gives the child the block as its whole environment.
    #[cfg(windows)]
    #[test]
    fn the_started_sval_gets_no_gecko_switches() {
        let mut env = agent_env();
        env.push(("moz_marionette".into(), "1".into()));
        let block = String::from_utf16(&environment_block(&child_env(env))).unwrap();
        let entries: Vec<&str> = block.trim_end_matches('\0').split('\0').collect();
        let switches: Vec<&str> = entries
            .iter()
            .filter(|entry| {
                entry
                    .split_once('=')
                    .is_some_and(|(name, _)| is_switch(name))
            })
            .copied()
            .collect();
        assert_eq!(switches, ["MOZ_ENABLE_WAYLAND=1"], "{block}");
        assert!(entries.contains(&"SVAL_MCP_TEST_PASSED_ON=1"), "{block}");
    }

    #[test]
    fn a_profile_with_no_lock_file_is_not_in_use() {
        let temp = TempDir::new("nolock");
        let dir = temp.0.as_path();
        assert!(!profile_in_use(dir));
    }

    /// `F_GETLK` reports no lock this process holds itself, so a child takes
    /// it, as Sval would.
    #[cfg(unix)]
    #[test]
    fn a_lock_another_process_holds_is_in_use() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let temp = TempDir::new("lock");
        let dir = temp.0.as_path();
        let lock = dir.join(".parentlock");
        std::fs::write(&lock, b"").unwrap();
        assert!(!profile_in_use(dir), "an unlocked file is not in use");
        // Python's fcntl.lockf takes the same POSIX write lock Firefox does.
        let mut child = Command::new("python3")
            .arg("-c")
            .arg("import fcntl,sys;f=open(sys.argv[1],'w');fcntl.lockf(f,fcntl.LOCK_EX);print('held',flush=True);sys.stdin.read()")
            .arg(&lock)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("python3 runs");
        let mut line = String::new();
        BufReader::new(child.stdout.as_mut().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line.trim(), "held");
        assert!(profile_in_use(dir), "the held lock is seen");
        drop(child.stdin.take());
        child.wait().unwrap();
        assert!(!profile_in_use(dir), "and seen gone once released");
    }

    /// A clock that `sleep` moves on, and `verify` by the time a check
    /// takes, with the checks' results in turn and the launches counted.
    struct Run {
        checks: Vec<bool>,
        checked: usize,
        launched: usize,
        elapsed: Duration,
    }

    fn run(dev: bool, checks: &[bool]) -> (io::Result<()>, Run) {
        let start = Instant::now();
        let run = std::cell::RefCell::new(Run {
            checks: checks.to_vec(),
            checked: 0,
            launched: 0,
            elapsed: Duration::ZERO,
        });
        let result = launch_when_whole(
            dev,
            || {
                let mut run = run.borrow_mut();
                run.elapsed += Duration::from_millis(1600);
                run.checked += 1;
                let i = (run.checked - 1).min(run.checks.len() - 1);
                run.checks[i]
            },
            || start + run.borrow().elapsed,
            |pause| run.borrow_mut().elapsed += pause,
            || {
                run.borrow_mut().launched += 1;
                Ok(())
            },
        );
        (result, run.into_inner())
    }

    #[test]
    fn a_whole_bundle_is_launched_at_once() {
        let (result, run) = run(false, &[true]);
        result.unwrap();
        assert_eq!((run.checked, run.launched), (1, 1));
    }

    #[test]
    fn a_bundle_that_becomes_whole_is_launched_then() {
        let (result, run) = run(false, &[false, false, true]);
        result.unwrap();
        assert_eq!((run.checked, run.launched), (3, 1));
    }

    #[test]
    fn a_bundle_that_never_verifies_is_not_launched() {
        let (result, run) = run(false, &[false]);
        assert!(is_unverified(&result.unwrap_err()));
        assert_eq!(run.launched, 0);
        assert!(run.checked > 1, "it is checked again");
        assert!(
            run.elapsed >= VERIFY_WAIT - VERIFY_RETRY && run.elapsed <= VERIFY_WAIT + VERIFY_RETRY,
            "{:?}",
            run.elapsed
        );
    }

    #[test]
    fn a_dev_build_is_launched_unchecked() {
        let (result, run) = run(true, &[false]);
        result.unwrap();
        assert_eq!((run.checked, run.launched), (0, 1));
    }

    #[test]
    fn a_launch_error_is_not_taken_for_an_unverified_bundle() {
        let failed = launch_when_whole(
            false,
            || true,
            Instant::now,
            |_| {},
            || Err(io::Error::other("open failed")),
        );
        assert!(!is_unverified(&failed.unwrap_err()));
    }

    /// `codesign` passes a whole bundle signed ad hoc and fails one whose
    /// executable was cut short, as Finder leaves one it is still copying.
    #[cfg(target_os = "macos")]
    #[test]
    fn codesign_tells_a_whole_bundle_from_a_cut_one() {
        let temp = TempDir::new("codesign");
        let app = temp.0.join("Whole.app");
        let macos = app.join("Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        std::fs::write(
            app.join("Contents/Info.plist"),
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>sval</string>
<key>CFBundleIdentifier</key><string>ai.ellmtree.sval-mcp-codesign-test</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
"#,
        )
        .unwrap();
        let exe = macos.join("sval");
        std::fs::copy("/usr/bin/true", &exe).unwrap();
        assert!(!verifies(&app), "a bundle with no seal of its own fails");
        let signed = std::process::Command::new("/usr/bin/codesign")
            .args(["--force", "--sign", "-"])
            .arg(&app)
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(signed.success());
        assert!(verifies(&app), "a whole signed bundle passes");
        let len = std::fs::metadata(&exe).unwrap().len();
        std::fs::OpenOptions::new()
            .write(true)
            .open(&exe)
            .unwrap()
            .set_len(len / 2)
            .unwrap();
        assert!(!verifies(&app), "a cut executable fails");
    }

    #[test]
    fn starting_from_a_directory_with_no_sval_fails() {
        let temp = TempDir::new("nosval");
        let dir = temp.0.as_path();
        assert!(start_from(dir, dir).is_err());
    }
}
