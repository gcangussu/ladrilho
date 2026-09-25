//! The measurement protocol and the gate's write, which `benches/engine.rs`
//! and `examples/compare.rs` share through `benches/measure.rs`.

mod support;

#[path = "../benches/measure.rs"]
mod measure;

/// [R9-18] Three warm-up runs discarded, then the median of at least nine
/// timed runs, for each figure — checked on runs whose values say which they
/// were, so a protocol that kept a warm-up or took a mean would be seen.
#[test]
fn the_protocol_discards_three_and_takes_the_median_of_nine() {
    assert_eq!(measure::WARMUP_RUNS, 3);
    const { assert!(measure::TIMED_RUNS >= 9) };
    let mut seen = Vec::new();
    // Warm-ups report 1000; timed runs report 1, 2, …, 9 and a skewed 500.
    let (a, b) = measure::protocol(|i| {
        seen.push(i);
        if i < measure::WARMUP_RUNS {
            (1000.0, -1000.0)
        } else if i == measure::WARMUP_RUNS + measure::TIMED_RUNS - 1 {
            (500.0, -500.0)
        } else {
            let k = (i - measure::WARMUP_RUNS + 1) as f64;
            (k, -k)
        }
    });
    assert_eq!(seen, (0..measure::WARMUP_RUNS + measure::TIMED_RUNS).collect::<Vec<_>>());
    // Timed values 1..=8 and 500: the median of nine is 5, whatever the outlier.
    assert_eq!((a, b), (5.0, -5.0));
    assert_eq!(measure::median(vec![3.0, 1.0, 2.0, 10.0]), 2.5);
}

/// [R9-18] The measured game is a complete, legal game from the seeded start.
#[test]
fn the_measured_game_is_a_whole_legal_game() {
    let actions = measure::record_game(measure::SEED);
    let mut s = azul_engine::AzulState::seeded(measure::SEED);
    for &a in &actions {
        s.apply(a).unwrap();
    }
    assert!(s.is_terminal());
}

fn scratch(name: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("azul-engine-rs-{nanos}-{name}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// [R9-19] Only a complete run writes the baseline: the write replaces the
/// file whole and leaves nothing beside it, and a write that cannot finish
/// leaves the old file exactly as it was.
#[test]
fn the_baseline_is_written_whole_or_not_at_all() {
    let dir = scratch("whole");
    let path = dir.join("baseline.json");
    std::fs::write(&path, "old").unwrap();
    measure::write_whole(&path, "new").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "nothing left beside it");

    // The temporary file cannot be created: a directory is in its way.
    std::fs::create_dir(path.with_extension("partial")).unwrap();
    assert!(measure::write_whole(&path, "newer").is_err());
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new", "the old file is untouched");
    std::fs::remove_dir_all(&dir).unwrap();

    // And the tool writes only through it, after every run is done.
    let compare = std::fs::read_to_string(support::crate_dir().join("examples/compare.rs")).unwrap();
    let write = compare.find("measure::write_whole(").expect("the tool writes through write_whole");
    assert!(compare.rfind("measure::protocol(").unwrap() < write, "written after the last run");
    assert!(!compare.contains("fs::write") && !compare.contains("File::create"), "no other write");
}
