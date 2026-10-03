//! Self-play and its samples ([Z11-26], [Z11-27]), through the binary.

mod support;

use azul_alphazero::samples::{
    AUX_BYTES, Aux, Kind, RECORD_BYTES, Sample, aux_path, mask_has, read_all, read_all_aux,
};
use azul_alphazero::selfplay::final_aux;
use azul_engine::{AzulState, OFF_FACTORIES, OFF_MY_WALL, OFF_OP_WALL, OFF_ROUND, OFF_TILES_LEFT, Player, Seeded};
use support::{config_json, crate_dir, fixture_paths, run, scratch};

/// [Z11-27]: a sample written is read back field for field, at the record size
/// the table implies. The same three records are left where the trainer's
/// suite reads them ([Z11-46]), with values it can recompute.
#[test]
fn a_sample_round_trips() {
    assert_eq!(RECORD_BYTES, 1 + 1 + 182 * 4 + 23 + 180 * 2);
    let mut bytes = Vec::new();
    let mut written = Vec::new();
    for i in 0..3usize {
        let boundary = i == 1;
        let s = Sample {
            kind: if boundary { Kind::Boundary } else { Kind::Move },
            result: [1, 0, -1][i],
            observation: std::array::from_fn(|j| (i * 1000 + j) as f32 / 7.0),
            legal: if boundary { [0; 23] } else { std::array::from_fn(|b| ((i * 23 + b) * 11 % 256) as u8) },
            visits: if boundary { [0; 180] } else { std::array::from_fn(|a| ((i * 180 + a) * 3 % 65536) as u16) },
        };
        s.write(&mut bytes);
        written.push(s);
    }
    assert_eq!(bytes.len(), 3 * RECORD_BYTES);
    assert_eq!(bytes[0], 0);
    assert_eq!(bytes[RECORD_BYTES], 1);
    assert_eq!(bytes[2 * RECORD_BYTES + 1], 0xff, "-1 as i8");
    assert_eq!(read_all(&bytes).unwrap(), written);
    assert!(read_all(&bytes[1..]).is_err());
    let dir = crate_dir().join("target/test-scratch/python-samples");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("samples.bin"), &bytes).unwrap();
    // [Z11-75]: kind 2 is a cheap sample; nothing past it is a kind.
    let mut record = bytes[RECORD_BYTES..2 * RECORD_BYTES].to_vec();
    record[0] = 2;
    assert_eq!(Sample::read(&record).unwrap().kind, Kind::Cheap);
    record[0] = 3;
    assert!(Sample::read(&record).is_err());
}

fn selfplay(dir: &std::path::Path, generation: u32, games: u32) -> Vec<Sample> {
    let (checkpoint, _) = fixture_paths();
    let cfg = dir.join("config.json");
    std::fs::write(&cfg, config_json(&[("selfPlaySimulations", "8"), ("threads", "4")])).unwrap();
    let out = dir.join(format!("{generation}.bin"));
    let o = run(
        &[
            "selfplay", checkpoint.to_str().unwrap(), "--config", cfg.to_str().unwrap(),
            "--generation", &generation.to_string(), "--games", &games.to_string(), "--out", out.to_str().unwrap(),
        ],
        &[],
    );
    assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
    read_all(&std::fs::read(&out).unwrap()).unwrap()
}

/// [Z11-26]: two generations of 16 games with the same config deal 32
/// pairwise distinct openings — the generation is in the seed. Every game
/// emits its move samples and its boundary samples, and [Z11-27]'s invariants
/// hold of each: visits sum to the simulation count and stay inside the legal
/// mask, and a boundary sample carries neither.
///
/// Mutations, seen red ([Z11-48]): leaving the generation out of `game_seed`,
/// or combining the triple as `seed + generation + index`, repeats openings
/// across the two generations; not emitting boundary samples in `play_game`
/// fails the boundary count.
#[test]
fn self_play_deals_every_game_its_own_opening() {
    let dir = scratch();
    let mut openings = Vec::new();
    for g in 0..2 {
        let samples = selfplay(dir.path(), g, 16);
        let mut boundaries = 0;
        for s in &samples {
            assert!((-1..=1).contains(&s.result));
            match s.kind {
                Kind::Move => {
                    let total: u32 = s.visits.iter().map(|&v| u32::from(v)).sum();
                    assert_eq!(total, 8);
                    for a in 0..180 {
                        assert!(s.visits[a] == 0 || mask_has(&s.legal, a));
                    }
                    if s.observation[OFF_TILES_LEFT] == 1.0 && s.observation[OFF_ROUND] == 0.0 {
                        openings.push(s.observation[OFF_FACTORIES..OFF_FACTORIES + 25].to_vec());
                    }
                }
                Kind::Boundary => {
                    boundaries += 1;
                    assert!(s.legal == [0; 23] && s.visits == [0; 180]);
                    assert_eq!(s.observation[OFF_TILES_LEFT], 0.0);
                }                Kind::Cheap => panic!("a cheap sample without the playout cap ([Z11-75])"),
            }
        }
        // Every game has at least four non-terminal boundaries: a row takes
        // five rounds to finish.
        assert!(boundaries >= 16 * 4, "{boundaries} boundary samples in 16 games");
    }
    assert_eq!(openings.len(), 32);
    for i in 0..32 {
        for j in 0..i {
            assert_ne!(openings[i], openings[j], "games {j} and {i} dealt the same opening");
        }
    }
}

/// [Z11-67]: an aux record written is read back, at ten bytes; a wall mask
/// with a bit past cell 24 is refused, and so is a partial record.
#[test]
fn an_aux_record_round_trips() {
    assert_eq!(AUX_BYTES, 10);
    let written = [
        Aux { margin: 17, walls: [0b1_1111, 1 << 24] },
        Aux { margin: -3, walls: [0, 0x1ff_ffff] },
        Aux { margin: i16::MIN, walls: [12345, 54321] },
    ];
    let mut bytes = Vec::new();
    for a in &written {
        a.write(&mut bytes);
    }
    assert_eq!(read_all_aux(&bytes).unwrap(), written);
    assert!(read_all_aux(&bytes[1..]).is_err());
    let mut bad = Vec::new();
    Aux { margin: 0, walls: [1 << 25, 0] }.write(&mut bad);
    assert!(read_all_aux(&bad).is_err());
    assert_eq!(aux_path(std::path::Path::new("runs/x/samples/16.bin")), std::path::Path::new("runs/x/samples/16.aux.bin"));
}

/// A finished game of uniformly random legal moves, from its seed.
fn random_game(seed: u64) -> AzulState<Seeded> {
    let mut s = AzulState::new_game(Seeded::new(seed));
    let mut x = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    while !s.is_terminal() {
        let legal = s.legal_actions();
        x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        s.apply(legal.as_slice()[(x >> 33) as usize % legal.len()]).unwrap();
    }
    s
}

/// [Z11-67]: `final_aux` is the seat's final score minus the other's, and the
/// two final walls with the seat's first, cell `i` at bit `i` — against a
/// reference written out here, on finished games, from both seats.
///
/// Mutations, seen red ([Z11-48]): the margin taken the other way round, the
/// walls not swapped for seat 1, and a wall's cells numbered from the end.
#[test]
fn final_aux_is_the_game_end_from_the_seat() {
    for seed in 1..=12 {
        let s = random_game(seed);
        let c = s.to_canonical();
        let mask = |w: &[u8; 25]| (0..25).filter(|&i| w[i] == 1).map(|i| 1u32 << i).sum::<u32>();
        let [m0, m1] = [mask(&c.walls[0]), mask(&c.walls[1])];
        // A finished game has a full row on some wall.
        assert!(m0.count_ones() >= 5 || m1.count_ones() >= 5, "seed {seed}: a finished game with no full row");
        let margin = s.scores()[0] - s.scores()[1];
        assert_eq!(final_aux(&s, Player::P0), Aux { margin: margin as i16, walls: [m0, m1] }, "seed {seed}");
        assert_eq!(final_aux(&s, Player::P1), Aux { margin: -margin as i16, walls: [m1, m0] }, "seed {seed}");
    }
}

/// [Z11-67]: `selfplay` writes the aux file beside the sample file, one record
/// per sample in the same order, each the game's end from that sample's seat:
/// the walls in its observation are a subset of the final walls on the same
/// side, and the margin never disagrees with the result's sign. The sample
/// file itself is what it was before the aux file existed: the existing
/// cases above read it.
///
/// Mutation, seen red ([Z11-48]): the aux file's walls taken from the seat
/// that ended the game instead of each sample's seat.
#[test]
fn the_aux_file_is_the_games_end_from_each_samples_seat() {
    let dir = scratch();
    let samples = selfplay(dir.path(), 3, 8);
    let aux = read_all_aux(&std::fs::read(aux_path(&dir.path().join("3.bin"))).unwrap()).unwrap();
    assert_eq!(aux.len(), samples.len());
    let wall = |obs: &[f32], off: usize| (0..25).filter(|&i| obs[off + i] == 1.0).map(|i| 1u32 << i).sum::<u32>();
    for (s, a) in samples.iter().zip(&aux) {
        assert_eq!(wall(&s.observation, OFF_MY_WALL) & !a.walls[0], 0, "the seat's wall lost a tile");
        assert_eq!(wall(&s.observation, OFF_OP_WALL) & !a.walls[1], 0, "the other wall lost a tile");
        match s.result {
            1 => assert!(a.margin >= 0, "a win with margin {}", a.margin),
            -1 => assert!(a.margin <= 0, "a loss with margin {}", a.margin),
            _ => assert_eq!(a.margin, 0, "a draw with margin {}", a.margin),
        }
    }
}

/// [Z11-69]: a self-played game's move samples are visit for visit what plain
/// searches of the same positions give, with the same noise drawn in the same
/// order, and the memo kept a share of those searches' calls from the network.
/// The temperature is off, so the move played is the most visited and the
/// reference needs no sampler of its own.
///
/// Mutations, seen red ([Z11-48]): keying the memo on the first 100
/// observation floats alone hands back another position's evaluation and
/// changes the visits; a memo that never answers makes as many calls as the
/// reference.
#[test]
fn memoised_self_play_changes_no_visit() {
    use azul_alphazero::config::{RunConfig, SearchKind, settings};
    use azul_alphazero::rng::{Rng, game_seed, noise_seed};
    use azul_alphazero::search::search;
    use azul_alphazero::selfplay::play_game;
    use azul_engine::{AzulState, Seeded};
    use support::{Counting, fixture};

    let cfg = RunConfig::parse(config_json(&[("selfPlaySimulations", "200"), ("tempPlies", "0")]).as_bytes()).unwrap();
    let s = settings(&cfg, SearchKind::SelfPlay).unwrap();
    let (generation, index) = (3, 5);

    let memoised = Counting::new(fixture());
    let samples = play_game(&memoised, &s, cfg.seed, generation, index);
    let moves: Vec<Sample> = samples.into_iter().map(|(x, _)| x).filter(|x| x.kind == Kind::Move).collect();

    let plain = Counting::new(fixture());
    let mut state = AzulState::new_game(Seeded::new(game_seed(cfg.seed, generation, index)));
    let mut rng = Rng::new(noise_seed(cfg.seed, generation, index));
    let mut ply = 0;
    while !state.is_terminal() {
        let noise = s.noise.as_ref().map(|n| (n, &mut rng));
        let (r, _) = search(&plain, &state, &s.search, noise).unwrap();
        let visits: Vec<u16> = r.visits.iter().map(|&n| n as u16).collect();
        assert_eq!(moves[ply].observation, state.encode(), "ply {ply}: a different position");
        assert_eq!(moves[ply].visits.to_vec(), visits, "ply {ply}: the memo changed the visits");
        let mut best = 0;
        for a in 0..180 {
            if r.visits[a] > r.visits[best] {
                best = a;
            }
        }
        state.apply(best as u8).unwrap();
        ply += 1;
    }
    assert_eq!(moves.len(), ply);
    // The fixture's random weights spread the visits, so less of a tree
    // survives the move: about 80% of the calls remain here, where run
    // `fourth`'s checkpoint keeps 41%.
    assert!(
        u64::from(memoised.calls()) * 10 < u64::from(plain.calls()) * 9,
        "the memo saved too little: {} calls against {}",
        memoised.calls(),
        plain.calls()
    );
}

/// [Z11-70]: `self_play`, four games to a thread and their leaves valued in
/// batches, writes exactly the bytes of the same games played one at a time
/// and unbatched, in game order. Eleven games on two threads, so batches run
/// short as games end and at the generation's tail; the memo's answers and
/// the network's mix within every batch.
///
/// Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
/// in `play_games`, each game supplied the evaluation of the next game's
/// request (`evals.iter().cycle().skip(1)`); and in `self_play`, each game's
/// bytes stored in the next game's slot (`d[(i as usize + 1) % games]`).
#[test]
fn batched_self_play_is_each_game_alone() {
    use azul_alphazero::config::{RunConfig, SearchKind, settings};
    use azul_alphazero::selfplay::{play_game, self_play};
    use support::fixture;

    let cfg = RunConfig::parse(config_json(&[("selfPlaySimulations", "48"), ("threads", "2")]).as_bytes()).unwrap();
    let s = settings(&cfg, SearchKind::SelfPlay).unwrap();
    let net = fixture();
    let games = 11;
    let (batched, batched_aux) = self_play(&net, &s, cfg.seed, 4, games);
    let (mut alone, mut alone_aux) = (Vec::new(), Vec::new());
    for i in 0..games as u64 {
        for (sample, aux) in play_game(&net, &s, cfg.seed, 4, i) {
            sample.write(&mut alone);
            aux.write(&mut alone_aux);
        }
    }
    assert_eq!(batched.len(), alone.len(), "a different number of samples");
    assert!(batched == alone, "batched self-play wrote different samples");
    // [Z11-67]: and the aux file, record for record.
    assert!(batched_aux == alone_aux, "batched self-play wrote different aux records");
}

/// [Z11-75]: under the playout cap, a game's samples are what a reference
/// replay gives that makes the cap's draws from a generator of its own: a full
/// search with the noise, written as a move sample with its visits, below
/// `fullSearchFraction`; a cheap search with `cheapSimulations` and no noise
/// otherwise, written as a cheap sample with neither mask nor visits. The
/// temperature is off, so the move played is the most visited either way.
///
/// Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
/// the cheap search run with the full count; the cheap search given the
/// noise; the cap's draw taken from the noise's generator; a cheap search's
/// sample written as a move sample.
#[test]
fn the_playout_cap_searches_a_share_of_moves_fully() {
    use azul_alphazero::config::{RunConfig, SearchKind, settings};
    use azul_alphazero::rng::{Rng, cap_seed, game_seed, noise_seed};
    use azul_alphazero::search::{SearchConfig, search};
    use azul_alphazero::selfplay::play_game;
    use azul_engine::{AzulState, Seeded};
    use support::fixture;

    let cfg = RunConfig::parse(
        config_json(&[
            ("selfPlaySimulations", "64"),
            ("cheapSimulations", "8"),
            ("fullSearchFraction", "0.25"),
            ("tempPlies", "0"),
        ])
        .as_bytes(),
    )
    .unwrap();
    let s = settings(&cfg, SearchKind::SelfPlay).unwrap();
    let net = fixture();
    let (mut full, mut cheap) = (0, 0);
    for index in 0..3 {
        let generation = 2;
        let records = play_game(&net, &s, cfg.seed, generation, index);
        let plies: Vec<Sample> = records.into_iter().map(|(x, _)| x).filter(|x| x.kind != Kind::Boundary).collect();
        let mut state = AzulState::new_game(Seeded::new(game_seed(cfg.seed, generation, index)));
        let mut noise_rng = Rng::new(noise_seed(cfg.seed, generation, index));
        let mut cap_rng = Rng::new(cap_seed(cfg.seed, generation, index));
        let cheap_config = SearchConfig { simulations: 8, ..s.search.clone() };
        let mut ply = 0;
        while !state.is_terminal() {
            let is_full = cap_rng.uniform() < 0.25;
            let (r, _) = if is_full {
                search(&net, &state, &s.search, s.noise.as_ref().map(|n| (n, &mut noise_rng))).unwrap()
            } else {
                search(&net, &state, &cheap_config, None).unwrap()
            };
            let sample = &plies[ply];
            assert_eq!(sample.observation, state.encode(), "game {index} ply {ply}: a different position");
            if is_full {
                full += 1;
                assert_eq!(sample.kind, Kind::Move, "game {index} ply {ply}: a full search's sample");
                let visits: Vec<u16> = r.visits.iter().map(|&n| n as u16).collect();
                assert_eq!(sample.visits.to_vec(), visits, "game {index} ply {ply}: different visits");
                assert_eq!(visits.iter().map(|&v| u32::from(v)).sum::<u32>(), 64);
            } else {
                cheap += 1;
                assert_eq!(sample.kind, Kind::Cheap, "game {index} ply {ply}: a cheap search's sample");
                assert!(sample.legal == [0; 23] && sample.visits == [0; 180]);
            }
            let mut best = 0;
            for a in 0..180 {
                if r.visits[a] > r.visits[best] {
                    best = a;
                }
            }
            state.apply(best as u8).unwrap();
            ply += 1;
        }
        assert_eq!(plies.len(), ply, "game {index}: a different number of plies");
    }
    // About a quarter of the plies searched fully, and both kinds present.
    assert!(full > 0 && cheap > full, "{full} full and {cheap} cheap searches");
}

/// [Z11-75]: with `fullSearchFraction` 1 every move is searched fully, and
/// the cap's draws touch nothing else: the samples and aux records are byte
/// for byte those of the same config without the cap.
///
/// Mutation, seen red ([Z11-48]): the cap's draw taken from the noise's
/// generator.
#[test]
fn a_cap_that_always_searches_fully_changes_nothing() {
    use azul_alphazero::config::{RunConfig, SearchKind, settings};
    use azul_alphazero::selfplay::self_play;
    use support::fixture;

    let base = [("selfPlaySimulations", "24"), ("threads", "2")];
    let plain = RunConfig::parse(config_json(&base).as_bytes()).unwrap();
    let mut capped = base.to_vec();
    capped.extend([("cheapSimulations", "4"), ("fullSearchFraction", "1")]);
    let capped = RunConfig::parse(config_json(&capped).as_bytes()).unwrap();
    assert!(capped.playout_cap.is_some());
    let net = fixture();
    let a = self_play(&net, &settings(&plain, SearchKind::SelfPlay).unwrap(), plain.seed, 1, 6);
    let b = self_play(&net, &settings(&capped, SearchKind::SelfPlay).unwrap(), capped.seed, 1, 6);
    assert!(a == b, "a cap at 1 changed what self-play wrote");
}

/// [Z11-75]: the two settings go together, inside their ranges, and only
/// self-play reads them.
#[test]
fn the_playout_cap_settings_are_checked() {
    use azul_alphazero::config::{PlayoutCap, RunConfig, SearchKind, settings};

    let parse = |extra: &[(&str, &str)]| {
        let mut f = vec![("selfPlaySimulations", "100")];
        f.extend_from_slice(extra);
        RunConfig::parse(config_json(&f).as_bytes())
    };
    assert_eq!(parse(&[]).unwrap().playout_cap, None);
    let ok = parse(&[("cheapSimulations", "25"), ("fullSearchFraction", "0.25")]).unwrap();
    assert_eq!(ok.playout_cap, Some(PlayoutCap { cheap_simulations: 25, full_search_fraction: 0.25 }));
    assert_eq!(settings(&ok, SearchKind::SelfPlay).unwrap().playout_cap, ok.playout_cap);
    assert_eq!(settings(&ok, SearchKind::Milestone).unwrap().playout_cap, None);
    assert_eq!(settings(&ok, SearchKind::Play).unwrap().playout_cap, None);
    for bad in [
        vec![("cheapSimulations", "25")],
        vec![("fullSearchFraction", "0.25")],
        vec![("cheapSimulations", "0"), ("fullSearchFraction", "0.25")],
        vec![("cheapSimulations", "101"), ("fullSearchFraction", "0.25")],
        vec![("cheapSimulations", "25"), ("fullSearchFraction", "0")],
        vec![("cheapSimulations", "25"), ("fullSearchFraction", "1.5")],
    ] {
        assert!(parse(&bad).is_err(), "{bad:?} was accepted");
    }
    assert!(parse(&[("cheapSimulations", "100"), ("fullSearchFraction", "1")]).is_ok());
}
