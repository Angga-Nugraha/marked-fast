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

720/720 cases byte-identical to marked 18.1.3 on the practice set (all 680
CommonMark + GFM spec cases pass, plus all 40 generated docs).

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/Angga-Nugraha/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/Angga-Nugraha/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
