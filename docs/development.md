# Package Development

The package manifests keep TypeScript checkout exports for kit development. `pnpm pack`
replaces them with `publishConfig.exports`, which points at built JavaScript and declarations.
Run `pnpm -r build` before packing; the `prepack` hook also builds
each package. Only `dist` and npm's mandatory metadata and README files are included.

The workspace root's `pnpm.overrides` links the sibling Tessera checkout for development.
Run `pnpm install` here with `../kition-tessera` present. Root overrides keep the lockfile and
live Tessera source in agreement while package dependencies retain public semver ranges.
The private workspace root is never packed, so registry consumers receive those ranges and
need no sibling checkout. Tessera must be published before packages that depend on it.

The pnpm version used by this checkout does not implement `pack --dry-run`. To inspect the
actual archive without publishing, run `pnpm pack --json --pack-destination <temporary-folder>`
in a package directory and inspect its file list and packed `package.json`.

## Repository templates

`templates/quality/` and `templates/community/` hold the files that Kition repositories share.
`node tools/sync-quality.mjs <repo>` writes the quality rules (`docs/quality.md`, the section at
the top of `AGENTS.md`, `.claude/CLAUDE.md`, the Claude Code Stop hook, the `CODEOWNERS` block); a
repository runs `node ../kition-sdk/tools/sync-quality.mjs .` from its root, with no flags. Its
values come from `templates/quality/repositories.json`, by the repository's directory name: the
owner, the local pre-finish check (`check`, what the Stop hook runs), and where the full checks run
(`fullChecks`: `kit-ci`, the kit's CI run on GitHub; `ci`, the repository's own CI run; `check`, the
check itself, locally), so that no sentence about the full checks names the pre-finish check. The
title of `docs/quality.md` is the product name from `templates/community/repositories.json` (the
entry's title, or the family product whose `repo` it is), or the table's `name` for a repository
that file does not name. `--name` and `--owner` override them; `--command` gives the check of a
repository not in the table. On every run it prints a `warning: <file>:<line>` for each line of
the repository's own `AGENTS.md` and `.claude/CLAUDE.md` text that contradicts the generated block
(a kit's text that still asks for `cargo xtask ci` before a commit, or forbids CI), without failing.
`node tools/sync-community.mjs <repo>` writes the community files (in `.github/` the
contributing guide, the code of conduct, the security and
support policies, the issue forms, and the pull request template) from the repository's entry in
`templates/community/repositories.json`, and lists where its `README.md` departs from the README
rules. A kit's README is a product page: the H2 sections What it does, Quick start, Maturity,
Build and contribute, The Kition family and License, a hero picture (`assets/readme/hero.png`) and at least two more
from `assets/readme/` (each with a full-sentence alt, at most 400 KB), and the version, KHP version
and level of its `kit.json`; the repository layout and the build commands go in the kit's
`docs/development.md`, which also describes the `KITION_LINK=1` opt-in of `web/`. A kit takes its
pictures with `tools/readme-shots/shots.mjs` (see its README). `--verify` (sync-quality) and
`--check` (sync-community) compare without writing and exit 1 on a difference;
`sync-community.mjs <repo> --print-readme` prints the README skeleton filled from the repository's
data and `kit.json`. The generated files are not edited in the target repository: change the
template or the data here and run the tool again. A `CLAUDE.md`, `QUALITY.md`, `CONTRIBUTING.md`
or `kit-waivers.yaml` left at a repository's root is a finding of both tools, which name the
`git mv` to run and write nothing until it is moved.

The Kition family (every public product, and the kits by product line) has one source, `family` in
`templates/community/repositories.json`, and `tools/kition-family.mjs` renders it. Each
repository's README carries it as the "## The Kition family" section between `kition-family`
markers right before "## License", which `sync-community.mjs` writes and checks like the community
files (an entry with `"family": false` has none). `node tools/kition-family.mjs` writes the
organization profile (`templates/community/org-profile.md`, for a `KitionAI/.github` repository's
`profile/README.md`) and the generated end of each `packages/*/README.md` ("Part of the Kition SDK",
the family, the license) after the package's own text; `--check` compares without writing, and
`tools/public-packages.test.mjs` fails when they are out of date. npm shows these READMEs away from
GitHub, so their links are absolute. The kit packages' READMEs are written by
`tools/kit-npm-package.mjs` from the same data ([distribution](sdk/distribution.md#kit-packages-and-the-kit-index)).
