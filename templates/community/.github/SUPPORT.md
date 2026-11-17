# {{title}} Support

## Questions about using {{title}}

Start with the [README](README.md) and the docs at [{{docsName}}]({{docs}}).

{{#issueForms}}
## Bug Reports

Use the [bug report form](https://github.com/{{github}}/issues/new?template=bug_report.yml)
for {{#kit}}a reproducible problem in the editor, the engine, or the headless executable{{/kit}}{{^kit}}a reproducible problem{{/kit}}. Search
existing issues first and include {{#kit}}the kit version or commit, the file format, a minimal
sample file, and where it runs{{/kit}}{{^kit}}the version or commit, your environment, and the
smallest steps that show it{{/kit}}.

## Requests

Use the [request form](https://github.com/{{github}}/issues/new?template=feature_request.yml)
for {{#kit}}a missing feature, a file format, an agent command, or a mistake in the documentation{{/kit}}{{^kit}}a missing feature, a change, or a mistake in the documentation{{/kit}}.
{{/issueForms}}
{{^issueForms}}
## Bug Reports and Requests

Open an [issue](https://github.com/{{github}}/issues/new/choose) for a reproducible problem or a
request. Search existing issues first.
{{/issueForms}}

## Security Reports

Do not open a public issue for a suspected vulnerability. Follow the
[security policy](.github/SECURITY.md).

## Contribution Help

Questions about local setup, checks, or pull requests start with
[CONTRIBUTING.md](.github/CONTRIBUTING.md).
