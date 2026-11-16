// Driver for the marked-fast renderer.
//
// Takes cases.json from $MAKEFUN_INPUT_DIR (default /input), renders
// every case with parse() from ./parse.js, and writes the HTML strings
// (a JSON array, in input order) to $MAKEFUN_OUTPUT_DIR/html.json
// (default /output). Erasable TypeScript for node 22: builtins only,
// no third-party dependencies.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = cases.map((c) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
