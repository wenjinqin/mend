# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wenjinqin/mend/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/wenjinqin/mend/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

One patch tool for every AI edit format.

`mend` applies an edit written by an AI model to a tree of text files. Models
write edits in four formats, and `mend` reads all four to one contract:

- unified diffs (often with wrong line numbers),
- SEARCH/REPLACE blocks,
- V4A patches,
- text-editor tool calls as JSON.

It finds the lines each edit names even when the model drifted their
whitespace or indentation, and it changes every file or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

The working directory is the root of the tree. `PATCH` is the patch file, or
standard input when it is absent or `-`.

- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a`, `json`, or `auto` (the default, which detects it).
- `--check` does everything but write: the same output and exit code, and no
  file is created, changed or deleted.
- `--strict` matches lines exactly.

Exit 0 prints one line per changed path (`A`, `D`, `M`, or `R old -> new`)
and `ok: <n> files`. Exit 1 lists each failed edit and `failed: <k> of <n>
edits`, and no file is written. Exit 2 is a usage, missing-patch, format or
parse error, with exactly one line.

## Files

- `main.ts`: the CLI. Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner, kept as it is; `main.ts` hands a trial
  over to it when `MAKEFUN_ENV_URL` is set.
- `LICENSE`: MIT.

## Notes

- Line matching runs at three tiers: exact, then ignoring trailing
  whitespace, then ignoring leading and trailing whitespace. `--strict` tries
  only the exact tier.
- A changed file keeps its own line breaks (CRLF or LF) and its final line
  break, except where the patch itself says otherwise.
- Edits apply in the patch's order to the tree as earlier edits left it. A
  failed edit changes nothing, the edits after it still run, and when any
  edit failed no file is written.
