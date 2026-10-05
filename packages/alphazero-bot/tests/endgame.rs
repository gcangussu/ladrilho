//! The endgame proof ([Z11-76]) and its setting ([Z11-77]), against a
//! brute-force minimax of the rest of the round written here.

mod support;

use azul_alphazero::config::{RunConfig, SearchKind, settings};
use azul_alphazero::endgame::{Verdict, can_end_this_round, refine};
use azul_alphazero::memo::{Memo, choose_memoised};
use azul_alphazero::rng::Rng;
use azul_alphazero::search::{SearchConfig, SearchResult, choose};
use azul_engine::{Action, AzulState, Outcome, Player, Seeded};
use support::{Zero, config_json};

/// The value to `me` of `s`, a position some move has just produced, with
/// every line that continues past `round` scored `cont`: no pruning, no table.
fn brute(s: &AzulState, me: Player, round: u32, cont: i8) -> i8 {
    if s.is_terminal() {
        return match (s.outcome(), me) {
            (Some(Outcome::Player0), Player::P0) | (Some(Outcome::Player1), Player::P1) => 1,
            (Some(Outcome::Draw), _) | (None, _) => 0,
            _ => -1,
        };
    }
    if s.round_index() != round {
        return cont;
    }
    let legal = s.legal_actions();
    let values = legal.as_slice().iter().map(|&a| {
        let mut c = s.clone();
        c.apply(a).unwrap();
        brute(&c, me, round, cont)
    });
    if s.current_player() == me { values.max().unwrap() } else { values.min().unwrap() }
}

fn after(s: &AzulState, a: Action, cont: i8) -> i8 {
    let mut c = s.clone();
    c.apply(a).unwrap();
    brute(&c, s.current_player(), s.round_index(), cont)
}

/// What [Z11-76] says the move must be, from the brute force alone.
fn expected(s: &AzulState, r: &SearchResult) -> (Action, Verdict) {
    let chosen = r.action;
    let mut others: Vec<Action> = s.legal_actions().as_slice().iter().copied().filter(|&a| a != chosen).collect();
    others.sort_by_key(|&a| std::cmp::Reverse(r.visits[usize::from(a)]));
    if after(s, chosen, -2) >= 1 {
        return (chosen, Verdict::Confirmed);
    }
    if let Some(&a) = others.iter().find(|&&a| after(s, a, -2) >= 1) {
        return (a, Verdict::Won);
    }
    if after(s, chosen, 2) <= -1
        && let Some(&a) = others.iter().find(|&&a| after(s, a, -2) >= 0)
    {
        return (a, Verdict::Saved);
    }
    (chosen, Verdict::Kept)
}

/// Late positions where the game can end this round, small enough to brute-force:
/// games that mostly fill pattern lines, so walls fill and rows reach four.
fn late_positions(count: usize) -> Vec<AzulState> {
    let mut out = Vec::new();
    let mut rng = Rng::new(76);
    let mut seed = 0;
    while out.len() < count {
        seed += 1;
        let mut s = AzulState::seeded(seed);
        while !s.is_terminal() {
            if can_end_this_round(&s) && s.tiles_left() <= 7 && s.legal_actions().len() > 1 {
                out.push(s.clone());
                break;
            }
            let legal = s.legal_actions();
            let lines: Vec<Action> = legal.as_slice().iter().copied().filter(|a| a % 6 != 5).collect();
            let pool = if !lines.is_empty() && rng.below(10) < 8 { &lines[..] } else { legal.as_slice() };
            s.apply(pool[rng.below(pool.len() as u64) as usize]).unwrap();
        }
    }
    out
}

fn plain(simulations: u32) -> SearchConfig {
    SearchConfig { simulations, cpuct: 1.25, fpu: 0.25, endgame_nodes: 0 }
}

/// [Z11-76]: on every position, the move and the verdict are what the brute
/// force says the rule gives: a proven win replaces a move that is not one, a
/// move proven to draw or better replaces a proven loss, and nothing else
/// changes. On the zero network the search's move is the lowest legal action,
/// which is often not the winning one, so the replacements happen; the counts
/// say they did, or this would pass with the proof deleted. A saved draw is
/// rare: two positions in the 3000.
///
/// Seen to fail ([Z11-48]): never replacing with a proven win; a proven loss
/// replaced only by a proven win; the table storing every result as exact; the
/// proof searching on past the round's end.
#[test]
fn the_proof_replaces_exactly_the_moves_the_rule_names() {
    let mut seen = std::collections::HashMap::new();
    for s in late_positions(3000) {
        let r = choose(&Zero, &s, &plain(32)).unwrap();
        let (want, verdict) = expected(&s, &r);
        let (got, v) = refine(&s, r.clone(), 50_000_000);
        assert_eq!((got.action, v), (want, verdict));
        // Only the action can change: the visits and the value are the search's.
        assert_eq!((got.visits, got.value), (r.visits, r.value));
        *seen.entry(format!("{v:?}")).or_insert(0) += 1;
    }
    // Measured: 122 won, 2 saved, 1232 confirmed, 1644 kept.
    let count = |k: &str| seen.get(k).copied().unwrap_or(0);
    assert!(count("Won") >= 50 && count("Saved") >= 1 && count("Confirmed") >= 50 && count("Kept") >= 50, "{seen:?}");
}

/// [Z11-76]'s gate and cap: with no wall row at four tiles nothing is tried,
/// however many nodes it may use; and a cap too small to finish changes
/// nothing. Seen to fail ([Z11-48]) with the gate always open.
#[test]
fn the_proof_is_gated_and_capped() {
    let mut gated = 0;
    for s in support::game_positions(3).iter().chain(support::game_positions(4).iter()) {
        if s.is_terminal() || can_end_this_round(s) {
            continue;
        }
        let r = choose(&Zero, s, &plain(8)).unwrap();
        let (got, v) = refine(s, r.clone(), u32::MAX);
        assert_eq!((got, v), (r, Verdict::NotTried));
        gated += 1;
    }
    assert!(gated > 20);
    for s in late_positions(10) {
        let r = choose(&Zero, &s, &plain(8)).unwrap();
        let (got, v) = refine(&s, r.clone(), 1);
        assert_eq!(got, r);
        assert!(matches!(v, Verdict::OutOfNodes | Verdict::Confirmed | Verdict::Won | Verdict::Kept), "{v:?}");
        assert_eq!(refine(&s, r.clone(), 0), (r, Verdict::NotTried));
    }
}

/// [Z11-76], [Z11-21]: the proof reads nothing a deal decides. Positions that
/// differ only in the bag's order and the shuffler's seed get the same move.
#[test]
fn the_proof_reads_no_deal() {
    for s in late_positions(15) {
        let mut c = s.to_canonical();
        c.bag.reverse();
        let other = AzulState::from_canonical(&c, Seeded::new(99)).unwrap();
        let config = SearchConfig { endgame_nodes: 50_000_000, ..plain(32) };
        assert_eq!(choose(&Zero, &s, &config), choose(&Zero, &other, &config));
    }
}

/// [Z11-72] with the proof on: the memoised chooser still answers exactly as
/// `choose` does, and the proof is applied by both. Seen to fail ([Z11-48])
/// with `choose_memoised` leaving the proof out.
#[test]
fn the_memoised_chooser_applies_the_proof_too() {
    let config = SearchConfig { endgame_nodes: 50_000_000, ..plain(32) };
    let mut changed = 0;
    let mut memo = Memo::new();
    for s in late_positions(300) {
        let with = choose(&Zero, &s, &config).unwrap();
        assert_eq!(choose_memoised(&Zero, &s, &config, &mut memo).unwrap(), with);
        if with.action != choose(&Zero, &s, &plain(32)).unwrap().action {
            changed += 1;
        }
    }
    assert!(changed > 0);
}

/// [Z11-77]: `playEndgameNodes` reaches `play` and the latency lane, and
/// nothing else; absent, it is 0, and out of range it is refused. Seen to fail
/// ([Z11-48]) with the setting reaching `--search milestone`.
#[test]
fn the_endgame_setting_reaches_play_alone() {
    let cfg = RunConfig::parse(config_json(&[("playSimulations", "800"), ("playEndgameNodes", "123456")]).as_bytes()).unwrap();
    for (kind, want) in [
        (SearchKind::Play, 123_456),
        (SearchKind::Latency(None), 123_456),
        (SearchKind::Latency(Some(100)), 123_456),
        (SearchKind::Milestone, 0),
        (SearchKind::SelfPlay, 0),
    ] {
        assert_eq!(settings(&cfg, kind).unwrap().search.endgame_nodes, want, "{kind:?}");
    }
    let absent = RunConfig::parse(config_json(&[("playSimulations", "800")]).as_bytes()).unwrap();
    assert_eq!(settings(&absent, SearchKind::Play).unwrap().search.endgame_nodes, 0);
    assert!(RunConfig::parse(config_json(&[("playEndgameNodes", "2000000000")]).as_bytes()).is_err());
    assert!(RunConfig::parse(config_json(&[("playEndgameNodes", "-1")]).as_bytes()).is_err());
}
