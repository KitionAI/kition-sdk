//! `CountingAlloc` as a test binary's global allocator.

use kition_convergence::CountingAlloc;

#[global_allocator]
static ALLOC: CountingAlloc = CountingAlloc::new();

#[test]
fn counts_live_heap_bytes() {
    let before = ALLOC.live();
    let block = vec![0u8; 1 << 20];
    assert!(ALLOC.live() - before >= 1 << 20);
    drop(block);
    assert!(ALLOC.live() - before < 1 << 20);
}
