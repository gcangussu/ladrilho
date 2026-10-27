//! The raw exports JavaScript calls ([T12-3], [T12-5]): numbers and one
//! buffer of words cross the boundary, and nothing else. The only module of
//! the crate allowed `unsafe`, for two reasons: `#[unsafe(no_mangle)]` is how
//! a function reaches JavaScript without a bindings crate, and the two byte
//! buffers `load` reads arrive as pointers.
//!
//! wasm32-unknown-unknown runs one thread, so the state lives in one
//! thread-local and its buffers never move once allocated.

use std::cell::RefCell;

use crate::{Player, Refusal};

/// Room for one canonical block: [0010 C10-8]'s is at most 238 words.
pub const WORDS: usize = 512;

struct State {
    player: Option<Player>,
    words: Box<[u32; WORDS]>,
    value: f32,
    error: String,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State {
        player: None,
        words: Box::new([0; WORDS]),
        value: 0.0,
        error: String::new(),
    });
}

fn with<R>(f: impl FnOnce(&mut State) -> R) -> R {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// A buffer of `len` bytes for JavaScript to fill, for `load`, which frees it.
#[unsafe(no_mangle)]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    Box::leak(vec![0u8; len].into_boxed_slice()).as_mut_ptr()
}

/// The checkpoint, parity file and `pastdeal.json` JavaScript wrote at three
/// `alloc`ed buffers (the last empty for none), the milestone's search
/// settings, and the shipped endgame node cap ([T12-33]). `0`, or `-1` with
/// the error set; a refused refinement refuses the load, so no player is
/// ever loaded without the settings it was given ([T12-36]). The buffers are
/// freed: the network keeps what it needs of the checkpoint in its own form,
/// and linear memory never shrinks, so a search reuses their room rather
/// than growing.
///
/// # Safety
///
/// `ck`, `par` and `pd` must each be a buffer `alloc` returned for exactly
/// `ck_len`, `par_len` and `pd_len` bytes respectively, and none used again.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn load(
    ck: *const u8,
    ck_len: usize,
    par: *const u8,
    par_len: usize,
    cpuct: f32,
    fpu: f32,
    endgame_nodes: u32,
    pd: *const u8,
    pd_len: usize,
) -> i32 {
    // SAFETY: the caller's contract above: each pointer is a buffer `alloc`
    // leaked at exactly that length, so it is a `Box<[u8]>` to take back.
    let (checkpoint, parity, past_deal) = unsafe {
        (
            Box::from_raw(std::ptr::slice_from_raw_parts_mut(ck.cast_mut(), ck_len)),
            Box::from_raw(std::ptr::slice_from_raw_parts_mut(par.cast_mut(), par_len)),
            Box::from_raw(std::ptr::slice_from_raw_parts_mut(pd.cast_mut(), pd_len)),
        )
    };
    let loaded = Player::load(&checkpoint, &parity, cpuct, fpu, endgame_nodes, &past_deal);
    drop((checkpoint, parity, past_deal));
    with(|s| match loaded {
        Ok(p) => {
            s.player = Some(p);
            0
        }
        Err(e) => {
            s.error = e;
            -1
        }
    })
}

/// Where JavaScript writes a canonical block: `WORDS` words.
#[unsafe(no_mangle)]
pub extern "C" fn words_ptr() -> *mut u32 {
    with(|s| s.words.as_mut_ptr())
}

/// The move for the block of `n_words` at `words_ptr`: the action, `-1` for a
/// terminal position, `-2` for a refused block or a missing `load`.
#[unsafe(no_mangle)]
pub extern "C" fn choose(n_words: usize, simulations: u32) -> i32 {
    with(|s| {
        let Some(player) = s.player.as_ref() else {
            s.error = "choose before load".into();
            return -2;
        };
        if n_words > WORDS {
            s.error = format!("a block of {n_words} words");
            return -2;
        }
        match player.choose(&s.words[..n_words], simulations) {
            Ok((action, value)) => {
                s.value = value;
                i32::from(action)
            }
            Err(Refusal::Terminal) => {
                s.error = "the position is terminal: there is no move to choose".into();
                -1
            }
            Err(Refusal::Block(e)) => {
                s.error = e;
                -2
            }
        }
    })
}

/// The root value of the last move `choose` made.
#[unsafe(no_mangle)]
pub extern "C" fn value() -> f32 {
    with(|s| s.value)
}

/// The last error, as UTF-8 at `error_ptr`, `error_len` bytes long.
#[unsafe(no_mangle)]
pub extern "C" fn error_ptr() -> *const u8 {
    with(|s| s.error.as_ptr())
}

#[unsafe(no_mangle)]
pub extern "C" fn error_len() -> usize {
    with(|s| s.error.len())
}
