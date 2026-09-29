//! `alphazero`: the crate's commands ([Z11-23], [Z11-26], [Z11-40], [Z11-53]).
//!
//! Every command loads one checkpoint, parity checked ([Z11-13]), and one
//! run's `config.json` ([Z11-60]). Timing lives here and in `commands`, the
//! modules only this file declares, never in the library ([Z11-18]).

#![forbid(unsafe_code)]

mod commands;

use std::process::ExitCode;

use clap::Parser;

fn main() -> ExitCode {
    // A usage error is an error exit with clap's message, never a panic
    // ([Z11-22]); `--help` and `--version` print and succeed.
    let cli = match commands::Cli::try_parse() {
        Ok(cli) => cli,
        Err(e) => {
            let _ = e.print();
            return if e.use_stderr() { ExitCode::from(2) } else { ExitCode::SUCCESS };
        }
    };
    match commands::run(cli) {
        Ok(()) => ExitCode::SUCCESS,
        Err(why) => {
            eprintln!("alphazero: {why}");
            ExitCode::from(2)
        }
    }
}
