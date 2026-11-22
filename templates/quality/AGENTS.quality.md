## Quality rules (read first)

- Tests are the spec. Read `docs/quality.md` and the feature catalogue (`features.yaml`)
  before changing behaviour. When code and a case disagree, the case wins unless a maintainer
  approves changing the case.
- Before you finish any task, run `{{check}}`. If it fails, the task is not done. Claude Code
  runs it for you through the Stop hook; agents without hooks (Codex) run it by hand and
  report the real exit code.
{{#kitCi}}
- The full checks and tests run on GitHub, in the kit's CI run, not on your machine: a task is
  done only when HEAD has a passing CI run and is on `origin/main`. Use Kition's
  `scripts/kit-ci.sh` (`push`, `wait`, `failures`, `land`; Kition's `docs/kits.md`, section
  4c). Compile only the crates you touched locally.
{{/kitCi}}
{{#repoCi}}
- The full checks and tests run on GitHub, in the repository's CI run (`.github/workflows/ci.yml`)
  on every push to `main` and every pull request: watch the run of your push; a task whose commit
  fails it is not done.
{{/repoCi}}
- Never edit expected results to make a test pass: files under `cases/**/expected/`, paths
  listed under `protected` in `features.yaml`, and the `expected`, `tolerance`, `reference`,
  `input` and `steps` of an existing `case.yaml`. If you believe an expected result is wrong,
  stop and explain why in the task's findings; only a maintainer approves expected-result changes.
- Never weaken a test to make it pass: no deleted or loosened assertions, no added
  `#[ignore]`, `.skip`, `.only` or `.todo`, no raised tolerances. kition-sdk's
  `tools/check-expected.mjs` lists every such change for the maintainers.
- Every bug fix starts with a failing case under `cases/regressions/issue-<n>/`, then the fix.
- Every new feature adds an entry to `features.yaml` and at least one gating test.
- Put the task id and the case ids in the commit message.
- Stage only your own files: `git add` them by name; never `git commit -a` or `git add -A`.
  Other sessions may have uncommitted work in the same checkout.
- Work on `kition-slide` only in its main checkout; never change, build, or commit in its worktrees (`kition-slide-wt/*`, `kition-*-wt`, `kition-naming-work`).
- Never start `cargo xtask eval` (the real-model `layer: eval` cases): only a maintainer starts it (F-QA-16). Write eval cases and check them with `--dry-run`, which calls no model.
- No compatibility layers: no aliases, old names, old file suffixes, migrations, or readers for
  old formats. Delete a replaced path in the same change.
