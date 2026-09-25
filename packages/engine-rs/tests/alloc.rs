//! [R9-17] The hot paths allocate nothing, counted by a global allocator.
//!
//! Its own test target, so the counting allocator is installed only here. The
//! count is per thread, so tests running in parallel cannot see each other's
//! allocations. This is the one file in the crate that needs `unsafe`
//! ([R9-6]): implementing `GlobalAlloc` requires it.

mod support;

use azul_engine::*;
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

struct Counting;

thread_local! {
    static ALLOCATIONS: Cell<u64> = const { Cell::new(0) };
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        ALLOCATIONS.with(|n| n.set(n.get() + 1));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        ALLOCATIONS.with(|n| n.set(n.get() + 1));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

/// Runs `f` and returns what it returned and how many allocations it made.
fn counted<T>(f: impl FnOnce() -> T) -> (T, u64) {
    let before = ALLOCATIONS.with(Cell::get);
    let out = f();
    (out, ALLOCATIONS.with(Cell::get) - before)
}

fn assert_none<T>(what: &str, f: impl FnOnce() -> T) -> T {
    let (out, n) = counted(f);
    assert_eq!(n, 0, "{what} allocated {n} time(s)");
    out
}

/// Every listed call, once, on `s`, then the ply through `path`.
fn check_ply<S: Shuffler>(s: &mut AzulState<S>, action: Action, explained: bool) {
    let legal = assert_none("legal_actions", || s.legal_actions());
    assert_none("is_legal", || (0..=u8::MAX).filter(|&a| s.is_legal(a)).count());
    assert_none("clone", || drop(std::hint::black_box(s.clone())));
    assert_none("encode", || s.encode());
    assert_none("encode_for", || (s.encode_for(Player::P0), s.encode_for(Player::P1)));
    assert_none("accessors", || {
        (
            s.current_player(), s.first_player(), s.scores(), s.round_index(), s.tiles_left(),
            s.shuffles_used(), s.is_terminal(), s.exhausted(), s.outcome(),
            s.floor_penalty(Player::P0), s.completed_rows(Player::P1), s.completed_cols(Player::P0),
            s.completed_colors(Player::P1), s.tile_census(), legal.len(),
        )
    });
    let wall = s.to_canonical().walls[0];
    assert_none("wall functions", || {
        let mut t = 0;
        for r in 0..5 {
            for c in 0..5 {
                t += placement_value(&wall, r, c);
            }
        }
        (t, wall_completed_rows(&wall), wall_completed_cols(&wall), wall_completed_colors(&wall))
    });
    let round = s.round_index();
    if explained {
        let (r, n) = counted(|| s.apply_explained(action).unwrap());
        if r.is_none() {
            assert_eq!(n, 0, "apply_explained allocated on a ply that ended no round [S7-4]");
        }
        assert_eq!(r.is_some(), s.round_index() != round || s.is_terminal());
        drop(r);
    } else {
        assert_none("apply", || s.apply(action).unwrap());
    }
}

/// [R9-17] Over complete seeded games, through both entry points: nothing on
/// the hot path allocates, and apply_explained allocates only on a
/// round-ending ply [S7-4]. placement_value allocates nothing [E1-68].
#[test]
fn seeded_games_allocate_nothing_on_the_hot_path() {
    for seed in 0..40u64 {
        for explained in [false, true] {
            let mut s = AzulState::seeded(seed);
            let mut pick = support::Picker::new(seed);
            while !s.is_terminal() {
                let a = s.legal_actions().as_slice()[pick.below(s.legal_actions().len())];
                check_ply(&mut s, a, explained);
            }
        }
    }
}

/// [R9-17] And over every game vector, through the recorded seam.
#[test]
fn every_game_vector_allocates_nothing_on_the_hot_path() {
    for v in support::vectors() {
        for explained in [false, true] {
            let mut s = support::start(v);
            for ply in &v.plies {
                check_ply(&mut s, ply.action, explained);
            }
            assert!(s.shuffler().fault.is_none());
        }
    }
}

/// The counter is real: a call that must allocate is seen to.
#[test]
fn the_counter_sees_an_allocation() {
    let s = AzulState::seeded(1);
    let (_, n) = counted(|| s.to_canonical());
    assert!(n > 0, "to_canonical returns a Vec, so something was allocated");
}
