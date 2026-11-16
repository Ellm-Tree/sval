// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use sval_mcp::bridge::{agent_dir, run_stdio, BUILD};
use sval_mcp::secrets::{remove_account_lock_files, FileStore};

const USAGE: &str = "usage: sval-mcp [--profile <Sval profile directory>] | --version | --help";

/// What the command line asks for.
#[derive(Debug, PartialEq)]
enum Command {
    Version,
    Help,
    Serve(Option<PathBuf>),
}

/// Reads the arguments after the program's name. An argument it does not
/// know, or a `--profile` with no directory, is an error: without one the
/// shim would drive Sval's own data directory in place of the profile meant.
fn parse_args(args: impl IntoIterator<Item = OsString>) -> Result<Command, String> {
    let mut args = args.into_iter();
    let mut profile = None;
    while let Some(arg) = args.next() {
        match arg.to_str() {
            Some("--version") => return Ok(Command::Version),
            Some("--help" | "-h") => return Ok(Command::Help),
            Some("--profile") => match args.next() {
                Some(dir) if !dir.is_empty() => profile = Some(PathBuf::from(dir)),
                _ => return Err("--profile needs a directory".into()),
            },
            _ => return Err(format!("unknown argument {}", arg.to_string_lossy())),
        }
    }
    Ok(Command::Serve(profile))
}

fn main() {
    let profile = match parse_args(std::env::args_os().skip(1)) {
        Ok(Command::Version) => {
            println!("sval-mcp {BUILD}");
            return;
        }
        Ok(Command::Help) => {
            println!("{USAGE}");
            return;
        }
        Ok(Command::Serve(profile)) => profile,
        Err(err) => {
            eprintln!("{USAGE}\nsval-mcp: {err}");
            std::process::exit(2);
        }
    };
    // Without the flag, the directory Sval starts on without one.
    let Some(profile) = profile.or_else(sval_mcp::install::default_profile) else {
        eprintln!(
            "{USAGE}\nsval-mcp found no home directory to find Sval's data in: give --profile"
        );
        std::process::exit(2);
    };
    let profile = sval_mcp::install::profile_spelling(&profile);
    remove_account_lock_files(&agent_dir(&profile));
    let store = Arc::new(FileStore::new(agent_dir(&profile)));
    if let Err(err) = run_stdio(&profile, store) {
        eprintln!("sval-mcp: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Command, String> {
        parse_args(args.iter().map(OsString::from))
    }

    #[test]
    fn the_known_arguments_are_read() {
        assert_eq!(parse(&[]), Ok(Command::Serve(None)));
        assert_eq!(
            parse(&["--profile", "/p"]),
            Ok(Command::Serve(Some(PathBuf::from("/p"))))
        );
        assert_eq!(parse(&["--version"]), Ok(Command::Version));
        assert_eq!(
            parse(&["--profile", "/p", "--version"]),
            Ok(Command::Version)
        );
        assert_eq!(parse(&["--help"]), Ok(Command::Help));
    }

    #[test]
    fn a_profile_flag_with_no_directory_is_refused() {
        assert!(parse(&["--profile"]).is_err());
        assert!(parse(&["--profile", ""]).is_err());
    }

    #[test]
    fn an_unknown_argument_is_refused() {
        assert!(parse(&["--profle", "/p"]).is_err());
        assert!(parse(&["/p"]).is_err());
    }
}
