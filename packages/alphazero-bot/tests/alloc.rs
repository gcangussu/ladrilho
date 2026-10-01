//! [Z11-10]: the forward pass allocates nothing, counted by a global
//! allocator. Its own test target, so the counting allocator is installed only
//! here; implementing `GlobalAlloc` is the one use of `unsafe` in the package,
//! and it is in a test, not the crate ([Z11-2]).

mod support;

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;

use azul_alphazero::network::{BATCH, Evaluation, Evaluator, Request};

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

/// [Z11-10]: `forward` and `evaluate` make no allocation, nor do their batched
/// forms ([Z11-70]), over whole groups of four and short ones.
///
/// Seen red: a `Vec` for the hidden activations in `Network::forward`, in a
/// copy, counts one allocation per call here.
#[test]
fn the_forward_pass_does_not_allocate() {
    let net = support::fixture();
    let s = azul_engine::AzulState::seeded(9);
    let obs = s.encode();
    let legal = s.legal_actions();
    let mut out = Evaluation::default();
    let mut logits = [0f32; 180];
    let requests: Vec<Request<'_>> = (0..7).map(|_| (&obs, legal.as_slice())).collect();
    let mut outs = vec![Evaluation::default(); 7];
    let mut batch = [[0f32; 180]; BATCH];
    let before = ALLOCATIONS.with(Cell::get);
    for _ in 0..10 {
        net.forward(&obs, &mut logits);
        net.evaluate(&obs, legal.as_slice(), &mut out);
        net.forward_batch([&obs; BATCH], &mut batch);
        net.evaluate_batch(&requests, &mut outs);
        net.evaluate_batch(&requests[..5], &mut outs[..5]);
    }
    assert_eq!(ALLOCATIONS.with(Cell::get) - before, 0);
}
