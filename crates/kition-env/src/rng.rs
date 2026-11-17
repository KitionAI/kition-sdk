//! The generator's seeded sampler: SplitMix64, written out so that a seed gives the same tasks
//! with every build of this crate, whatever random-number library the workspace uses.

pub(crate) struct Rng(u64);

impl Rng {
    /// The sampler for task `index` of a run with `seed`.
    pub(crate) fn new(seed: u64, index: u64) -> Self {
        let mut rng = Self(seed ^ index.wrapping_mul(0xD1B5_4A32_D192_ED03));
        rng.next();
        rng
    }

    pub(crate) fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number in `0..n` (`n` > 0).
    pub(crate) fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    /// One of `items`, none when there are none.
    pub(crate) fn pick<'a, T>(&mut self, items: &'a [T]) -> Option<&'a T> {
        if items.is_empty() { None } else { items.get(self.below(items.len())) }
    }

    /// True with probability `share` (0 to 1).
    pub(crate) fn chance(&mut self, share: f64) -> bool {
        if share <= 0.0 {
            return false;
        }
        ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < share
    }
}
