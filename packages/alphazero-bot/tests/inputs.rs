//! [Z11-22]: no public function panics on any input. Every reader of
//! untrusted bytes — the word framing, the canonical block, the config, a
//! checkpoint with its parity file, a sample file — is fed arbitrary input
//! and near-miss mutations of valid input, and must answer `Ok` or `Err`.
//!
//! A panic fails the property, so each case is a crash test; the valid seeds
//! make sure the inputs reach past the first length check.
//!
//! Seen red: in `wire::read_messages`, slicing `&bytes[at..at + 4 * n]` for the
//! checked `bytes.get(..)` panics on a short body, and
//! `framing_with_small_lengths_never_panics` finds it.

mod support;

use azul_alphazero::config::RunConfig;
use azul_alphazero::network::Network;
use azul_alphazero::samples::{RECORD_BYTES, read_all};
use azul_alphazero::wire::{frame, read_canonical, read_messages, write_canonical};
use azul_engine::{AzulState, Seeded};
use proptest::prelude::*;
use support::{config_json, fixture_paths, read};

/// A valid input with a few bytes overwritten, and possibly cut short.
fn mutated(valid: Vec<u8>) -> impl Strategy<Value = Vec<u8>> {
    let len = valid.len();
    (proptest::collection::vec((0..len, any::<u8>()), 1..8), 0..=len).prop_map(move |(edits, keep)| {
        let mut b = valid.clone();
        for (at, v) in edits {
            b[at] = v;
        }
        b.truncate(keep.max(1));
        b
    })
}

fn position_words() -> Vec<u32> {
    let mut s = AzulState::seeded(3);
    for _ in 0..9 {
        let a = s.legal_actions().as_slice()[0];
        s.apply(a).unwrap();
    }
    write_canonical(&s.to_canonical())
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn framing_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..600)) {
        let _ = read_messages(&bytes);
    }

    /// Plausible length prefixes over bodies too short, too long or just
    /// right: random bytes almost never make a small length, so the first
    /// property alone never reaches the body.
    #[test]
    fn framing_with_small_lengths_never_panics(
        messages in proptest::collection::vec((0u32..300, proptest::collection::vec(any::<u8>(), 0..1300)), 1..4),
    ) {
        let mut bytes = Vec::new();
        for (n, body) in messages {
            bytes.extend_from_slice(&n.to_le_bytes());
            bytes.extend_from_slice(&body);
        }
        let _ = read_messages(&bytes);
    }

    #[test]
    fn a_canonical_block_never_panics(words in proptest::collection::vec(any::<u32>(), 0..300)) {
        if let Ok(c) = read_canonical(&words) {
            let _ = AzulState::from_canonical(&c, Seeded::new(0));
        }
    }

    #[test]
    fn a_near_miss_block_never_panics(edits in proptest::collection::vec((0usize..400, any::<u32>()), 1..6)) {
        let mut words = position_words();
        let n = words.len();
        for (at, v) in edits {
            // Small values mostly, so a block often still parses and reaches the engine.
            words[at % n] = if v % 3 == 0 { v } else { v % 8 };
        }
        let _ = read_messages(&frame(&words));
        if let Ok(c) = read_canonical(&words) {
            let _ = AzulState::from_canonical(&c, Seeded::new(0));
        }
    }

    #[test]
    fn a_config_never_panics(bytes in mutated(config_json(&[]).into_bytes())) {
        let _ = RunConfig::parse(&bytes);
    }

    #[test]
    fn arbitrary_text_as_a_config_never_panics(text in "\\PC{0,200}") {
        let _ = RunConfig::parse(text.as_bytes());
    }

    #[test]
    fn a_checkpoint_never_panics(bytes in mutated(read(&fixture_paths().0))) {
        let parity = read(&fixture_paths().1);
        let _ = Network::load(&bytes, &parity);
    }

    #[test]
    fn a_parity_file_never_panics(bytes in mutated(read(&fixture_paths().1))) {
        let checkpoint = read(&fixture_paths().0);
        let _ = Network::load(&checkpoint, &bytes);
    }

    #[test]
    fn a_sample_file_never_panics(bytes in proptest::collection::vec(any::<u8>(), 0..3 * RECORD_BYTES)) {
        let _ = read_all(&bytes);
    }
}
