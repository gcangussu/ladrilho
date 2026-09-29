//! The network and its files: the checkpoint format ([Z11-11]), parity
//! ([Z11-12], [Z11-13]), the forward pass ([Z11-6], [Z11-10]), and every
//! committed checkpoint ([Z11-44]).

mod support;

use azul_alphazero::network::{Evaluation, Evaluator, LoadError, Network};
use azul_alphazero::parity::{corpus, corpus_sha256, read_parity};
use azul_engine::AzulState;
use support::{crate_dir, fixture, fixture_paths, read};

fn fixture_bytes() -> (Vec<u8>, Vec<u8>) {
    let (c, p) = fixture_paths();
    (read(&c), read(&p))
}

fn put_u32(b: &mut [u8], at: usize, v: u32) {
    b[at..at + 4].copy_from_slice(&v.to_le_bytes());
}

fn field_of(e: LoadError) -> &'static str {
    match e {
        LoadError::Checkpoint { field, .. } => field,
        other => panic!("expected a checkpoint error, got {other}"),
    }
}

/// [Z11-11]: a checkpoint is refused, with the field named, for a wrong magic,
/// version, input size or policy size, or a length its header does not imply.
#[test]
fn a_malformed_checkpoint_is_refused_field_by_field() {
    let (good, parity) = fixture_bytes();
    type Mutation = Box<dyn Fn(&mut Vec<u8>)>;
    let cases: Vec<(&str, Mutation)> = vec![
        ("magic", Box::new(|b| b[0] = b'X')),
        ("version", Box::new(|b| put_u32(b, 4, 2))),
        ("input", Box::new(|b| put_u32(b, 8, 181))),
        ("width", Box::new(|b| put_u32(b, 12, 0))),
        ("width", Box::new(|b| put_u32(b, 12, 1_000_000))),
        ("blocks", Box::new(|b| put_u32(b, 16, 1_000_000))),
        ("policy", Box::new(|b| put_u32(b, 20, 179))),
        ("value hidden", Box::new(|b| put_u32(b, 24, 32))),
        ("length", Box::new(|b| b.truncate(b.len() - 4))),
        ("length", Box::new(|b| b.extend_from_slice(&[0; 4]))),
        ("length", Box::new(|b| put_u32(b, 12, 17))),
        ("length", Box::new(|b| b.truncate(10))),
    ];
    for (want, mutate) in cases {
        let mut bad = good.clone();
        mutate(&mut bad);
        let err = Network::load(&bad, &parity).expect_err(want);
        assert_eq!(field_of(err.clone()), want, "{err}");
        assert!(err.to_string().contains(want));
    }
    let net = Network::load(&good, &parity).unwrap();
    assert_eq!(net.architecture(), (16, 1));
    assert_eq!(net.generation(), 0);
}

/// [Z11-12] and [Z11-55]: the fixture's parity file names the compiled-in
/// corpus and holds one entry per corpus position; one naming another corpus
/// is refused as that, not as a mismatch.
#[test]
fn a_parity_file_names_its_corpus() {
    let (checkpoint, parity) = fixture_bytes();
    assert_eq!(&parity[0..4], b"AZPF");
    assert_eq!(u32::from_le_bytes(parity[4..8].try_into().unwrap()), 1);
    assert_eq!(parity[8..40], corpus_sha256());
    assert_eq!(read_parity(&parity).unwrap().len(), corpus().len());
    assert_eq!(parity.len(), 44 + 64 * 181 * 4);

    let mut other = parity.clone();
    other[8] ^= 1;
    match Network::load(&checkpoint, &other) {
        Err(LoadError::ParityCorpus { .. }) => {}
        other => panic!("expected the corpus error, got {other:?}"),
    }
    let mut short = parity.clone();
    short.truncate(parity.len() - 1);
    assert!(matches!(Network::load(&checkpoint, &short), Err(LoadError::ParityFile { field: "length", .. })));
}

/// [Z11-13]: a checkpoint whose forward pass differs from its parity file is
/// refused, with the entry and output named — a changed weight, and a changed
/// expected value, each past the relative bound; a change inside it loads.
#[test]
fn a_forward_pass_that_disagrees_with_pytorch_is_refused() {
    let (checkpoint, parity) = fixture_bytes();
    let mut weights = checkpoint.clone();
    let at = weights.len() - 4; // v2b, the value's bias
    let v = f32::from_le_bytes(weights[at..at + 4].try_into().unwrap()) + 0.5;
    weights[at..at + 4].copy_from_slice(&v.to_le_bytes());
    let err = Network::load(&weights, &parity).unwrap_err();
    assert!(matches!(err, LoadError::ParityMismatch { .. }), "{err}");

    let logit = |p: &[u8], e: usize, a: usize| {
        let at = 44 + (e * 181 + a) * 4;
        f32::from_le_bytes(p[at..at + 4].try_into().unwrap())
    };
    let set = |p: &mut Vec<u8>, e: usize, a: usize, v: f32| {
        let at = 44 + (e * 181 + a) * 4;
        p[at..at + 4].copy_from_slice(&v.to_le_bytes());
    };
    let r = logit(&parity, 5, 17);
    let mut off = parity.clone();
    set(&mut off, 5, 17, r + 3e-4 * (1.0 + r.abs()));
    match Network::load(&checkpoint, &off) {
        Err(LoadError::ParityMismatch { entry: 5, output, .. }) => assert_eq!(output, "logit 17"),
        other => panic!("expected a mismatch at entry 5, got {other:?}"),
    }
    let mut within = parity.clone();
    set(&mut within, 5, 17, r + 0.5e-4 * (1.0 + r.abs()));
    Network::load(&checkpoint, &within).expect("inside the relative bound");
}

/// [Z11-44]: the fixture and every checkpoint under `milestones/` load, which
/// runs [Z11-13]'s parity check on each.
///
/// Mutation, seen red ([Z11-48]): in `Network::forward`, the first block's
/// `B1` read transposed — `linear` handed `w[b1w + (k % n) * n + k / n]` for
/// element `k` — makes the fixture fail its parity check here.
#[test]
fn every_committed_checkpoint_loads() {
    fixture();
    let mut found = Vec::new();
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else if p.extension().is_some_and(|x| x == "bin") {
                out.push(p);
            }
        }
    }
    walk(&crate_dir().join("milestones"), &mut found);
    for c in found {
        let parity = c.with_extension("parity");
        Network::load(&read(&c), &read(&parity)).unwrap_or_else(|e| panic!("{}: {e}", c.display()));
    }
}

/// [Z11-6]: the policy is a softmax over the legal set and zero elsewhere, the
/// value is in `[-1, 1]`; and [Z11-10]: the forward pass is deterministic, bit
/// for bit, however often it runs.
#[test]
fn the_forward_pass_is_a_masked_softmax_and_deterministic() {
    let net = fixture();
    let positions = support::game_positions(3);
    for s in positions.iter().step_by(7) {
        let legal = s.legal_actions();
        let mut a = Evaluation::default();
        let mut b = Evaluation::default();
        net.evaluate(&s.encode(), legal.as_slice(), &mut a);
        net.evaluate(&s.encode(), legal.as_slice(), &mut b);
        assert_eq!(a.value.to_bits(), b.value.to_bits());
        assert!(a.policy.iter().zip(&b.policy).all(|(x, y)| x.to_bits() == y.to_bits()));
        assert!((-1.0..=1.0).contains(&a.value));
        let sum: f32 = a.policy.iter().sum();
        assert!((sum - 1.0).abs() < 1e-5);
        for i in 0..180u8 {
            if !legal.as_slice().contains(&i) {
                assert_eq!(a.policy[usize::from(i)], 0.0);
            } else {
                assert!(a.policy[usize::from(i)] > 0.0);
            }
        }
    }
    // The value is not constant: the fixture is a network that sees its input.
    let v: Vec<f32> = positions.iter().map(|s| {
        let mut e = Evaluation::default();
        net.evaluate(&s.encode(), s.legal_actions().as_slice(), &mut e);
        e.value
    }).collect();
    assert!(v.iter().any(|x| (x - v[0]).abs() > 1e-4));
    let _ = AzulState::seeded(0);
}
