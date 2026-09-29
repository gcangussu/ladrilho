//! The sample file ([Z11-27]): fixed-size little-endian records, the one thing
//! self-play hands the trainer.

use azul_engine::{ACTION_SPACE, Action, ENCODED_SIZE};

/// A 180-bit mask: action `a` at bit `a % 8` of byte `a / 8`.
pub const LEGAL_BYTES: usize = ACTION_SPACE.div_ceil(8);
/// `kind`, `result`, the observation, the mask, the visits.
pub const RECORD_BYTES: usize = 1 + 1 + ENCODED_SIZE * 4 + LEGAL_BYTES + ACTION_SPACE * 2;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// One per ply: the observation, the legal set, the root visits.
    Move = 0,
    /// One per non-terminal boundary ply: the pre-deal view, value only.
    Boundary = 1,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Sample {
    pub kind: Kind,
    /// The game's result from the observed seat: `+1`, `0` or `-1`.
    pub result: i8,
    pub observation: [f32; ENCODED_SIZE],
    /// All zero for a boundary sample.
    pub legal: [u8; LEGAL_BYTES],
    /// All zero for a boundary sample.
    pub visits: [u16; ACTION_SPACE],
}

/// The mask of a legal set. Actions past the space are ignored.
pub fn legal_mask(legal: &[Action]) -> [u8; LEGAL_BYTES] {
    let mut m = [0u8; LEGAL_BYTES];
    for &a in legal {
        let a = usize::from(a);
        if a < ACTION_SPACE {
            m[a / 8] |= 1 << (a % 8);
        }
    }
    m
}

/// Whether action `a` is set in a mask.
pub fn mask_has(mask: &[u8; LEGAL_BYTES], a: usize) -> bool {
    a < ACTION_SPACE && mask[a / 8] >> (a % 8) & 1 != 0
}

impl Sample {
    pub fn write(&self, out: &mut Vec<u8>) {
        out.push(self.kind as u8);
        out.push(self.result as u8);
        for x in self.observation {
            out.extend_from_slice(&x.to_le_bytes());
        }
        out.extend_from_slice(&self.legal);
        for n in self.visits {
            out.extend_from_slice(&n.to_le_bytes());
        }
    }

    /// One record. Refuses a kind or result outside the format.
    pub fn read(record: &[u8]) -> Result<Sample, String> {
        if record.len() != RECORD_BYTES {
            return Err(format!("a record of {} bytes, not {RECORD_BYTES}", record.len()));
        }
        let kind = match record[0] {
            0 => Kind::Move,
            1 => Kind::Boundary,
            k => return Err(format!("kind {k}")),
        };
        let result = record[1] as i8;
        if !(-1..=1).contains(&result) {
            return Err(format!("result {result}"));
        }
        let mut at = 2;
        let mut observation = [0f32; ENCODED_SIZE];
        for x in &mut observation {
            *x = f32::from_le_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]]);
            at += 4;
        }
        let mut legal = [0u8; LEGAL_BYTES];
        legal.copy_from_slice(&record[at..at + LEGAL_BYTES]);
        at += LEGAL_BYTES;
        let mut visits = [0u16; ACTION_SPACE];
        for n in &mut visits {
            *n = u16::from_le_bytes([record[at], record[at + 1]]);
            at += 2;
        }
        Ok(Sample { kind, result, observation, legal, visits })
    }
}

/// Every record of a sample file.
pub fn read_all(bytes: &[u8]) -> Result<Vec<Sample>, String> {
    if !bytes.len().is_multiple_of(RECORD_BYTES) {
        return Err(format!("{} bytes is not a whole number of {RECORD_BYTES}-byte records", bytes.len()));
    }
    bytes.as_chunks::<RECORD_BYTES>().0.iter().map(|r| Sample::read(r)).collect()
}
