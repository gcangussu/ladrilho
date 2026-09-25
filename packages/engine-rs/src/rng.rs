//! Randomness ([R9-12], [R9-13]): the shuffle seam and the crate's own seeded
//! generator.
//!
//! The generator is `xoshiro256**` seeded through `splitmix64`, deliberately
//! not the TypeScript engine's `xoshiro128**`. Seeds are portable neither to
//! the oracle nor to the TypeScript engine; conformance is replay-based
//! through the seam ([0002 V2-2]).

/// The bag shuffle seam. Reorders `bag` in place; `index` is the state's
/// `shuffles_used` at the moment of the call ([0001 E1-61]).
///
/// The shuffler is owned by the state and copied with it by `clone`, so an
/// injected shuffler replaying `recorded[index]` keeps no cursor two states
/// could fight over, and the seeded one carries its stream into the clone
/// ([0001 E1-48]).
pub trait Shuffler: Clone + PartialEq + core::fmt::Debug {
    fn shuffle(&mut self, bag: &mut [u8], index: u32);
}

/// The seeded default: `xoshiro256**`, Fisher–Yates descending.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Seeded {
    s: [u64; 4],
}

impl Seeded {
    /// Seeds the stream by running `splitmix64` over `seed` to fill four words.
    pub fn new(seed: u64) -> Self {
        let mut x = seed;
        let mut s = [0u64; 4];
        for word in &mut s {
            x = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
            let mut z = x;
            z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
            *word = z ^ (z >> 31);
        }
        // xoshiro is undefined on an all-zero state. splitmix64 is a bijection
        // of its counter and practically never produces one; this removes the
        // "practically".
        if s == [0; 4] {
            s[0] = 1;
        }
        Seeded { s }
    }

    fn next_u64(&mut self) -> u64 {
        let s = &mut self.s;
        let result = s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = s[1] << 17;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(45);
        result
    }

    /// A uniform integer in `0..n` for `n >= 1`, by Lemire's multiply-and-reject
    /// on `u64`. Unbiased; the outputs it consumes vary, deterministically.
    fn below(&mut self, n: u64) -> u64 {
        let mut m = u128::from(self.next_u64()) * u128::from(n);
        if (m as u64) < n {
            let threshold = n.wrapping_neg() % n;
            while (m as u64) < threshold {
                m = u128::from(self.next_u64()) * u128::from(n);
            }
        }
        (m >> 64) as u64
    }
}

impl Shuffler for Seeded {
    /// Fisher–Yates, descending. The direction is contractual: ascending with
    /// the same stream deals a different game.
    fn shuffle(&mut self, bag: &mut [u8], _index: u32) {
        for i in (1..bag.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            bag.swap(i, j);
        }
    }
}
