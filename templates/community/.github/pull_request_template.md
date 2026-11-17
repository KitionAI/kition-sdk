## Summary

Describe the change and why it is useful.

{{#hasWeb}}
## Screenshots

- Add screenshots for a visible change{{#kit}} in the editor{{/kit}}.
- If there is no visual change, write `No visual change`.

{{/hasWeb}}
## Verification

- [ ] `{{check}}` exits 0
{{#quality}}
- [ ] Added or updated a case (`cases/`) or a test, or explained why one was not needed; a bug fix
      starts with a failing case under `cases/regressions/`
- [ ] A new feature has an entry in `features.yaml`
- [ ] No expected result changed (`cases/**/expected/`, the `protected` paths in `features.yaml`,
      an existing case's `expected`, `tolerance`, `reference`, `input` or `steps`), or each change
      is named for the maintainers' review as `docs/quality.md` requires
- [ ] No test was weakened: no deleted assertions, `#[ignore]`, `.skip`, `.only`, `.todo`, or raised
      tolerances
{{/quality}}
{{^quality}}
- [ ] Added or updated a test, or explained why one was not needed
{{/quality}}
{{#changelog}}
- [ ] `CHANGELOG.md` has an entry under **Unreleased** for a change users or hosts notice
{{/changelog}}

## Compatibility

{{#kit}}
- [ ] A changed or removed command, file format detail, or `kit.json` field is listed in
      `CHANGELOG.md`
{{/kit}}
- [ ] No credentials, host-specific paths, or generated local data are included
