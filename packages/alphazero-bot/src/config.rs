//! A run's settings, read from its `config.json` ([Z11-25]), and the one
//! function that turns them into a search's settings ([Z11-60]).

use serde::Deserialize;

use crate::search::{SearchConfig, SelfPlayNoise};

/// What the crate reads from `config.json`. The file holds more — the
/// trainer's settings, the loop's — which the crate ignores.
#[derive(Clone, Debug, PartialEq)]
pub struct RunConfig {
    pub width: u32,
    pub blocks: u32,
    pub seed: u64,
    /// Unset until the latency lane has measured it ([Z11-58]).
    pub play_simulations: Option<u32>,
    pub milestone_simulations: u32,
    pub self_play_simulations: u32,
    pub cpuct: f32,
    pub fpu: f32,
    pub alpha: f32,
    pub epsilon: f32,
    pub temp_plies: u32,
    pub tau: f32,
    pub threads: u32,
    pub games_per_generation: u32,
    pub max_generation_minutes: f64,
    /// [Z11-75]: playout-cap randomisation, or `None` for every move searched
    /// fully.
    pub playout_cap: Option<PlayoutCap>,
}

/// [Z11-75]: a cheap search's count, and the share of moves searched fully.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PlayoutCap {
    pub cheap_simulations: u32,
    pub full_search_fraction: f64,
}

/// The file as written, before its ranges are checked.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Raw {
    width: u64,
    blocks: u64,
    seed: u64,
    #[serde(default)]
    play_simulations: Option<u64>,
    milestone_simulations: u64,
    self_play_simulations: u64,
    cpuct: f64,
    fpu: f64,
    alpha: f64,
    epsilon: f64,
    temp_plies: u64,
    tau: f64,
    threads: u64,
    games_per_generation: u64,
    max_generation_minutes: f64,
    #[serde(default)]
    cheap_simulations: Option<u64>,
    #[serde(default)]
    full_search_fraction: Option<f64>,
}

fn whole(key: &str, n: u64, min: u64, max: u64) -> Result<u32, String> {
    if (min..=max).contains(&n) {
        Ok(n as u32)
    } else {
        Err(format!("config: \"{key}\" must be a whole number in {min}..={max}"))
    }
}

fn positive(key: &str, n: f64) -> Result<f32, String> {
    if n > 0.0 && n < 1e6 { Ok(n as f32) } else { Err(format!("config: \"{key}\" must be positive")) }
}

fn within(key: &str, n: f64, lo: f64, hi: f64) -> Result<f32, String> {
    if (lo..=hi).contains(&n) { Ok(n as f32) } else { Err(format!("config: \"{key}\" must be in [{lo}, {hi}]")) }
}

/// The most simulations a search may run: a sample stores root visits as
/// `u16` ([Z11-27]).
pub const MAX_SIMULATIONS: u64 = 65_535;

impl RunConfig {
    pub fn parse(bytes: &[u8]) -> Result<RunConfig, String> {
        let r: Raw = serde_json::from_slice(bytes).map_err(|e| format!("config: {e}"))?;
        if r.seed > 1 << 53 {
            return Err("config: \"seed\" must be at most 2^53, which every language reads exactly".into());
        }
        let self_play_simulations = whole("selfPlaySimulations", r.self_play_simulations, 1, MAX_SIMULATIONS)?;
        let playout_cap = match (r.cheap_simulations, r.full_search_fraction) {
            (None, None) => None,
            (Some(n), Some(f)) => {
                if !(f > 0.0 && f <= 1.0) {
                    return Err("config: \"fullSearchFraction\" must be in (0, 1]".into());
                }
                Some(PlayoutCap {
                    cheap_simulations: whole("cheapSimulations", n, 1, u64::from(self_play_simulations))?,
                    full_search_fraction: f,
                })
            }
            _ => {
                return Err("config: \"cheapSimulations\" and \"fullSearchFraction\" go together ([Z11-75])".into());
            }
        };
        Ok(RunConfig {
            width: whole("width", r.width, 1, u64::from(crate::network::MAX_WIDTH))?,
            blocks: whole("blocks", r.blocks, 0, 64)?,
            seed: r.seed,
            play_simulations: match r.play_simulations {
                None => None,
                Some(n) => Some(whole("playSimulations", n, 1, MAX_SIMULATIONS)?),
            },
            milestone_simulations: whole("milestoneSimulations", r.milestone_simulations, 1, MAX_SIMULATIONS)?,
            self_play_simulations,
            cpuct: positive("cpuct", r.cpuct)?,
            fpu: within("fpu", r.fpu, 0.0, 2.0)?,
            alpha: positive("alpha", r.alpha)?,
            epsilon: within("epsilon", r.epsilon, 0.0, 1.0)?,
            temp_plies: whole("tempPlies", r.temp_plies, 0, 1000)?,
            tau: positive("tau", r.tau)?,
            threads: whole("threads", r.threads, 1, 256)?,
            games_per_generation: whole("gamesPerGeneration", r.games_per_generation, 1, 1_000_000)?,
            max_generation_minutes: f64::from(positive("maxGenerationMinutes", r.max_generation_minutes)?),
            playout_cap,
        })
    }
}

/// Which search a command runs ([Z11-60]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SearchKind {
    /// `play --search play`: the shipped count.
    Play,
    /// `play --search milestone`.
    Milestone,
    /// `selfplay` and `throughput`: noise, temperature, threads.
    SelfPlay,
    /// `latency`: the shipped count, or the override that steps it ([Z11-57]).
    Latency(Option<u32>),
}

/// Everything a command needs to search, from one place.
#[derive(Clone, Debug, PartialEq)]
pub struct Settings {
    pub search: SearchConfig,
    /// Self-play only.
    pub noise: Option<SelfPlayNoise>,
    pub temp_plies: u32,
    pub tau: f32,
    pub threads: u32,
    /// Self-play only ([Z11-75]).
    pub playout_cap: Option<PlayoutCap>,
}

/// The only place in the crate that reads search settings ([Z11-60]).
pub fn settings(config: &RunConfig, kind: SearchKind) -> Result<Settings, String> {
    let simulations = match kind {
        SearchKind::Play => config.play_simulations.ok_or(
            "playSimulations is unset: the latency lane has not measured this run yet ([Z11-58])",
        )?,
        SearchKind::Milestone => config.milestone_simulations,
        SearchKind::SelfPlay => config.self_play_simulations,
        SearchKind::Latency(Some(n)) => {
            if n == 0 || u64::from(n) > MAX_SIMULATIONS {
                return Err(format!("--simulations must be in 1..={MAX_SIMULATIONS}"));
            }
            n
        }
        SearchKind::Latency(None) => config.play_simulations.ok_or(
            "playSimulations is unset, so latency needs --simulations ([Z11-58])",
        )?,
    };
    let noise = (kind == SearchKind::SelfPlay)
        .then_some(SelfPlayNoise { alpha: config.alpha, epsilon: config.epsilon });
    Ok(Settings {
        search: SearchConfig { simulations, cpuct: config.cpuct, fpu: config.fpu },
        noise,
        temp_plies: config.temp_plies,
        tau: config.tau,
        threads: config.threads,
        playout_cap: if kind == SearchKind::SelfPlay { config.playout_cap } else { None },
    })
}
