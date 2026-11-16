// marked-fast: a fast, dependency-free CommonMark + GFM renderer.
// Written from scratch to match the HTML marked 18.1.3 produces with its
// default options (gfm on, breaks off, pedantic off). Where marked departs
// from the CommonMark/GFM specs, marked's output wins.
// SPDX-License-Identifier: MIT

// ---------------------------------------------------------------- helpers

/** Escape &, <, >, ", ' for text and attribute values (marked's escape). */
function esc(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > last) out += s.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

/** marked's href encoding: encodeURI (with %25 folded back to %, so
 * existing percent-escapes are not double-encoded), then attribute-escape
 * (entity-like & stays raw). */
function encodeHref(dest) {
  let u;
  try {
    u = encodeURI(dest).replace(/%25/g, '%');
  } catch {
    u = dest;
  }
  return escNoEncode(u);
}

/**
 * Is s[i] an '&' starting an entity-like reference (&word; / &#123; /
 * &#x1f;)? Decimal is limited to 7 digits, hex to 6 — longer is not a
 * reference and the '&' gets escaped.
 */
function isEntityRef(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) : c >= 48 && c <= 57) j++;
      else break;
    }
    const count = j - start;
    if (count === 0 || (hex ? count > 6 : count > 7)) return false;
    return j < n && s[j] === ';';
  }
  const start = j;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) j++;
    else break;
  }
  return j > start && j < n && s[j] === ';';
}

/**
 * Escape &, <, >, ", ' — but leave an '&' raw when it starts an
 * entity-like reference (marked's escape with encode=false). Used for
 * hrefs, titles and alts, where `&amp;` / `&#169;` must survive.
 */
function escNoEncode(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (isEntityRef(s, i)) continue;
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > last) out += s.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

function isSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** ASCII punctuation (CommonMark's definition). */
function isAsciiPunct(ch) {
  const c = ch.charCodeAt(0);
  return (
    (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)
  );
}

const PUNCT_RE = /[\p{P}\p{S}]/u;
/** Unicode punctuation or symbol (for emphasis flanking rules). */
function isPunct(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunct(ch);
  return PUNCT_RE.test(ch);
}

function isAlnum(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return /[\p{L}\p{N}]/u.test(ch);
}

/** Is the string blank (only spaces/tabs)? */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * Leading indentation of a line: [columns, charIndex]. A tab advances to the
 * next multiple of 4 columns.
 */
function lineIndent(line) {
  let col = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col = (col | 3) + 1;
    else break;
  }
  return [col, i];
}

/**
 * Remove up to `n` columns of LEADING WHITESPACE only (fenced-code
 * dedent: a content line with less indent keeps its text). Otherwise the
 * same tab rules as stripCols.
 */
function stripIndentWs(line, n) {
  let col = 0;
  let i = 0;
  let out = '';
  for (; i < line.length && col < n; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) {
      const next = (col | 3) + 1;
      if (next > n) {
        out += ' '.repeat(next - n);
        col = next;
        i++;
        break;
      }
      col = next;
    } else break;
  }
  // A surviving leading tab is expanded to spaces (its original width)
  // when n is a multiple of 4: the tab sits on a tab stop, so after the
  // strip it would keep its width as a tab, but marked emits spaces.
  // When n is not a multiple of 4 the tab is kept literal (marked
  // preserves it in fenced code).
  if (n % 4 === 0) {
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 32) {
        out += ' ';
        col++;
        i++;
      } else if (c === 9) {
        const next = (col | 3) + 1;
        out += ' '.repeat(next - col);
        col = next;
        i++;
      } else break;
    }
  }
  return out + line.slice(i);
}

/**
 * Remove `n` columns of leading indentation from a line. A tab straddling
 * the boundary is replaced by the spaces needed to reach it. Tabs are
 * expanded against the line's original columns: when `n` is not a multiple
 * of 4, a tab that survives the strip would land on a different tab stop,
 * so the remaining leading tabs are expanded to spaces (their original
 * widths); when `n` is a multiple of 4 the survivors keep their stops and
 * stay literal tabs (marked preserves them in code content).
 */
function stripCols(line, n) {
  let col = 0;
  let i = 0;
  let out = '';
  for (; i < line.length && col < n; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) {
      const next = (col | 3) + 1;
      if (next > n) {
        out += ' '.repeat(next - n);
        col = next;
        i++;
        break;
      }
      col = next;
    } else col++;
  }
  if (n % 4 !== 0) {
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 32) {
        out += ' ';
        col++;
        i++;
      } else if (c === 9) {
        const next = (col | 3) + 1;
        out += ' '.repeat(next - col);
        col = next;
        i++;
      } else break;
    }
  }
  return out + line.slice(i);
}

// ---------------------------------------------------------------- entities

const ENTITIES = {
  AMP: '&', amp: '&', apos: "'", AElig: '\u00C6', aelig: '\u00E6', Aacute: '\u00C1',
  aacute: '\u00E1', Acirc: '\u00C2', acirc: '\u00E2', acute: '\u00B4', Atilde: '\u00C3',
  atilde: '\u00E3', Auml: '\u00C4', auml: '\u00E4', Aring: '\u00C5', aring: '\u00E5',
  Agrave: '\u00C0', agrave: '\u00E0', Alpha: '\u0391', alpha: '\u03B1', and: '\u2227',
  ang: '\u2220', Aring2: '\u00C5', asymp: '\u2248', Atilde2: '\u00C3', bdquo: '\u201E',
  Beta: '\u0392', beta: '\u03B2', brvbar: '\u00A6', bull: '\u2022', cap: '\u2229',
  Ccedil: '\u00C7', ccedil: '\u00E7', cedil: '\u00B8', cent: '\u00A2', Chi: '\u03A7',
  chi: '\u03C7', circ: '\u02C6', ClockwiseContourIntegral: '\u2232', clubs: '\u2663',
  cong: '\u2245', copy: '\u00A9', crarr: '\u21B5', cup: '\u222A', curren: '\u00A4',
  Dagger: '\u2021', dagger: '\u2020', dArr: '\u21D3', Darr: '\u2193', darr: '\u2193',
  Dcaron: '\u010E', dcaron: '\u010F', deg: '\u00B0', Delta: '\u0394', delta: '\u03B4',
  diams: '\u2666', DifferentialD: '\u2146', divide: '\u00F7', Eacute: '\u00C9',
  eacute: '\u00E9', Ecirc: '\u00CA', ecirc: '\u00EA', Egrave: '\u00C8', egrave: '\u00E8',
  empty: '\u2205', emsp: '\u2003', ensp: '\u2002', Epsilon: '\u0395', epsilon: '\u03B5',
  equiv: '\u2261', Eta: '\u0397', eta: '\u03B7', eth: '\u00F0', ETH: '\u00D0',
  Euml: '\u00CB', euml: '\u00EB', euro: '\u20AC', exist: '\u2203', fnof: '\u0192',
  forall: '\u2200', frac12: '\u00BD', frac14: '\u00BC', frac34: '\u00BE', frasl: '\u2044',
  Gamma: '\u0393', gamma: '\u03B3', ge: '\u2265', gt: '>', hArr: '\u21D4',
  harr: '\u2194', hearts: '\u2665', hellip: '\u2026', HilbertSpace: '\u210B',
  Iacute: '\u00CD', iacute: '\u00ED', Icirc: '\u00CE', icirc: '\u00EE', iexcl: '\u00A1',
  Igrave: '\u00CC', igrave: '\u00EC', image: '\u2111', infin: '\u221E', int: '\u222B',
  Iota: '\u0399', iota: '\u03B9', iquest: '\u00BF', isin: '\u2208', Iuml: '\u00CF',
  iuml: '\u00EF', Kappa: '\u039A', kappa: '\u03BA', Lambda: '\u039B', lambda: '\u03BB',
  lang: '\u27E8', laquo: '\u00AB', larr: '\u2190', lArr: '\u21D0', lceil: '\u2308',
  ldquo: '\u201C', le: '\u2264', lfloor: '\u230A', lowast: '\u2217', loz: '\u25CA',
  lrm: '\u200E', lsaquo: '\u2039', lsquo: '\u2018', lt: '<', macr: '\u00AF',
  mdash: '\u2014', micro: '\u00B5', middot: '\u00B7', minus: '\u2212', Mu: '\u039C',
  mu: '\u03BC', nabla: '\u2207', nbsp: '\u00A0', ndash: '\u2013', ne: '\u2260',
  ngE: '\u2267\u0338', ni: '\u220B', not: '\u00AC', notin: '\u2209', nsub: '\u2284',
  Ntilde: '\u00D1', ntilde: '\u00F1', Nu: '\u039D', nu: '\u03BD', Oacute: '\u00D3',
  oacute: '\u00F3', Ocirc: '\u00D4', ocirc: '\u00F4', Ograve: '\u00D2', ograve: '\u00F2',
  oline: '\u203E', Omega: '\u03A9', omega: '\u03C9', Omicron: '\u039F', omicron: '\u03BF',
  oplus: '\u2295', or: '\u2228', ordf: '\u00AA', ordm: '\u00BA', Oslash: '\u00D8',
  oslash: '\u00F8', Otilde: '\u00D5', otilde: '\u00F5', otimes: '\u2297', Ouml: '\u00D6',
  ouml: '\u00F6', para: '\u00B6', part: '\u2202', permil: '\u2030', perp: '\u22A5',
  Phi: '\u03A6', phi: '\u03C6', Pi: '\u03A0', pi: '\u03C0', piv: '\u03D6',
  plusmn: '\u00B1', pound: '\u00A3', prime: '\u2032', Prime: '\u2033', prod: '\u220F',
  prop: '\u221D', Psi: '\u03A8', psi: '\u03C8', quot: '"', radic: '\u221A',
  rang: '\u27E9', raquo: '\u00BB', rarr: '\u2192', rArr: '\u21D2', rceil: '\u2309',
  rdquo: '\u201D', real: '\u211C', reg: '\u00AE', rfloor: '\u230B', Rho: '\u03A1',
  rho: '\u03C1', rlm: '\u200F', rsaquo: '\u203A', rsquo: '\u2019', sbquo: '\u201A',
  Scaron: '\u0160', scaron: '\u0161', sect: '\u00A7', shy: '\u00AD', Sigma: '\u03A3',
  sigma: '\u03C3', sigmaf: '\u03C2', sim: '\u223C', spades: '\u2660', sub: '\u2282',
  sube: '\u2286', sum: '\u2211', sup: '\u2283', sup1: '\u00B9', sup2: '\u00B2',
  sup3: '\u00B3', supe: '\u2287', szlig: '\u00DF', Tau: '\u03A4', tau: '\u03C4',
  there4: '\u2234', Theta: '\u0398', theta: '\u03B8', thetasym: '\u03D1', thinsp: '\u2009',
  THORN: '\u00DE', thorn: '\u00FE', tilde: '\u02DC', times: '\u00D7', trade: '\u2122',
  Uacute: '\u00DA', uacute: '\u00FA', uarr: '\u2191', uArr: '\u21D1', Ucirc: '\u00DB',
  ucirc: '\u00FB', Ugrave: '\u00D9', ugrave: '\u00F9', uml: '\u00A8', upsih: '\u03D2',
  Upsilon: '\u03A5', upsilon: '\u03C5', Uuml: '\u00DC', uuml: '\u00FC', weierp: '\u2118',
  Xi: '\u039E', xi: '\u03BE', Yacute: '\u00DD', yacute: '\u00FD', yen: '\u00A5',
  Yuml: '\u0178', yuml: '\u00FF', Zeta: '\u0396', zeta: '\u03B6', zwj: '\u200D',
  zwnj: '\u200C',
};

/** Decode one entity starting at s[i] === '&'. Returns [decoded, nextIndex] or null. */
/**
 * Match an entity reference at s[i] === '&'. Returns [value, nextIdx, raw]
 * or null. Numeric entities decode to a character (0, surrogates and
 * >0x10FFFF become U+FFFD; decimal >7 digits / hex >6 digits do not match).
 * Named entities are NOT decoded: `raw` is true and value is the literal
 * `&name;` reference, which marked passes through verbatim.
 */
function parseEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s[i + 1] === '#') {
    let j = i + 2;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102) : c >= 48 && c <= 57) j++;
      else break;
    }
    const count = j - start;
    if (count === 0 || j >= n || s[j] !== ';') return null;
    if (hex ? count > 6 : count > 7) return null;
    let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return [String.fromCodePoint(cp), j + 1, false];
  }
  // named: word chars then ';' — passed through verbatim, never decoded
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) j++;
    else break;
  }
  if (j >= n || s[j] !== ';' || j === i + 1) return null;
  return [s.slice(i, j + 1), j + 1, true];
}

/** Unescape backslash escapes (\ + ASCII punct -> punct). Entities are NOT decoded. */
function unescapeBackslash(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) {
      if (i > last) out += s.slice(last, i);
      out += s[i + 1];
      i++;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// ---------------------------------------------------------------- inline

/** Normalize a link label: collapse whitespace, trim, lowercase. */
function normalizeLabel(label) {
  // full case folding for ß/ẞ (both fold to 'ss'; toLowerCase alone
  // leaves ß as ß, so a [ẞ] link would miss a [SS] definition)
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

/** Unicode whitespace (for flanking: a non-breaking space counts as
 * whitespace, so `* a *` with NBSP around `a` is not emphasis). */
function isWs(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0' ||
    ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') || ch === '\u202f' ||
    ch === '\u205f' || ch === '\u3000';
}

/** Flanking info for a delimiter run at [start, end) in s. */
function flanking(s, start, end) {
  const before = start > 0 ? s[start - 1] : '';
  const after = end < s.length ? s[end] : '';
  const beforeWs = before === '' ? true : isWs(before);
  const afterWs = after === '' ? true : isWs(after);
  const beforePunct = before === '' ? false : isPunct(before);
  const afterPunct = after === '' ? false : isPunct(after);
  const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
  const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
  return [left, right];
}

/** Scan a run of `ch` starting at i. Returns run length. */
function runLen(s, i, ch) {
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  return j - i;
}

/**
 * Try to parse a link destination starting at s[i] (after '(' or after
 * `]:`). Returns [dest, nextIndex] or null. Handles <...> and bare
 * destinations with balanced parens.
 */
function parseDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return [out, j + 1];
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
        out += s[j + 1];
        j += 2;
      } else {
        out += c;
        j++;
      }
    }
    return null;
  }
  // bare destination: no spaces/control chars, balanced parens
  let j = i;
  let depth = 0;
  let out = '';
  while (j < n) {
    const c = s[j];
    if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) return [out, j];
    if (c === '(') {
      depth++;
      out += c;
      j++;
    } else if (c === ')') {
      if (depth === 0) return [out, j];
      depth--;
      out += c;
      j++;
    } else if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
      out += s[j + 1];
      j += 2;
    } else {
      out += c;
      j++;
    }
  }
  // a bare destination may run to the end of the text (a reference
  // definition's destination need not be followed by ')' or whitespace)
  return [out, j];
}

/** Try to parse a link title starting at s[i]. Returns [title, nextIndex] or null. */
function parseTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === q) return [out, j + 1];
      if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
        out += s[j + 1];
        j += 2;
      } else {
        out += c;
        j++;
      }
    }
    return null;
  }
  if (q === '(') {
    let j = i + 1;
    let depth = 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '(') {
        depth++;
        out += c;
        j++;
      } else if (c === ')') {
        depth--;
        if (depth === 0) return [out, j + 1];
        out += c;
        j++;
      } else if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
        out += s[j + 1];
        j += 2;
      } else {
        out += c;
        j++;
      }
    }
    return null;
  }
  return null;
}

/** Skip spaces/tabs/newlines. Returns new index. */
function skipWs(s, i) {
  while (i < s.length && isSpace(s[i])) i++;
  return i;
}

/**
 * Try to parse an inline link `(dest "title")` starting at s[i] === '('.
 * Returns {dest, title, next} or null.
 */
function parseInlineLink(s, i) {
  const n = s.length;
  if (s[i] !== '(') return null;
  let j = skipWs(s, i + 1);
  if (j >= n) return null;
  if (s[j] === ')') return { dest: '', title: null, next: j + 1 };
  const d = parseDest(s, j);
  if (!d) return null;
  let dest = d[0];
  j = d[1];
  if (j < n && s[j] === ')') return { dest, title: null, next: j + 1 };
  // a title must be separated from the destination by whitespace
  if (j >= n || !isSpace(s[j])) return null;
  j = skipWs(s, j);
  if (j >= n) return null;
  if (s[j] === ')') return { dest, title: null, next: j + 1 };
  const t = parseTitle(s, j);
  if (!t) return null;
  j = skipWs(s, t[1]);
  if (j >= n || s[j] !== ')') return null;
  return { dest, title: t[0], next: j + 1 };
}

/**
 * Scan a link label starting at s[i] === '['. Returns [label, nextIndex]
 * where nextIndex is just past the matching ']', or null. Handles nested
 * brackets and backslash escapes.
 */
function scanLabel(s, i) {
  // A label ends at the FIRST unescaped ']' (labels do not nest: the
  // text up to that ']' is the label, even if it contains an unmatched
  // '['). The returned text is raw (backslashes preserved) so that a
  // label with an escape does not match one without it.
  const n = s.length;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isAsciiPunct(s[j + 1])) {
      label += c + s[j + 1];
      j += 2;
    } else if (c === '[') {
      // an unescaped '[' inside a label makes it unbalanced: not a label
      return null;
    } else if (c === ']') {
      return [label, j + 1];
    } else {
      label += c;
      j++;
    }
  }
  return null;
}

/** Does a raw link label contain a backtick run that marked's label regex
 * cannot match? In a label, a backtick run must either open a code span
 * whose content has no backticks (closing run of any length, first one
 * wins) or be a `` run at the very end of the label. A run like the
 * opening `` of `` a ` b `` pairs with the inner single backtick, leaving
 * the closing `` unmatched, so the link never forms (the text still
 * renders the code span via the normal tokenizer rule). */
function labelBadBackticks(label) {
  const n = label.length;
  let i = 0;
  while (i < n) {
    if (label[i] !== '`') { i++; continue; }
    const len = runLen(label, i, '`');
    let j = i + len;
    let closer = -1;
    while (j < n) {
      if (label[j] === '`') { closer = j; break; }
      j++;
    }
    if (closer !== -1) {
      i = closer + runLen(label, closer, '`');
      continue;
    }
    if (len >= 2 && i + len === n) return false;
    return true;
  }
  return false;
}

/** Is the char at s[i] the start of an HTML tag, comment, etc.? Returns end index or -1.
 * Validated per CommonMark: attribute names are [a-zA-Z_:][a-zA-Z0-9_.:-]*,
 * a '/' must sit directly before '>', a closing tag takes no attributes,
 * and a comment may not start with '>' or '->', contain '--', or end with '-'. */
function scanHtmlTag(s, i) {
  const n = s.length;
  if (s[i] !== '<' || i + 1 >= n) return -1;
  const c1 = s[i + 1];
  // comment
  if (c1 === '!' && s.startsWith('<!--', i)) {
    // abruptly closed empty comments are valid
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    // otherwise the content may not start with '>' or '->', or end with '-'
    if (s[i + 4] === '>' || s.startsWith('->', i + 4)) return -1;
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return -1;
    if (s[end - 1] === '-') return -1;
    return end + 3;
  }
  // processing instruction
  if (c1 === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return -1;
    return end + 2;
  }
  // declaration
  if (c1 === '!') {
    if (i + 2 < n && s[i + 2] >= 'A' && s[i + 2] <= 'Z') {
      let j = i + 2;
      while (j < n && s[j] !== '>') j++;
      return j < n ? j + 1 : -1;
    }
    if (s.startsWith('<![CDATA[', i)) {
      const end = s.indexOf(']]>', i + 9);
      if (end === -1) return -1;
      return end + 3;
    }
    return -1;
  }
  // tag: optional /, tag name, attributes, optional /
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (j >= n || !/[A-Za-z]/.test(s[j])) return -1;
  while (j < n && /[A-Za-z0-9-]/.test(s[j])) j++;
  // after the tag name only whitespace, '/', or '>' may follow
  // (so `<https://...>` is an autolink, not a tag)
  if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '/' && s[j] !== '>') return -1;
  if (closing) {
    // a closing tag takes no attributes
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return j < n && s[j] === '>' ? j + 1 : -1;
  }
  // open tag: attributes, then optional '/' directly before '>'
  for (;;) {
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/') return j + 1 < n && s[j + 1] === '>' ? j + 2 : -1;
    // attribute name
    if (!/[A-Za-z_:]/.test(s[j])) return -1;
    while (j < n && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    if (j < n && s[j] === '=') {
      j++;
      while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= n) return -1;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        // unquoted value: one or more chars, none of space " ' = < > `
        const vs = j;
        while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '"' && s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '>' && s[j] !== '`') j++;
        if (j === vs) return -1;
      }
      // after a value only whitespace, '/', or '>' may follow
      if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '/' && s[j] !== '>') return -1;
    }
  }
}

/** Autolink <scheme:...> or <email>. Returns [href, text, next] or null. */
function scanAutolink(s, i) {
  const n = s.length;
  if (s[i] !== '<') return null;
  let j = i + 1;
  // scheme: [A-Za-z][A-Za-z0-9+.-]{1,31}:
  let k = j;
  if (k < n && /[A-Za-z]/.test(s[k])) {
    k++;
    while (k < n && /[A-Za-z0-9+.-]/.test(s[k])) k++;
    if (k - j >= 2 && k - j <= 32 && k < n && s[k] === ':') {
      let end = k + 1;
      while (end < n && s[end] !== '>' && s[end] !== ' ' && s[end] !== '\n' && s[end] !== '<') end++;
      if (end < n && s[end] === '>') {
        const text = s.slice(i + 1, end);
        return [text, text, end + 1];
      }
      return null;
    }
  }
  // email: [A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*
  let end = j;
  while (end < n && s[end] !== '>' && s[end] !== ' ' && s[end] !== '\n' && s[end] !== '<') end++;
  if (end < n && s[end] === '>') {
    const text = s.slice(i + 1, end);
    if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/.test(text)) {
      return ['mailto:' + text, text, end + 1];
    }
  }
  return null;
}

const GFM_SCHEMES = ['http://', 'https://', 'ftp://'];
// marked's GFM autolink backpedal (its `_backpedal`), anchored: non-punct
// runs, balanced (...) groups, a bare & (not an entity at the end), and
// mid-string trailing punctuation only.
const GFM_BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
// GFM email (marked's It): local@domain with at least one dot in the
// domain, labels not ending in '-', and not followed by a word char or '-'
// (the trailing-underscore form GFM_EMAIL_RE_U is used only when an active
// '_' opener is on the stack, i.e. the '_' after the email closes emphasis
// and marked's tokenizer never lets the email regex see it)
const GFM_EMAIL_RE = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const GFM_EMAIL_RE_U = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-])/;
/**
 * GFM extended autolink at s[i]: www. / scheme://. `prev` is the
 * previous char ('' at start). Returns [href, text, next] or null.
 */
function scanGfmAutolink(s, i, prev) {
  const n = s.length;
  // www. or scheme://
  let isWww = false;
  let start = i;
  if (s.startsWith('www.', i)) {
    // www. must be preceded by start, whitespace, or one of *_~(
    if (prev !== '' && !isSpace(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') return null;
    isWww = true;
  } else {
    // a scheme:// autolink may follow any character (e.g. '<')
    let isScheme = false;
    const low = s.slice(i, i + 8).toLowerCase();
    for (const sc of GFM_SCHEMES) {
      if (low.startsWith(sc)) { isScheme = true; break; }
    }
    if (!isScheme) return null;
  }
  let end = i;
  while (end < n) {
    const c = s[end];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    end++;
  }
  let text = s.slice(start, end);
  // a trailing entity-like &word; is not part of the link (checked
  // before trimming the ';', or the entity would be split apart)
  const ampIdx = text.lastIndexOf('&');
  if (ampIdx !== -1) {
    const ent = parseEntity(text, ampIdx);
    if (ent && ent[1] === text.length) {
      text = text.slice(0, ampIdx);
      end = start + text.length;
    }
  }
  // marked's GFM backpedal: a regex matched from the start, repeated
  // until stable. It keeps runs of non-punct chars, balanced (...) groups,
  // and mid-string punctuation, but drops a '(' that never closes and any
  // trailing punctuation (the (?!$) lookahead). ']' and '}' are ordinary
  // chars here and are kept.
  let text0 = text;
  let prevT;
  do {
    prevT = text0;
    const m = GFM_BACKPEDAL.exec(text0);
    text0 = m ? m[0] : '';
  } while (text0 !== prevT);
  text = text0;
  end = start + text.length;
  if (text.length === 0) return null;
  if (isWww) {
    // www. needs a valid domain: a dot after www. with a TLD
    if (!/^www\.[^\s]*\.[^\s.]+$/.test(text) && !/^www\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(text)) return null;
    return ['http://' + text, text, end];
  }
  return [text, text, end];
}

/** GFM email autolink: word@domain.tld starting at s[i] (i is start of word). */
function scanGfmEmail(s, i, allowUnderscore) {
  const m = (allowUnderscore ? GFM_EMAIL_RE_U : GFM_EMAIL_RE).exec(s.slice(i));
  if (!m) return null;
  const text = m[0];
  return ['mailto:' + text, text, i + text.length];
}

// A delimiter record in the inline parser's output/stack.
function delim(ch, len, open, close, idx, img) {
  return { ch, len, orig: len, open, close, active: true, idx, img: !!img, ot: '', ct: '' };
}

/** Render one output entry (string or delimiter record) to HTML. */
function renderEntry(e) {
  if (typeof e === 'string') return e;
  if (e.ch === '[') return e.img ? '![' : '[';
  return e.ct + e.ch.repeat(e.len) + e.ot;
}

/** Render output entries [from, to) to HTML. */
function renderRange(out, from, to) {
  let s = '';
  for (let i = from; i < to; i++) s += renderEntry(out[i]);
  return s;
}

/**
 * Process emphasis delimiters in `stack` above index `bottom` (exclusive),
 * scanning closers left to right (the spec order: the first closer is
 * matched first, so an inner pair forms before an outer one). Mutates `out`
 * entries via the records' ot/ct.
 */
function processEmphasis(stack, bottom, out) {
  let cur = bottom + 1;
  while (cur < stack.length) {
    const closer = stack[cur];
    if (!closer.active || closer.ch === '[' || !closer.close || closer.len === 0) {
      cur++;
      continue;
    }
    // find the nearest matching opener
    let found = -1;
    for (let oi = cur - 1; oi > bottom; oi--) {
      const op = stack[oi];
      if (!op.active || op.ch === '[' || op.ch !== closer.ch || !op.open || op.len === 0) continue;
      // the odd rule: skip this opener when the match would use a single
      // delimiter (an <em>, not a <strong>), either side can both open
      // and close, and their original lengths sum odd (the closer is
      // saved as an opener for a later match)
      const use = Math.min(op.len, closer.len, 2);
      const odd =
        use === 1 && ((op.open && op.close) || (closer.open && closer.close)) &&
        (op.orig + closer.orig) % 2 === 1;
      if (odd) continue;
      found = oi;
      break;
    }
    if (found < 0) {
      cur++;
      continue;
    }
    const opener = stack[found];
    const use = Math.min(opener.len, closer.len, 2);
    const tag = opener.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    opener.len -= use;
    opener.ot = '<' + tag + '>' + opener.ot;
    closer.len -= use;
    closer.ct = closer.ct + '</' + tag + '>';
    // remove delimiters between opener and closer from the stack
    if (cur - found > 1) {
      stack.splice(found + 1, cur - found - 1);
      cur = found + 1;
    }
    if (opener.len === 0) opener.active = false;
    if (closer.len === 0) {
      closer.active = false;
      cur++;
    }
    // else: closer still has delimiters; re-examine it (stay at cur)
  }
}

/**
 * Plain-text rendering of a source range (for image alt text and shortcut
 * reference labels): render it as inline HTML, strip the tags, and unescape
 * the entities the renderer produced.
 */
function unescapeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) =>
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : "'");
}

function plainText(src, S) {
  const html = inlineParse(src, S);
  // an <img> in the rendered text contributes its alt text (cm-574:
  // ![foo ![bar](/url)](/url2) has alt "foo bar", not "foo ")
  const withAlt = html.replace(/<img src="[^"]*" alt="([^"]*)"[^>]*>/g, '$1');
  return unescapeEntities(withAlt.replace(/<[^>]*>/g, ''));
}

/** The inline parser: renders one leaf block's text to HTML. */
function inlineParse(src, S) {
  const n = src.length;
  const out = [];
  const stack = [];
  let t0 = 0; // start of current plain-text run
  let i = 0;
  // emphasis suppression after a mismatched-backtick link (marked's
  // emStrongMask): set when such a link forms and a code span follows
  // later in this inline text; cleared when that code span forms.
  // suppressMode 2 = clear only on a len>=2 span, 1 = clear on any span.
  let suppressEmph = false;
  let suppressMode = 0;
  const flush = (to) => {
    if (to > t0) out.push(esc(src.slice(t0, to)));
  };

  while (i < n) {
    const c = src[i];
    // --- backslash escape / hard break
    if (c === '\\') {
      if (i + 1 < n) {
        const d = src[i + 1];
        if (d === '\n') {
          flush(i);
          out.push('<br>');
          i += 2;
          // a hard break strips the next line's leading spaces/tabs
          while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
          t0 = i;
        } else if (isAsciiPunct(d)) {
          // the backslash is dropped; the char joins the plain run
          // (it is already literal in the source, so just skip the backslash
          // by flushing up to i and pushing the escaped char)
          flush(i);
          out.push(esc(d));
          i += 2;
          t0 = i;
        } else {
          i++;
        }
      } else {
        i++;
      }
      continue;
    }
    // --- code span
    if (c === '`') {
      const len = runLen(src, i, '`');
      let j = i + len;
      let found = -1;
      while (j < n) {
        const k = src.indexOf('`', j);
        if (k === -1) break;
        const rl = runLen(src, k, '`');
        if (rl === len) { found = k; break; }
        j = k + rl;
      }
      // Inside link text, marked's link regex decides first: a label
      // can contain a backtick run only if some backtick run closes it
      // before the label's ']'. If the same-length closer is before
      // that ']' the span forms normally. If the closer is past the
      // ']' (or absent), check for ANY backtick run before the ']':
      //  - one exists: the label matches (counts need not agree, e.g.
      //    ``url` ), so leave the backticks literal and let the link
      //    form; the label renders them literally.
      //  - none exists: the label cannot match, so the link never
      //    forms; the span forms across the ']' if it has a closer
      //    (cm-342/525/537), else the lone backtick poisons the label.
      let inLink = false;
      for (let k = 0; k < stack.length; k++) {
        if (stack[k].ch === '[' && stack[k].active) { inLink = true; break; }
      }
      if (inLink) {
        // NB: `j` was advanced by the closer search above; both scans
        // here start fresh just past the opening run.
        let closeBracket = -1;
        for (let q = i + len; q < n; q++) {
          if (src[q] === ']' && src[q - 1] !== '\\') { closeBracket = q; break; }
        }
        if (closeBracket !== -1 && (found === -1 || found >= closeBracket)) {
          let anyTick = -1;
          for (let q = i + len; q < closeBracket; q++) {
            if (src[q] === '`') { anyTick = q; break; }
          }
          if (anyTick !== -1) {
            // the label matches (counts need not agree, e.g. ``url` ):
            // consume opening run, content, and closer run as literal
            // text so the closer is not re-processed as a new opener.
            // Remember the mismatch on the opener: marked's emphasis
            // masking suppresses emphasis after such a link until the
            // next code span (see suppressEmph in inlineParse).
            for (let k = stack.length - 1; k >= 0; k--) {
              if (stack[k].ch === '[' && stack[k].active) { stack[k].mismatch = true; stack[k].mismatchLen = len; break; }
            }
            i = anyTick + runLen(src, anyTick, '`');
            continue;
          }
          if (found === -1) {
            for (let k = stack.length - 1; k >= 0; k--) {
              if (stack[k].ch === '[' && stack[k].active) { stack[k].active = false; break; }
            }
            i += len;
            continue;
          }
          // no backtick before ']': fall through and form the span
          // across the ']' (it swallows the link close).
        }
      }
      if (found === -1) {
        // no closer run at all: a backtick run with no closer inside
        // link text poisons the label (marked's link regex cannot match
        // a label containing an unmatched backtick, so the link never
        // forms). Deactivate the nearest '[' opener.
        if (inLink) {
          for (let k = stack.length - 1; k >= 0; k--) {
            if (stack[k].ch === '[' && stack[k].active) { stack[k].active = false; break; }
          }
        }
        i += len;
        continue;
      }
      let content = src.slice(i + len, found);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush(i);
      out.push('<code>' + esc(content) + '</code>');
      // a multi-backtick code span ends the emphasis suppression; if no
      // such span exists later in the text, the first span of any length
      // ends it (marked's emStrongMask resynchronises on a `` run when
      // one is coming, else on the first code span).
      if (suppressMode === 1 || (suppressMode === 2 && len >= 2)) {
        suppressEmph = false;
        suppressMode = 0;
      }
      i = found + len;
      t0 = i;
      continue;
    }
    // --- emphasis / strikethrough delimiters
    if (c === '*' || c === '_' || c === '~') {
      const len = runLen(src, i, c);
      // emphasis suppressed after a mismatched-backtick link until the
      // next code span: leave the run in the plain-text run.
      if (suppressEmph) {
        i += len;
        continue;
      }
      const [left, right] = flanking(src, i, i + len);
      let open, close;
      if (c === '_') {
        const beforePunct = i > 0 && isPunct(src[i - 1]);
        const afterPunct = i + len < n && isPunct(src[i + len]);
        open = left && (!right || beforePunct);
        close = right && (!left || afterPunct);
      } else {
        open = left;
        close = right;
      }
      // strikethrough uses one or two tildes: a run of three or more
      // can never open or close a <del>
      if (c === '~' && len > 2) {
        open = false;
        close = false;
      }
      // a delimiter that can neither open nor close can never form
      // emphasis: leave it in the plain-text run (flushing here would
      // split runs that a later GFM email look-back needs intact)
      if (!open && !close) {
        i += len;
        continue;
      }
      flush(i);
      const rec = delim(c, len, open, close, out.length, false);
      out.push(rec);
      stack.push(rec);
      i += len;
      t0 = i;
      continue;
    }
    // --- image / link opener
    if (c === '[' || (c === '!' && i + 1 < n && src[i + 1] === '[')) {
      const img = c === '!';
      const pos = img ? i + 1 : i;
      flush(i);
      const rec = delim('[', 0, false, false, out.length, img);
      rec.pos = pos;
      out.push(rec);
      stack.push(rec);
      i = pos + 1;
      t0 = i;
      continue;
    }
    // --- link closer
    if (c === ']') {
      // find nearest '[' opener, active or not: a ']' belongs to the
      // nearest '[' (its own closing bracket). If that '[' was
      // deactivated (e.g. an inner link formed inside it), this ']' is
      // literal; remove the opener so a later ']' can try the outer one.
      let p = -1;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].ch === '[') { p = k; break; }
      }
      if (p === -1) {
        i++;
        continue;
      }
      const opener = stack[p];
      if (!opener.active) {
        stack.splice(p, 1);
        i++;
        continue;
      }
      let dest = null;
      let title = null;
      let next = -1;
      let ok = false;
      let fullRef = false;
      if (i + 1 < n && src[i + 1] === '(') {
        const link = parseInlineLink(src, i + 1);
        if (link) {
          dest = link.dest;
          title = link.title;
          next = link.next;
          ok = true;
        }
        // a failed inline link does not deactivate the opener: the
        // text may still be a shortcut reference (cm-568)
      } else if (i + 1 < n && src[i + 1] === '[') {
        fullRef = true;
        const lab = scanLabel(src, i + 1);
        if (lab) {
          // the label for lookup is the raw text, normalized; for the
          // empty-label case use the link text's raw text (formatting
          // and escapes preserved: [*foo* bar] matches [*foo* bar],
          // not [foo bar]; [bar\\] matches [bar\\], not [bar\])
          const key = lab[0] === '' ? normalizeLabel(src.slice(opener.pos + 1, i)) : normalizeLabel(lab[0]);
          const ref = S.refs.get(key);
          if (ref) {
            dest = ref.dest;
            title = ref.title;
            next = lab[1];
            ok = true;
          }
        }
      }
      if (!ok && !fullRef) {
        // shortcut reference: link text is the label (raw text)
        const key = normalizeLabel(src.slice(opener.pos + 1, i));
        const ref = S.refs.get(key);
        if (ref) {
          dest = ref.dest;
          title = ref.title;
          next = i + 1;
          ok = true;
        }
      }
      if (!ok) {
        // no link formed from this ']': remove the opener (a later ']'
        // must try the next-outer '[')
        stack.splice(p, 1);
        i++;
        continue;
      }
      // a label with a backtick run the label regex cannot match (a
      // code span whose content holds a backtick) never forms a link
      if (labelBadBackticks(src.slice(opener.pos + 1, i))) {
        stack.splice(p, 1);
        i++;
        continue;
      }
      // flush the link text run into `out` before rendering it
      flush(i);
      // process emphasis inside the link text
      processEmphasis(stack, p, out);
      const textHtml = renderRange(out, opener.idx + 1, out.length);
      out.length = opener.idx;
      if (opener.img) {
        const alt = escNoEncode(plainText(src.slice(opener.pos + 1, i), S));
        out.push(
          '<img src="' + encodeHref(dest) + '" alt="' + alt + '"' +
          (title !== null ? ' title="' + escNoEncode(title) + '"' : '') + '>',
        );
      } else {
        out.push(
          '<a href="' + encodeHref(dest) + '"' +
          (title !== null ? ' title="' + escNoEncode(title) + '"' : '') + '>' + textHtml + '</a>',
        );
      }
      // remove stack records from the opener onward
      stack.length = p;
      if (!opener.img) {
        // links cannot contain links: deactivate earlier '[' link
        // openers (but not '!' image openers: an image may still form
        // around a link in its alt text)
        for (let k = 0; k < stack.length; k++) {
          if (stack[k].ch === '[' && !stack[k].img) stack[k].active = false;
        }
      }
      // a link whose label had mismatched backticks suppresses emphasis
      // until the next code span (marked's emStrongMask), but only when
      // a code span actually follows later in this inline text. If a
      // multi-backtick span follows, suppression lasts until it; else
      // it lasts until the first span of any length.
      if (opener.mismatch) {
        let q = next;
        let hasSpan = false;
        let hasSpan2 = false;
        while (q < n) {
          const k = src.indexOf('`', q);
          if (k === -1) break;
          const rl = runLen(src, k, '`');
          let j2 = k + rl;
          let okSpan = false;
          while (j2 < n) {
            const k2 = src.indexOf('`', j2);
            if (k2 === -1) break;
            if (runLen(src, k2, '`') === rl) { okSpan = true; break; }
            j2 = k2 + runLen(src, k2, '`');
          }
          if (okSpan) {
            hasSpan = true;
            if (rl >= 2) { hasSpan2 = true; break; }
          }
          q = k + rl;
        }
        if (hasSpan) {
          suppressEmph = true;
          suppressMode = hasSpan2 ? 2 : 1;
        }
      }
      i = next;
      t0 = i;
      continue;
    }
    // --- entity
    if (c === '&') {
      const e = parseEntity(src, i);
      if (e) {
        flush(i);
        // named entities pass through verbatim; numeric decodes get escaped
        out.push(e[2] ? e[0] : esc(e[0]));
        i = e[1];
        t0 = i;
      } else {
        i++;
      }
      continue;
    }
    // --- autolink / inline HTML
    if (c === '<') {
      const auto = scanAutolink(src, i);
      if (auto) {
        flush(i);
        out.push('<a href="' + encodeHref(auto[0]) + '">' + escNoEncode(auto[1]) + '</a>');
        i = auto[2];
        t0 = i;
        continue;
      }
      const tagEnd = scanHtmlTag(src, i);
      if (tagEnd !== -1) {
        flush(i);
        out.push(src.slice(i, tagEnd));
        i = tagEnd;
        t0 = i;
        continue;
      }
      i++;
      continue;
    }
    // --- GFM extended autolink: www. / scheme:// (scheme is
    // case-insensitive: "Https://..." is a link too). A GFM autolink
    // never forms inside link text: a link cannot contain a link
    // (marked: "[private https://example.com/x method](...)" keeps the
    // bare URL as plain text). Angle autolinks <...> DO nest, so only
    // the GFM forms are suppressed here.
    if ((c === 'w' && src.startsWith('www.', i)) ||
        ((c === 'h' || c === 'H') && (/^https?:\/\//i.test(src.slice(i, i + 8)))) ||
        ((c === 'f' || c === 'F') && src.slice(i, i + 6).toLowerCase() === 'ftp://')) {
      let inLink = false;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].ch === '[' && stack[k].active) { inLink = true; break; }
      }
      if (!inLink) {
        const prev = i > 0 ? src[i - 1] : '';
        const g = scanGfmAutolink(src, i, prev);
        if (g) {
          flush(i);
          out.push('<a href="' + encodeHref(g[0]) + '">' + escNoEncode(g[1]) + '</a>');
          i = g[2];
          t0 = i;
          continue;
        }
      }
      i++;
      continue;
    }
    // --- GFM email autolink: look back for a word start at '@'.
    // Suppressed inside link text, like the GFM bare-URL autolink.
    if (c === '@') {
      let inLink = false;
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].ch === '[' && stack[k].active) { inLink = true; break; }
      }
      if (!inLink) {
      // find word start
      let ws = i - 1;
      while (ws >= t0) {
        const ch = src[ws];
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') ||
            ch === '.' || ch === '_' || ch === '-' || ch === '+') ws--;
        else break;
      }
      ws++;
      if (ws < i) {
        // a trailing '_' after the email only extends it when it closes
        // an active '_' opener (marked tokenizes emphasis first); with
        // no opener the '_' blocks the match, as in marked's (?![\w-])
        let allowU = false;
        for (let k = stack.length - 1; k >= 0; k--) {
          if (stack[k].ch === '_' && stack[k].active && stack[k].open) { allowU = true; break; }
        }
        const em = scanGfmEmail(src, ws, allowU);
        if (em) {
          // a mailto:/xmpp: scheme immediately before the email is
          // part of the link (only those two schemes; any other 'foo:'
          // stays literal and only the email links)
          let href = em[0];
          let text = em[1];
          let start = ws;
          let end = em[2];
          for (const sc of ['mailto:', 'xmpp:']) {
            if (ws >= sc.length && src.slice(ws - sc.length, ws) === sc) {
              const b = ws - sc.length;
              const pb = b > 0 ? src[b - 1] : '';
              if (pb === '' || isSpace(pb) || pb === '*' || pb === '_' || pb === '~' || pb === '(') {
                start = b;
                href = sc + em[1];
                text = sc + em[1];
                if (sc === 'xmpp:') {
                  // optional /path after an xmpp: email
                  let p = end;
                  if (src[p] === '/') {
                    let q = p + 1;
                    while (q < src.length && /[A-Za-z0-9@.]/.test(src[q])) q++;
                    if (q > p + 1) {
                      end = q;
                      href += src.slice(p, q);
                      text += src.slice(p, q);
                    }
                  }
                }
              }
              break;
            }
          }
          flush(start);
          out.push('<a href="' + encodeHref(href) + '">' + escNoEncode(text) + '</a>');
          i = end;
          t0 = i;
          continue;
        }
      }
      } // !inLink
      i++;
      continue;
    }
    // --- newline: hard break (backslash handled above; two+ spaces) or soft
    if (c === '\n') {
      flush(i);
      // hard break if the line ends with two or more spaces
      let j = i - 1;
      let spaces = 0;
      while (j >= 0 && src[j] === ' ') { spaces++; j--; }
      if (spaces >= 2) {
        // strip the trailing spaces from the output
        const lastOut = out[out.length - 1];
        if (typeof lastOut === 'string') {
          out[out.length - 1] = lastOut.slice(0, lastOut.length - spaces);
        }
        out.push('<br>');
        i++;
        // a hard break strips the next line's leading spaces/tabs
        while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
        t0 = i;
      } else {
        out.push('\n');
        i++;
        t0 = i;
      }
      continue;
    }
    i++;
  }
  flush(n);
  processEmphasis(stack, -1, out);
  return out.map(renderEntry).join('');
}

// ---------------------------------------------------------------- blocks

function matchFence(s) {
  const c = s[0];
  if (c !== '`' && c !== '~') return null;
  let len = 0;
  while (len < s.length && s[len] === c) len++;
  if (len < 3) return null;
  const info = s.slice(len);
  if (c === '`' && info.includes('`')) return null;
  return { char: c, len, info };
}

function matchATX(s) {
  if (s[0] !== '#') return null;
  let level = 0;
  while (level < s.length && s[level] === '#') level++;
  if (level > 6) return null;
  if (level === s.length) return { level, text: '' };
  const c = s[level];
  if (c !== ' ' && c !== '\t') return null;
  let text = s.slice(level + 1);
  if (/^#+[ \t]*$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+[ \t]*$/, '');
  text = text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  return { level, text };
}

function isHr(s) {
  const c = s[0];
  if (c !== '*' && c !== '-' && c !== '_') return false;
  let count = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === c) count++;
    else if (ch !== ' ' && ch !== '\t') return false;
  }
  return count >= 3;
}

function matchSetext(s) {
  if (s.length === 0) return 0;
  const c = s[0];
  if (c !== '=' && c !== '-') return 0;
  // a run of the same char, then only trailing spaces/tabs
  // (`= =` and `--- -` are not underlines)
  let i = 1;
  while (i < s.length && s[i] === c) i++;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i === s.length ? (c === '=' ? 1 : 2) : 0;
}

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe',
  'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol',
  'optgroup', 'option', 'p', 'param', 'section', 'source', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
]);

/** HTML block type (1-7) for a line's content, or 0. `forInterrupt` when the line follows a paragraph. */
function htmlBlockType(s, forInterrupt) {
  if (s[0] !== '<') return 0;
  const m1 = /^<(script|pre|style|textarea)([ \t>]|$)/i.exec(s);
  if (m1) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (s.startsWith('<!') && s.length > 2 && /[A-Za-z]/.test(s[2])) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  let j = 1;
  if (s[j] === '/') j++;
  if (j < s.length && /[A-Za-z]/.test(s[j])) {
    const nameStart = j;
    while (j < s.length && /[A-Za-z0-9-]/.test(s[j])) j++;
    if (BLOCK_TAGS.has(s.slice(nameStart, j).toLowerCase())) {
      if (j >= s.length) return 6;
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '>') {
        if (scanHtmlTag(s, 0) !== -1) return 6;
        // the tag closes on this line but is not a valid tag
        if (s.replace(/[ \t]+$/, '').endsWith('>')) return 0;
        return 6;
      }
      if (c === '/' && s[j + 1] === '>') return 6;
    }
  }
  // type 7 (cannot interrupt a paragraph): a complete tag alone on the line
  if (!forInterrupt) {
    const tagEnd = scanHtmlTag(s, 0);
    if (tagEnd !== -1 && isBlank(s.slice(tagEnd))) return 7;
  }
  return 0;
}

/**
 * Parse a link reference definition starting at lines[k]. Returns the number
 * of lines consumed, or 0 when the lines do not form a definition.
 */
function tryParseRefDef(lines, k, S) {
  const line = lines[k];
  const [ind, idx] = lineIndent(line);
  if (ind >= 4 || line[idx] !== '[') return 0;
  // the label may span lines, so scan it in the joined text
  const text = lines.slice(k).join('\n');
  const lab = scanLabel(text, idx);
  if (!lab || text[lab[1]] !== ':') return 0;
  const key = normalizeLabel(lab[0]);
  if (key === '' || key.length > 999) return 0;
  let pos = lab[1] + 1;
  pos = skipWs(text, pos);
  if (pos >= text.length) return 0;
  const d = parseDest(text, pos);
  if (!d) return 0;
  pos = d[1];
  // only whitespace (or the end) may follow the destination
  if (pos < text.length && !isSpace(text[pos])) return 0;
  let title = null;
  // a title may follow on the same line or the next line (at most one
  // newline separates it from the destination)
  let p2 = pos;
  while (p2 < text.length && (text[p2] === ' ' || text[p2] === '\t')) p2++;
  if (p2 < text.length && text[p2] === '\n') {
    p2++;
    while (p2 < text.length && (text[p2] === ' ' || text[p2] === '\t')) p2++;
  }
  let endPos = pos;
  if (p2 < text.length) {
    const t = parseTitle(text, p2);
    if (t) {
      let q = t[1];
      while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
      if (q >= text.length || text[q] === '\n') {
        title = t[0];
        endPos = q;
      }
    }
    if (title === null) {
      // no (valid) title: only spaces/tabs may follow the destination
      // on its line; the definition ends at that line's newline
      let q = pos;
      while (q < text.length && (text[q] === ' ' || text[q] === '\t')) q++;
      if (q < text.length && text[q] !== '\n') return 0;
      endPos = q;
    }
  } else {
    endPos = p2;
  }
  if (endPos < text.length && text[endPos] !== '\n') return 0;
  let consumed = 1;
  for (let q = 0; q < endPos; q++) if (text[q] === '\n') consumed++;
  if (!S.refs.has(key)) S.refs.set(key, { dest: d[0], title });
  return consumed;
}

/** Split a table row on unescaped pipes outside code spans; trim cells. */
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') {
      cur += '|';
      i += 2;
      continue;
    }
    if (c === '|') {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += c;
    i++;
  }
  cells.push(cur);
  let start = 0;
  while (start < n && (line[start] === ' ' || line[start] === '\t')) start++;
  let end = n;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end--;
  if (line[start] === '|' && cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (line[end - 1] === '|' && cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

/** Parse a table delimiter row; returns alignments or null. */
function parseDelimiterRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    aligns.push(m[1] && m[2] ? 'center' : m[1] ? 'left' : m[2] ? 'right' : null);
  }
  return aligns;
}

/** A list marker at the start of `s` (content after 0-3 indent), or null. */
function matchListMarker(s, startCol) {
  const sc = startCol || 0;
  const c0 = s[0];
  let markerLen = 0;
  let type = '';
  let bullet = '';
  let delim = '';
  let start = 0;
  if (c0 === '-' || c0 === '*' || c0 === '+') {
    type = 'bullet';
    bullet = c0;
    markerLen = 1;
  } else if (c0 >= '0' && c0 <= '9') {
    let d = 0;
    while (d < s.length && s[d] >= '0' && s[d] <= '9') d++;
    if (d === 0 || d > 9) return null;
    if (d < s.length && (s[d] === '.' || s[d] === ')')) {
      type = 'ordered';
      delim = s[d];
      start = parseInt(s.slice(0, d), 10);
      markerLen = d + 1;
    } else {
      return null;
    }
  } else {
    return null;
  }
  // whitespace after the marker
  const after = s[markerLen];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  // content column (absolute): marker column + whitespace width (1-4),
  // or +1 if >= 5 / EOL
  let col = sc + markerLen;
  let idx = markerLen;
  let empty = after === undefined;
  if (!empty) {
    while (idx < s.length && (s[idx] === ' ' || s[idx] === '\t')) {
      if (s[idx] === ' ') col++;
      else col = (col | 3) + 1;
      idx++;
    }
    if (idx >= s.length) empty = true;
    const width = col - (sc + markerLen);
    if (width >= 5) col = sc + markerLen + 1;
  }
  return {
    type, bullet, delim, start, markerLen,
    contentCol: empty ? sc + markerLen + 1 : col,
    contentIdx: idx,
    empty,
  };
}

/** Can the line's block start interrupt a paragraph? */
function canInterruptParagraph(s, inItem) {
  if (matchATX(s) || matchFence(s) || isHr(s) || htmlBlockType(s, true) || s[0] === '>') return true;
  const m = matchListMarker(s);
  if (!m || m.empty) return false;
  if (m.type === 'bullet') return true;
  // an ordered list can interrupt a paragraph only when it starts with 1
  // — except inside a list item, where any start number interrupts
  // (marked: "- foo\n  bar\n  5. baz" nests the "5." list)
  return inItem ? true : m.start === 1;
}

/** Can the line continue a paragraph (lazy continuation)? A setext
 * underline cannot be a lazy continuation line. */
function isParaContinuation(line) {
  if (isBlank(line)) return false;
  const [ind, idx] = lineIndent(line);
  if (ind >= 4) return true;
  const s = line.slice(idx);
  return !canInterruptParagraph(s);
}

// Track fenced-code state for lazy-continuation decisions while collecting
// container lines. `st` is {inFence, char, len}.
function trackFence(line, st) {
  const [ind, idx] = lineIndent(line);
  if (ind >= 4) return;
  const s = line.slice(idx);
  if (!st.inFence) {
    const f = matchFence(s);
    if (f) {
      st.inFence = true;
      st.char = f.char;
      st.len = f.len;
    }
    return;
  }
  if (s[0] === st.char) {
    let len = 0;
    while (len < s.length && s[len] === st.char) len++;
    if (len >= st.len && isBlank(s.slice(len))) st.inFence = false;
  }
}

function parseIndentedCode(lines, i, hi, out) {
  const code = [];
  let j = i;
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) {
      // a blank line keeps its whitespace minus the 4-column code indent
      code.push(stripCols(line, 4));
      j++;
      continue;
    }
    const [ind] = lineIndent(line);
    if (ind >= 4) {
      code.push(stripCols(line, 4));
      j++;
    } else break;
  }
  while (code.length && code[code.length - 1].trim() === '') code.pop();
  const text = code.length ? code.join('\n') + '\n' : '';
  out.push('<pre><code>' + esc(text) + '</code></pre>\n');
  return j;
}

function parseFenced(lines, i, hi, out, fence, fenceIndent) {
  const content = [];
  let j = i + 1;
  // marked quirk: only backtick fences dedent their content by the
  // opening fence's indent; tilde fences keep content lines as-is
  const dedent = fence.char === '~' ? 0 : fenceIndent;
  while (j < hi) {
    const line = lines[j];
    const [ind, idx] = lineIndent(line);
    if (ind < 4) {
      const s = line.slice(idx);
      if (s[0] === fence.char) {
        let len = 0;
        while (len < s.length && s[len] === fence.char) len++;
        if (len >= fence.len && isBlank(s.slice(len))) {
          j++;
          break;
        }
      }
    }
    // content lines are dedented by the opening fence's indent
    // (backtick fences only; tilde fences keep content as-is)
    content.push(dedent ? stripIndentWs(line, dedent) : line);
    j++;
  }
  const lang = unescapeBackslash(fence.info.trim().split(/\s+/)[0] || '');
  // the text is the lines joined by '\n'; a trailing '\n' is added
  // only when the last line is non-empty (a trailing blank line already
  // ends the joined text with '\n')
  const text = content.length ? content.join('\n') + (content[content.length - 1] !== '' ? '\n' : '') : '';
  out.push(
    '<pre><code' + (lang ? ' class="language-' + escNoEncode(lang) + '"' : '') + '>' +
    esc(text) + '</code></pre>\n',
  );
  return j;
}

function parseHtmlBlock(lines, i, hi, out, type) {
  let j = i;
  let tag = '';
  if (type === 1) {
    const m = /^<(script|pre|style|textarea)/i.exec(lines[i]);
    tag = m ? m[1].toLowerCase() : '';
  }
  while (j < hi) {
    const line = lines[j];
    if (type === 1) {
      if (line.toLowerCase().includes('</' + tag + '>')) { j++; break; }
    } else if (type === 2) {
      if (line.includes('-->')) { j++; break; }
    } else if (type === 3) {
      if (line.includes('?>')) { j++; break; }
    } else if (type === 4) {
      if (line.includes('>')) { j++; break; }
    } else if (type === 5) {
      if (line.includes(']]>')) { j++; break; }
    } else {
      if (isBlank(line)) break;
    }
    j++;
  }
  let text = lines.slice(i, j).join('\n');
  // Trailing newline: an HTML block keeps the newline after its last line
  // when the next line (in the same container) is real content. For
  // types 1-5 (which end at a closing marker) a following whitespace-only
  // line that is not empty (e.g. a lone tab) still counts as content, so
  // the newline is kept; only a truly empty line drops it. Types 6-7 end
  // at a blank line, so any blank next line drops it. A block that runs
  // to the end of its container keeps the newline only at the top level
  // when the input ends with one (inside a quote/list it has none).
  const nextLine = j < lines.length ? lines[j] : null;
  const nextIsContent = nextLine !== null &&
    (type <= 5 ? nextLine !== '' : !isBlank(nextLine));
  const atEndWithTerm = j === lines.length && lines.isTop && lines.term;
  if (nextIsContent || atEndWithTerm) text += '\n';
  out.push(text);
  return j;
}

/** Is the last block in qlines a paragraph (so a lazy line may continue
 * it)? A lazy continuation can only continue a paragraph. An indented
 * code block (every line indented 4+ back to the block start) is not a
 * paragraph; neither is a last line that itself starts a heading, fence,
 * hr, HTML block, list or blockquote. */
function lastBlockIsPara(qlines) {
  const L = qlines[qlines.length - 1];
  if (L === '') return false;
  const [lind, lidx] = lineIndent(L);
  // a nested blockquote line: strip its '>' markers and judge the
  // innermost content line (the nested quote's parser will handle the
  // lazy continuation)
  if (lind < 4 && L[lidx] === '>') {
    let inner = L;
    for (;;) {
      const [iind, iidx] = lineIndent(inner);
      if (iind >= 4 || inner[iidx] !== '>') break;
      inner = stripCols(inner, iind + 1 + ((inner[iidx + 1] === ' ' || inner[iidx + 1] === '\t') ? 1 : 0));
    }
    const [iind2, iidx2] = lineIndent(inner);
    if (iind2 >= 4) return false;
    const s = inner.slice(iidx2);
    if (matchATX(s) || matchFence(s) || isHr(s) || htmlBlockType(s, true)) return false;
    const lm = matchListMarker(inner, iidx2);
    if (lm) {
      // list marker: judge the item's first content line (it may itself
      // be a nested quote: "1. > Blockquote" ends in a paragraph)
      return lastBlockIsPara([stripCols(inner, lm.contentCol)]);
    }
    return true;
  }
  if (lind < 4) {
    const s = L.slice(lidx);
    if (matchATX(s) || matchFence(s) || isHr(s) || htmlBlockType(s, true)) return false;
    const lm = matchListMarker(L, lidx);
    if (lm) {
      return lastBlockIsPara([stripCols(L, lm.contentCol)]);
    }
    return true;
  }
  // indented 4+: part of an indented code block unless a paragraph line
  // (ind < 4, not itself a block start) precedes it in the same block
  let k = qlines.length - 1;
  while (k > 0) {
    const prev = qlines[k - 1];
    if (prev === '') break;
    const [pind, pidx] = lineIndent(prev);
    if (pind < 4) {
      const ps = prev.slice(pidx);
      if (ps[0] === '>' || matchATX(ps) || matchFence(ps) || isHr(ps) || htmlBlockType(ps, true) || matchListMarker(prev, pidx)) break;
      return true; // a paragraph line: this line continues it
    }
    k--;
  }
  return false; // indented code
}

function parseBlockquote(lines, i, hi, out, S, collect, inItem) {
  const qlines = [];
  const st = { inFence: false, char: '', len: 0 };
  let j = i;
  // marked indents a setext-like lazy line by 4 spaces, unless it starts
  // a new chunk (a lazy line directly after a `>` line). A chunk ends at
  // the first lazy line after a `>` line.
  let chunkStart = true;
  // lazy setext-like lines at a chunk start stay paragraph text when the
  // quote is re-parsed (a setext underline cannot be a lazy continuation)
  const noSetext = new Set();
  // lazy lines are paragraph continuations: they must not interrupt the
  // paragraph when the quote's content is re-parsed (a lazy '- bar' is
  // text, not a list item)
  const noInterrupt = new Set();
  const SETEXT_LINE = /^ {0,3}(=+|-+)[ \t]*$/;
  while (j < hi) {
    const line = lines[j];
    const [ind, idx] = lineIndent(line);
    if (ind < 4 && line[idx] === '>') {
      // strip '>' plus one following space/tab; stripCols handles a
      // straddling tab and re-expands surviving leading tabs
      const stripped = stripCols(line, ind + 1 + ((line[idx + 1] === ' ' || line[idx + 1] === '\t') ? 1 : 0));
      qlines.push(stripped);
      trackFence(stripped, st);
      chunkStart = true;
      j++;
    } else if (isBlank(line)) {
      // a blank line with no '>' marker ends the blockquote (a following
      // '>' line starts a new, separate blockquote)
      break;
    } else if (!st.inFence && qlines.length > 0 && qlines[qlines.length - 1] !== '' && isParaContinuation(line) && lastBlockIsPara(qlines)) {
      // a lazy line indented 4+ columns loses 4 columns (it is not
      // indented code inside a paragraph); a lazy line indented less
      // keeps its spaces
      let lazy = ind >= 4 ? stripCols(line, 4) : line;
      // a lazy setext-like line that is not at a chunk start is indented
      // by 4 spaces, so it stays paragraph text instead of becoming a
      // setext underline when the quote's content is re-parsed
      if (SETEXT_LINE.test(lazy)) {
        if (chunkStart) noSetext.add(qlines.length);
        else lazy = lazy.replace(/^ {0,3}/, '    ');
      }
      noInterrupt.add(qlines.length);
      qlines.push(lazy);
      trackFence(lazy, st);
      chunkStart = false;
      j++;
    } else {
      break;
    }
  }
  qlines.noSetext = noSetext;
  qlines.noInterrupt = noInterrupt;
  const inner = [];
  parseBlocks(qlines, 0, qlines.length, inner, S, false, collect, inItem);
  out.push('<blockquote>\n' + inner.join('') + '</blockquote>\n');
  return j;
}

function renderTable(headCells, aligns, rows, out, S) {
  const cols = headCells.length;
  out.push('<table>\n<thead>\n<tr>\n');
  for (let c = 0; c < cols; c++) {
    const a = aligns[c];
    out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(headCells[c], S) + '</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (rows.length > 0) {
    out.push('<tbody>');
    for (const row of rows) {
      out.push('<tr>\n');
      for (let c = 0; c < cols; c++) {
        const a = aligns[c];
        const cell = c < row.length ? row[c] : '';
        out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(cell, S) + '</td>\n');
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

function parseParagraph(lines, i, hi, out, S, tight, collect, inItem) {
  const plines = [];
  let j = i;
  let setextLevel = 0;
  // set once the second line is collected: this paragraph is a GFM
  // table (its second line is a delimiter row)
  let isTable = false;
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) {
      // a whitespace-only line that is the last line of the input is
      // paragraph content, not a blank line (marked's paragraph rule
      // only treats a spaces-only line as blank when a newline follows)
      if (j === hi - 1 && line !== '') {
        plines.push(line);
        j++;
        continue;
      }
      // a whitespace-only line inside a table is an empty table row,
      // not a paragraph break — but only when it holds a tab: a lone
      // "\t" after the last row is a row of empty cells (padded to the
      // header width), while a spaces-only line ends the table
      if (isTable && line.indexOf('\t') !== -1) {
        plines.push(line);
        j++;
        continue;
      }
      break;
    }
    const [ind, idx] = lineIndent(line);
    if (j > i && ind < 4) {
      const s = line.slice(idx);
      // a lazy line is a paragraph continuation: it cannot be a setext
      // underline or interrupt the paragraph
      const isLazy = lines.noInterrupt && lines.noInterrupt.has(j);
      // a lazy setext-like line inside a blockquote is paragraph text,
      // not an underline (marked: a setext underline cannot be lazy)
      const se = (isLazy || (lines.noSetext && lines.noSetext.has(j))) ? 0 : matchSetext(s);
      if (se) {
        setextLevel = se;
        break;
      }
      // in a table, a line without '|' is still a row (a single cell,
      // padded: gfm-202 "bar" and doc-02 "Config ..." are rows)
      if (!isLazy && canInterruptParagraph(s, inItem)) break;
    }
    plines.push(line);
    if (plines.length === 2) {
      const [dind] = lineIndent(plines[1]);
      isTable = dind < 4 && !!parseDelimiterRow(plines[1]);
    }
    j++;
  }
  // strip link reference definitions from the start
  let start = 0;
  while (start < plines.length) {
    const consumed = tryParseRefDef(plines, start, S);
    if (consumed === 0) break;
    start += consumed;
  }
  const rest = plines.slice(start);
  if (collect) return setextLevel ? (rest.length === 0 ? j : j + 1) : j;
  if (setextLevel) {
    if (rest.length === 0) return j; // only defs: leave the setext line for the caller
    // setext heading text is trimmed at both ends (leading spaces of the
    // first line and trailing spaces of the last line go; a continuation
    // line's leading spaces stay)
    const text = rest.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    out.push('<h' + setextLevel + '>' + inlineParse(text, S) + '</h' + setextLevel + '>\n');
    return j + 1;
  }
  if (rest.length === 0) return j; // only definitions, no output
  // GFM table? The delimiter row must be indented less than 4 columns.
  if (rest.length >= 2) {
    const [dind] = lineIndent(rest[1]);
    const aligns = dind < 4 ? parseDelimiterRow(rest[1]) : null;
    if (aligns) {
      const headCells = splitTableRow(rest[0]);
      if (aligns.length === headCells.length) {
        const rows = [];
        for (let r = 2; r < rest.length; r++) rows.push(splitTableRow(rest[r]));
        renderTable(headCells, aligns, rows, out, S);
        return j;
      }
    }
  }
  const text = rest.join('\n');
  if (tight) out.push(inlineParse(text, S));
  else out.push('<p>' + inlineParse(text, S) + '</p>\n');
  return j;
}

function parseListItem(lines, i, hi, m) {
  const firstContent = stripCols(lines[i], m.contentCol);
  const itemLines = [firstContent];
  const st = { inFence: false, char: '', len: 0 };
  trackFence(firstContent, st);
  let j = i + 1;
  let loose = false;
  while (j < hi) {
    const line = lines[j];
    if (isBlank(line)) {
      // an empty item ends at a blank line: content after it is not
      // part of the item
      let hasContent = false;
      for (const l of itemLines) if (l !== '') { hasContent = true; break; }
      if (!hasContent) break;
      let k = j;
      while (k < hi && isBlank(lines[k])) k++;
      if (k >= hi) break;
      const [ind2] = lineIndent(lines[k]);
      if (ind2 < m.contentCol) break;
      // blank line(s) inside the item, followed by indented content.
      // it only makes this item loose if it separates two blocks at
      // this item's own level: if the following content is indented and
      // a nested list (or its continuation) is already open in this
      // item, the blank line belongs to the nested list, not this item.
      // blank lines inside a fenced code block never loosen the item.
      if (hasContent && !st.inFence) {
        const stripped = stripCols(lines[k], m.contentCol);
        const [sind] = lineIndent(stripped);
        let nestedOpen = false;
        for (let t = itemLines.length - 1; t >= 0; t--) {
          const l = itemLines[t];
          if (l === '') continue;
          const [lind, lidx] = lineIndent(l);
          if (lind > 0 || (lind < 4 && matchListMarker(l.slice(lidx), lind))) nestedOpen = true;
          break;
        }
        // the blank loosens this item only when it separates blocks at
        // this item's own level. When a nested list is open and the
        // next line continues that nested structure — another item of
        // the list, or an indented line inside it (cm-307 "bim") — the
        // blank belongs to the nested list, not this item.
        const nextIsList = sind < 4 && !!matchListMarker(stripped, sind);
        if (!nestedOpen || (!nextIsList && sind === 0)) loose = true;
      }
      while (j < k) {
        itemLines.push('');
          j++;
      }
      continue;
    }
    const [ind2] = lineIndent(line);
    if (ind2 >= m.contentCol) {
      const stripped = stripCols(line, m.contentCol);
      itemLines.push(stripped);
      trackFence(stripped, st);
      j++;
      continue;
    }
    // inside a fenced code block, lines belong to the fence regardless
    // of indent (a fence's content is not re-indented to the item:
    // "function f(a, b) {" at column 0 is still fence content, and a
    // "- foo" line inside a fence is code, not a list marker)
    if (st.inFence) {
      // strip only leading whitespace (stripCols would eat non-space
      // characters of a column-0 fence content line: "function" -> "nction")
      const stripped = stripIndentWs(line, m.contentCol);
      itemLines.push(stripped);
      trackFence(stripped, st);
      j++;
      continue;
    }
    // a list marker at this level starts a new item (or a new list):
    // it ends this item, it is not a lazy continuation of its paragraph
    const [mind, midx] = lineIndent(line);
    if (mind < 4 && matchListMarker(line.slice(midx), mind)) break;
    if (itemLines.length > 0 && itemLines[itemLines.length - 1] !== '' && isParaContinuation(line)) {
      // a lazy line indented 4+ columns loses 4 columns (it is not
      // indented code inside a paragraph); a lazy line indented less
      // keeps its spaces
      let lazy = ind2 >= 4 ? stripCols(line, 4) : line;
      // a lazy setext-like line is paragraph text, not an underline
      if (/^ {0,3}(=+|-+)[ \t]*$/.test(lazy)) {
        (itemLines.noSetext || (itemLines.noSetext = new Set())).add(itemLines.length);
      }
      // a lazy line is a paragraph continuation: it must not interrupt
      // the paragraph when the item's content is re-parsed
      (itemLines.noInterrupt || (itemLines.noInterrupt = new Set())).add(itemLines.length);
      itemLines.push(lazy);
      trackFence(lazy, st);
      j++;
      continue;
    }
    break;
  }
  // task list marker on the first non-blank line
  let task = null;
  for (let t = 0; t < itemLines.length; t++) {
    const l = itemLines[t];
    if (l === '') continue;
    const tm = /^\[( |x|X)\](?:[ \t]+(.*))?$/.exec(l);
    if (tm) {
      task = tm[1];
      itemLines[t] = tm[2] !== undefined ? tm[2] : '';
    }
    break;
  }
  return { lines: itemLines, next: j, loose, task };
}

function parseList(lines, i, hi, out, S, first, collect) {
  const items = [];
  let j = i;
  let loose = false;
  while (j < hi) {
    let k = j;
    let blanks = 0;
    while (k < hi && isBlank(lines[k])) {
      blanks++;
      k++;
    }
    if (k >= hi) break;
    const [ind, idx] = lineIndent(lines[k]);
    if (ind >= 4) break;
    // a thematic break ends the list (e.g. `* * *` is an <hr>, not an item)
    if (isHr(lines[k].slice(idx))) break;
    const m = matchListMarker(lines[k].slice(idx), ind);
    if (!m || m.type !== first.type || m.bullet !== first.bullet || m.delim !== first.delim) break;
    if (blanks > 0) loose = true;
    const item = parseListItem(lines, k, hi, m);
    if (item.loose) loose = true;
    items.push(item);
    j = item.next;
  }
  if (first.type === 'bullet') out.push('<ul>\n');
  else out.push(first.start === 1 ? '<ol>\n' : '<ol start="' + first.start + '">\n');
  for (const item of items) {
    const itemOut = [];
    parseBlocks(item.lines, 0, item.lines.length, itemOut, S, loose ? false : true, collect, true);
    let html = itemOut.join('');
    if (item.task !== null) {
      const cb =
        item.task === ' '
          ? '<input disabled="" type="checkbox">'
          : '<input checked="" disabled="" type="checkbox">';
      if (html.startsWith('<p>')) html = '<p>' + cb + ' ' + html.slice(3);
      else html = cb + ' ' + html;
    }
    out.push('<li>' + html + '</li>\n');
  }
  out.push(first.type === 'bullet' ? '</ul>\n' : '</ol>\n');
  return j;
}

function parseBlocks(lines, lo, hi, out, S, tight, collect, inItem) {
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const [ind, idx] = lineIndent(line);
    if (ind >= 4) {
      i = parseIndentedCode(lines, i, hi, out);
      continue;
    }
    const s = line.slice(idx);
    const fence = matchFence(s);
    if (fence) {
      i = parseFenced(lines, i, hi, out, fence, ind);
      continue;
    }
    const atx = matchATX(s);
    if (atx) {
      out.push('<h' + atx.level + '>' + inlineParse(atx.text, S) + '</h' + atx.level + '>\n');
      i++;
      continue;
    }
    if (isHr(s)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    const htmlType = htmlBlockType(s, false);
    if (htmlType) {
      i = parseHtmlBlock(lines, i, hi, out, htmlType);
      continue;
    }
    if (s[0] === '>') {
      i = parseBlockquote(lines, i, hi, out, S, collect, inItem);
      continue;
    }
    const listM = matchListMarker(s, ind);
    if (listM) {
      i = parseList(lines, i, hi, out, S, listM, collect);
      continue;
    }
    i = parseParagraph(lines, i, hi, out, S, tight, collect, inItem);
  }
}

/** The entry point: render `markdown` exactly as marked 18.1.3 does by default. */
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const lines = src.split('\n');
  const term = src.endsWith('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.term = term;
  lines.isTop = true;
  const S = { refs: new Map() };
  // Phase 1: collect link reference definitions (a use may precede its
  // definition), without rendering. Phase 2 renders with them available.
  parseBlocks(lines, 0, lines.length, [], S, false, true);
  const out = [];
  parseBlocks(lines, 0, lines.length, out, S, false, false);
  return out.join('');
}
