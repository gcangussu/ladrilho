//! The words `play` reads and writes ([Z11-23]): [0010 C10-12]'s framing —
//! little-endian 32-bit words prefixed by their count — around
//! [0010 C10-8]'s canonical block. The latency corpus is a sequence of the
//! same messages ([Z11-38]).

use azul_engine::{Canonical, NUM_COLORS, Player};

/// No message this crate reads is longer: a canonical block is at most 238 words.
pub const MAX_MESSAGE_WORDS: usize = 1 << 16;

/// Splits a byte stream into its messages. Refuses a truncated one.
pub fn read_messages(bytes: &[u8]) -> Result<Vec<Vec<u32>>, String> {
    let mut out = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let Some(head) = bytes.get(at..at + 4) else {
            return Err(format!("a message length cut short at byte {at}"));
        };
        let n = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
        if n > MAX_MESSAGE_WORDS {
            return Err(format!("a message of {n} words"));
        }
        at += 4;
        let Some(body) = bytes.get(at..at + 4 * n) else {
            return Err(format!("a message of {n} words cut short at byte {}", bytes.len()));
        };
        out.push(body.as_chunks::<4>().0.iter().map(|w| u32::from_le_bytes(*w)).collect());
        at += 4 * n;
    }
    Ok(out)
}

/// The next message of a stream, or `None` at its end. An end inside a message
/// is refused, as `read_messages` refuses it ([Z11-72]).
pub fn read_message(input: &mut impl std::io::Read) -> Result<Option<Vec<u32>>, String> {
    let mut head = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match input.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err("a message length cut short".into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => return Err(format!("reading a message: {e}")),
        }
    }
    let n = u32::from_le_bytes(head) as usize;
    if n > MAX_MESSAGE_WORDS {
        return Err(format!("a message of {n} words"));
    }
    let mut body = vec![0u8; 4 * n];
    input
        .read_exact(&mut body)
        .map_err(|e| format!("a message of {n} words cut short: {e}"))?;
    Ok(Some(body.as_chunks::<4>().0.iter().map(|w| u32::from_le_bytes(*w)).collect()))
}

/// One message as bytes.
pub fn frame(words: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + 4 * words.len());
    out.extend_from_slice(&(words.len() as u32).to_le_bytes());
    for w in words {
        out.extend_from_slice(&w.to_le_bytes());
    }
    out
}

struct Cursor<'a> {
    words: &'a [u32],
    at: usize,
}

impl Cursor<'_> {
    fn word(&mut self, what: &str) -> Result<u32, String> {
        let w = self.words.get(self.at).copied();
        self.at += 1;
        w.ok_or_else(|| format!("the block ends before {what}"))
    }

    fn small(&mut self, what: &str, max: u32) -> Result<u32, String> {
        let w = self.word(what)?;
        if w > max {
            return Err(format!("{what} is {w}, past {max}"));
        }
        Ok(w)
    }

    fn byte(&mut self, what: &str) -> Result<u8, String> {
        Ok(self.small(what, 255)? as u8)
    }

    fn flag(&mut self, what: &str) -> Result<bool, String> {
        Ok(self.small(what, 1)? == 1)
    }

    fn bytes<const N: usize>(&mut self, what: &str) -> Result<[u8; N], String> {
        let mut out = [0; N];
        for x in out.iter_mut() {
            *x = self.byte(what)?;
        }
        Ok(out)
    }

    fn player(&mut self, what: &str) -> Result<Player, String> {
        Ok(if self.small(what, 1)? == 0 { Player::P0 } else { Player::P1 })
    }
}

/// A canonical block, in [0001 E1-62]'s field order, and nothing after it.
pub fn read_canonical(words: &[u32]) -> Result<Canonical, String> {
    let mut c = Cursor { words, at: 0 };
    let mut factories = [[0; 5]; 5];
    for f in factories.iter_mut() {
        *f = c.bytes("factories")?;
    }
    let center = c.bytes("center")?;
    let marker_in_center = c.flag("markerInCenter")?;
    let n = c.small("the bag's length", 100)?;
    let bag = (0..n).map(|_| c.byte("bag")).collect::<Result<Vec<u8>, String>>()?;
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
                return Err(format!("plColor is {w}"));
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
    let canonical = Canonical {
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
    };
    if c.at != words.len() {
        return Err(format!("{} words past the end of the block", words.len() - c.at));
    }
    Ok(canonical)
}

/// The canonical block of a snapshot.
pub fn write_canonical(c: &Canonical) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new();
    let b = |x: bool| u32::from(x);
    for f in &c.factories {
        out.extend(f.iter().map(|&x| u32::from(x)));
    }
    out.extend(c.center.iter().map(|&x| u32::from(x)));
    out.push(b(c.marker_in_center));
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
    out.extend([b(c.floor_marker[0]), b(c.floor_marker[1]), c.scores[0] as u32, c.scores[1] as u32]);
    out.extend([c.current_player as u32, c.first_player as u32, c.round_index, u32::from(c.tiles_left)]);
    out.extend([c.shuffles_used, b(c.is_terminal), b(c.exhausted)]);
    out
}
