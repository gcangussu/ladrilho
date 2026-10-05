//! The network and its files: the checkpoint format ([Z11-11]), parity
//! ([Z11-12], [Z11-13]), the forward pass ([Z11-6], [Z11-10]), and every
//! committed checkpoint ([Z11-44]).

mod support;

use azul_alphazero::network::{BATCH, Evaluation, Evaluator, LoadError, Network, Request, masked_softmax};
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

/// The forward pass of [Z11-6] computed the plain way, one scalar at a time,
/// in [Z11-10]'s order: lane `l` sums `w[16j + l] · x[16j + l]` over the whole
/// chunks in ascending `j`; the elements past them are summed from zero in
/// ascending order; the lanes fold in halves, `acc[i] += acc[i + n]` for
/// `n = 8, 4, 2, 1`; the tail is added last, then the bias. Weights are read
/// straight from the checkpoint's bytes in [Z11-11]'s order.
fn reference_forward(checkpoint: &[u8], x: &[f32]) -> (Vec<f32>, f32) {
    let word = |at: usize| u32::from_le_bytes(checkpoint[at..at + 4].try_into().unwrap()) as usize;
    let (input, width, blocks, policy, hidden) = (word(8), word(12), word(16), word(20), word(24));
    let w: Vec<f32> = checkpoint[32..].as_chunks::<4>().0.iter().map(|b| f32::from_le_bytes(*b)).collect();
    let mut at = 0;
    let mut take = |n: usize| {
        let s = &w[at..at + n];
        at += n;
        s
    };
    fn dot(row: &[f32], x: &[f32]) -> f32 {
        let chunks = x.len() / 16;
        let mut acc = [0f32; 16];
        for j in 0..chunks {
            for l in 0..16 {
                acc[l] += row[16 * j + l] * x[16 * j + l];
            }
        }
        let mut tail = 0f32;
        for k in 16 * chunks..x.len() {
            tail += row[k] * x[k];
        }
        for n in [8, 4, 2, 1] {
            for i in 0..n {
                acc[i] += acc[i + n];
            }
        }
        acc[0] + tail
    }
    fn linear(m: &[f32], b: &[f32], x: &[f32]) -> Vec<f32> {
        (0..b.len()).map(|o| dot(&m[o * x.len()..(o + 1) * x.len()], x) + b[o]).collect()
    }
    let relu = |v: Vec<f32>| -> Vec<f32> { v.into_iter().map(|a| a.max(0.0)).collect() };
    let (s, sb) = (take(width * input), take(width));
    let mut h = relu(linear(s, sb, x));
    for _ in 0..blocks {
        let (b1, b1b, b2, b2b) = (take(width * width), take(width), take(width * width), take(width));
        let t = relu(linear(b1, b1b, &h));
        let u = linear(b2, b2b, &t);
        h = h.iter().zip(&u).map(|(a, b)| (a + b).max(0.0)).collect();
    }
    let (p, pb) = (take(policy * width), take(policy));
    let logits = linear(p, pb, &h);
    let (v1, v1b, v2, v2b) = (take(hidden * width), take(hidden), take(hidden), take(1));
    let v = relu(linear(v1, v1b, &h));
    (logits, (dot(v2, &v) + v2b[0]).tanh())
}

/// A checkpoint of width `width` with small pseudo-random weights, and the
/// parity file its reference forward pass implies.
fn synthetic(width: u32, blocks: u32, seed: u64) -> (Vec<u8>, Vec<u8>) {
    let (w, b) = (width as usize, blocks as usize);
    let count = w * 182 + w + b * 2 * (w * w + w) + 180 * w + 180 + 64 * w + 64 + 64 + 1;
    let mut checkpoint = b"AZ11".to_vec();
    for v in [1, 182, width, blocks, 180, 64, 0] {
        checkpoint.extend_from_slice(&v.to_le_bytes());
    }
    let mut state = seed;
    for _ in 0..count {
        state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        let u = (state >> 40) as f32 / (1u64 << 24) as f32;
        checkpoint.extend_from_slice(&((u - 0.5) * 0.6).to_le_bytes());
    }
    let mut parity = b"AZPF".to_vec();
    parity.extend_from_slice(&1u32.to_le_bytes());
    parity.extend_from_slice(&corpus_sha256());
    parity.extend_from_slice(&(corpus().len() as u32).to_le_bytes());
    for e in corpus() {
        let (logits, value) = reference_forward(&checkpoint, &e.observation);
        for v in logits.iter().chain([&value]) {
            parity.extend_from_slice(&v.to_le_bytes());
        }
    }
    (checkpoint, parity)
}

/// [Z11-10]: the forward pass is the reference order, bit for bit — every logit
/// and the value — on the parity corpus and on positions of a game, for the
/// fixture, for each run's latest committed milestone (width 256, the corpus only), and
/// for synthetic networks of odd width, whose last row goes without a partner
/// and whose hidden inputs end in a tail past the last whole chunk.
///
/// [Z11-70]: `forward_batch` is the same reference order, bit for bit, on
/// every input of each group of four.
///
/// Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
/// in `network.rs`, `finish` summing the lanes in sequence
/// (`for i in 1..LANES { acc[0] += acc[i] }`) instead of folding them in
/// halves; `lanes2` accumulating the second row against the first row's
/// weights (`a1[l] += p[l] * b[l]`); and `linear` leaving the unpaired last
/// row of an odd width uncomputed (its `if let [y] = last` arm removed). The
/// first fails the bit comparison — the fixture's logit 1 one unit in the last
/// place off, which [Z11-13]'s parity check tolerates — and the other two fail
/// the parity check this test's own loads run: the second on the fixture,
/// the third on the synthetic width 17, which no committed network exercises.
///
/// The column form the single pass reads the stem and blocks by, likewise:
/// `column_finish` summing the lanes in sequence, and `NonZero::of` listing a
/// lane's inputs in descending order (`.step_by(LANES).rev()`), each fail the
/// bit comparison on the fixture's logit 4, one unit in the last place off;
/// `column_lanes` dropping the tail (`(lanes, [0f32; B])`), and the rows past
/// the last whole block all reading the first one's column
/// (`wt[whole * n..(whole + 1) * n]`), each fail the parity check of the
/// synthetic widths' loads.
#[test]
fn the_forward_pass_is_the_reference_order_bit_for_bit() {
    let positions: Vec<[f32; 182]> = support::game_positions(5).iter().map(|s| s.encode()).collect();
    let corpus_inputs: Vec<[f32; 182]> = corpus().iter().map(|e| e.observation).collect();
    let check = |name: &str, checkpoint: &[u8], net: &Network, inputs: &[[f32; 182]]| {
        let mut logits = [0f32; 180];
        for (i, x) in inputs.iter().enumerate() {
            let value = net.forward(x, &mut logits);
            let (want, want_value) = reference_forward(checkpoint, x);
            for (a, (ours, theirs)) in logits.iter().zip(&want).enumerate() {
                assert_eq!(ours.to_bits(), theirs.to_bits(), "{name}, input {i}, logit {a}: {ours} against {theirs}");
            }
            assert_eq!(value.to_bits(), want_value.to_bits(), "{name}, input {i}, value: {value} against {want_value}");
        }
        // [Z11-70]: four at a time, each input the same bits again.
        let mut batch = [[0f32; 180]; BATCH];
        for start in (0..inputs.len()).step_by(BATCH) {
            let at = |k: usize| (start + k) % inputs.len();
            let values = net.forward_batch(std::array::from_fn(|k| &inputs[at(k)]), &mut batch);
            for k in 0..BATCH {
                let (want, want_value) = reference_forward(checkpoint, &inputs[at(k)]);
                for (a, (ours, theirs)) in batch[k].iter().zip(&want).enumerate() {
                    assert_eq!(ours.to_bits(), theirs.to_bits(), "{name}, batched input {}, logit {a}: {ours} against {theirs}", at(k));
                }
                assert_eq!(values[k].to_bits(), want_value.to_bits(), "{name}, batched input {}, value", at(k));
            }
        }
    };
    let all: Vec<[f32; 182]> = corpus_inputs.iter().chain(&positions).copied().collect();

    let (c, p) = fixture_bytes();
    check("the fixture", &c, &Network::load(&c, &p).unwrap(), &all);

    for (width, blocks) in [(17, 1), (33, 2)] {
        let (c, p) = synthetic(width, blocks, u64::from(width));
        let net = Network::load(&c, &p).unwrap_or_else(|e| panic!("width {width}: {e}"));
        assert_eq!(net.architecture(), (width, blocks));
        check(&format!("width {width}"), &c, &net, &all);
    }

    // Each run's latest milestone: the width-256 kernel on weights as training
    // leaves them, at a cost the suite's budget ([Z11-50]) can carry.
    let mut milestones = Vec::new();
    for run in std::fs::read_dir(crate_dir().join("milestones")).into_iter().flatten().flatten() {
        let latest = std::fs::read_dir(run.path())
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|g| Some((g.file_name().to_str()?.parse::<u32>().ok()?, g.path().join("checkpoint.bin"))))
            .filter(|(_, c)| c.exists())
            .max();
        milestones.extend(latest.map(|(_, c)| c));
    }
    assert!(!milestones.is_empty(), "no committed milestone to check at width 256");
    for c in milestones {
        let bytes = read(&c);
        let net = Network::load(&bytes, &read(&c.with_extension("parity"))).unwrap();
        check(&c.display().to_string(), &bytes, &net, &corpus_inputs);
    }
}

/// [Z11-70]: `evaluate_batch` answers every request exactly as `evaluate`
/// answers it alone, for every batch size from 0 to 9 — whole groups of four,
/// a short last group padded, and a last request on its own — with expanding
/// and boundary requests (no legal set) mixed.
///
/// Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
/// in `lanes_x4`, the second input accumulated against the first's
/// activations (`a1[l] += p[l] * x0[j][l]`), which the bit comparison above
/// also catches; and in `evaluate_batch`, every softmax of a group taken over
/// the group's first legal set (`requests[at].1`).
#[test]
fn a_batch_is_each_request_alone() {
    let net = fixture();
    let states = support::game_positions(11);
    let inputs: Vec<([f32; 182], Vec<u8>)> = states
        .iter()
        .enumerate()
        .map(|(i, s)| (s.encode(), if i % 3 == 2 { Vec::new() } else { s.legal_actions().as_slice().to_vec() }))
        .collect();
    for size in 0..=9 {
        for start in [0, 5, 17] {
            let group: Vec<Request<'_>> =
                (0..size).map(|k| &inputs[(start + k) % inputs.len()]).map(|(o, l)| (o, &l[..])).collect();
            let mut batched = vec![Evaluation::default(); size];
            net.evaluate_batch(&group, &mut batched);
            for (k, &(o, l)) in group.iter().enumerate() {
                let mut alone = Evaluation::default();
                net.evaluate(o, l, &mut alone);
                assert_eq!(batched[k], alone, "batch of {size} from {start}, request {k}");
            }
        }
    }
}

/// [Z11-71]: `evaluate` computes only the legal actions' logits, and
/// `evaluate_batch` only those legal in some request of each group of four;
/// either way every evaluation is, bit for bit, the softmax over the legal set
/// of all 180 logits from `forward`. On the fixture and on a synthetic odd
/// width, over every position of a game — legal sets of odd and even sizes,
/// so the last row goes alone as often as not — and with boundary requests,
/// which want no logits at all, mixed into the batches.
///
/// Mutations, seen red ([Z11-48]), each in a copy with its anchor confirmed:
/// in `linear_rows`, the second row of a pair given the first row's bias
/// (`out[o1] = finish(a1, t1, xt) + b[o0]`); the unpaired last row left
/// uncomputed (its `if let [r] = last` arm removed); and in `evaluate_batch`,
/// the wanted rows taken from a group's first request alone
/// (`&requests[at..at + 1]`). The first fails the parity check the test's
/// own fixture load runs, since `forward` computes its rows the same way; the
/// other two fail the comparisons.
#[test]
fn only_the_legal_logits_are_computed_and_nothing_changes() {
    let (c, p) = synthetic(17, 1, 17);
    let nets = [("the fixture", fixture()), ("width 17", Network::load(&c, &p).unwrap())];
    let states = support::game_positions(13);
    let inputs: Vec<([f32; 182], Vec<u8>)> = states
        .iter()
        .enumerate()
        .map(|(i, s)| (s.encode(), if i % 5 == 4 { Vec::new() } else { s.legal_actions().as_slice().to_vec() }))
        .collect();
    assert!(inputs.iter().any(|(_, l)| l.len() % 2 == 1) && inputs.iter().any(|(_, l)| !l.is_empty() && l.len() % 2 == 0));
    for (name, net) in &nets {
        let expected: Vec<Evaluation> = inputs
            .iter()
            .map(|(o, l)| {
                let mut logits = [0f32; 180];
                let value = net.forward(o, &mut logits);
                let mut e = Evaluation { policy: [0.0; 180], value };
                masked_softmax(&logits, l, &mut e.policy);
                e
            })
            .collect();
        for (i, (o, l)) in inputs.iter().enumerate() {
            let mut e = Evaluation::default();
            net.evaluate(o, l, &mut e);
            assert_eq!(e, expected[i], "{name}, position {i}, alone");
        }
        for size in [3, 4, 7] {
            for start in (0..inputs.len()).step_by(size) {
                let idx: Vec<usize> = (start..start + size).map(|k| k % inputs.len()).collect();
                let group: Vec<Request<'_>> = idx.iter().map(|&k| (&inputs[k].0, &inputs[k].1[..])).collect();
                let mut out = vec![Evaluation::default(); size];
                net.evaluate_batch(&group, &mut out);
                for (j, &k) in idx.iter().enumerate() {
                    assert_eq!(out[j], expected[k], "{name}, position {k}, in a batch of {size}");
                }
            }
        }
    }
}
