//! Memory per replica: an allocator that counts live heap bytes. A kit's perf test installs it:
//!
//! ```ignore
//! #[global_allocator]
//! static ALLOC: kition_convergence::CountingAlloc = kition_convergence::CountingAlloc::new();
//! ```
//!
//! and passes `Some(&ALLOC)` in [`crate::perf::PerfOptions::allocator`].

// The one place the suite needs `unsafe`: `GlobalAlloc` is an unsafe trait. Every call forwards
// to the system allocator unchanged.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

/// The system allocator, counting the bytes currently allocated.
#[derive(Debug, Default)]
pub struct CountingAlloc {
    live: AtomicIsize,
}

impl CountingAlloc {
    pub const fn new() -> Self {
        Self { live: AtomicIsize::new(0) }
    }

    /// Heap bytes allocated and not yet freed, by every thread.
    pub fn live(&self) -> isize {
        self.live.load(Ordering::Relaxed)
    }

    fn add(&self, bytes: usize) {
        self.live.fetch_add(isize::try_from(bytes).unwrap_or(isize::MAX), Ordering::Relaxed);
    }

    fn sub(&self, bytes: usize) {
        self.live.fetch_sub(isize::try_from(bytes).unwrap_or(isize::MAX), Ordering::Relaxed);
    }
}

// SAFETY: every method forwards to `System` with the caller's arguments, so it upholds
// `GlobalAlloc`'s contract exactly as `System` does; the counter has no effect on allocation.
unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarded unchanged (see the impl).
        let pointer = unsafe { System.alloc(layout) };
        if !pointer.is_null() {
            self.add(layout.size());
        }
        pointer
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        // SAFETY: forwarded unchanged (see the impl).
        let pointer = unsafe { System.alloc_zeroed(layout) };
        if !pointer.is_null() {
            self.add(layout.size());
        }
        pointer
    }

    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        // SAFETY: forwarded unchanged (see the impl).
        unsafe { System.dealloc(pointer, layout) };
        self.sub(layout.size());
    }

    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: forwarded unchanged (see the impl).
        let moved = unsafe { System.realloc(pointer, layout, new_size) };
        if !moved.is_null() {
            self.sub(layout.size());
            self.add(new_size);
        }
        moved
    }
}
