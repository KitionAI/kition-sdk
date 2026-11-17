# Agent integration reference

Generate the reference without loading, building or executing a kit:

```sh
node tools/docs-gen/build.mjs
node tools/docs-gen/build.mjs --check
```

The default inputs are `packages/script/kits/*.ts` (excluding the barrel `index.ts`). Every
catalogue must have exactly one nonempty `Commands extends CommandMap` interface. The
generator uses the existing `typescript` development dependency to parse types and JSDoc;
it does not import the catalogue modules or call an engine. Malformed or unsupported command
declarations fail before any output is written.

Outputs, rooted at `docs/generated/` by default:

| Path | Contents |
| --- | --- |
| `llms.txt` | One link per kit and per guide in `docs/sdk/`, plus the combined JSONL |
| `commands.jsonl` | One self-contained JSON object per command of every kit |
| `kits/<kit>/commands/<command-id>.md` | One standalone Markdown reference page per command |
| `kits/<kit>/llms.txt` | Links and command descriptions for that kit |
| `kits/<kit>/commands.jsonl` | The same records, restricted to that kit |

Command ids are URL-encoded in filenames and links; ordinary dotted ids such as `cell.set`
remain unchanged. Reference links are relative to the output tree. Guide links point to the
repository's public `docs/sdk/` sources, so an alternate output directory does not change
their meaning or expose a local filesystem path.

`--dir <directory>` selects a catalogue directory; `--out <directory>` selects the output
root. Use the same options in write and check modes. Kit names, command ids, object properties
and output paths use a stable lexical order. There are no timestamps, local paths or engine
versions in generated files. Existing output files are rewritten only when their bytes change.

`--check` exits 1 for missing files, changed bytes, obsolete command pages or removed kits'
outputs, and writes nothing. Invalid arguments or inputs also exit 1; a successful write or
check exits 0. Write mode deletes obsolete files only in the generated path patterns listed
above, leaving unrelated files alone. Reserve those patterns for this generator. Symlinks
inside the output tree are refused.

## Record contract and missing metadata

Each JSONL record includes `kit`, `id`, `description`, `mutates`, `params`, `source`,
`schema_source`, `markdown`, `missing` and `lint`. `params` is a JSON Schema projection of
the committed TypeScript type, with `x-typescript-type` retaining the original text at each
node. It preserves required flags, literal values, arrays, nested objects and property
descriptions. Parameterless commands use an empty object schema. Unexpanded references
(including `Json`) retain their TypeScript spelling and remain unconstrained. This is a
description of the SDK type, not evidence of runtime unknown-parameter rejection.

`description` is the catalogue's complete command JSDoc, including the title and notation
text retained by `generate-kit.mjs`. `mutates` uses that generator's final
`Changes the document.` marker. There are no description overrides. `output`, `availability`,
`errors`, `examples`, `see_also` and `since` are explicitly null because these catalogues do
not retain them. Null means unknown, including for errors and examples. The generator never
invents passing cases, invocation examples, defaults, numeric limits, structured units,
recovery instructions or a version history. Parameter prose is preserved even where the
structured metadata is unavailable.

Every page and record reports the integration spec's L1–L9:

| Rule | Evidence available from these inputs |
| --- | --- |
| L1 | Required flags are retained; notation agreement is unknown |
| L2 | Counts documented properties, including nested properties |
| L3 | Structured units are unknown; parameter prose remains visible |
| L4 | Passing example coverage is unknown |
| L5 | Output schema coverage is unknown |
| L6 | Runtime unknown-parameter rejection is unknown |
| L7 | Counts unconstrained `Json` types, including nested types |
| L8 | Command error declarations are unknown |
| L9 | Keyword coverage is unknown |

Missing metadata is reported without inferring return values, errors or executable examples.
The reference is generated from the committed command catalogues.

## Verification

```sh
pnpm exec vitest run tools/docs-gen/docs-gen.test.mjs
```

The gate case `sdk.docs.integration/catalogues` points at this suite. It checks nested
types and descriptions, honest missing metadata, all sixteen committed catalogues against
the vocabulary reader, stable bytes and links, stale output deletion, read-only check mode,
and CLI exit codes. It does not require generated outputs to be committed first.

Generate and review the reference before enabling checks against committed output.
