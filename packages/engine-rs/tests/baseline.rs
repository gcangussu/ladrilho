//! [R9-20] The throughput gate, asserted on the committed evidence.
//!
//! `pnpm -F engine-rs compare` measures both engines on one machine and
//! writes `bench/baseline.json` ([R9-19]). This checks the file is whole and
//! honest — the ratio is the quotient of the figures it records, `passed` is
//! the ratio against five — and that it passed.

mod support;

use serde_json::Value;

fn baseline() -> Value {
    let path = support::crate_dir().join("bench/baseline.json");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}; run `pnpm -F engine-rs compare`", path.display()));
    serde_json::from_str(&text).unwrap()
}

/// [R9-20] rust.pliesPerSecond / typescript.pliesPerSecond = ratio,
/// passed = ratio >= 5, and passed is true.
#[test]
fn the_committed_baseline_passes_the_gate() {
    let b = baseline();
    for key in ["date", "machine", "typescript", "rust", "ratio", "passed"] {
        assert!(b.get(key).is_some(), "baseline.json lacks {key}");
    }
    for key in ["os", "arch", "cpu"] {
        assert!(b["machine"][key].is_string(), "machine.{key}");
    }
    let figure = |engine: &str, key: &str| {
        let x = b[engine][key].as_f64().unwrap_or_else(|| panic!("{engine}.{key}"));
        assert!(x.is_finite() && x > 0.0, "{engine}.{key} = {x}");
        x
    };
    let (ts, rust) = (figure("typescript", "pliesPerSecond"), figure("rust", "pliesPerSecond"));
    figure("typescript", "cloneNs");
    figure("rust", "cloneNs");
    let ratio = b["ratio"].as_f64().unwrap();
    assert_eq!(ratio, rust / ts, "ratio is the quotient of the recorded figures");
    let passed = b["passed"].as_bool().unwrap();
    assert_eq!(passed, ratio >= 5.0, "passed is the ratio against five");
    assert!(passed, "the crate must sustain five times the TypeScript engine's throughput; ratio {ratio:.2}");
}
