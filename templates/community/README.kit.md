<div align="center">

# {{title}}

**{{description}}**

<!-- One line of at most six abilities, in a reader's words, separated by " · ". -->
Ability · Ability · Ability

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-5645d4)](LICENSE)
[![npm: {{embedSpecifier}}](https://img.shields.io/npm/v/{{embedPackage}}?label={{embedLabel}}&color=5645d4)](https://www.npmjs.com/package/{{embedPackage}})
[![KHP {{khp}}](https://img.shields.io/badge/KHP-{{khpBadge}}-5645d4)](https://github.com/kitharness/kitharness)
[![Engine: Rust](https://img.shields.io/badge/engine-Rust%20%2B%20WebAssembly-5645d4)](bindings/wasm)

[Use it in Kition](https://kition.ai) · [Embed it](#embed-it-in-your-app) · [Give it to your agent](#give-it-to-your-agent) · [Showcase](https://github.com/KitionAI/kition-showcase/tree/main/{{kit}}) · [Developer docs]({{docs}}) · [KHP](https://github.com/kitharness/kitharness)

</div>

<!-- First paragraph, two to four sentences: the trouble people had before this kit. Second
person, present tense, short sentences, one thing per sentence. -->

<!-- Second paragraph, two to four sentences: what {{name}} does differently, and how a person
and an AI agent work on the same file. -->

<!-- The hero: the whole editor on a rich, invented sample, taken by web/scripts/readme-shots.mjs
(kition-sdk tools/readme-shots/README.md): Classic mode, light theme, English, 1440 × 900 at
device scale 2, at most 400 KB. The alt is one full sentence about what the picture shows. -->
<img src="assets/readme/hero.png" alt="The {{name}} editor on a sample file: say what it shows in one sentence." width="100%" />

## What it does

### Why {{name}}

<!-- Five or six benefits: a bold sentence each, then one or two more. What a person can do, not
how it is built; a number only with its source (a test, features.yaml, kit.json). -->

- **A benefit.** What it means for the person using it.

### See it

<!-- Four features, a picture of each (assets/readme/see-1.png … see-4.png, or named by feature)
and one line each. -->

<table>
<tr>
<td width="50%"><img src="assets/readme/see-1.png" alt="Say what the first feature's picture shows in one sentence." /><br /><b>Feature</b>: one line.</td>
<td width="50%"><img src="assets/readme/see-2.png" alt="Say what the second feature's picture shows in one sentence." /><br /><b>Feature</b>: one line.</td>
</tr>
<tr>
<td width="50%"><img src="assets/readme/see-3.png" alt="Say what the third feature's picture shows in one sentence." /><br /><b>Feature</b>: one line.</td>
<td width="50%"><img src="assets/readme/see-4.png" alt="Say what the fourth feature's picture shows in one sentence." /><br /><b>Feature</b>: one line.</td>
</tr>
</table>

<!-- Repository-specific parts (Note's "The file stays byte for byte yours") are H3 sections
here, inside "What it does": the README has no other H2 sections. -->

### Made with {{name}}

<!-- Four finished samples from kition-showcase: each sample's thumb.png copied to
assets/readme/made-1.png … made-4.png, linked to the sample's folder. -->

<table>
<tr>
<td width="25%"><a href="https://github.com/KitionAI/kition-showcase/tree/main/{{kit}}"><img src="assets/readme/made-1.png" alt="Say what the first sample is in one sentence." /></a></td>
<td width="25%"><a href="https://github.com/KitionAI/kition-showcase/tree/main/{{kit}}"><img src="assets/readme/made-2.png" alt="Say what the second sample is in one sentence." /></a></td>
<td width="25%"><a href="https://github.com/KitionAI/kition-showcase/tree/main/{{kit}}"><img src="assets/readme/made-3.png" alt="Say what the third sample is in one sentence." /></a></td>
<td width="25%"><a href="https://github.com/KitionAI/kition-showcase/tree/main/{{kit}}"><img src="assets/readme/made-4.png" alt="Say what the fourth sample is in one sentence." /></a></td>
</tr>
</table>

Every sample is built with {{name}}'s own commands. [See all of them](https://github.com/KitionAI/kition-showcase/tree/main/{{kit}}).

### Formats

<!-- Filled from kit.json (formats, creates, exports). -->

| Opens | Creates | Exports |
| --- | --- | --- |
| {{opens}} | {{creates}} | {{exports}} |

## Quick start

### Use it in Kition

<!-- Two sentences: which files Kition opens with {{name}}, and that Kition's agent edits the same
file. -->

[Download Kition](https://github.com/KitionAI/kition/releases/latest).

### Embed it in your app

<!-- Code that runs, ten lines or fewer: {{embedSpecifier}}'s KitionEmbed.mount with this kit's package
(`{{kit}}-ui/` from the kit's releases), a file, and the host's storage. -->

### Give it to your agent

<!-- A real session on a sample file, with its real output: kition-kits-mcp serving the
kition-{{kit}} executable as MCP tools. -->

## Maturity

Version {{version}} · KHP {{khp}}, conformance level `{{level}}`.

<!-- Three to five features per cell, in plain words. "Not yet" is never empty (write — when there
is nothing); a Preview kit says so in this section's first sentence. Ten lines or fewer. -->

| Works today | Partly there | Not yet |
| --- | --- | --- |
| … | … | — |

Known gaps: [docs/gaps.md](docs/gaps.md). What's next: [docs/roadmap.md](docs/roadmap.md).

## Build and contribute

Build and test instructions are in [docs/development.md](docs/development.md). Read
[CONTRIBUTING.md](.github/CONTRIBUTING.md) before opening a pull request, and ask questions in
[Discussions](https://github.com/KitionAI/kition/discussions) or on [Discord](https://discord.gg/bFSjRDjVY).

{{family}}
## License

<!-- When the kit derives from an upstream project, credit it here in one sentence. -->

Apache-2.0 ([LICENSE](LICENSE)). Third-party licenses and notices are listed in [NOTICE](NOTICE)
and [docs/attribution.md](docs/attribution.md).
