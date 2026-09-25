//! `pnpm -F engine-rs compare`: the gate run of [R9-19].
//!
//! Runs the TypeScript engine's bench and this crate's measurement in one
//! session on one machine, with the same protocol for both — three discarded
//! warm-up runs, then the median of nine — and writes `bench/baseline.json`.
//! [R9-20] is asserted on that file by `tests/baseline.rs`.
//!
//! Only a complete run writes: the file is written to a temporary path and
//! renamed into place at the end, so an interrupted run leaves the old one.
//! The two engines' runs are interleaved, one of each per step.

#[path = "../benches/measure.rs"]
mod measure;

use std::path::{Path, PathBuf};
use std::process::Command;

/// Plies per second and nanoseconds per clone, from one run of
/// `pnpm -F engine bench`: `hz` of the whole-game bench times its ply count,
/// and `1e9 / hz` of the clone bench.
fn typescript_run(repo: &Path) -> (f64, f64) {
    let out = Command::new("pnpm")
        .args(["-F", "engine", "bench"])
        .current_dir(repo)
        .output()
        .expect("pnpm runs the TypeScript bench");
    assert!(out.status.success(), "the TypeScript bench failed:\n{}", String::from_utf8_lossy(&out.stderr));
    let text = String::from_utf8_lossy(&out.stdout);
    let hz = |line: &str, after: &str| -> f64 {
        let rest = &line[line.find(after).unwrap() + after.len()..];
        rest.split_whitespace().next().unwrap().replace(',', "").parse().unwrap()
    };
    let game = text.lines().find(|l| l.contains("-ply game ") && !l.contains('>')).expect("the game bench line");
    let plies: f64 = game.split_whitespace().find_map(|w| w.strip_suffix("-ply")).unwrap().parse().unwrap();
    let clone = text.lines().find(|l| l.contains("mid-game position ") && !l.contains('>')).expect("the clone bench line");
    (hz(game, "-ply game") * plies, 1e9 / hz(clone, "mid-game position"))
}

fn run(cmd: &str, args: &[&str]) -> String {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string())
}

fn cpu() -> String {
    match std::env::consts::OS {
        "macos" => run("sysctl", &["-n", "machdep.cpu.brand_string"]),
        "linux" => std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|t| t.lines().find(|l| l.starts_with("model name")).map(|l| l.split(':').nth(1).unwrap_or("").trim().to_string()))
            .unwrap_or_else(|| "unknown".to_string()),
        _ => "unknown".to_string(),
    }
}

fn main() {
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let repo = crate_dir.join("../..");

    // The two engines' runs interleave, one of each per step, so a transient
    // load on the machine slows both sides of the ratio rather than one.
    let rust = measure::Workload::new();
    let mut rust_runs = Vec::new();
    let (ts_plies, ts_clone) = measure::protocol(|i| {
        let ts = typescript_run(&repo);
        let rs = rust.run_once();
        let tag = if i < measure::WARMUP_RUNS { " (warm-up)" } else { "" };
        eprintln!("run {}: typescript {:.0} plies/s, {:.1} ns/clone; rust {:.0} plies/s, {:.1} ns/clone{tag}", i + 1, ts.0, ts.1, rs.0, rs.1);
        rust_runs.push(rs);
        ts
    });
    let mut i = 0;
    let (rust_plies, rust_clone) = measure::protocol(|_| {
        i += 1;
        rust_runs[i - 1]
    });
    let ts_plies = ts_plies.round();
    let ts_clone = (ts_clone * 10.0).round() / 10.0;
    let rust_plies = rust_plies.round();
    let rust_clone = (rust_clone * 10.0).round() / 10.0;

    // The engines deal different games from the same seed ([R9-13]), so each
    // times its own recorded game: the ratio compares plies per second, not
    // one game's cost.
    let ratio = rust_plies / ts_plies;
    let doc = serde_json::json!({
        "date": run("date", &["+%F"]),
        "machine": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "cpu": cpu() },
        "typescript": { "pliesPerSecond": ts_plies, "cloneNs": ts_clone },
        "rust": { "pliesPerSecond": rust_plies, "cloneNs": rust_clone, "plies": rust.plies() },
        "ratio": ratio,
        "passed": ratio >= 5.0,
    });
    let path = crate_dir.join("bench/baseline.json");
    // Only now, with every run done, is anything written ([R9-19]).
    measure::write_whole(&path, &(serde_json::to_string_pretty(&doc).unwrap() + "\n")).unwrap();
    println!("ratio {ratio:.2}: {}", if ratio >= 5.0 { "passed" } else { "NOT passed" });
    println!("wrote {}", path.display());
}
