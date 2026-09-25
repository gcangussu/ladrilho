//! Randomness: the seam, the seeded generator, and clones.

mod support;

use azul_engine::{AzulState, Canonical, FLOOR, Seeded, Shuffler, encode_action};
use std::cell::RefCell;
use std::rc::Rc;

/// An independent reading of the published algorithms, written from the
/// papers rather than from `src/rng.rs`: splitmix64 seeding, xoshiro256**,
/// Lemire's bounded integers, Fisher–Yates descending.
mod reference {
    pub fn splitmix64(state: &mut u64) -> u64 {
        *state = state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    pub struct Xoshiro256StarStar([u64; 4]);

    impl Xoshiro256StarStar {
        pub fn seeded(seed: u64) -> Self {
            let mut sm = seed;
            Xoshiro256StarStar([0; 4].map(|_| splitmix64(&mut sm)))
        }

        pub fn next(&mut self) -> u64 {
            let s = &mut self.0;
            let result = (s[1].wrapping_mul(5)).rotate_left(7).wrapping_mul(9);
            let t = s[1] << 17;
            s[2] ^= s[0];
            s[3] ^= s[1];
            s[1] ^= s[2];
            s[0] ^= s[3];
            s[2] ^= t;
            s[3] = s[3].rotate_left(45);
            result
        }

        /// Lemire 2019, Algorithm 5 on 64-bit words.
        pub fn bounded(&mut self, s: u64) -> u64 {
            let mut x = self.next();
            let mut m = (x as u128) * (s as u128);
            let mut l = m as u64;
            if l < s {
                let t = s.wrapping_neg() % s;
                while l < t {
                    x = self.next();
                    m = (x as u128) * (s as u128);
                    l = m as u64;
                }
            }
            (m >> 64) as u64
        }
    }

    pub fn shuffle(bag: &mut [u8], rng: &mut Xoshiro256StarStar) {
        let mut i = bag.len();
        while i > 1 {
            i -= 1;
            let j = rng.bounded(i as u64 + 1) as usize;
            bag.swap(i, j);
        }
    }
}

/// Each call's index and the bag it left, shared by a state and its clones.
type Log = Rc<RefCell<Vec<(u32, Vec<u8>)>>>;

/// Delegates to the seeded shuffler and logs each call's index and result.
#[derive(Clone, Debug)]
struct Logged {
    inner: Seeded,
    log: Log,
}

impl PartialEq for Logged {
    fn eq(&self, other: &Self) -> bool {
        self.inner == other.inner && Rc::ptr_eq(&self.log, &other.log)
    }
}

impl Shuffler for Logged {
    fn shuffle(&mut self, bag: &mut [u8], index: u32) {
        self.inner.shuffle(bag, index);
        self.log.borrow_mut().push((index, bag.to_vec()));
    }
}

fn logged(seed: u64) -> (Logged, Log) {
    let log = Rc::new(RefCell::new(Vec::new()));
    (Logged { inner: Seeded::new(seed), log: log.clone() }, log)
}

/// [R9-13] Seeded is xoshiro256** seeded by splitmix64, bounded by Lemire,
/// shuffling Fisher–Yates descending: the opening shuffle of 200 seeds
/// matches an independent implementation of the published algorithms, whose
/// splitmix64 is checked against its published first output.
#[test]
fn the_seeded_shuffle_is_the_published_algorithm() {
    let mut zero = 0u64;
    assert_eq!(reference::splitmix64(&mut zero), 0xE220A8397B1DCDAF, "splitmix64(0), as published");
    for seed in (0..200u64).chain([u64::MAX, 1 << 63, 0xDEAD_BEEF]) {
        let (shuffler, log) = logged(seed);
        let _ = AzulState::new_game(shuffler);
        let log = log.borrow();
        assert_eq!(log.len(), 1);
        let mut want: Vec<u8> = (0..100).map(|i| (i / 20) as u8).collect();
        reference::shuffle(&mut want, &mut reference::Xoshiro256StarStar::seeded(seed));
        assert_eq!(log[0].1, want, "seed {seed}");
    }
}

/// [R9-13] Known answers, committed as literals: the bag left after the
/// opening deal, and the deal, for seeds 0, 1 and 2. A change to any part of
/// the algorithm changes these.
#[test]
fn the_seeded_opening_is_pinned() {
    let want: [(Vec<u8>, [[u8; 5]; 5]); 3] = [
        (
            vec![0, 2, 0, 3, 4, 4, 4, 4, 4, 4, 0, 3, 4, 4, 4, 1, 3, 3, 2, 1, 1, 2, 3, 1, 2, 1, 1, 0, 1, 0, 0, 0, 2, 3, 1, 1, 2, 3, 3, 1, 0, 3, 1, 0, 0, 0, 1, 1, 1, 1, 2, 3, 2, 0, 2, 4, 0, 0, 2, 4, 3, 0, 3, 2, 3, 4, 4, 2, 1, 4, 3, 3, 3, 2, 1, 4, 2, 4, 4, 1],
            [[1, 0, 1, 2, 0], [0, 1, 1, 1, 1], [1, 0, 0, 1, 2], [1, 1, 2, 0, 0], [2, 0, 2, 0, 0]],
        ),
        (
            vec![2, 0, 4, 1, 4, 3, 1, 2, 4, 4, 2, 3, 3, 3, 0, 3, 1, 4, 3, 0, 4, 4, 2, 1, 4, 0, 4, 0, 0, 0, 2, 0, 3, 0, 2, 1, 4, 0, 4, 3, 1, 1, 0, 4, 4, 2, 2, 2, 1, 0, 1, 2, 2, 1, 1, 0, 1, 3, 0, 4, 3, 1, 2, 3, 3, 2, 3, 1, 3, 0, 3, 2, 3, 1, 0, 1, 1, 2, 1, 4],
            [[0, 1, 2, 1, 0], [2, 1, 0, 1, 0], [0, 0, 1, 1, 2], [0, 0, 1, 1, 2], [2, 0, 1, 0, 1]],
        ),
        (
            vec![4, 1, 3, 1, 0, 3, 2, 3, 1, 2, 3, 3, 3, 3, 0, 2, 3, 0, 2, 0, 0, 2, 1, 1, 2, 0, 3, 2, 4, 4, 3, 4, 3, 2, 4, 1, 4, 1, 2, 4, 2, 1, 4, 0, 0, 4, 0, 4, 3, 0, 2, 4, 3, 2, 1, 2, 1, 0, 1, 2, 0, 4, 1, 0, 4, 0, 4, 4, 1, 1, 2, 1, 0, 3, 2, 2, 2, 0, 1, 0],
            [[2, 0, 0, 2, 0], [0, 2, 0, 2, 0], [0, 1, 1, 2, 0], [1, 0, 1, 0, 2], [0, 1, 0, 0, 3]],
        ),
    ];
    for (k, (bag, factories)) in want.iter().enumerate() {
        let c = AzulState::seeded(k as u64).to_canonical();
        assert_eq!(&c.bag, bag, "seed {k}");
        assert_eq!(&c.factories, factories, "seed {k}");
    }
}

/// [R9-12] The seam is called exactly where randomness is permitted — once by
/// new_game with index 0, then once per lid recycle, never on an ordinary
/// refill — with the state's shuffles_used as the index, incremented after
/// [E1-61]. The seeded path counts the same way, so new_game reports one.
#[test]
fn the_seam_is_called_only_where_permitted_with_its_index() {
    for seed in 0..30 {
        let (shuffler, log) = logged(seed);
        let mut s = AzulState::new_game(shuffler);
        assert_eq!(s.shuffles_used(), 1);
        assert_eq!(log.borrow()[0].0, 0);
        let mut pick = support::Picker::new(seed);
        let mut recycles = 0;
        while !s.is_terminal() {
            let before = s.to_canonical();
            let legal = s.legal_actions();
            s.apply(legal.as_slice()[pick.below(legal.len())]).unwrap();
            let after = s.to_canonical();
            let calls = log.borrow().len() as u32;
            assert_eq!(after.shuffles_used, calls, "shuffles_used counts calls actually made");
            if after.shuffles_used > before.shuffles_used {
                // Only a refill that found the bag empty with tiles in the lid.
                assert_eq!(after.shuffles_used, before.shuffles_used + 1);
                assert_eq!(log.borrow().last().unwrap().0, before.shuffles_used);
                recycles += 1;
            }
        }
        let _ = recycles;
    }
    // A loaded position reports its snapshot's count and does not shuffle.
    let mut c: Canonical = support::vectors()[0].plies[10].state.clone();
    c.shuffles_used = 7;
    let (shuffler, log) = logged(0);
    let s = AzulState::from_canonical(&c, shuffler).unwrap();
    assert_eq!((s.shuffles_used(), log.borrow().len()), (7, 0));
}

/// [E1-47] Only shuffles consume the generator: plies that recycle nothing
/// leave the seeded shuffler exactly as it was.
#[test]
fn only_shuffles_consume_the_generator() {
    let mut s = AzulState::seeded(9);
    let mut pick = support::Picker::new(9);
    while !s.is_terminal() {
        let before = (s.shuffler().clone(), s.shuffles_used());
        let legal = s.legal_actions();
        s.apply(legal.as_slice()[pick.below(legal.len())]).unwrap();
        if s.shuffles_used() == before.1 {
            assert_eq!(s.shuffler(), &before.0);
        } else {
            assert_ne!(s.shuffler(), &before.0);
        }
    }
}

/// [E1-48] A clone carries the generator: the same moves reach the same
/// states, shuffler included, through lid recycles; and a clone played
/// differently leaves its parent untouched.
#[test]
fn a_clone_continues_the_stream_exactly() {
    for seed in 0..10 {
        let states = support::self_play(seed);
        let mut parent = AzulState::seeded(seed);
        let mut child = parent.clone();
        let mut pick = support::Picker::new(seed);
        for next in &states[1..] {
            let legal = parent.legal_actions();
            let a = legal.as_slice()[pick.below(legal.len())];
            parent.apply(a).unwrap();
            child.apply(a).unwrap();
            assert_eq!(&parent, next);
            assert_eq!(child, parent);
        }
        let mut s = AzulState::seeded(seed);
        let snapshot = s.clone();
        let mut other = s.clone();
        let legal = other.legal_actions();
        other.apply(legal.as_slice()[0]).unwrap();
        assert_eq!(s, snapshot);
        s.apply(legal.as_slice()[legal.len() - 1]).unwrap();
        assert_ne!(s, other);
    }
}

/// [E1-72] A clone of a state built with an injected shuffle recycles the lid
/// during a later apply: the shuffle is called exactly once, with the recycled
/// bag and the clone's shuffles_used, and the source is unaffected.
#[test]
fn a_clone_with_an_injected_shuffle_recycles_through_the_seam() {
    let mut c = support::blank();
    c.bag = Vec::new();
    c.lid = [4, 4, 4, 4, 3];
    c.factories[0] = [0, 0, 0, 0, 1];
    c.shuffles_used = 5;
    c.tiles_left = 1;
    let (shuffler, log) = logged(1);
    let source = AzulState::from_canonical(&c, shuffler).unwrap();
    let before = source.to_canonical();
    let mut child = source.clone();
    child.apply(encode_action(0, 4, FLOOR).unwrap()).unwrap();
    let log = log.borrow();
    assert_eq!(log.len(), 1, "exactly one call");
    assert_eq!(log[0].0, 5, "the clone's shuffles_used");
    let mut recycled = log[0].1.clone();
    recycled.sort_unstable();
    let mut want: Vec<u8> = [(0, 4), (1, 4), (2, 4), (3, 4), (4, 4)]
        .iter()
        .flat_map(|&(c, n)| std::iter::repeat_n(c as u8, n))
        .collect();
    want.sort_unstable();
    assert_eq!(recycled, want, "the lid's tiles, the taken teal among them");
    assert_eq!(child.shuffles_used(), 6);
    assert_eq!(source.to_canonical(), before);
}

/// [E1-64] shuffles_used never decreases and rises by exactly one per call:
/// asserted per ply across seeded games (the vector replay asserts it against
/// the recorded count).
#[test]
fn the_shuffle_counter_only_rises_by_one() {
    for seed in 0..50 {
        let states = support::self_play(seed);
        for w in states.windows(2) {
            let d = w[1].shuffles_used() - w[0].shuffles_used();
            assert!(d <= 1, "seed {seed}");
        }
    }
}
