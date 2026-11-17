# Contributing to {{title}}

{{description}}

Thank you for contributing; every change keeps the checks green.

## Scope

| Path | Contents |
| --- | --- |
{{scopeRows}}

## Local setup

Use {{toolchain}}.

```sh
{{build}}
```

{{#setupNotes}}
{{setupNotes}}

{{/setupNotes}}
Before you open a pull request, run the check; it must exit 0:

```sh
{{check}}
```

## Rules

{{#quality}}
The full rules are in [AGENTS.md](AGENTS.md), and [docs/quality.md](docs/quality.md) is the
testing reference; they apply to people and to coding agents alike. The ones that most often
matter:

- **Tests are the spec.** The feature catalogue (`features.yaml`) and each case's `intent` say how
  this repository must behave. A new feature adds an entry to `features.yaml` and at least one
  golden case; a bug fix starts with a failing case under `cases/regressions/issue-<n>/`.
- **Expected results are protected.** Never change files under `cases/**/expected/`, or the
  `expected`, `tolerance`, `reference`, `input` or `steps` of an existing case, to make a test
  pass, and never weaken a test. Only the owner approves an expected-result change.
- **No compatibility layers**: no aliases, old names, old file suffixes, migrations, or readers
  for old formats.
{{/quality}}
- **English** for code, comments, docs, and commit messages.
{{#rules}}
{{rules}}
{{/rules}}

## Pull requests

1. Open an issue first for a new feature or a change to {{#kit}}a command, the file format, or
   `kit.json`{{/kit}}{{^kit}}a public interface{{/kit}}, so the shape is agreed before the work.
2. Keep a pull request to one change. {{#quality}}Add or update a case or test with it.{{/quality}}{{^quality}}Add
   or update a test with it where one applies.{{/quality}}
3. Run the check above; it must exit 0.{{#changelog}} Add an entry to `CHANGELOG.md` under
   **Unreleased**.{{/changelog}}
{{#hasWeb}}
4. For a visual change, add screenshots.
{{/hasWeb}}

By contributing you agree that your contribution is licensed under the
[Apache License 2.0](LICENSE).{{#licenseNote}} {{licenseNote}}{{/licenseNote}} Follow the [Code of Conduct](.github/CODE_OF_CONDUCT.md), and report security
problems privately as the [security policy](.github/SECURITY.md) says.
