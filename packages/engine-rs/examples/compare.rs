//! `pnpm -F engine-rs compare`: the gate run of [R9-19].
//!
//! Runs the TypeScript engine's bench and this crate's measurement in one
//! session on one machine, with the same protocol for both — three discarded
//! warm-up runs, then the median of nine — and writes `bench/baseline.json`.
//! [R9-20] is asserted on that file by `tests/baseline.rs`.
//!
//! Only a complete run writes: the file is written to a temporary path and
//! renamed into place at the end, so an interrupted run leaves the old one.

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

    let mut ts_plies = Vec::new();
    let mut ts_clone = Vec::new();
    for i in 0..measure::WARMUP_RUNS + measure::TIMED_RUNS {
        let (p, c) = typescript_run(&repo);
        eprintln!("typescript run {}: {p:.0} plies/s, {c:.1} ns/clone{}", i + 1, if i < measure::WARMUP_RUNS { " (warm-up)" } else { "" });
        if i >= measure::WARMUP_RUNS {
            ts_plies.push(p);
            ts_clone.push(c);
        }
    }
    let ts_plies = measure::median(ts_plies).round();
    let ts_clone = (measure::median(ts_clone) * 10.0).round() / 10.0;

    let rust = measure::measure();
    let rust_plies = rust.plies_per_second.round();
    let rust_clone = (rust.clone_ns * 10.0).round() / 10.0;
    eprintln!("rust: {rust_plies:.0} plies/s over a {}-ply game, {rust_clone:.1} ns/clone", rust.plies);

    let ratio = rust_plies / ts_plies;
    let doc = serde_json::json!({
        "date": run("date", &["+%F"]),
        "machine": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH, "cpu": cpu() },
        "typescript": { "pliesPerSecond": ts_plies, "cloneNs": ts_clone },
        "rust": { "pliesPerSecond": rust_plies, "cloneNs": rust_clone },
        "ratio": ratio,
        "passed": ratio >= 5.0,
    });
    let path = crate_dir.join("bench/baseline.json");
    let tmp = path.with_extension("json.partial");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
    std::fs::rename(&tmp, &path).unwrap();
    println!("ratio {ratio:.2}: {}", if ratio >= 5.0 { "passed" } else { "NOT passed" });
    println!("wrote {}", path.display());
}
