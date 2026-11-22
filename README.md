# mend

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats: a unified diff (often with wrong line numbers),
SEARCH/REPLACE blocks, the V4A patch format, and text-editor tool calls as
JSON. Each format is read as `SPEC.md` says, and every file is changed or
nothing is.

Run it as:

    node main.ts [arguments]

Node 22, the standard library alone. `runner.ts` runs the CLI over a trial's
checks when `MAKEFUN_ENV_URL` is set; `check.ts` runs it over the practice
set:

    node check.ts <practice.json>

See `SPEC.md` for the full contract.
