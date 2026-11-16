// Driver for the marked-fast markdown renderer.
//
// Reads /input/cases.json (or $MAKEFUN_INPUT_DIR/cases.json), renders each
// case with parse() from ./parse.js, and writes /output/html.json (or
// $MAKEFUN_OUTPUT_DIR/html.json) as a JSON array of HTML strings, in order.
//
// Node 22 erasable TypeScript: builtins only, no dependencies.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8'));
const html = cases.map((c) => parse(c.markdown));

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'html.json'), JSON.stringify(html));
