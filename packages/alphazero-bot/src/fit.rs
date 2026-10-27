//! [Z11-97]: `alphazero past-deal fit`, the refinement's constants fitted to
//! one checkpoint on the panel's boundaries into round 5 ([Z11-83]).
//!
//! Per boundary view whose bag can deal the round (20 tiles or more): this
//! checkpoint's head on the pre-deal view, and on each of the pool's deals
//! the head on the dealt position and a greedy rollout's margin, exactly as
//! the refinement computes them ([`rungs_dealt`]). Then least squares against
//! the replays' mean `p̂`, 5-fold cross-validated, scored by the panel's
//! noise-corrected error `mean((x − p̂)²) − mean(s²)/R`: the recalibration on
//! the head alone, and the blend on a grid of `sigma`, the lowest error kept.

#![allow(clippy::needless_range_loop)]

use std::sync::Mutex;

use azul_alphazero::network::{Evaluation, Evaluator, Network};
use azul_alphazero::pastdeal::{Blend, DEAL_TILES, Pool, Recal, Rungs, margin_value, rungs_dealt};
use azul_engine::{
    AzulState, Canonical, ENCODED_SIZE, OFF_BAG, OFF_LID, OFF_MY_LINES, OFF_MY_WALL, OFF_OP_LINES, OFF_OP_WALL,
    OFF_SCORES, Player, Seeded,
};
use serde::Serialize;

/// The panel's replays a record ([Z11-83]).
const REPLAYS: usize = 16;
const RECORD: usize = 1 + 1 + REPLAYS + 4 + 4 * ENCODED_SIZE;
const HEADER: usize = 20;

/// The `sigma`s the blend is fitted at.
pub const SIGMAS: [f64; 8] = [2.0, 2.5, 3.0, 3.5, 4.0, 5.0, 6.0, 8.0];

/// One panel boundary view: its replays' results and its observation.
struct Rec {
    replays: [i8; REPLAYS],
    obs: [f32; ENCODED_SIZE],
}

/// The panel's boundary views about to deal round 5 (0-based 4).
fn read_panel(bytes: &[u8]) -> Result<Vec<Rec>, String> {
    let word = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap_or_default()) as usize;
    if bytes.len() < HEADER || &bytes[0..4] != b"AZPN" {
        return Err("the panel does not start with AZPN ([Z11-83])".into());
    }
    let (version, count, replays, length) = (word(4), word(8), word(12), word(16));
    if version != 1 || replays != REPLAYS || length != ENCODED_SIZE || bytes.len() != HEADER + count * RECORD {
        return Err(format!("the panel is version {version}, {replays} replays, {length} inputs: not this one's layout"));
    }
    let mut out = Vec::new();
    for b in bytes[HEADER..].as_chunks::<RECORD>().0 {
        if b[0] != 1 || b[1] != 4 {
            continue;
        }
        let mut replays = [0i8; REPLAYS];
        for (r, &x) in replays.iter_mut().zip(&b[2..2 + REPLAYS]) {
            *r = x as i8;
        }
        let mut obs = [0f32; ENCODED_SIZE];
        for (o, w) in obs.iter_mut().zip(b[2 + REPLAYS + 4..].as_chunks::<4>().0) {
            *o = f32::from_le_bytes(*w);
        }
        out.push(Rec { replays, obs });
    }
    Ok(out)
}

fn cnt(v: f32, scale: f32) -> u8 {
    (v * scale).round() as u8
}

/// The position the view describes, the opener as P0 and to move, between
/// scoring and dealing: an empty board, the bag in colour order, round index
/// 4. [`dealt`] then deals it as the engine's refill does.
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
/// order, four each, from the end of the bag). The panel holds the view, not
/// the boundary ply, so the deal is made here rather than by [`Pool::deal`].
fn dealt(pre: &Canonical, pool: &Pool, k: usize) -> Result<AzulState<Seeded>, String> {
    let mut c = pre.clone();
    let mut bag = pool.orders[k].clone();
    for f in 0..5 {
        for _ in 0..4 {
            let t = bag.pop().ok_or("a bag of under 20 tiles")?;
            c.factories[f][usize::from(t)] += 1;
        }
    }
    c.bag = bag;
    c.tiles_left = DEAL_TILES as u8;
    AzulState::from_canonical(&c, Seeded::new(pool.seeds[k])).map_err(|e| format!("a dealt view was refused: {e:?}"))
}

struct Row {
    p: f64,
    s2: f64,
    v: f64,
    dealt: f64,
    margin: f64,
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
        let piv = (i..d).max_by(|&p, &q| a[p][i].abs().total_cmp(&a[q][i].abs())).unwrap_or(i);
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

/// The panel's noise-corrected error of `pred`, clamped as values are.
fn err(pred: &[f64], rows: &[Row]) -> f64 {
    let n = rows.len() as f64;
    let raw: f64 = pred.iter().zip(rows).map(|(x, r)| (x.clamp(-1.0, 1.0) - r.p).powi(2)).sum::<f64>() / n;
    raw - rows.iter().map(|r| r.s2).sum::<f64>() / n / REPLAYS as f64
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

/// What the fit measured, beside the settings in `pastdeal.json`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
    pub panel_sha256: String,
    pub boundaries: usize,
    pub calls_per_boundary: f64,
    pub head_error: f64,
    pub recal_error: f64,
    pub blend_error: f64,
    /// The cross-validated error at each of [`SIGMAS`].
    pub sigma_errors: Vec<f64>,
}

/// The fitted constants and what they were fitted on.
pub struct Fitted {
    pub blend: Blend,
    pub recal: Recal,
    pub measured: Measured,
}

/// [Z11-97]'s fit of `net` on the panel's bytes, `deals` deals a view,
/// `threads` views at a time. The result depends on neither the threads nor
/// their order: each view is fitted alone and the rows are kept in panel order.
pub fn fit(net: &Network, panel: &[u8], panel_sha256: String, deals: u32, threads: usize) -> Result<Fitted, String> {
    let recs: Vec<Rec> =
        read_panel(panel)?.into_iter().filter(|r| bag_len(&r.obs) >= DEAL_TILES).collect();
    if recs.len() < 50 {
        return Err(format!("only {} panel boundaries into round 5 can be dealt: too few to fit", recs.len()));
    }
    let rows: Mutex<Vec<Option<(Row, u64)>>> = Mutex::new((0..recs.len()).map(|_| None).collect());
    let next = Mutex::new(0usize);
    let failed: Mutex<Option<String>> = Mutex::new(None);
    std::thread::scope(|s| {
        for _ in 0..threads.max(1) {
            s.spawn(|| {
                loop {
                    let i = {
                        let mut n = next.lock().unwrap_or_else(|e| e.into_inner());
                        let i = *n;
                        *n += 1;
                        i
                    };
                    let Some(rec) = recs.get(i) else { break };
                    match fit_row(net, rec, deals) {
                        Ok(row) => rows.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(row),
                        Err(e) => {
                            failed.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert(e);
                        }
                    }
                }
            });
        }
    });
    if let Some(e) = failed.into_inner().unwrap_or_else(|e| e.into_inner()) {
        return Err(e);
    }
    let rows: Vec<(Row, u64)> = rows.into_inner().unwrap_or_else(|e| e.into_inner()).into_iter().flatten().collect();
    let calls: u64 = rows.iter().map(|r| r.1).sum();
    let rows: Vec<Row> = rows.into_iter().map(|r| r.0).collect();

    let (head_error, _) = cv(&rows, &|r| vec![r.v]);
    let (recal_error, w) = cv(&rows, &|r| vec![1.0, r.v]);
    let recal = Recal { a: w[0], b: w[1] };
    let mut sigma_errors = Vec::new();
    let mut best: Option<(f64, f64, Vec<f64>)> = None;
    for sigma in SIGMAS {
        let (e, w) = cv(&rows, &|r| vec![1.0, r.v, r.dealt, margin_value(r.margin, sigma)]);
        sigma_errors.push(e);
        if best.as_ref().is_none_or(|b| e < b.0) {
            best = Some((e, sigma, w));
        }
    }
    let (blend_error, sigma, w) = best.ok_or("no sigma was fitted")?;
    Ok(Fitted {
        blend: Blend { intercept: w[0], head: w[1], dealt: w[2], rollout: w[3], sigma },
        recal,
        measured: Measured {
            panel_sha256,
            boundaries: rows.len(),
            calls_per_boundary: calls as f64 / rows.len() as f64,
            head_error,
            recal_error,
            blend_error,
            sigma_errors,
        },
    })
}

fn bag_len(obs: &[f32; ENCODED_SIZE]) -> usize {
    (0..5).map(|c| usize::from(cnt(obs[OFF_BAG + c], 20.0))).sum()
}

/// One view's row: the head on it, and its rungs on the pool.
fn fit_row(net: &Network, rec: &Rec, deals: u32) -> Result<(Row, u64), String> {
    let mut e = Evaluation::default();
    net.evaluate(&rec.obs, &[], &mut e);
    let pre = pre_deal(&rec.obs);
    let state = AzulState::from_canonical(&pre, Seeded::new(0)).map_err(|e| format!("a panel view was refused: {e:?}"))?;
    let pool = Pool::of(&state, deals);
    let mut calls = 1u64;
    let mut r = Rungs::default();
    for k in 0..deals as usize {
        rungs_dealt(net, &dealt(&pre, &pool, k)?, true, &mut r, &mut calls);
    }
    let p = rec.replays.iter().map(|&x| f64::from(x)).sum::<f64>() / REPLAYS as f64;
    let s2 = rec.replays.iter().map(|&x| (f64::from(x) - p).powi(2)).sum::<f64>() / (REPLAYS - 1) as f64;
    let mean = |xs: &[f64]| xs.iter().sum::<f64>() / xs.len().max(1) as f64;
    let dealt: Vec<f64> = r.dealt.iter().map(|&x| f64::from(x)).collect();
    let margins: Vec<f64> = r.margins.iter().map(|&x| f64::from(x)).collect();
    Ok((Row { p, s2, v: f64::from(e.value), dealt: mean(&dealt), margin: mean(&margins) }, calls))
}
