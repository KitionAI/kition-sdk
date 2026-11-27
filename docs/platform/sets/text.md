# `KitText 1.0`: a document's words for search

For hosts that index the words of kit documents, and for kit authors whose
words live outside the object model. A host reads a document's words without
knowing its file format: from the object model when the words are there, and
from `file.text` when they are not.

The key words MUST, MUST NOT, SHOULD, SHOULD NOT, and MAY are to be read as
described in RFC 2119.

| | |
| --- | --- |
| Status | Platform feature in edition 2026.11. Implemented by kition-sdk's `kition-headless` |
| Bindings | [Kit Process Protocol](../reference/kit-process-protocol.md) section 5b, `file.text`; manifest K22 ([manifest](../kits/manifest.md)) |
| Kit side | T1 to T6; `KitDocument::text` with `kition_kit::text::TextBuilder`, checked by `kition_kit::testing::check_text` |
| Host side | T7, T8 |

## 1. Why

Hosts index the words of documents for
search. Kits may keep every word in their object model. A host reads them with `model.describe` and
`model.export` and the Kit Data Model, with no method of its own.

Other kits keep their words outside the object model, where a host could only
read them by knowing the file format, which a host must not do:

| Document kind | Words in the object model | Words only `file.text` answers |
| --- | --- | --- |
| Page archive | None | All page text |
| Vector drawing | Style, symbol and swatch names | Text objects (SVG `text`, AI/EPS text) |
| Technical drawing | Constraint names | `TEXT`, `MTEXT`, attribute values, dimension text |
| Layered image | Layer and channel names | Text layers |
| Video project | Project, bin and item names | Titles and captions |

## 2. The capability

- **T1** A kit that answers `file.text` lists the capability
  `document-text` in its manifest's `headless.capabilities` (K22), and its
  headless executable lists the same in `kit.initialize`'s
  `capabilities.capabilities`. A kit whose words are all in its object model
  need not list it.

```json
"headless": {
  "executable": "example-pages",
  "protocol": "kition-kit/1",
  "features": ["view.describe", "file.check"],
  "capabilities": ["document-text"]
}
```

`document-text` is a capability, not a protocol feature: it is never listed
in `headless.features` (`tools/check-manifest.mjs` refuses `file.text`
there).

## 3. `file.text`

A request from any client (host or agent) on an open document:

```json
{ "method": "file.text", "params": { "documentId": "d1", "limit": 1048576 } }
```

```json
{ "text": "Quarterly report\nRevenue grew 12%", "truncated": false,
  "parts": [{ "label": "Page 1", "start": 0, "end": 16 }, { "label": "Page 2", "start": 17, "end": 33 }] }
```

| Field | Type | Meaning |
| --- | --- | --- |
| `documentId` | string | An open document (`file.open`, `model.open`) |
| `limit` | integer, optional | The most characters to answer, counted in Unicode scalar values; `1048576` (1 Mi) when absent; `0` is allowed |
| `text` | string | The document's words in reading order, as plain text |
| `truncated` | boolean | Whether the document has more words than `text` holds |
| `parts` | array, optional | Labelled ranges of `text`: `{ label, start, end }` |

- **T2 Read-only.** `file.text` changes nothing: not the document, its
  revision or model version, its dirty state, nor its undo history. It
  answers for read-only documents, and the same document answers the same
  text every time.
- **T3 Plain text in reading order.** `text` holds the words a person reads,
  in the order they read them, with blocks (pages, paragraphs, text objects)
  separated by newlines. It holds no markup, no formulas (a sheet's computed
  values, if any), no hidden or deleted content, and no content the kit
  cannot read (scanned pages without a text layer answer no text; a kit
  runs no recognition it does not ship as a feature).
- **T4 Parts.** `parts` label ranges of `text` so a host can say where a
  match is: `Page 3`, `Slide 2`, `Layer "Title"`. Ranges count Unicode
  scalar values, `end` exclusive, `start <= end <= ` the length of `text`;
  parts are in order and do not overlap; every label is non-empty. A block
  without words has no part. A kit with no natural divisions leaves `parts`
  out.
- **T5 The limit.** `text` has at most `limit` characters. When the
  document has more words, `truncated` is `true` and `text` is the start of
  what a larger limit would answer, cut at a character, never in the middle
  of a scalar value. With the length of the whole text as the limit the
  answer is the whole text, not truncated.
- **T6 Errors.** An unknown `documentId` is `-32010 document_not_found`; a
  negative or non-integer `limit` is `-32602`. A kit without the capability
  answers `-32601` (method not found).

## 4. Hosts

- **T7 Fallback order.** To read a document's words, a host:
  1. calls `file.text` when the kit lists `document-text`;
  2. otherwise, or when the call fails, reads the object model: every
     `text` field, the string fields that name things, and string values of
     map fields, through `model.describe` and `model.export`
     ([`KitObjectModel 1.0`](object-model.md));
  3. otherwise indexes the file name alone.

  A kit that lists `document-text` and has an object model answers its
  words through both; a host MAY combine them, and SHOULD prefer
  `file.text` for the body.
- **T8** A host asks with the limit it can index and treats `truncated` as
  "indexed in part", never as an error. It MUST NOT parse a kit's file to
  find words.

## 5. For kit authors

A kit on the Kition SDK implements `KitDocument::text`; `kition-headless`
serves `file.text` for it when the manifest lists the capability (it
reads `headless.capabilities` itself), and answers method not found
otherwise:

```rust
fn text(&self, limit: usize) -> Result<kition_kit::text::DocumentText, String> {
    let mut text = kition_kit::text::TextBuilder::new(limit);
    for (index, page) in self.pages().enumerate() {
        if !text.part(format!("Page {}", index + 1), &page.text()) {
            break; // a page did not fit: nothing more is kept
        }
    }
    Ok(text.finish())
}
```

`TextBuilder` keeps T3 to T5: it separates blocks with one newline, leaves
out empty blocks and their parts, counts scalar values, and sets
`truncated`. `kition_kit_process_protocol` has the wire types for hosts: the method
`methods::DocumentText`, `DocumentTextParams`, `DocumentTextResult`,
`TextPart`, `DOCUMENT_TEXT_CAPABILITY`, and `DOCUMENT_TEXT_LIMIT`.

## 6. Conformance

| Who | Test | Rules |
| --- | --- | --- |
| Kits | `kition_kit::testing::check_text` on a fixture whose words the test states: the whole text within the default limit, parts in bounds and in order, the same answer twice, no change to revision, dirty state, or `inspect`, the whole text at its own length, and a truncated start of it at shorter limits (its length minus one, half, one, zero); and a document without words answers `""` | T2 to T5 |
| Kits, headless | Kit Process Protocol check 15 (section 14): a kit that lists `document-text` answers `file.text` for the fixture, within `limit`, with parts in bounds, and the document's state unchanged | T1, T2, T5, T6 |
| Kits, manifest | `tools/check-manifest.mjs`: `headless.capabilities` holds only known capabilities; `file.text` is not a feature | T1, K22 |
| Hosts | Against a kit with the capability, a kit without it, and a kit whose call fails: the body comes from `file.text`, the object model, or the file name in that order | T7, T8 |

`check_text` and the manifest checks run in kition-sdk today. Check 15 is
specified in the Kit Process Protocol; the black-box `kition-kit-conformance`
suite (in Kition) has not added it yet.
