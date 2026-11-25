//! A document's words as plain text, for hosts that index them (`KitText 1.0`, the Kit Process
//! Protocol's `file.text`; platform `docs/platform/sets/text.md`).
//!
//! A kit whose words live outside its object model (PDF page text, text layers, CAD `TEXT`)
//! answers [`crate::KitDocument::text`] and lists the capability [`CAPABILITY`] in its manifest's
//! `headless.capabilities`. [`TextBuilder`] keeps the limit, `truncated`, and the parts' ranges:
//!
//! ```
//! use kition_kit::text::TextBuilder;
//!
//! let mut text = TextBuilder::new(1024);
//! for (n, page) in ["Hello", "world"].iter().enumerate() {
//!     if !text.part(format!("Page {}", n + 1), page) {
//!         break; // the limit is reached: nothing more is kept
//!     }
//! }
//! let text = text.finish();
//! assert_eq!(text.text, "Hello\nworld");
//! assert_eq!((text.parts[1].start, text.parts[1].end), (6, 11));
//! ```

use serde::{Deserialize, Serialize};

/// The capability a kit lists in `kit.json`'s `headless.capabilities` (and `kit.initialize`
/// answers in `capabilities.capabilities`) when it answers `file.text`.
pub const CAPABILITY: &str = "document-text";

/// The Kit Process Protocol method.
pub const METHOD: &str = "file.text";

/// The `limit` a request without one means: 1 MiB of Unicode scalar values.
pub const DEFAULT_LIMIT: usize = 1_048_576;

/// What `file.text` answers.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DocumentText {
    /// The words in reading order, plain text, blocks separated by newlines. At most `limit`
    /// Unicode scalar values.
    pub text: String,
    /// Whether the document has more words than `text` holds.
    pub truncated: bool,
    /// Labelled ranges of `text` (pages, slides, layers), in order and not overlapping.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parts: Vec<TextPart>,
}

/// A labelled range of [`DocumentText::text`], counted in Unicode scalar values (`chars`), `end`
/// exclusive.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextPart {
    pub label: String,
    pub start: usize,
    pub end: usize,
}

impl DocumentText {
    /// The answer as JSON.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or_default()
    }
}

/// Builds a [`DocumentText`] block by block within a limit.
///
/// Blocks are separated by one newline. An empty block adds nothing, not even a part: a page
/// without words has no range to point to. Once the limit is reached the builder keeps nothing
/// more and records that there was more ([`DocumentText::truncated`]).
#[derive(Clone, Debug)]
pub struct TextBuilder {
    limit: usize,
    text: String,
    chars: usize,
    truncated: bool,
    parts: Vec<TextPart>,
}

impl TextBuilder {
    /// A builder that keeps at most `limit` Unicode scalar values.
    pub fn new(limit: usize) -> Self {
        Self { limit, text: String::new(), chars: 0, truncated: false, parts: Vec::new() }
    }

    /// Adds a labelled block, such as a page. Answers whether more may follow: `false` once a
    /// block did not fit, so a kit can stop extracting (at exactly the limit it is still `true`,
    /// since only the next block with words says whether there was more).
    pub fn part(&mut self, label: impl Into<String>, block: &str) -> bool {
        if let Some((start, end)) = self.push(block) {
            self.parts.push(TextPart { label: label.into(), start, end });
        }
        !self.full()
    }

    /// Adds a block without a label; answers as [`TextBuilder::part`].
    pub fn block(&mut self, block: &str) -> bool {
        self.push(block);
        !self.full()
    }

    /// Whether a block did not fit: nothing more is kept.
    pub fn full(&self) -> bool {
        self.truncated
    }

    /// The text so far, in Unicode scalar values.
    pub fn len(&self) -> usize {
        self.chars
    }

    /// Whether no word was kept yet.
    pub fn is_empty(&self) -> bool {
        self.chars == 0
    }

    pub fn finish(self) -> DocumentText {
        DocumentText { text: self.text, truncated: self.truncated, parts: self.parts }
    }

    /// Appends `block` after a separator; the range it took, if it took any.
    fn push(&mut self, block: &str) -> Option<(usize, usize)> {
        let block = block.trim_end_matches(['\n', '\r']);
        if block.is_empty() || self.truncated {
            return None;
        }
        let separator = usize::from(self.chars > 0);
        // Room for the separator and at least one character of the block.
        if self.chars + separator >= self.limit {
            self.truncated = true;
            return None;
        }
        if separator == 1 {
            self.text.push('\n');
            self.chars += 1;
        }
        let start = self.chars;
        let room = self.limit - self.chars;
        let (taken, cut) = match block.char_indices().nth(room) {
            Some((byte, _)) => (&block[..byte], true),
            None => (block, false),
        };
        self.text.push_str(taken);
        self.chars += taken.chars().count();
        self.truncated = cut;
        Some((start, self.chars))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pages(limit: usize, pages: &[&str]) -> DocumentText {
        let mut text = TextBuilder::new(limit);
        for (n, page) in pages.iter().enumerate() {
            if !text.part(format!("Page {}", n + 1), page) {
                break;
            }
        }
        text.finish()
    }

    #[test]
    fn joins_blocks_with_newlines_and_labels_their_ranges() {
        let text = pages(DEFAULT_LIMIT, &["Hello", "", "wörld\n"]);
        assert_eq!(text.text, "Hello\nwörld");
        assert!(!text.truncated);
        assert_eq!(text.parts, vec![TextPart { label: "Page 1".into(), start: 0, end: 5 }, TextPart { label: "Page 3".into(), start: 6, end: 11 }]);
        assert_eq!(text.to_json()["parts"][1]["label"], "Page 3");
    }

    #[test]
    fn cuts_at_the_limit_in_scalar_values() {
        let text = pages(8, &["中文字", "abcdef"]);
        assert_eq!(text.text, "中文字\nabcd");
        assert!(text.truncated);
        assert_eq!(text.parts[1], TextPart { label: "Page 2".into(), start: 4, end: 8 });
        // Exactly full: the next block is what was cut, and no lone separator is left.
        let text = pages(3, &["abc", "d"]);
        assert_eq!((text.text.as_str(), text.truncated, text.parts.len()), ("abc", true, 1));
        let text = pages(4, &["abc", "d"]);
        assert_eq!((text.text.as_str(), text.truncated), ("abc", true));
        let text = pages(5, &["abc", "d"]);
        assert_eq!((text.text.as_str(), text.truncated), ("abc\nd", false));
        let text = pages(0, &["abc"]);
        assert_eq!((text.text.as_str(), text.truncated, text.parts.len()), ("", true, 0));
    }

    #[test]
    fn no_words_is_empty_and_not_truncated() {
        let text = pages(DEFAULT_LIMIT, &["", "\n"]);
        assert_eq!(text, DocumentText::default());
        assert_eq!(text.to_json(), serde_json::json!({ "text": "", "truncated": false }));
    }
}
