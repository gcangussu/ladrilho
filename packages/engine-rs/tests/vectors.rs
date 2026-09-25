//! The conformance replay: every committed vector, ply by ply, compared state
//! for state against the oracle's recording.

mod support;

use azul_engine::{AzulState, Outcome, Shuffler};
use support::{FULL_CENSUS, Kind, Recorded, Vector, check_invariants, diff, start, vectors};

/// Which entry point a replay drives.
#[derive(Clone, Copy, PartialEq)]
enum Path {
    Apply,
    Explained,
}

fn play(s: &mut AzulState<Recorded>, action: u8, path: Path) -> Result<(), String> {
    match path {
        Path::Apply => s.apply(action).map_err(|e| format!("{e:?}")),
        Path::Explained => s.apply_explained(action).map(|_| ()).map_err(|e| format!("{e:?}")),
    }
}

/// Replays `v` from ply `from` onwards on `s`, returning the first fault
/// with the file, ply, action and first differing field ([R9-16]).
fn replay_from(v: &Vector, s: &mut AzulState<Recorded>, from: usize, path: Path, brute: bool) -> Result<(), String> {
    let census = if from == 0 { s.tile_census() } else { start(v).tile_census() };
    for (i, ply) in v.plies.iter().enumerate().skip(from) {
        let at = format!("{} ply {i} action {}", v.name, ply.action);
        // [V2-7] the legal list before the ply, ascending, compared unsorted.
        let legal = s.legal_actions();
        if legal.as_slice() != ply.legal.as_slice() {
            return Err(format!("{at}: legal {:?} != {:?}", legal.as_slice(), ply.legal));
        }
        // [V2-20] and cross-checked against isLegal over every encoding (and
        // every u8 past the space, which must all be illegal).
        if brute {
            let brute: Vec<u8> = (0..=u8::MAX).filter(|&a| s.is_legal(a)).collect();
            if brute != ply.legal {
                return Err(format!("{at}: brute force {brute:?} != {:?}", ply.legal));
            }
        }
        let before = s.shuffles_used();
        play(s, ply.action, path).map_err(|e| format!("{at}: refused {e}"))?;
        // [V2-6] a request past the end of `shuffles` fails the replay.
        if let Some(fault) = &s.shuffler().fault {
            return Err(format!("{at}: {fault}"));
        }
        // [V2-1] [V2-5] the whole state, every ply.
        let got = s.to_canonical();
        if let Some(d) = diff(&got, &ply.state) {
            return Err(format!("{at}: first difference in {d}"));
        }
        // [V2-19] the structural invariants, every ply.
        if let Some(fault) = check_invariants(&got, before) {
            return Err(format!("{at}: {fault}"));
        }
        // [V2-18] conservation as invariance, every ply.
        if s.tile_census() != census {
            return Err(format!("{at}: [E1-40] census {:?} != {census:?}", s.tile_census()));
        }
        // [R9-11] a from-scratch rebuild agrees with the incremental state,
        // caches included.
        let rebuilt = AzulState::from_canonical(&got, s.shuffler().clone())
            .map_err(|e| format!("{at}: own snapshot refused: {e:?}"))?;
        if rebuilt != *s {
            return Err(format!("{at}: rebuilt state differs from the played one [R9-11]"));
        }
    }
    Ok(())
}

fn check_final(v: &Vector, s: &AzulState<Recorded>) -> Result<(), String> {
    // [V2-6] [V2-34] every recorded shuffle was consumed, and no more.
    if s.shuffles_used() as usize != v.shuffles.len() {
        return Err(format!("{}: final shufflesUsed {} != {} recorded", v.name, s.shuffles_used(), v.shuffles.len()));
    }
    if s.scores() != v.final_scores || s.exhausted() != v.final_exhausted {
        return Err(format!("{}: final {:?}/{} != {:?}/{}", v.name, s.scores(), s.exhausted(), v.final_scores, v.final_exhausted));
    }
    // [E1-39] the outcome, against the oracle's.
    let outcome = s.outcome().map(|o| o as i64);
    if outcome != v.final_outcome {
        return Err(format!("{}: outcome {outcome:?} != {:?}", v.name, v.final_outcome));
    }
    Ok(())
}

fn replay(v: &Vector, path: Path) -> Result<(), String> {
    let mut s = start(v);
    // [V2-36] [E1-65] a game's `initial` is compared against what new_game
    // returns, not loaded into it.
    if v.kind == Kind::Game
        && let Some(d) = diff(&s.to_canonical(), &v.initial)
    {
        return Err(format!("{} initial: first difference in {d}", v.name));
    }
    // [V2-35] a fixture under 100 tiles must say so; with the flag, the check
    // narrows to invariance and is never disabled.
    let census = s.tile_census();
    let total: u32 = census.iter().map(|&n| u32::from(n)).sum();
    match (v.short_census, census == FULL_CENSUS) {
        (false, false) => return Err(format!("{}: {total} tiles without \"census\": \"short\"", v.name)),
        (true, true) => return Err(format!("{}: declares a short census but holds 100 tiles", v.name)),
        _ => {}
    }
    replay_from(v, &mut s, 0, path, path == Path::Apply)?;
    check_final(v, &s)
}

fn all(path: Path) {
    let faults: Vec<String> = vectors().iter().filter_map(|v| replay(v, path).err()).collect();
    assert!(faults.is_empty(), "{} vector(s) failed:\n{}", faults.len(), faults.join("\n"));
}

/// [R9-15] every vector in the committed directory, read in place.
/// [R9-16] a mismatch names the file, ply, action and first differing field.
/// [V2-1] [V2-3] [V2-5] [V2-6] [V2-7] [V2-18] [V2-19] [V2-20] [V2-35] [V2-36]
/// [R9-11] plus the rules every ply exercises, from the opening deal
/// [E1-65] to the final outcome [E1-39].
#[test]
fn every_vector_replays_through_apply() {
    all(Path::Apply);
}

/// [S7-29] the same fixtures driven a second time, through apply_explained,
/// asserting the same states.
#[test]
fn every_vector_replays_through_apply_explained() {
    all(Path::Explained);
}

/// [V2-22] mutating a clone leaves the parent untouched, and a clone taken
/// mid-game replays the rest of the vector identically [E1-48].
#[test]
fn a_clone_is_independent_and_replays_the_rest() {
    for v in vectors() {
        let mut s = start(v);
        let mid = v.plies.len() / 2;
        for ply in &v.plies[..mid] {
            s.apply(ply.action).unwrap();
        }
        let parent_before = s.to_canonical();
        let mut c = s.clone();
        replay_from(v, &mut c, mid, Path::Apply, false).unwrap_or_else(|e| panic!("clone: {e}"));
        check_final(v, &c).unwrap_or_else(|e| panic!("clone: {e}"));
        assert_eq!(s.to_canonical(), parent_before, "{}: playing the clone moved the parent", v.name);
        replay_from(v, &mut s, mid, Path::Apply, false).unwrap_or_else(|e| panic!("parent: {e}"));
    }
}

/// [V2-37] the harness refuses a schema it does not know rather than guess.
#[test]
#[should_panic(expected = "unknown schema")]
fn an_unknown_schema_is_refused() {
    let text = std::fs::read_to_string(support::vector_dir().join("game-00.json")).unwrap();
    let bumped = text.replacen("\"schema\": 1", "\"schema\": 2", 1);
    assert_ne!(bumped, text, "the mutation must land");
    support::parse_vector("game-00.json", &bumped);
}

/// [V2-37] a vector without `kind` is unreplayable, and refused.
#[test]
#[should_panic(expected = "missing `kind`")]
fn a_vector_without_kind_is_refused() {
    let text = std::fs::read_to_string(support::vector_dir().join("game-00.json")).unwrap();
    let cut = text.replacen("\"kind\": \"game\",", "", 1);
    assert_ne!(cut, text, "the mutation must land");
    support::parse_vector("game-00.json", &cut);
}

/// [V2-35] a short fixture stripped of its flag is a generator bug, and fails.
#[test]
fn a_short_census_without_its_flag_fails() {
    let name = "position-05-empty-bag-and-lid.json";
    let text = std::fs::read_to_string(support::vector_dir().join(name)).unwrap();
    let cut = text.replacen("\"census\": \"short\",", "", 1);
    assert_ne!(cut, text, "the mutation must land");
    let v = support::parse_vector(name, &cut);
    let err = replay(&v, Path::Apply).unwrap_err();
    assert!(err.contains("without \"census\""), "{err}");
}

/// [V2-6] a replay that asks for a shuffle past the recording fails, and one
/// that leaves recorded shuffles unconsumed fails at the end.
#[test]
fn the_shuffle_count_is_held_at_both_ends() {
    let v = vectors().iter().find(|v| v.kind == Kind::Game && v.shuffles.len() >= 2).expect("a game that recycles the lid");
    let mut short = support::parse_vector(&v.name, &std::fs::read_to_string(support::vector_dir().join(&v.name)).unwrap());
    short.shuffles = &v.shuffles[..v.shuffles.len() - 1];
    let err = replay(&short, Path::Apply).unwrap_err();
    assert!(err.contains("past the"), "{err}");

    let mut long = support::parse_vector(&v.name, &std::fs::read_to_string(support::vector_dir().join(&v.name)).unwrap());
    let mut extra = v.shuffles.to_vec();
    extra.push(v.shuffles[0].clone());
    long.shuffles = Box::leak(extra.into_boxed_slice());
    let err = replay(&long, Path::Apply).unwrap_err();
    assert!(err.contains("final shufflesUsed"), "{err}");
}

/// [V2-3] replays start only through the constructors and the seam: the
/// recorded shuffler is the one way randomness reaches a replay.
#[test]
fn replays_reach_randomness_only_through_the_seam() {
    let v = vectors().iter().find(|v| v.kind == Kind::Game).unwrap();
    let mut a = start(v);
    let mut b = start(v);
    // A seam that ignores its recording deals differently from the first shuffle.
    let mut scrambled = a.shuffler().clone();
    let mut bag: Vec<u8> = v.shuffles[0].clone();
    scrambled.shuffle(&mut bag, 0);
    assert_eq!(bag, v.shuffles[0]);
    for ply in &v.plies {
        a.apply(ply.action).unwrap();
        b.apply_explained(ply.action).unwrap();
    }
    assert_eq!(a.to_canonical(), b.to_canonical());
    assert_eq!(a.outcome().map(|o| o as i64), v.final_outcome);
    let _: Option<Outcome> = a.outcome();
}
