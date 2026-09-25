//! Shared harness: the conformance vectors, read in place ([R9-15]); the
//! recorded shuffler that replays them; snapshot diffing ([R9-16]); and the
//! per-ply invariant battery.
//!
//! Each integration test is its own crate and uses a different slice of this
//! module, hence the blanket `dead_code` allowance.
#![allow(dead_code)]

use azul_engine::{
    AzulState, Canonical, NUM_COLORS, NUM_ROWS, Player, Seeded, Shuffler, wall_color_at,
};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// The vector format this harness understands ([0002 V2-37]).
pub const SCHEMA: u64 = 1;

/// The committed vectors, where 0002 says they live ([R9-15]).
pub fn vector_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../engine/test/vectors")
}

/// The repository root, for the tests that read specs and sources.
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

pub fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Game,
    Position,
}

/// The oracle's observation vector from both seats ([0002 V2-38]).
pub type EncodedPair = [Vec<f64>; 2];

pub struct Ply {
    pub action: u8,
    /// Legal actions before the ply, ascending ([0002 V2-7]).
    pub legal: Vec<u8>,
    pub state: Canonical,
    pub encoded: Option<EncodedPair>,
}

pub struct Vector {
    pub name: String,
    pub kind: Kind,
    pub short_census: bool,
    pub shuffles: &'static [Vec<u8>],
    pub initial: Canonical,
    pub initial_encoded: Option<EncodedPair>,
    pub plies: Vec<Ply>,
    pub final_scores: [i32; 2],
    pub final_outcome: Option<i64>,
    pub final_exhausted: bool,
}

/// Replays `shuffles[index]` into the bag, keeping no cursor ([0002 V2-6]). A
/// request past the end, or for a bag the recording does not fit, is kept as a
/// fault on the shuffler and checked by the harness after every ply.
#[derive(Clone, Debug, PartialEq)]
pub struct Recorded {
    pub shuffles: &'static [Vec<u8>],
    pub fault: Option<String>,
}

impl Recorded {
    pub fn new(shuffles: &'static [Vec<u8>]) -> Self {
        Recorded { shuffles, fault: None }
    }
}

impl Shuffler for Recorded {
    fn shuffle(&mut self, bag: &mut [u8], index: u32) {
        match self.shuffles.get(index as usize) {
            None => {
                self.fault.get_or_insert(format!("shuffle index {index} past the {} recorded", self.shuffles.len()));
            }
            Some(order) if order.len() != bag.len() => {
                self.fault.get_or_insert(format!(
                    "shuffle {index}: recorded {} tiles for a bag of {}",
                    order.len(),
                    bag.len()
                ));
            }
            Some(order) => bag.copy_from_slice(order),
        }
    }
}

fn field<'a>(obj: &'a Value, key: &str, at: &str) -> &'a Value {
    obj.get(key).unwrap_or_else(|| panic!("{at}: missing `{key}` [V2-37]"))
}

fn int(v: &Value, at: &str) -> i64 {
    v.as_i64().unwrap_or_else(|| panic!("{at}: not an integer: {v}"))
}

fn ints(v: &Value, at: &str) -> Vec<i64> {
    v.as_array().unwrap_or_else(|| panic!("{at}: not an array")).iter().map(|x| int(x, at)).collect()
}

fn bytes<const N: usize>(v: &Value, at: &str) -> [u8; N] {
    let xs = ints(v, at);
    assert_eq!(xs.len(), N, "{at}: expected {N} values");
    xs.iter().map(|&x| u8::try_from(x).unwrap_or_else(|_| panic!("{at}: {x}"))).collect::<Vec<_>>().try_into().unwrap()
}

fn pair<T, const N: usize>(v: &Value, at: &str, f: impl Fn(&Value, &str) -> [T; N]) -> [[T; N]; 2] {
    let a = v.as_array().unwrap_or_else(|| panic!("{at}: not an array"));
    assert_eq!(a.len(), 2, "{at}: expected both seats");
    [f(&a[0], at), f(&a[1], at)]
}

fn boolean(v: &Value, at: &str) -> bool {
    v.as_bool().unwrap_or_else(|| panic!("{at}: not a boolean"))
}

fn player(v: &Value, at: &str) -> Player {
    match int(v, at) {
        0 => Player::P0,
        1 => Player::P1,
        x => panic!("{at}: seat {x}"),
    }
}

/// The 18 keys of a canonical state ([0002 V2-5]).
pub const CANONICAL_KEYS: [&str; 18] = [
    "factories", "center", "markerInCenter", "bag", "lid", "walls", "plColor", "plCount", "floor",
    "floorMarker", "scores", "currentPlayer", "firstPlayer", "roundIndex", "tilesLeft",
    "shufflesUsed", "isTerminal", "exhausted",
];

/// A complete canonical state, parsed into the crate's own `Canonical`
/// ([0002 V2-5]); a digest or a partial object is refused.
pub fn canonical(v: &Value, at: &str) -> Canonical {
    let obj = v.as_object().unwrap_or_else(|| panic!("{at}: not an object"));
    let mut keys: Vec<&str> = obj.keys().map(String::as_str).collect();
    keys.sort_unstable();
    let mut want = CANONICAL_KEYS.to_vec();
    want.sort_unstable();
    assert_eq!(keys, want, "{at}: canonical keys");
    let f = |k: &str| field(v, k, at);
    let factories = f("factories").as_array().unwrap_or_else(|| panic!("{at}: factories"));
    assert_eq!(factories.len(), 5, "{at}: five displays");
    Canonical {
        factories: [0, 1, 2, 3, 4].map(|i| bytes(&factories[i], at)),
        center: bytes(f("center"), at),
        marker_in_center: boolean(f("markerInCenter"), at),
        bag: ints(f("bag"), at).iter().map(|&x| x as u8).collect(),
        lid: bytes(f("lid"), at),
        walls: pair(f("walls"), at, bytes),
        pl_color: pair(f("plColor"), at, |v, at| {
            let xs = ints(v, at);
            assert_eq!(xs.len(), 5, "{at}: plColor");
            [0, 1, 2, 3, 4].map(|i| xs[i] as i8)
        }),
        pl_count: pair(f("plCount"), at, bytes),
        floor: pair(f("floor"), at, bytes),
        floor_marker: {
            let a = f("floorMarker").as_array().unwrap_or_else(|| panic!("{at}: floorMarker"));
            [boolean(&a[0], at), boolean(&a[1], at)]
        },
        scores: {
            let xs = ints(f("scores"), at);
            [xs[0] as i32, xs[1] as i32]
        },
        current_player: player(f("currentPlayer"), at),
        first_player: player(f("firstPlayer"), at),
        round_index: int(f("roundIndex"), at) as u32,
        tiles_left: int(f("tilesLeft"), at) as u8,
        shuffles_used: int(f("shufflesUsed"), at) as u32,
        is_terminal: boolean(f("isTerminal"), at),
        exhausted: boolean(f("exhausted"), at),
    }
}

fn encoded(v: &Value, at: &str) -> EncodedPair {
    let seats = v.as_array().unwrap_or_else(|| panic!("{at}: encoded must hold both seats [V2-38]"));
    assert_eq!(seats.len(), 2, "{at}: encoded must hold both seats [V2-38]");
    let seat = |s: &Value| -> Vec<f64> {
        let xs: Vec<f64> = s
            .as_array()
            .unwrap_or_else(|| panic!("{at}: encoded seat"))
            .iter()
            .map(|x| x.as_f64().unwrap_or_else(|| panic!("{at}: encoded value {x}")))
            .collect();
        assert_eq!(xs.len(), azul_engine::ENCODED_SIZE, "{at}: encoded seat length [V2-38]");
        assert!(xs.iter().all(|x| x.is_finite()), "{at}: non-finite encoded value [V2-38]");
        xs
    };
    [seat(&seats[0]), seat(&seats[1])]
}

/// Parses and validates one vector file ([0002 V2-37]).
pub fn parse_vector(name: &str, text: &str) -> Vector {
    let v: Value = serde_json::from_str(text).unwrap_or_else(|e| panic!("{name}: {e}"));
    let schema = field(&v, "schema", name).as_u64().unwrap_or_else(|| panic!("{name}: schema"));
    assert_eq!(schema, SCHEMA, "{name}: unknown schema {schema}; refusing to guess [V2-37]");
    let kind = match field(&v, "kind", name).as_str() {
        Some("game") => Kind::Game,
        Some("position") => Kind::Position,
        other => panic!("{name}: kind {other:?} [V2-37]"),
    };
    let generator = field(&v, "generator", name);
    for key in ["repo", "commit", "script", "pythonSeed"] {
        field(generator, key, name);
    }
    if kind == Kind::Game {
        field(generator, "policy", name);
    } else {
        assert!(v.get("note").and_then(Value::as_str).is_some(), "{name}: a position carries a note [V2-37]");
    }
    let short_census = match v.get("census") {
        None => false,
        Some(c) if c.as_str() == Some("short") => true,
        Some(c) => panic!("{name}: census {c}"),
    };
    let shuffles: Vec<Vec<u8>> = field(&v, "shuffles", name)
        .as_array()
        .unwrap_or_else(|| panic!("{name}: shuffles"))
        .iter()
        .map(|s| ints(s, name).iter().map(|&x| x as u8).collect())
        .collect();
    let initial = canonical(field(&v, "initial", name), &format!("{name}: initial"));
    let wants_encoded = kind == Kind::Position;
    let initial_encoded = v.get("initialEncoded").map(|e| encoded(e, &format!("{name}: initial")));
    assert_eq!(initial_encoded.is_some(), wants_encoded, "{name}: initialEncoded is for positions only [V2-38]");
    let plies = field(&v, "plies", name)
        .as_array()
        .unwrap_or_else(|| panic!("{name}: plies"))
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let at = format!("{name}: ply {i}");
            let enc = p.get("encoded").map(|e| encoded(e, &at));
            assert_eq!(enc.is_some(), wants_encoded, "{at}: encoded is for positions only [V2-38]");
            Ply {
                action: int(field(p, "action", &at), &at) as u8,
                legal: ints(field(p, "legal", &at), &at).iter().map(|&x| x as u8).collect(),
                state: canonical(field(p, "state", &at), &at),
                encoded: enc,
            }
        })
        .collect();
    let fin = field(&v, "final", name);
    let scores = ints(field(fin, "scores", name), name);
    Vector {
        name: name.to_string(),
        kind,
        short_census,
        shuffles: Box::leak(shuffles.into_boxed_slice()),
        initial,
        initial_encoded,
        plies,
        final_scores: [scores[0] as i32, scores[1] as i32],
        final_outcome: field(fin, "outcome", name).as_i64(),
        final_exhausted: boolean(field(fin, "exhausted", name), name),
    }
}

/// Every `*.json` in the vector directory, parsed once per test binary. Fails
/// when there are none: a harness that replays nothing passes everything
/// ([R9-15]).
pub fn vectors() -> &'static [Vector] {
    static ALL: OnceLock<Vec<Vector>> = OnceLock::new();
    ALL.get_or_init(|| {
        let dir = vector_dir();
        let mut names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap_or_else(|e| panic!("{}: {e}", dir.display()))
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .filter(|n| n.ends_with(".json"))
            .collect();
        names.sort();
        assert!(!names.is_empty(), "no vectors in {}", dir.display());
        names
            .iter()
            .map(|n| parse_vector(n, &std::fs::read_to_string(dir.join(n)).unwrap()))
            .collect()
    })
}

/// How a replay starts ([0002 V2-36]): a game from `new_game`, which consumes
/// shuffle 0 and is compared against `initial`; a position loaded from it.
pub fn start(v: &Vector) -> AzulState<Recorded> {
    let recorded = Recorded::new(v.shuffles);
    match v.kind {
        Kind::Game => AzulState::new_game(recorded),
        Kind::Position => AzulState::from_canonical(&v.initial, recorded)
            .unwrap_or_else(|e| panic!("{}: initial refused: {e:?}", v.name)),
    }
}

/// The first field on which two snapshots differ, by 0001's field name
/// ([R9-16]).
pub fn diff(got: &Canonical, want: &Canonical) -> Option<String> {
    macro_rules! cmp {
        ($($f:ident => $name:literal),* $(,)?) => {
            $(if got.$f != want.$f {
                return Some(format!("{}: got {:?}, want {:?}", $name, got.$f, want.$f));
            })*
        };
    }
    cmp!(
        factories => "factories", center => "center", marker_in_center => "markerInCenter",
        bag => "bag", lid => "lid", walls => "walls", pl_color => "plColor",
        pl_count => "plCount", floor => "floor", floor_marker => "floorMarker",
        scores => "scores", current_player => "currentPlayer", first_player => "firstPlayer",
        round_index => "roundIndex", tiles_left => "tilesLeft", shuffles_used => "shufflesUsed",
        is_terminal => "isTerminal", exhausted => "exhausted",
    );
    None
}

pub const FULL_CENSUS: [u8; 5] = [20; 5];

/// The structural invariants of 0001 on one snapshot: [E1-4], [E1-41],
/// [E1-42], [E1-43], [E1-44], [E1-45] and [E1-64]. Returns the first
/// violation, named by requirement.
pub fn check_invariants(c: &Canonical, previous_shuffles_used: u32) -> Option<String> {
    // [E1-41] tilesLeft equals the display and centre total.
    let board: u32 = c.center.iter().chain(c.factories.iter().flatten()).map(|&n| u32::from(n)).sum();
    if u32::from(c.tiles_left) != board {
        return Some(format!("[E1-41] tilesLeft {} != board {board}", c.tiles_left));
    }
    // [E1-42] the marker is in exactly one place.
    let places = [c.marker_in_center, c.floor_marker[0], c.floor_marker[1]].iter().filter(|&&b| b).count();
    if places != 1 {
        return Some(format!("[E1-42] marker in {places} places"));
    }
    for p in 0..2 {
        let wall = &c.walls[p];
        for r in 0..NUM_ROWS {
            let n = c.pl_count[p][r];
            let colour = c.pl_color[p][r];
            if usize::from(n) > r + 1 {
                return Some(format!("[E1-43] p{p} line {r} holds {n}"));
            }
            if n == 0 {
                if colour != -1 {
                    return Some(format!("[E1-4] p{p} line {r} empty with colour {colour}"));
                }
                continue;
            }
            if !(0..NUM_COLORS as i8).contains(&colour) {
                return Some(format!("[E1-43] p{p} line {r} colour {colour}"));
            }
            if wall[r * 5 + (colour as usize + r) % NUM_COLORS] != 0 {
                return Some(format!("[E1-43] p{p} line {r} holds colour {colour}, already on the wall"));
            }
        }
        // [E1-44] every cell 0/1, no colour twice in a row or column.
        for r in 0..5 {
            let mut row_seen = [false; 5];
            for col in 0..5 {
                let cell = wall[r * 5 + col];
                if cell > 1 {
                    return Some(format!("[E1-44] p{p} cell ({r},{col}) is {cell}"));
                }
                if cell == 1 {
                    let colour = usize::from(wall_color_at(r as u8, col as u8));
                    if std::mem::replace(&mut row_seen[colour], true) {
                        return Some(format!("[E1-44] p{p} row {r} repeats colour {colour}"));
                    }
                }
            }
        }
        for col in 0..5 {
            let mut seen = [false; 5];
            for r in 0..5 {
                if wall[r * 5 + col] == 1 {
                    let colour = usize::from(wall_color_at(r as u8, col as u8));
                    if std::mem::replace(&mut seen[colour], true) {
                        return Some(format!("[E1-44] p{p} column {col} repeats colour {colour}"));
                    }
                }
            }
        }
        // [E1-45] scores are never negative.
        if c.scores[p] < 0 {
            return Some(format!("[E1-45] p{p} score {}", c.scores[p]));
        }
    }
    // [E1-64] shufflesUsed never decreases.
    if c.shuffles_used < previous_shuffles_used {
        return Some(format!("[E1-64] shufflesUsed fell from {previous_shuffles_used} to {}", c.shuffles_used));
    }
    None
}

/// A small deterministic move picker for self-play, independent of the
/// engine's generator ([0001 E1-47]).
pub struct Picker(u64);

impl Picker {
    pub fn new(seed: u64) -> Self {
        Picker(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
    }

    pub fn below(&mut self, n: usize) -> usize {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        (self.0 % n as u64) as usize
    }
}

/// A complete seeded game played with uniformly random legal moves; returns the
/// states after each ply, the first included.
pub fn self_play(seed: u64) -> Vec<AzulState<Seeded>> {
    let mut s = AzulState::seeded(seed);
    let mut pick = Picker::new(seed);
    let mut out = vec![s.clone()];
    while !s.is_terminal() {
        let legal = s.legal_actions();
        let a = legal.as_slice()[pick.below(legal.len())];
        s.apply(a).unwrap();
        out.push(s.clone());
    }
    out
}

/// A canonical position with nothing on it but what the caller sets: empty
/// board, marker in the centre, player 0 to move. `tiles_left` is left for
/// [`settle`] to fill in.
pub fn blank() -> Canonical {
    Canonical {
        factories: [[0; 5]; 5],
        center: [0; 5],
        marker_in_center: true,
        bag: Vec::new(),
        lid: [0; 5],
        walls: [[0; 25]; 2],
        pl_color: [[-1; 5]; 2],
        pl_count: [[0; 5]; 2],
        floor: [[0; 5]; 2],
        floor_marker: [false; 2],
        scores: [0; 2],
        current_player: Player::P0,
        first_player: Player::P0,
        round_index: 0,
        tiles_left: 0,
        shuffles_used: 0,
        is_terminal: false,
        exhausted: false,
    }
}

/// Sets `tiles_left` from the board and loads the position with a seeded
/// shuffler.
pub fn settle(mut c: Canonical) -> AzulState<Seeded> {
    c.tiles_left = c.center.iter().chain(c.factories.iter().flatten()).sum();
    AzulState::from_canonical(&c, Seeded::new(0)).unwrap_or_else(|e| panic!("posed position refused: {e:?}"))
}
