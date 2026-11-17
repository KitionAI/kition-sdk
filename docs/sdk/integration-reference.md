# Generated integration reference for agents

The command reference comes from the same committed kit catalogues that describe commands
in `@kition/script`. Generate it with:

```sh
node tools/docs-gen/build.mjs
```

Start at `docs/generated/llms.txt` for links to every kit and integration guide. Read
`docs/generated/commands.jsonl` for one record per command across all kits, or
`docs/generated/kits/<kit>/commands.jsonl` for one kit. A command's page is
`docs/generated/kits/<kit>/commands/<command-id>.md`, for example
`docs/generated/kits/note/commands/text.insert.md`.

Each command page includes its full catalogue description, parameter types and descriptions,
required flags, a parameter schema, and an L1–L9 metadata coverage report. Missing return
schemas, error declarations and tested examples are explicitly unknown. Consult the live
kit's command catalogue before execution when the reference lacks necessary information.

After generating and committing the outputs, CI can detect drift without writing files:

```sh
node tools/docs-gen/build.mjs --check
```

See the [generator documentation](https://github.com/KitionAI/kition-sdk/blob/main/tools/docs-gen/README.md)
for output options, record fields, tests and catalogue limitations.
