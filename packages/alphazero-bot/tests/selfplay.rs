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
                }
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
