# marked-fast

A fast, dependency-free Markdown renderer that produces byte-identical output
to `marked` 18.1.3 with default options (GFM on, breaks off, pedantic off).

## Layout

- `parse.js` — the renderer. `export function parse(markdown)` returns the
  HTML string for one document. No dependencies, no network, no caching
  across calls, deterministic.
- `main.ts` — driver. Reads `/input/cases.json`, renders each case with
  `parse`, writes `/output/html.json` (JSON array of HTML strings, in order).

## Run locally

```sh
MAKEFUN_INPUT_DIR=kit/markdown-render-speed-02-kit/practice/input \
MAKEFUN_OUTPUT_DIR=/tmp/out \
node main.ts
```

Then score with the kit scorer (`kit/program/scorer/main.ts`) by setting
`MAKEFUN_OUTPUT_DIR`, `MAKEFUN_REFERENCE_DIR`, and `MAKEFUN_SCORES_DIR`.

## Practice score

700/720 cases byte-identical to marked 18.1.3 on the practice set (all 680
CommonMark + GFM spec cases pass; 20 generated docs still differ, mostly
nested-emphasis rule-of-3 cases and context-dependent list/fence/ref edges).
Work in progress toward 720/720.
