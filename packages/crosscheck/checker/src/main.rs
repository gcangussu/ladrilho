//! The checker of spec 0010: replays a game on the Rust engine and reports, in
//! the ply-record layout of [C10-8], what the engine said about every position.
//!
//! It decides nothing. The driver plays the game on the TypeScript engine,
//! sends the game input here, and compares what comes back ([C10-12]).
//!
//! Synchronous, safe, and panic-free on any input ([C10-2]): a malformed
//! message is an error exit with a message on stderr, never a panic.

#![forbid(unsafe_code)]
#![allow(clippy::needless_range_loop)]

use azul_engine::{AzulState, Canonical, NUM_COLORS, Outcome, Player, RoundScoring, Shuffler};
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::process::ExitCode;

/// Record status words ([C10-8]).
const DESCRIBED: u32 = 0;
const REJECTED: u32 = 1;
const START_REJECTED: u32 = 2;
const SEAM_MISUSED: u32 = 3;

/// Far past any lawful game; a length beyond it is a corrupt stream, not a game.
const MAX_MESSAGE_WORDS: usize = 1 << 22;

/// A message that does not parse. Carries a sentence for stderr.
struct Malformed(String);

type Parsed<T> = Result<T, Malformed>;

/// What went wrong at the shuffle seam, if anything ([C10-13]).
#[derive(Clone, Debug, PartialEq, Eq)]
enum Fault {
    /// The engine asked for an `index` the game input holds no order for.
    Missing(u32),
    /// The bag handed over is not a permutation of the recorded order.
    NotPermutation(u32),
}

/// Writes `recorded[index]` into the bag, and nothing that is not a
/// permutation of the bag it was handed ([C10-13]).
#[derive(Clone, Debug, PartialEq, Eq)]
struct Recorded {
    orders: Vec<Vec<u8>>,
    fault: Option<Fault>,
}

impl Shuffler for Recorded {
    fn shuffle(&mut self, bag: &mut [u8], index: u32) {
        let Some(order) = self.orders.get(index as usize) else {
            self.fault.get_or_insert(Fault::Missing(index));
            return;
        };
        if census(bag) != census(order) || bag.len() != order.len() {
            self.fault.get_or_insert(Fault::NotPermutation(index));
            return;
        }
        bag.copy_from_slice(order);
    }
}

fn census(tiles: &[u8]) -> [usize; 256] {
    let mut out = [0; 256];
    for &t in tiles {
        out[t as usize] += 1;
    }
    out
}

/// Reads words off a message, refusing to run past its end.
struct Cursor<'a> {
    words: &'a [u32],
    at: usize,
}

impl Cursor<'_> {
    fn word(&mut self, what: &str) -> Parsed<u32> {
        let w = self.words.get(self.at).copied();
        self.at += 1;
        w.ok_or_else(|| Malformed(format!("message ends before {what}")))
    }

    fn small(&mut self, what: &str, max: u32) -> Parsed<u32> {
        let w = self.word(what)?;
        if w > max {
            return Err(Malformed(format!("{what} is {w}, past {max}")));
        }
        Ok(w)
    }

    fn byte(&mut self, what: &str) -> Parsed<u8> {
        Ok(self.small(what, 255)? as u8)
    }

    fn flag(&mut self, what: &str) -> Parsed<bool> {
        Ok(self.small(what, 1)? == 1)
    }

    fn bytes<const N: usize>(&mut self, what: &str) -> Parsed<[u8; N]> {
        let mut out = [0; N];
        for x in out.iter_mut() {
            *x = self.byte(what)?;
        }
        Ok(out)
    }

    fn player(&mut self, what: &str) -> Parsed<Player> {
        Ok(if self.small(what, 1)? == 0 {
            Player::P0
        } else {
            Player::P1
        })
    }

    /// A length-prefixed list of bytes, at most `max` long.
    fn list(&mut self, what: &str, max: u32) -> Parsed<Vec<u8>> {
        let n = self.small(what, max)?;
        (0..n).map(|_| self.byte(what)).collect()
    }

    fn done(&self) -> Parsed<()> {
        if self.at == self.words.len() {
            Ok(())
        } else {
            Err(Malformed(format!(
                "{} words past the end of the message",
                self.words.len() - self.at
            )))
        }
    }
}

/// The canonical block of [C10-8], in 0001 [E1-62]'s field order.
fn read_canonical(c: &mut Cursor) -> Parsed<Canonical> {
    let mut factories = [[0; 5]; 5];
    for f in factories.iter_mut() {
        *f = c.bytes("factories")?;
    }
    let center = c.bytes("center")?;
    let marker_in_center = c.flag("markerInCenter")?;
    let bag = c.list("bag", 100)?;
    let lid = c.bytes("lid")?;
    let mut walls = [[0; 25]; 2];
    for w in walls.iter_mut() {
        *w = c.bytes("walls")?;
    }
    let mut pl_color = [[0i8; 5]; 2];
    for p in pl_color.iter_mut() {
        for x in p.iter_mut() {
            let w = c.word("plColor")? as i32;
            if !(-1..NUM_COLORS as i32).contains(&w) {
                return Err(Malformed(format!("plColor is {w}")));
            }
            *x = w as i8;
        }
    }
    let mut pl_count = [[0; 5]; 2];
    for p in pl_count.iter_mut() {
        *p = c.bytes("plCount")?;
    }
    let mut floor = [[0; 5]; 2];
    for p in floor.iter_mut() {
        *p = c.bytes("floor")?;
    }
    let floor_marker = [c.flag("floorMarker")?, c.flag("floorMarker")?];
    let scores = [c.word("scores")? as i32, c.word("scores")? as i32];
    Ok(Canonical {
        factories,
        center,
        marker_in_center,
        bag,
        lid,
        walls,
        pl_color,
        pl_count,
        floor,
        floor_marker,
        scores,
        current_player: c.player("currentPlayer")?,
        first_player: c.player("firstPlayer")?,
        round_index: c.word("roundIndex")?,
        tiles_left: c.byte("tilesLeft")?,
        shuffles_used: c.word("shufflesUsed")?,
        is_terminal: c.flag("isTerminal")?,
        exhausted: c.flag("exhausted")?,
    })
}

struct Game {
    start: Option<Canonical>,
    shuffles: Vec<Vec<u8>>,
    actions: Vec<u8>,
    probes: Vec<u8>,
}

/// A game message of [C10-12]. The game index is read and not used: the
/// checker holds nothing between games ([C10-15]).
fn read_game(words: &[u32]) -> Parsed<Game> {
    let mut c = Cursor { words, at: 0 };
    c.word("the game index")?;
    c.word("the game index")?;
    let start = match c.small("the start kind", 1)? {
        0 => None,
        _ => Some(read_canonical(&mut c)?),
    };
    let count = c.word("the shuffle count")?;
    let mut shuffles = Vec::new();
    for _ in 0..count {
        shuffles.push(c.list("a shuffle", 100)?);
    }
    let n = c.word("the action count")?;
    let actions = (0..n)
        .map(|_| c.byte("an action"))
        .collect::<Parsed<Vec<u8>>>()?;
    let m = c.word("the probe count")?;
    if m as usize != actions.len() + 1 {
        return Err(Malformed(format!(
            "{m} probes for {n} actions; one per record"
        )));
    }
    let probes = (0..m)
        .map(|_| c.byte("a probe"))
        .collect::<Parsed<Vec<u8>>>()?;
    c.done()?;
    Ok(Game {
        start,
        shuffles,
        actions,
        probes,
    })
}

fn push_canonical(out: &mut Vec<u32>, c: &Canonical) {
    for f in &c.factories {
        out.extend(f.iter().map(|&x| u32::from(x)));
    }
    out.extend(c.center.iter().map(|&x| u32::from(x)));
    out.push(u32::from(c.marker_in_center));
    out.push(c.bag.len() as u32);
    out.extend(c.bag.iter().map(|&x| u32::from(x)));
    out.extend(c.lid.iter().map(|&x| u32::from(x)));
    for w in &c.walls {
        out.extend(w.iter().map(|&x| u32::from(x)));
    }
    for p in &c.pl_color {
        out.extend(p.iter().map(|&x| i32::from(x) as u32));
    }
    for p in &c.pl_count {
        out.extend(p.iter().map(|&x| u32::from(x)));
    }
    for p in &c.floor {
        out.extend(p.iter().map(|&x| u32::from(x)));
    }
    out.extend(c.floor_marker.iter().map(|&x| u32::from(x)));
    out.extend(c.scores.iter().map(|&x| x as u32));
    out.push(c.current_player.index() as u32);
    out.push(c.first_player.index() as u32);
    out.push(c.round_index);
    out.push(u32::from(c.tiles_left));
    out.push(c.shuffles_used);
    out.push(u32::from(c.is_terminal));
    out.push(u32::from(c.exhausted));
}

/// The `record` block of [C10-9]: 0007's `RoundScoring` in declaration order.
fn push_scoring(out: &mut Vec<u32>, r: Option<&RoundScoring>) {
    let Some(r) = r else {
        out.push(0);
        return;
    };
    out.push(1);
    out.push(r.round);
    for p in &r.players {
        out.push(p.placements.len() as u32);
        for x in &p.placements {
            out.extend([
                u32::from(x.row),
                u32::from(x.col),
                u32::from(x.h),
                u32::from(x.v),
            ]);
            out.push(x.points as u32);
        }
        out.push(p.tiling as u32);
        out.push(u32::from(p.floor.occupied));
        out.push(p.floor.rungs.len() as u32);
        out.extend(p.floor.rungs.iter().map(|&x| x as u32));
        out.push(u32::from(p.floor.marker_held));
        out.push(p.floor.penalty as u32);
        out.push(p.score_before as u32);
        out.push(p.score_after_round as u32);
        out.push(p.forgiven as u32);
    }
    match &r.bonuses {
        None => out.push(0),
        Some(b) => {
            out.push(1);
            for p in b {
                out.extend([u32::from(p.rows), u32::from(p.cols), u32::from(p.colors)]);
                out.extend(
                    [
                        p.row_points,
                        p.col_points,
                        p.color_points,
                        p.total,
                        p.score_before,
                        p.score_after,
                    ]
                    .iter()
                    .map(|&x| x as u32),
                );
            }
        }
    }
}

/// One ply record of [C10-8], describing `s` as it stands.
fn push_record(
    out: &mut Vec<u32>,
    status: u32,
    s: &AzulState<Recorded>,
    probe: u8,
    scoring: Option<&RoundScoring>,
) {
    out.push(status);
    push_canonical(out, &s.to_canonical());
    let legal = s.legal_actions();
    out.push(legal.len() as u32);
    out.extend(legal.as_slice().iter().map(|&a| u32::from(a)));
    out.push(u32::from(probe));
    out.push(u32::from(s.is_legal(probe)));
    out.push(match s.outcome() {
        None => 2,
        Some(Outcome::Player0) => 1,
        Some(Outcome::Draw) => 0,
        Some(Outcome::Player1) => -1i32 as u32,
    });
    out.extend(s.tile_census().iter().map(|&x| u32::from(x)));
    for p in [Player::P0, Player::P1] {
        out.push(s.floor_penalty(p) as u32);
        out.push(u32::from(s.completed_rows(p)));
        out.push(u32::from(s.completed_cols(p)));
        out.push(u32::from(s.completed_colors(p)));
    }
    for p in [Player::P0, Player::P1] {
        out.extend(s.encode_for(p).iter().map(|x| x.to_bits()));
    }
    push_scoring(out, scoring);
}

/// Replays one game and returns its records, record count first ([C10-12]).
fn replay(game: Game) -> Vec<u32> {
    let mut records = Vec::new();
    let mut count = 0u32;
    let shuffler = Recorded {
        orders: game.shuffles,
        fault: None,
    };
    let built = match &game.start {
        None => Ok(AzulState::new_game(shuffler)),
        Some(c) => AzulState::from_canonical(c, shuffler),
    };
    let mut s = match built {
        Ok(s) => s,
        Err(_) => return vec![1, START_REJECTED],
    };
    let seam = |s: &AzulState<Recorded>| {
        if s.shuffler().fault.is_some() {
            SEAM_MISUSED
        } else {
            DESCRIBED
        }
    };
    let status = seam(&s);
    push_record(&mut records, status, &s, game.probes[0], None);
    count += 1;
    if status == DESCRIBED {
        for (k, &action) in game.actions.iter().enumerate() {
            let probe = game.probes[k + 1];
            let (status, scoring) = match s.apply_explained(action) {
                Err(_) => (REJECTED, None),
                Ok(scoring) => (seam(&s), scoring),
            };
            push_record(&mut records, status, &s, probe, scoring.as_ref());
            count += 1;
            if status != DESCRIBED {
                break;
            }
        }
    }
    if let Some(fault) = &s.shuffler().fault {
        eprintln!("checker: shuffle seam misused: {fault:?}");
    }
    let mut out = Vec::with_capacity(records.len() + 1);
    out.push(count);
    out.extend(records);
    out
}

/// Reads one length-prefixed message; `None` at a clean end of input.
fn read_message(input: &mut impl Read) -> io::Result<Option<Vec<u32>>> {
    let mut head = [0u8; 4];
    match input.read_exact(&mut head) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let n = u32::from_le_bytes(head) as usize;
    if n > MAX_MESSAGE_WORDS {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a message of {n} words"),
        ));
    }
    let mut body = vec![0u8; n * 4];
    input.read_exact(&mut body)?;
    Ok(Some(
        body.as_chunks::<4>()
            .0
            .iter()
            .map(|w| u32::from_le_bytes(*w))
            .collect(),
    ))
}

fn write_message(output: &mut impl Write, words: &[u32]) -> io::Result<()> {
    output.write_all(&(words.len() as u32).to_le_bytes())?;
    for w in words {
        output.write_all(&w.to_le_bytes())?;
    }
    output.flush()
}

fn main() -> ExitCode {
    let mut input = BufReader::new(io::stdin().lock());
    let mut output = BufWriter::new(io::stdout().lock());
    loop {
        let words = match read_message(&mut input) {
            Ok(Some(words)) => words,
            Ok(None) => return ExitCode::SUCCESS,
            Err(e) => {
                eprintln!("checker: reading a message: {e}");
                return ExitCode::from(2);
            }
        };
        let game = match read_game(&words) {
            Ok(game) => game,
            Err(Malformed(why)) => {
                eprintln!("checker: malformed game message: {why}");
                return ExitCode::from(2);
            }
        };
        if let Err(e) = write_message(&mut output, &replay(game)) {
            eprintln!("checker: writing a reply: {e}");
            return ExitCode::from(2);
        }
    }
}
