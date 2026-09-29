//! The crate's own generator ([Z11-20]): self-play's noise and move sampling
//! draw from it, never from a state's shuffler, which [0001 E1-47] reserves for
//! shuffles.
//!
//! The generator is `rand_xoshiro`'s `xoshiro256**` and the Gamma draws behind
//! the Dirichlet noise are `rand_distr`'s; what stays here is the spec's own:
//! how a game's triple becomes its seeds. `xoshiro256**` seeded through
//! `splitmix64` is also the family the engine's `Seeded` uses, which is exactly
//! why the two are seeded apart: the noise stream is seeded from the game's
//! triple mixed with [`NOISE_SALT`], so it can never be the bag order read
//! another way.

use rand::{Rng as _, RngExt, SeedableRng};
use rand_distr::{Distribution, Gamma};
use rand_xoshiro::Xoshiro256StarStar;

/// Mixed into a game's seed to seed its noise generator ([Z11-20]).
pub const NOISE_SALT: u64 = 0x6e6f_6973_655f_7a31; // "noise_z1"

/// One step of `splitmix64`: a bijection with good avalanche, used to combine
/// the elements of a seed triple.
pub fn splitmix64(x: u64) -> u64 {
    let mut z = x.wrapping_add(0x9e37_79b9_7f4a_7c15);
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    z ^ (z >> 31)
}

/// The shuffler's seed for game `index` of generation `generation` of a run
/// seeded `seed` ([Z11-26]). Each element passes through the mixer before the
/// next is folded in, so no two triples that differ collide by arithmetic —
/// `(s, 1, 0)` and `(s, 0, 1)` are as unrelated as any other pair.
pub fn game_seed(seed: u64, generation: u64, index: u64) -> u64 {
    splitmix64(splitmix64(splitmix64(seed) ^ generation) ^ index)
}

/// The noise generator's seed for the same game: the triple mixed with a fixed
/// constant ([Z11-20]).
pub fn noise_seed(seed: u64, generation: u64, index: u64) -> u64 {
    splitmix64(game_seed(seed, generation, index) ^ NOISE_SALT)
}

/// The crate's generator. Seeded explicitly, always: nothing here can reach
/// the operating system's entropy (`rand` is built without it).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Rng(Xoshiro256StarStar);

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng(Xoshiro256StarStar::seed_from_u64(seed))
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0.next_u64()
    }

    /// Uniform on `[0, 1)`.
    pub fn uniform(&mut self) -> f64 {
        self.0.random::<f64>()
    }

    /// A uniform integer in `0..n`; `n == 0` returns 0 rather than panicking.
    pub fn below(&mut self, n: u64) -> u64 {
        if n == 0 { 0 } else { self.0.random_range(0..n) }
    }

    /// A symmetric `Dir(alpha)` draw into `out`, whose length is the number of
    /// components: independent `Gamma(alpha, 1)` draws, normalised. A draw
    /// whose gammas all underflow to zero is drawn again. An `alpha` the
    /// Gamma refuses — not positive, not finite — fills `out` with NaN, so a
    /// broken setting shows in the noise rather than as a panic.
    pub fn dirichlet(&mut self, alpha: f64, out: &mut [f64]) {
        if out.is_empty() {
            return;
        }
        let Ok(gamma) = Gamma::new(alpha, 1.0) else {
            out.fill(f64::NAN);
            return;
        };
        loop {
            let mut sum = 0.0;
            for x in out.iter_mut() {
                *x = gamma.sample(&mut self.0);
                sum += *x;
            }
            if sum != 0.0 {
                for x in out.iter_mut() {
                    *x /= sum;
                }
                return;
            }
        }
    }
}
