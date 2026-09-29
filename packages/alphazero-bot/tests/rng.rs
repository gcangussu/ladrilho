//! The crate's own generator and the Dirichlet sampler ([Z11-52]).

use azul_alphazero::rng::Rng;

/// Draws `n` samples of `Dir(alpha)` with `k` components and checks them.
fn check(alpha: f64, k: usize, seed: u64) {
    let n = 100_000;
    let mut rng = Rng::new(seed);
    let mut draw = vec![0f64; k];
    let mut sum = vec![0f64; k];
    let mut sq = vec![0f64; k];
    for _ in 0..n {
        rng.dirichlet(alpha, &mut draw);
        let total: f64 = draw.iter().sum();
        assert!((total - 1.0).abs() <= 1e-5, "a draw sums to {total}");
        for (i, &x) in draw.iter().enumerate() {
            assert!(!x.is_nan() && x >= 0.0, "component {i} is {x}");
            sum[i] += x;
            sq[i] += x * x;
        }
    }
    let kf = k as f64;
    let want = (1.0 / kf) * (1.0 - 1.0 / kf) / (kf * alpha + 1.0);
    for i in 0..k {
        let mean = sum[i] / n as f64;
        let var = sq[i] / n as f64 - mean * mean;
        assert!(
            (var - want).abs() <= 0.1 * want,
            "Dir({alpha}) with {k} components: component {i}'s variance is {var}, not {want}"
        );
    }
}

/// [Z11-52]: at `α = 0.3` with 2, 20 and 50 components and at `α = 2` with 20,
/// over 100 000 draws each, every draw sums to 1, no component is negative or
/// NaN, and each component's variance is within 10% of
/// `(1/k)(1 − 1/k)/(kα + 1)` — the check that sees α, which the means do not.
///
/// The Gamma draws are `rand_distr`'s; this is the acceptance check of
/// whatever sampler is used, not a test of our own arithmetic.
///
/// Mutations, seen red ([Z11-48]): in `Rng::dirichlet`, `Gamma::new(alpha + 1.0, 1.0)`
/// for `Gamma::new(alpha, 1.0)` draws `Dir(α + 1)` and fails the variance
/// clause; leaving out the division by `sum` fails the sum clause.
#[test]
fn the_dirichlet_sampler_has_the_right_shape() {
    check(0.3, 2, 1);
    check(0.3, 20, 2);
    check(0.3, 50, 3);
    check(2.0, 20, 4);
}

/// The generator's bounded draw is uniform enough to deal from, and the
/// unit draws stay in `[0, 1)`.
#[test]
fn the_generator_draws_in_range() {
    let mut rng = Rng::new(5);
    let mut counts = [0u32; 7];
    for _ in 0..70_000 {
        counts[rng.below(7) as usize] += 1;
        let u = rng.uniform();
        assert!((0.0..1.0).contains(&u));
    }
    assert!(counts.iter().all(|&c| (9_500..10_500).contains(&c)), "{counts:?}");
    assert_eq!(rng.below(0), 0);
}
