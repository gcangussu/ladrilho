//! The parity corpus ([Z11-55]) and parity files ([Z11-12]).
//!
//! The corpus is compiled in, so a parity check needs only a checkpoint and
//! the parity file PyTorch wrote beside it.

use std::sync::OnceLock;

use azul_engine::{AzulState, ENCODED_SIZE};

use crate::network::{LoadError, POLICY};
use crate::rng::Rng;
use crate::samples::{LEGAL_BYTES, legal_mask};
use sha2::{Digest, Sha256};
use crate::view::{is_boundary, pre_deal_view};

/// The committed corpus, `train/parity-corpus.bin`.
pub const CORPUS_BYTES: &[u8] = include_bytes!("../train/parity-corpus.bin");
pub const CORPUS_COUNT: usize = 64;
const CORPUS_MAGIC: &[u8; 4] = b"AZPC";
const PARITY_MAGIC: &[u8; 4] = b"AZPF";
const VERSION: u32 = 1;
const ENTRY_BYTES: usize = ENCODED_SIZE * 4 + LEGAL_BYTES;

/// One corpus entry: an observation and its legal mask ([Z11-27]'s layout),
/// all zero for a pre-deal view.
#[derive(Clone, Debug, PartialEq)]
pub struct CorpusEntry {
    pub observation: [f32; ENCODED_SIZE],
    pub legal: [u8; LEGAL_BYTES],
}

/// What PyTorch computed for one corpus entry.
#[derive(Clone, Debug, PartialEq)]
pub struct Expected {
    pub logits: [f32; POLICY],
    pub value: f32,
}

fn u32_at(b: &[u8], at: usize) -> Option<u32> {
    let w: [u8; 4] = b.get(at..at + 4)?.try_into().ok()?;
    Some(u32::from_le_bytes(w))
}

/// Parses a corpus file.
pub fn read_corpus(bytes: &[u8]) -> Result<Vec<CorpusEntry>, String> {
    if bytes.get(0..4) != Some(CORPUS_MAGIC) {
        return Err("parity corpus: magic is not AZPC".into());
    }
    if u32_at(bytes, 4) != Some(VERSION) {
        return Err("parity corpus: version is not 1".into());
    }
    let count = u32_at(bytes, 8).ok_or("parity corpus: no count")? as usize;
    if count != CORPUS_COUNT {
        return Err(format!("parity corpus: count {count}, not {CORPUS_COUNT}"));
    }
    if bytes.len() != 12 + count * ENTRY_BYTES {
        return Err(format!("parity corpus: {} bytes, not {}", bytes.len(), 12 + count * ENTRY_BYTES));
    }
    Ok(bytes[12..]
        .as_chunks::<ENTRY_BYTES>()
        .0
        .iter()
        .map(|e| {
            let mut observation = [0f32; ENCODED_SIZE];
            for (x, w) in observation.iter_mut().zip(e[..ENCODED_SIZE * 4].as_chunks::<4>().0) {
                *x = f32::from_le_bytes(*w);
            }
            let mut legal = [0u8; LEGAL_BYTES];
            legal.copy_from_slice(&e[ENCODED_SIZE * 4..]);
            CorpusEntry { observation, legal }
        })
        .collect())
}

/// The compiled-in corpus. Empty only while it is being bootstrapped, before
/// `train/parity-corpus.bin` has been written for the first time.
pub fn corpus() -> &'static [CorpusEntry] {
    static CORPUS: OnceLock<Vec<CorpusEntry>> = OnceLock::new();
    CORPUS.get_or_init(|| read_corpus(CORPUS_BYTES).unwrap_or_default())
}

/// The sha256 of the compiled-in corpus, which every parity file names.
pub fn corpus_sha256() -> [u8; 32] {
    Sha256::digest(CORPUS_BYTES).into()
}

fn parity_error(field: &'static str, detail: impl Into<String>) -> LoadError {
    LoadError::ParityFile { field, detail: detail.into() }
}

/// Parses a parity file and holds it to the compiled-in corpus ([Z11-12]): a
/// file computed on another corpus is refused as that, not as a mismatch.
pub fn read_parity(bytes: &[u8]) -> Result<Vec<Expected>, LoadError> {
    if bytes.get(0..4) != Some(PARITY_MAGIC) {
        return Err(parity_error("magic", "not AZPF"));
    }
    if u32_at(bytes, 4) != Some(VERSION) {
        return Err(parity_error("version", "not 1"));
    }
    let Some(hash) = bytes.get(8..40) else {
        return Err(parity_error("corpus", "the file ends inside the corpus hash"));
    };
    let expected = corpus_sha256();
    if hash != expected {
        return Err(LoadError::ParityCorpus { expected: hex::encode(expected), found: hex::encode(hash) });
    }
    let count = u32_at(bytes, 40).ok_or_else(|| parity_error("count", "missing"))? as usize;
    if count != corpus().len() || count == 0 {
        return Err(parity_error("count", format!("{count}, but the corpus holds {}", corpus().len())));
    }
    let per = (POLICY + 1) * 4;
    if bytes.len() != 44 + count * per {
        return Err(parity_error("length", format!("{} bytes, not {}", bytes.len(), 44 + count * per)));
    }
    Ok(bytes[44..]
        .chunks_exact(per)
        .map(|e| {
            let floats: Vec<f32> = e.as_chunks::<4>().0.iter().map(|w| f32::from_le_bytes(*w)).collect();
            let mut logits = [0f32; POLICY];
            logits.copy_from_slice(&floats[..POLICY]);
            Expected { logits, value: floats[POLICY] }
        })
        .collect())
}

/// Writes the corpus from recorded-seed games ([Z11-55]): from game `i` of 32,
/// one ordinary position and one pre-deal view, so half are each. Moves are
/// uniform from the crate's own generator. Done once; the file is committed,
/// and every parity file ever written names its hash.
pub fn generate_corpus() -> Vec<u8> {
    let mut ordinary: Vec<CorpusEntry> = Vec::new();
    let mut views: Vec<CorpusEntry> = Vec::new();
    for i in 0..(CORPUS_COUNT / 2) as u64 {
        let seed = 20_260_929 + i * 7_919;
        let mut s = AzulState::seeded(seed);
        let mut rng = Rng::new(seed);
        let mut positions = Vec::new();
        let mut boundaries = Vec::new();
        while !s.is_terminal() {
            let legal = s.legal_actions();
            positions.push(CorpusEntry { observation: s.encode(), legal: legal_mask(legal.as_slice()) });
            let a = legal.as_slice()[rng.below(legal.len() as u64) as usize];
            let before = s.clone();
            if s.apply(a).is_err() {
                break;
            }
            if is_boundary(&before, &s) && !s.is_terminal() {
                boundaries.push(CorpusEntry { observation: pre_deal_view(&before, &s), legal: [0; LEGAL_BYTES] });
            }
        }
        let i = i as usize;
        ordinary.push(positions[(i * 11 + 3) % positions.len()].clone());
        views.push(boundaries[i % boundaries.len()].clone());
    }
    let mut out = Vec::new();
    out.extend_from_slice(CORPUS_MAGIC);
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&(CORPUS_COUNT as u32).to_le_bytes());
    for e in ordinary.iter().zip(&views).flat_map(|(a, b)| [a, b]) {
        for x in e.observation {
            out.extend_from_slice(&x.to_le_bytes());
        }
        out.extend_from_slice(&e.legal);
    }
    out
}

