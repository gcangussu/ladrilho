//! `pnpm -F engine-rs bench`: the figures of [R9-18]. Non-gating; the gate is
//! the committed baseline that `pnpm -F engine-rs compare` writes ([R9-20]).

#[path = "measure.rs"]
mod measure;

fn main() {
    // `cargo bench` passes `--bench`; a filter argument means nothing here.
    let f = measure::measure();
    println!(
        "legal_actions + apply: {:.0} plies/second over one {}-ply game (median of {} runs)",
        f.plies_per_second,
        f.plies,
        measure::TIMED_RUNS
    );
    println!("clone of a mid-game position: {:.1} ns (median of {} runs)", f.clone_ns, measure::TIMED_RUNS);
}
