//! Files a command produces (engine contract E16): an export, a rendered PDF, a CSV. The engine does no IO,
//! so it keeps the bytes and answers what it made; the binding takes each output with
//! `takeOutput(id)` (in chunks for a long one) and writes it to the handle the command's
//! parameters named, or to a new file it asks the host for (`files/create`).
//!
//! Keep an [`Outputs`] in the document, [`Outputs::keep`] what a command makes, answer
//! [`answer`] (or put the [`OutputInfo`]s under `outputs` in a richer answer), and serve
//! [`crate::KitDocument::take_output`] with [`Outputs::take`]:
//!
//! ```ignore
//! "file.exportCsv" => {
//!     let csv = self.csv();
//!     Ok(kition_kit::outputs::answer(&[self.outputs.keep(csv, "Sheet.csv", "text/csv")]))
//! }
//! // …
//! fn take_output(&mut self, id: &str, max: Option<usize>) -> Result<Vec<u8>, String> {
//!     self.outputs.take(id, max)
//! }
//! ```

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

/// One output a command made, as it answers it: `{ id, suggestedName, mime, size }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputInfo {
    /// Names the output for `takeOutput`; unique for the document's life.
    pub id: String,
    /// The file name the engine suggests, with its extension (the host may change it).
    pub suggested_name: String,
    pub mime: String,
    /// The whole output's length in bytes: the binding takes chunks until it has them all.
    pub size: u64,
}

/// `{ "outputs": [...] }`, a command's answer when it made only files.
pub fn answer(outputs: &[OutputInfo]) -> Value {
    json!({ "outputs": outputs })
}

/// The output schema (KHP A1 `output.schema`) of a command that answers only [`answer`].
pub fn output_schema() -> Value {
    let field = |kind: &str, description: &str| json!({ "type": kind, "description": description, "required": true });
    json!({
        "type": "object",
        "additionalProperties": false,
        "properties": {
            "outputs": {
                "type": "array",
                "required": true,
                "description": "The files the command made, for the host to write",
                "items": {
                    "type": "object",
                    "additionalProperties": false,
                    "properties": {
                        "id": field("string", "Names the output for takeOutput"),
                        "suggestedName": field("string", "The file name the engine suggests"),
                        "mime": field("string", "The file's MIME type"),
                        "size": field("integer", "The output's length in bytes"),
                    },
                },
            },
        },
    })
}

/// The outputs a document made and the binding has not taken yet.
#[derive(Clone, Debug, Default)]
pub struct Outputs {
    next: u64,
    kept: HashMap<String, Kept>,
}

#[derive(Clone, Debug)]
struct Kept {
    bytes: Vec<u8>,
    taken: usize,
}

impl Outputs {
    /// Keeps `bytes` until they are taken; answers the output's info.
    pub fn keep(&mut self, bytes: Vec<u8>, suggested_name: &str, mime: &str) -> OutputInfo {
        self.next += 1;
        let id = format!("out-{}", self.next);
        let info = OutputInfo { id: id.clone(), suggested_name: suggested_name.to_owned(), mime: mime.to_owned(), size: bytes.len() as u64 };
        self.kept.insert(id, Kept { bytes, taken: 0 });
        info
    }

    /// The next chunk of output `id`, at most `max` bytes (all that is left when `None`). The call
    /// that takes the last byte forgets the output (an engine must not keep it, E16), so taking it
    /// again is an error, as is an id it never made.
    pub fn take(&mut self, id: &str, max: Option<usize>) -> Result<Vec<u8>, String> {
        let kept = self.kept.get_mut(id).ok_or_else(|| format!("there is no output {id}"))?;
        let left = kept.bytes.len() - kept.taken;
        let count = max.map_or(left, |max| max.max(1).min(left));
        let chunk = kept.bytes[kept.taken..kept.taken + count].to_vec();
        kept.taken += count;
        if kept.taken == kept.bytes.len() {
            self.kept.remove(id);
        }
        Ok(chunk)
    }

    /// Forgets every output not taken yet (the document closed, or a new export replaces them).
    pub fn clear(&mut self) {
        self.kept.clear();
    }

    /// How many outputs wait to be taken.
    pub fn len(&self) -> usize {
        self.kept.len()
    }

    pub fn is_empty(&self) -> bool {
        self.kept.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_output_is_taken_in_chunks_then_forgotten() -> Result<(), String> {
        let mut outputs = Outputs::default();
        let info = outputs.keep(b"0123456789".to_vec(), "a.csv", "text/csv");
        assert_eq!(info, OutputInfo { id: "out-1".into(), suggested_name: "a.csv".into(), mime: "text/csv".into(), size: 10 });
        crate::schema::validate_output(&output_schema())?;
        assert_eq!(answer(std::slice::from_ref(&info)), json!({ "outputs": [{ "id": "out-1", "suggestedName": "a.csv", "mime": "text/csv", "size": 10 }] }));
        assert_eq!(outputs.take("out-1", Some(4))?, b"0123");
        assert_eq!(outputs.take("out-1", Some(4))?, b"4567");
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs.take("out-1", Some(4))?, b"89");
        assert!(outputs.is_empty());
        assert!(outputs.take("out-1", None).is_err());
        assert!(outputs.take("out-9", None).is_err());
        Ok(())
    }

    #[test]
    fn an_empty_output_is_taken_once() -> Result<(), String> {
        let mut outputs = Outputs::default();
        let info = outputs.keep(Vec::new(), "empty.txt", "text/plain");
        assert_eq!(outputs.take(&info.id, Some(8))?, b"");
        assert!(outputs.take(&info.id, Some(8)).is_err());
        let second = outputs.keep(b"x".to_vec(), "x.txt", "text/plain");
        assert_ne!(second.id, info.id);
        outputs.clear();
        assert!(outputs.take(&second.id, None).is_err());
        Ok(())
    }
}
