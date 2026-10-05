//! [Z11-69]: the memo of evaluator calls self-play keeps for each game and
//! `serve` for each game it is handed ([Z11-72]), and the move `serve` makes
//! with it.

use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};

use azul_engine::{ACTION_SPACE, Action, AzulState, ENCODED_SIZE, Shuffler};

use crate::network::{Evaluation, Evaluator, Request};
use crate::search::{Search, SearchConfig, SearchResult};

/// [Z11-69]: one game's memo of evaluator calls. A call whose observation and
/// legal set equal an earlier one's gets that call's evaluation back without
/// reaching the evaluator. The forward pass is a pure function of its input
/// ([Z11-10]), so this changes no visit and no sample: the search still asks
/// once per node ([Z11-42]), and the memo answers the asks it has seen.
///
/// Measured on run `fourth`'s checkpoints, 59% of a game's calls repeat an
/// earlier one: about a quarter of them transpositions inside one search, the
/// rest the tree of the move just played, searched again from its child.
#[derive(Default)]
pub struct Memo {
    seen: HashMap<Box<[u32]>, Evaluation, BuildHasherDefault<KeyHasher>>,
}

impl Memo {
    pub fn new() -> Memo {
        Memo::default()
    }

    /// The evaluation remembered for `request`, or its key, to `insert` once
    /// the network has answered.
    pub fn lookup(&self, (observation, legal): Request<'_>) -> Result<&Evaluation, Box<[u32]>> {
        let mut buf = [0u32; KEY_WORDS];
        let k = key(observation, legal, &mut buf);
        self.seen.get(k).ok_or_else(|| k.into())
    }

    pub fn insert(&mut self, key: Box<[u32]>, eval: &Evaluation) {
        self.seen.insert(key, eval.clone());
    }

    /// Forgets every call. What the memo answers is exact however often it is
    /// emptied; emptying it is for memory.
    pub fn clear(&mut self) {
        self.seen.clear();
    }

    /// The calls it holds.
    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

/// The longest key: every observation bit, then at most every action.
const KEY_WORDS: usize = ENCODED_SIZE + ACTION_SPACE;

/// The input exactly: every observation bit, then the legal set, written into
/// `buf`. Built on the stack, so a lookup that hits allocates nothing; only a
/// miss copies its key out to be remembered.
fn key<'a>(observation: &[f32; ENCODED_SIZE], legal: &[Action], buf: &'a mut [u32; KEY_WORDS]) -> &'a [u32] {
    for (k, f) in buf.iter_mut().zip(observation) {
        *k = f.to_bits();
    }
    for (k, &a) in buf[ENCODED_SIZE..].iter_mut().zip(legal) {
        *k = u32::from(a);
    }
    &buf[..ENCODED_SIZE + legal.len().min(ACTION_SPACE)]
}

/// The memo's hasher: a multiply-and-rotate over eight bytes at a time, in the
/// manner of rustc's own FxHash. The keys are the crate's own inputs, never an
/// adversary's, so SipHash's protection buys nothing here, and costs a
/// fifth of a microsecond a lookup. Fixed, so it seeds nothing from the clock
/// or the system; a collision costs only the full key comparison the map
/// makes anyway.
#[derive(Default)]
struct KeyHasher(u64);

impl KeyHasher {
    fn add(&mut self, word: u64) {
        self.0 = (self.0.rotate_left(5) ^ word).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

impl Hasher for KeyHasher {
    fn write(&mut self, bytes: &[u8]) {
        let (words, rest) = bytes.as_chunks::<8>();
        for w in words {
            self.add(u64::from_le_bytes(*w));
        }
        for &b in rest {
            self.add(u64::from(b));
        }
    }

    fn write_usize(&mut self, n: usize) {
        self.add(n as u64);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

/// `choose` ([Z11-19]) with the memo answering what it has seen: an empty
/// tree, no noise, the most-visited action, [Z11-76]'s endgame proof, and the
/// same result `choose` gives, bit for bit ([Z11-72]). `None` for a terminal root ([Z11-62]).
pub fn choose_memoised<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    memo: &mut Memo,
) -> Option<SearchResult> {
    let mut search = Search::new(root, config, None)?;
    let mut eval = Evaluation::default();
    while let Some(request) = search.wants() {
        match memo.lookup(request) {
            Ok(e) => search.supply(e),
            Err(k) => {
                let (observation, legal) = request;
                net.evaluate(observation, legal, &mut eval);
                memo.insert(k, &eval);
                search.supply(&eval);
            }
        }
    }
    Some(crate::endgame::refine(root, search.finish().0, config.endgame_nodes).0)
}
