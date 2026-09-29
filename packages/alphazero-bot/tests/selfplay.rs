//! Self-play and its samples ([Z11-26], [Z11-27]), through the binary.

mod support;

use azul_alphazero::samples::{Kind, RECORD_BYTES, Sample, mask_has, read_all};
use azul_engine::{OFF_FACTORIES, OFF_ROUND, OFF_TILES_LEFT};
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
