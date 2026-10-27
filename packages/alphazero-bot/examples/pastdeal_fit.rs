//! Fits the past-deal lookahead's blends on the panel's boundaries into
//! round 5 (an experiment's tool, not a lane).
//!
//! usage: pastdeal_fit <checkpoint> <panel> <deals> <deep-deals> <deep-sims> <threads> <out.json>
//!
//! Per boundary view: the head on the pre-deal view, and on `deals` deals of
//! the pool the head on the dealt position and a greedy rollout's margin; on
//! the first `deep-deals` a `deep-sims` search. Then least squares against
//! the replays' mean `p̂`, 5-fold cross-validated, with the panel's
//! noise-corrected error, `mean((x − p̂)²) − mean(s²)/R`.


#![allow(clippy::needless_range_loop)]
use std::sync::Mutex;

use azul_alphazero::network::Network;
use azul_alphazero::pastdeal::{Blend, Deep, Pool, Recal, Rungs, margin_value, rungs_dealt};
use azul_engine::{AzulState, Canonical, ENCODED_SIZE, OFF_BAG, OFF_LID, OFF_MY_LINES, OFF_MY_WALL, OFF_OP_LINES, OFF_OP_WALL, OFF_SCORES, Player, Seeded};

const RECORD: usize = 1 + 1 + 16 + 4 + 4 * ENCODED_SIZE;

struct Rec {
    replays: [i8; 16],
    v: f32,
    obs: [f32; ENCODED_SIZE],
}

fn read_panel(path: &str) -> Vec<Rec> {
    let bytes = std::fs::read(path).unwrap();
    assert_eq!(&bytes[0..4], b"AZPN");
    let count = u32::from_le_bytes(bytes[8..12].try_into().unwrap()) as usize;
    let mut out = Vec::new();
    for i in 0..count {
        let b = &bytes[20 + i * RECORD..20 + (i + 1) * RECORD];
        // Boundary views about to deal round 5 (0-based 4).
        if b[0] != 1 || b[1] != 4 {
            continue;
        }
        let mut replays = [0i8; 16];
        for j in 0..16 {
            replays[j] = b[2 + j] as i8;
        }
        let v = f32::from_le_bytes(b[18..22].try_into().unwrap());
        let mut obs = [0f32; ENCODED_SIZE];
        for j in 0..ENCODED_SIZE {
            obs[j] = f32::from_le_bytes(b[22 + 4 * j..26 + 4 * j].try_into().unwrap());
        }
        out.push(Rec { replays, v, obs });
    }
    out
}

fn cnt(v: f32, scale: f32) -> u8 {
    (v * scale).round() as u8
}

/// The position the view describes, the opener as P0 and to move, between
/// scoring and dealing: an empty board, the bag in colour order, round
/// index 4. `dealt` then deals it as the engine's refill does.
fn pre_deal(obs: &[f32; ENCODED_SIZE]) -> Canonical {
    let mut walls = [[0u8; 25]; 2];
    for i in 0..25 {
        walls[0][i] = cnt(obs[OFF_MY_WALL + i], 1.0);
        walls[1][i] = cnt(obs[OFF_OP_WALL + i], 1.0);
    }
    let mut pl_color = [[-1i8; 5]; 2];
    let mut pl_count = [[0u8; 5]; 2];
    for (p, off) in [(0usize, OFF_MY_LINES), (1, OFF_OP_LINES)] {
        for r in 0..5 {
            let base = off + r * 6;
            let n = cnt(obs[base + 5], (r + 1) as f32);
            if n != 0 {
                for c in 0..5 {
                    if obs[base + c] == 1.0 {
                        pl_color[p][r] = c as i8;
                    }
                }
                pl_count[p][r] = n;
            }
        }
    }
    let mut bag = Vec::new();
    let mut lid = [0u8; 5];
    for c in 0..5 {
        for _ in 0..cnt(obs[OFF_BAG + c], 20.0) {
            bag.push(c as u8);
        }
        lid[c] = cnt(obs[OFF_LID + c], 20.0);
    }
    Canonical {
        factories: [[0; 5]; 5],
        center: [0; 5],
        marker_in_center: true,
        bag,
        lid,
        walls,
        pl_color,
        pl_count,
        floor: [[0; 5]; 2],
        floor_marker: [false; 2],
        scores: [(obs[OFF_SCORES] * 100.0).round() as i32, (obs[OFF_SCORES + 1] * 100.0).round() as i32],
        current_player: Player::P0,
        first_player: Player::P0,
        round_index: 4,
        tiles_left: 0,
        shuffles_used: 0,
        is_terminal: false,
        exhausted: false,
    }
}

/// The dealt position of deal `k`: the engine's refill, by hand (displays in
/// order, four each, from the end of the bag).
fn dealt(pre: &Canonical, pool: &Pool, k: usize) -> AzulState<Seeded> {
    let mut c = pre.clone();
    let mut bag = pool.orders[k].clone();
    for f in 0..5 {
        for _ in 0..4 {
            let t = bag.pop().unwrap();
            c.factories[f][usize::from(t)] += 1;
        }
    }
    c.bag = bag;
    c.tiles_left = 20;
    AzulState::from_canonical(&c, Seeded::new(pool.seeds[k])).unwrap()
}

struct Row {
    p: f64,
    s2: f64,
    v: f64,
    dealt: f64,
    margin: f64,
    deep4: f64,
    deep8: f64,
    dealt1: f64,
}

/// Solves `min |Xw − y|²` by the normal equations.
fn ols(x: &[Vec<f64>], y: &[f64]) -> Vec<f64> {
    let d = x[0].len();
    let mut a = vec![vec![0.0; d + 1]; d];
    for (xi, &yi) in x.iter().zip(y) {
        for r in 0..d {
            for c in 0..d {
                a[r][c] += xi[r] * xi[c];
            }
            a[r][d] += xi[r] * yi;
        }
    }
    for r in 0..d {
        a[r][r] += 1e-9;
    }
    for i in 0..d {
        let piv = (i..d).max_by(|&p, &q| a[p][i].abs().total_cmp(&a[q][i].abs())).unwrap();
        a.swap(i, piv);
        for r in 0..d {
            if r != i {
                let f = a[r][i] / a[i][i];
                for c in i..=d {
                    a[r][c] -= f * a[i][c];
                }
            }
        }
    }
    (0..d).map(|i| a[i][d] / a[i][i]).collect()
}

fn err(pred: &[f64], rows: &[Row]) -> f64 {
    let n = rows.len() as f64;
    let raw: f64 = pred.iter().zip(rows).map(|(x, r)| (x.clamp(-1.0, 1.0) - r.p).powi(2)).sum::<f64>() / n;
    raw - rows.iter().map(|r| r.s2).sum::<f64>() / n / 16.0
}

/// 5-fold cross-validated error of the features `f`, and the weights fit on all.
fn cv(rows: &[Row], f: &dyn Fn(&Row) -> Vec<f64>) -> (f64, Vec<f64>) {
    let mut pred = vec![0.0; rows.len()];
    for fold in 0..5 {
        let train: Vec<usize> = (0..rows.len()).filter(|i| i % 5 != fold).collect();
        let w = ols(&train.iter().map(|&i| f(&rows[i])).collect::<Vec<_>>(), &train.iter().map(|&i| rows[i].p).collect::<Vec<_>>());
        for i in (0..rows.len()).filter(|i| i % 5 == fold) {
            pred[i] = f(&rows[i]).iter().zip(&w).map(|(a, b)| a * b).sum();
        }
    }
    let w = ols(&rows.iter().map(f).collect::<Vec<_>>(), &rows.iter().map(|r| r.p).collect::<Vec<_>>());
    (err(&pred, rows), w)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let net = Network::load(&std::fs::read(&a[1]).unwrap(), &std::fs::read(a[1].replace(".bin", ".parity")).unwrap()).unwrap();
    let recs = read_panel(&a[2]);
    let deals: u32 = a[3].parse().unwrap();
    let deep_deals: u32 = a[4].parse().unwrap();
    let deep_sims: u32 = a[5].parse().unwrap();
    let threads: usize = a[6].parse().unwrap();
    eprintln!("{} boundaries into round 5", recs.len());

    let rows: Mutex<Vec<(usize, Row, u64)>> = Mutex::new(Vec::new());
    let next = Mutex::new(0usize);
    std::thread::scope(|s| {
        for _ in 0..threads {
            s.spawn(|| {
                loop {
                    let i = {
                        let mut n = next.lock().unwrap();
                        let i = *n;
                        *n += 1;
                        i
                    };
                    let Some(rec) = recs.get(i) else { break };
                    let pre = pre_deal(&rec.obs);
                    let state = AzulState::from_canonical(&pre, Seeded::new(0)).unwrap();
                    let pool = Pool::of(&state, deals);
                    let mut calls = 0u64;
                    let mut r = Rungs::default();
                    // The panel has only the view, not the boundary ply, so
                    // each deal is made by hand and its rungs taken alone.
                    let deep = Deep { leaves: 1, deals: 1, simulations: deep_sims, blend: BLANK };
                    for k in 0..deals as usize {
                        let s = dealt(&pre, &pool, k);
                        let d = ((k as u32) < deep_deals).then_some(&deep);
                        rungs_dealt(&net, &s, true, d, &mut r, &mut calls);
                    }
                    let p = rec.replays.iter().map(|&x| f64::from(x)).sum::<f64>() / 16.0;
                    let s2 = rec.replays.iter().map(|&x| (f64::from(x) - p).powi(2)).sum::<f64>() / 15.0;
                    let m = |xs: &[f32]| xs.iter().map(|&x| f64::from(x)).sum::<f64>() / xs.len().max(1) as f64;
                    let row = Row {
                        p,
                        s2,
                        v: f64::from(rec.v),
                        dealt: m(&r.dealt),
                        dealt1: f64::from(r.dealt[0]),
                        margin: r.margins.iter().map(|&x| f64::from(x)).sum::<f64>() / r.margins.len() as f64,
                        deep4: m(&r.deep[..r.deep.len().min(4)]),
                        deep8: m(&r.deep),
                    };
                    rows.lock().unwrap().push((i, row, calls));
                }
            });
        }
    });
    let mut rows = rows.into_inner().unwrap();
    rows.sort_by_key(|r| r.0);
    let calls: u64 = rows.iter().map(|r| r.2).sum();
    let rows: Vec<Row> = rows.into_iter().map(|r| r.1).collect();
    eprintln!("calls per boundary: {:.0}", calls as f64 / rows.len() as f64);

    let one = |r: &Row| vec![1.0, r.v];
    let (e_v, _) = cv(&rows, &|r| vec![r.v]);
    let (e_recal, w_recal) = cv(&rows, &one);
    println!("head alone                 {e_v:.4}");
    println!("recalibrated head          {e_recal:.4}  a {:.4} b {:.4}", w_recal[0], w_recal[1]);
    let (e, _) = cv(&rows, &|r| vec![1.0, r.v, r.dealt1]);
    println!("v + dealt x1               {e:.4}");
    let (e, _) = cv(&rows, &|r| vec![1.0, r.v, r.dealt]);
    println!("v + dealt x{deals}               {e:.4}");
    let mut best = (f64::INFINITY, 0.0, vec![]);
    for sigma in [2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0] {
        let (e, w) = cv(&rows, &|r| vec![1.0, r.v, r.dealt, margin_value(r.margin, sigma)]);
        println!("v + dealt + rollout s={sigma:<4} {e:.4}");
        if e < best.0 {
            best = (e, sigma, w);
        }
    }
    let mut best_deep = (f64::INFINITY, 0.0, vec![]);
    if deep_deals > 0 {
        for sigma in [2.0, 3.0, 3.5, 4.0, 5.0, 6.0] {
            let (e, w) = cv(&rows, &|r| vec![1.0, r.v, r.dealt, margin_value(r.margin, sigma), r.deep4]);
            println!("+ deep x{} s={sigma:<4}          {e:.4}", deep_deals.min(4));
            if e < best_deep.0 {
                best_deep = (e, sigma, w);
            }
        }
        let (e, _) = cv(&rows, &|r| vec![1.0, r.v, r.deep8]);
        println!("v + deep x{deep_deals} only            {e:.4}");
    }
    let blend = |w: &[f64], sigma: f64| Blend {
        intercept: w[0],
        head: w[1],
        dealt: w[2],
        rollout: w[3],
        sigma,
        deep: w.get(4).copied().unwrap_or(0.0),
    };
    let shallow = blend(&best.2, best.1);
    let deep = (deep_deals > 0).then(|| blend(&best_deep.2, best_deep.1));
    let recal = Recal { a: w_recal[0], b: w_recal[1] };
    let json = format!(
        "{{\n  \"deals\": {deals},\n  \"deepDeals\": {deep_deals},\n  \"deepSimulations\": {deep_sims},\n  \"boundaries\": {},\n  \"recal\": {{ \"a\": {}, \"b\": {}, \"error\": {e_recal} }},\n  \"shallow\": {},\n  \"deep\": {}\n}}\n",
        rows.len(),
        recal.a,
        recal.b,
        blend_json(&shallow, best.0),
        deep.map_or("null".into(), |d| blend_json(&d, best_deep.0)),
    );
    std::fs::write(&a[7], json).unwrap();
    eprintln!("wrote {}", a[7]);
}

const BLANK: Blend = Blend { intercept: 0.0, head: 0.0, dealt: 0.0, rollout: 0.0, sigma: 1.0, deep: 0.0 };

fn blend_json(b: &Blend, error: f64) -> String {
    format!(
        "{{ \"intercept\": {}, \"head\": {}, \"dealt\": {}, \"rollout\": {}, \"sigma\": {}, \"deep\": {}, \"error\": {error} }}",
        b.intercept, b.head, b.dealt, b.rollout, b.sigma, b.deep
    )
}

