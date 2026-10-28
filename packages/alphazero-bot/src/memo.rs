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
    /// The codes the keys write the observation's values in.
    codes: Codes,
}

/// A call's input as the memo keys it, once the memo has missed it: to
/// `insert` once the network has answered. The key itself when every value
/// had a code; otherwise the input, to be keyed once `insert` has given its
/// new values theirs.
pub enum Key {
    Coded(Box<[u8]>),
    Raw(Box<[f32; ENCODED_SIZE]>, Box<[Action]>),
}

/// The byte each of the first values met stands for in a key, 0 to 254;
/// a value met once all are taken is written as `ESCAPE` and its four bytes.
/// An observation holds few distinct values (the latency corpus, 71 in all:
/// counts over small divisors), so nearly every value is a byte instead of
/// four. A value keeps its code while the memo lives, and one met after the
/// codes ran out is always escaped, so each value has one way of being
/// written, and a key is still the input exactly.
#[derive(Default)]
struct Codes {
    of: std::collections::HashMap<u32, u8, BuildHasherDefault<KeyHasher>>,
}

const ESCAPE: u8 = u8::MAX;

impl Codes {
    /// `value`'s code, giving it the next free one if it has none and one is left.
    fn assign(&mut self, bits: u32) -> Option<u8> {
        let next = self.of.len();
        if let Some(&c) = self.of.get(&bits) {
            return Some(c);
        }
        (next < usize::from(ESCAPE)).then(|| {
            self.of.insert(bits, next as u8);
            next as u8
        })
    }
}

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
        // A value without a code while codes are left was in no input the
        // memo holds; once they are all taken, it is written escaped.
        let full = self.codes.of.len() >= usize::from(ESCAPE);
        let code = &mut |bits| self.codes.of.get(&bits).copied().or(full.then_some(ESCAPE));
        let Some(k) = key(observation, legal, code, &mut buf) else {
            return Err(Key::Raw(Box::new(*observation), legal.into()));
        };
        let Some(entry) = self.seen.get(k) else { return Err(Key::Coded(k.into())) };
        let mut eval = Evaluation::default();
        let mut answer = entry.answer();
        eval.value = answer.next().unwrap_or_default();
        for (&a, p) in legal.iter().zip(answer) {
            eval.policy[usize::from(a)] = p;
        }
        Ok(eval)
    }

    pub fn insert(&mut self, k: Key, eval: &Evaluation) {
        let mut buf = [0u8; KEY_BYTES];
        let (key, legal): (&[u8], usize) = match &k {
            Key::Coded(k) => (k, legal_len(k)),
            Key::Raw(observation, legal) => {
                let codes = &mut self.codes;
                // Every value can be written: given a code, or escaped.
                let coded = key(observation, legal, &mut |bits| Some(codes.assign(bits).unwrap_or(ESCAPE)), &mut buf);
                (coded.unwrap_or_default(), legal.len())
            }
        };
        let legal = &key[key.len() - legal..];
        let mut entry = Vec::with_capacity(1 + key.len() + 4 * (legal.len() + 1));
        entry.push(legal.len() as u8);
        entry.extend_from_slice(key);
        entry.extend_from_slice(&eval.value.to_le_bytes());
        for &a in legal {
            entry.extend_from_slice(&eval.policy[usize::from(a)].to_le_bytes());
        }
        self.seen.insert(Entry(entry.into_boxed_slice()));
    }

    /// Forgets every call. What the memo answers is exact however often it is
    /// emptied; emptying it is for memory. The values' codes stay: there are
    /// at most 255 of them.
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

const _: () = assert!(ACTION_SPACE <= 256);

/// The bytes of a key's mask: a bit for each input.
const MASK: usize = ENCODED_SIZE.div_ceil(8);

/// The longest key: the mask, every input escaped, then every action.
const KEY_BYTES: usize = MASK + 5 * ENCODED_SIZE + ACTION_SPACE;

/// The input exactly, written into `buf`: a mask of the inputs whose bits are
/// not zero, then each of those in order as its code (`code` of its bits, the
/// code `ESCAPE` followed by the bits themselves), then the legal set, a byte
/// an action. `None` if `code` has none for a value. Three quarters of an
/// observation is `+0` and the rest takes few values, so this is about a
/// twelfth of its bits. Built on the stack, so a lookup that hits allocates
/// nothing; only a miss copies its key out to be remembered.
///
/// Two inputs have the same key only if they are equal: the mask places the
/// values, each value is written one way, and a value's code (one byte, or
/// five beginning `ESCAPE`) says where the next begins, so the legal set is
/// the rest.
fn key<'a>(
    observation: &[f32; ENCODED_SIZE],
    legal: &[Action],
    code: &mut dyn FnMut(u32) -> Option<u8>,
    buf: &'a mut [u8; KEY_BYTES],
) -> Option<&'a [u8]> {
    buf[..MASK].fill(0);
    let mut n = MASK;
    for (i, f) in observation.iter().enumerate() {
        let bits = f.to_bits();
        if bits != 0 {
            buf[i / 8] |= 1 << (i % 8);
            let c = code(bits)?;
            buf[n] = c;
            n += 1;
            if c == ESCAPE {
                buf[n..n + 4].copy_from_slice(&bits.to_le_bytes());
                n += 4;
            }
        }
    }
    for &a in &legal[..legal.len().min(ACTION_SPACE)] {
        buf[n] = a;
        n += 1;
    }
    Some(&buf[..n])
}

/// The length of the legal set a key ends with: what its mask and codes leave.
fn legal_len(key: &[u8]) -> usize {
    let values: u32 = key[..MASK].iter().map(|b| b.count_ones()).sum();
    let mut at = MASK;
    for _ in 0..values {
        at += if key[at] == ESCAPE { 5 } else { 1 };
    }
    key.len() - at
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

#[cfg(test)]
mod tests {
    use super::*;

    /// An observation with `k`'s value at input 3, another at 40, and a
    /// value every input shares at 100.
    fn input(k: u32) -> [f32; ENCODED_SIZE] {
        let mut o = [0f32; ENCODED_SIZE];
        o[3] = 1.0 + k as f32 / 1024.0;
        o[40] = -(k as f32) - 0.5;
        o[100] = 0.25;
        o
    }

    fn answer(k: u32, legal: &[Action]) -> Evaluation {
        let mut e = Evaluation { value: k as f32 / 1000.0, ..Evaluation::default() };
        for &a in legal {
            e.policy[usize::from(a)] = k as f32 + f32::from(a);
        }
        e
    }

    /// [Z11-69]: a memo answers a call exactly when it is bit for bit an
    /// earlier one, once its values have outrun the 255 codes too, so that
    /// some are written escaped: 600 inputs of two fresh values each, then
    /// every one asked again, and each asked with a legal set it was not
    /// stored with, and with `-0` where it held `+0`.
    ///
    /// Mutations, seen red: `lookup` taking a value with no code for one never
    /// stored, as it first did ("input 127 missed": every escaped input
    /// missed for good); the escape's four bytes not written, and `legal_len`
    /// stepping one byte past an escape (each reads a key back out of bounds
    /// and panics).
    #[test]
    fn keys_are_exact_past_the_codes() {
        let legal: [Action; 3] = [2, 7, 179];
        let mut memo = Memo::new();
        for k in 0..600 {
            let o = input(k);
            let Err(key) = memo.lookup((&o, &legal)) else { panic!("input {k} hit before it was stored") };
            memo.insert(key, &answer(k, &legal));
        }
        assert_eq!(memo.len(), 600);
        assert_eq!(memo.codes.of.len(), 255, "the codes ran out, so later values were escaped");
        for k in 0..600 {
            let o = input(k);
            let e = memo.lookup((&o, &legal)).unwrap_or_else(|_| panic!("input {k} missed"));
            let want = answer(k, &legal);
            assert_eq!(e.value.to_bits(), want.value.to_bits(), "input {k}");
            for &a in &legal {
                assert_eq!(e.policy[usize::from(a)].to_bits(), want.policy[usize::from(a)].to_bits(), "input {k}");
            }
            assert!(memo.lookup((&o, &legal[..2])).is_err(), "input {k} with another legal set");
            let mut z = o;
            z[7] = -0.0;
            assert!(memo.lookup((&z, &legal)).is_err(), "input {k} with -0 for +0");
        }
    }
}
