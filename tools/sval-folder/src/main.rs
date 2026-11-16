// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

use std::path::PathBuf;
use sval_folder::serve::{run, BUILD, EXIT_USAGE};

const USAGE: &str = "usage: sval-folder <request directory> | --version";

fn main() {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.as_slice() {
        [arg] if arg == "--version" => println!("sval-folder {BUILD}"),
        [dir] if PathBuf::from(dir).is_absolute() => std::process::exit(run(PathBuf::from(dir))),
        _ => {
            eprintln!("{USAGE}");
            std::process::exit(EXIT_USAGE);
        }
    }
}
