//! Office Math in OOXML (OMML, ECMA-376 Part 1 §22.1) ↔ the [`super`] tree: `m:oMath`
//! content, `m:oMathPara` justification and the settings part's `m:mathPr`. Runs carry their
//! WordprocessingML formatting (`w:rPr`: size, colour, a normal-text run's font and weight), as
//! Word writes equations.
//!
//! Element and attribute names are matched as written with their usual prefixes (`m:`, `w:`),
//! as Office writes them.

mod read;
mod write;

pub use read::{para_jc, read, read_math_pr};
pub use write::{math_pr, para_pr, write};
