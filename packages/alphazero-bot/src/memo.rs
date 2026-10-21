//! [Z11-69]: the memo of evaluator calls self-play keeps for each game and
//! `serve` for each game it is handed ([Z11-72]), and the move `serve` makes
//! with it.

use std::borrow::{Borrow, BorrowMut};
use std::collections::HashSet;
use std::hash::{BuildHasherDefault, Hash, Hasher};

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
    seen: HashSet<Entry, BuildHasherDefault<KeyHasher>>,
}

/// A call's input as the memo keys it, once the memo has missed it: to
/// `insert` once the network has answered.
pub struct Key(Box<[u8]>);

/// One remembered call, in one allocation: the legal set's length, the key,
/// the value's bits, then the policy's over the legal set in the key's order.
/// Nothing else of the policy is kept, and a hit answers zero there: the
/// search reads a policy at the request's legal actions only, and the forward
/// pass leaves it zero elsewhere anyway ([Z11-6]).
struct Entry(Box<[u8]>);

impl Entry {
    fn legal(&self) -> usize {
        usize::from(self.0[0])
    }

    fn key(&self) -> &[u8] {
        &self.0[1..self.0.len() - 4 * (self.legal() + 1)]
    }

    /// The value, then the legal set's probabilities.
    fn answer(&self) -> impl Iterator<Item = f32> + '_ {
        let (words, _) = self.0[self.0.len() - 4 * (self.legal() + 1)..].as_chunks::<4>();
        words.iter().map(|w| f32::from_le_bytes(*w))
    }
}

impl Borrow<[u8]> for Entry {
    fn borrow(&self) -> &[u8] {
        self.key()
    }
}

impl Hash for Entry {
    fn hash<H: Hasher>(&self, h: &mut H) {
        self.key().hash(h);
    }
}

impl PartialEq for Entry {
    fn eq(&self, other: &Entry) -> bool {
        self.key() == other.key()
    }
}

impl Eq for Entry {}

impl Memo {
    pub fn new() -> Memo {
        Memo::default()
    }

    /// The evaluation remembered for `request`, or its key, to `insert` once
    /// the network has answered.
    pub fn lookup(&self, (observation, legal): Request<'_>) -> Result<Evaluation, Key> {
        let mut buf = [0u8; KEY_BYTES];
        let k = key(observation, legal, &mut buf);
        let Some(entry) = self.seen.get(k) else { return Err(Key(k.into())) };
        let mut eval = Evaluation::default();
        let mut answer = entry.answer();
        eval.value = answer.next().unwrap_or_default();
        for (&a, p) in legal.iter().zip(answer) {
            eval.policy[usize::from(a)] = p;
        }
        Ok(eval)
    }

    pub fn insert(&mut self, Key(key): Key, eval: &Evaluation) {
        let legal = legal_of(&key);
        let mut entry = Vec::with_capacity(1 + key.len() + 4 * (legal.len() + 1));
        entry.push(legal.len() as u8);
        entry.extend_from_slice(&key);
        entry.extend_from_slice(&eval.value.to_le_bytes());
        for &a in legal {
            entry.extend_from_slice(&eval.policy[usize::from(a)].to_le_bytes());
        }
        self.seen.insert(Entry(entry.into_boxed_slice()));
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

/// Ends the observation's part of a key: no input index is this large.
const SEPARATOR: u8 = u8::MAX;
const _: () = assert!(ENCODED_SIZE < SEPARATOR as usize && ACTION_SPACE <= 256);

/// The longest key: every observation bit with its index, the separator, then
/// at most every action.
const KEY_BYTES: usize = 5 * ENCODED_SIZE + 1 + ACTION_SPACE;

/// The input exactly, written into `buf`: each observation float whose bits
/// are not zero as its index and its bits, then the separator, then the legal
/// set, a byte an action. Three quarters of an observation is `+0`, so this is
/// a quarter of its bits. Built on the stack, so a lookup that hits allocates
/// nothing; only a miss copies its key out to be remembered.
fn key<'a>(observation: &[f32; ENCODED_SIZE], legal: &[Action], buf: &'a mut [u8; KEY_BYTES]) -> &'a [u8] {
    let mut n = 0;
    for (i, f) in observation.iter().enumerate() {
        let bits = f.to_bits();
        if bits != 0 {
            buf[n] = i as u8;
            buf[n + 1..n + 5].copy_from_slice(&bits.to_le_bytes());
            n += 5;
        }
    }
    buf[n] = SEPARATOR;
    n += 1;
    for &a in &legal[..legal.len().min(ACTION_SPACE)] {
        buf[n] = a;
        n += 1;
    }
    &buf[..n]
}

/// The legal set a key ends with.
fn legal_of(key: &[u8]) -> &[Action] {
    let mut at = 0;
    while key[at] != SEPARATOR {
        at += 5;
    }
    &key[at + 1..]
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
///
/// The memo is `&mut Memo` to keep it for the next move, or a `Memo` to be done
/// with it: then it is dropped before the proof, so the proof's table has the
/// room the search's tree and memo held, rather than what lies between the
/// memo's entries.
pub fn choose_memoised<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    mut memo: impl BorrowMut<Memo>,
) -> Option<SearchResult> {
    let r = search_memoised_until(net, root, config, memo.borrow_mut(), &mut || false)?;
    drop(memo);
    Some(crate::endgame::refine(root, r, config.endgame_nodes).0)
}

/// The search of `choose_memoised`, without the endgame proof, asking `stop`
/// before each evaluation it hands the search, and after each whole
/// simulation, whether to stop ([Z11-78]). `serve` calls this and the proof apart,
/// to time them apart ([Z11-79]).
pub fn search_memoised_until<S: Shuffler, E: Evaluator>(
    net: &E,
    root: &AzulState<S>,
    config: &SearchConfig,
    memo: &mut Memo,
    stop: &mut dyn FnMut() -> bool,
) -> Option<SearchResult> {
    let mut search = Search::new(root, config, None)?;
    let mut eval = Evaluation::default();
    let mut stopped = false;
    while search.wants().is_some() {
        // The simulation in flight needs this evaluation whatever `stop`
        // says, so asking first changes nothing.
        if !stopped && stop() {
            stopped = true;
            search.stop();
        }
        let Some(request) = search.wants() else { break };
        let after: &mut dyn FnMut() -> bool = if stopped { &mut || false } else { &mut *stop };
        match memo.lookup(request) {
            Ok(e) => search.supply_until(&e, after),
            Err(k) => {
                let (observation, legal) = request;
                net.evaluate(observation, legal, &mut eval);
                memo.insert(k, &eval);
                search.supply_until(&eval, after);
            }
        }
    }
    Some(search.finish().0)
}
