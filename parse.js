// marked-fast: dependency-free CommonMark + GFM renderer.
//
// Output is byte-identical to marked 18.1.3 with default options (gfm
// on, breaks off, pedantic off). Where marked disagrees with the
// CommonMark/GFM specs, marked wins. Emphasis follows marked's emStrong
// scan (the y%3 rule with open/close capacity accounting); a fence line
// inside a list item whose first content line sits below the item's
// content column leaves the fence empty.
// SPDX-License-Identifier: MIT

// ------------------------------------------------------------------ scalars

const ESCAPE_TEST = /[&<>"']/;

// Escape &, <, >, ", ' (marked's escape with encode on).
function escHtml(s) {
  if (!ESCAPE_TEST.test(s)) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = '';
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (i > last) out += s.slice(last, i);
    out += rep;
    last = i + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

// Does s[i] start an entity-like reference (&word; / &#123; / &#x1f;)?
// Decimal runs cap at 7 digits, hex at 6; longer runs are not references.
function entityAt(s, i) {
  const n = s.length;
  let j = i + 1;
  if (j < n && s[j] === '#') {
    j++;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
              : c >= 48 && c <= 57) j++;
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

// Escape &, <, >, ", ' but leave an '&' alone when it starts an
// entity-like reference (marked's escape with encode=false). Used for
// hrefs, titles and alt text, where &amp; / &#169; must survive.
function escAttr(s) {
  if (!ESCAPE_TEST.test(s)) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = '';
    if (c === 38) {
      if (entityAt(s, i)) continue;
      rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    else continue;
    if (i > last) out += s.slice(last, i);
    out += rep;
    last = i + 1;
  }
  return last === 0 ? s : out + s.slice(last);
}

// marked's href encoding: encodeURI (folding %25 back to %, so existing
// percent-escapes are not double-encoded), then attribute-escaping.
function encodeHref(dest) {
  let u;
  try {
    u = encodeURI(dest).replace(/%25/g, '%');
  } catch {
    u = dest;
  }
  return escAttr(u);
}

function isSpaceCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function asciiPunct(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const UNICODE_PUNCT = /[\p{P}\p{S}]/u;
// Unicode punctuation or symbol (emphasis flanking rules). ASCII is
// decided by code ranges; the regex only runs for non-ASCII chars.
function isPunctCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return asciiPunct(ch);
  return UNICODE_PUNCT.test(ch);
}

const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
function isAlnumCh(ch) {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
  return UNICODE_ALNUM.test(ch);
}

// Is the line blank (only spaces/tabs)?
function blankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Leading indentation of a line, packed into one number so callers pay
// no array allocation: columns in the high bits, char index in the low
// 20 bits (lines here are far shorter than 2^20 chars). Decode with
// indCol / indIdx below.
const IND_SHIFT = 1048576;
function indentOf(line) {
  let col = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col = (col | 3) + 1;
    else break;
  }
  return col * IND_SHIFT + i;
}
function indCol(v) { return (v / IND_SHIFT) | 0; }
function indIdx(v) { return v - ((v / IND_SHIFT) | 0) * IND_SHIFT; }

// marked's Dt dedent for fenced code: strip up to `n` leading-whitespace
// CHARACTERS from a line starting with whitespace (a tab counts as one
// character here, not four columns).
function dtDedent(line, n) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  if (i === 0) return line;
  return line.slice(Math.min(i, n));
}

// Strip up to `n` columns of LEADING WHITESPACE only (fenced-code
// dedent: a line with less indent keeps its text). A surviving leading
// tab is expanded to spaces when n is a multiple of 4 (the tab sits on
// a tab stop, so marked emits spaces); when n is not a multiple of 4
// the tab stays literal (marked preserves it in fenced code).
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
  if (n % 4 === 0) {
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 32) { out += ' '; col++; i++; }
      else if (c === 9) {
        const next = (col | 3) + 1;
        out += ' '.repeat(next - col);
        col = next;
        i++;
      } else break;
    }
  }
  return out + line.slice(i);
}

// Strip `n` columns of leading indentation. A tab straddling the
// boundary becomes the spaces needed to reach it. Tabs expand against
// the line's original columns: when `n` is not a multiple of 4, a tab
// that survives the strip would land on a different tab stop, so the
// remaining leading tabs expand to spaces (their original widths); when
// `n` is a multiple of 4 the survivors keep their stops and stay literal
// tabs (marked preserves them in code content). Note the rule is the
// OPPOSITE of stripIndentWs. `expandAll` (list-item lines only):
// marked's list tokenizer expands the line's leading whitespace (tabs
// to the next multiple of 4) BEFORE slicing the indent, so a tab that
// survives the strip always becomes spaces there.
function stripCols(line, n, expandAll) {
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
  if (expandAll || n % 4 !== 0) {
    while (i < line.length) {
      const c = line.charCodeAt(i);
      if (c === 32) { out += ' '; col++; i++; }
      else if (c === 9) {
        const next = (col | 3) + 1;
        out += ' '.repeat(next - col);
        col = next;
        i++;
      } else break;
    }
  }
  return out + line.slice(i);
}

// Unescape backslash escapes (\ + ASCII punct -> punct). Entities are
// NOT decoded.
function unescapeBackslash(s) {
  if (s.indexOf('\\') === -1) return s;
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && asciiPunct(s[i + 1])) {
      if (i > last) out += s.slice(last, i);
      out += s[i + 1];
      i++;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Decode one entity starting at s[i] === '&'. Returns [decoded,
// nextIndex, raw] or null. Numeric entities decode to a character (0,
// surrogates and >0x10FFFF become U+FFFD; decimal >7 digits / hex >6
// digits do not match). Named entities are NOT decoded: `raw` is true
// and the value is the literal `&name;` reference, which marked passes
// through verbatim.
function decodeEntity(s, i) {
  const n = s.length;
  if (i + 1 >= n) return null;
  if (s[i + 1] === '#') {
    let j = i + 2;
    let hex = false;
    if (j < n && (s[j] === 'x' || s[j] === 'X')) { hex = true; j++; }
    const start = j;
    while (j < n) {
      const c = s.charCodeAt(j);
      if (hex ? (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102)
              : c >= 48 && c <= 57) j++;
      else break;
    }
    const count = j - start;
    if (count === 0 || j >= n || s[j] !== ';') return null;
    if (hex ? count > 6 : count > 7) return null;
    let cp = parseInt(s.slice(start, j), hex ? 16 : 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return [String.fromCodePoint(cp), j + 1, false];
  }
  let j = i + 1;
  while (j < n) {
    const c = s.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) j++;
    else break;
  }
  if (j >= n || s[j] !== ';' || j === i + 1) return null;
  return [s.slice(i, j + 1), j + 1, true];
}

// Normalize a link label: collapse whitespace, trim, lowercase. Full
// case folding for ß/ẞ (both fold to 'ss'; toLowerCase alone leaves ß
// as ß, so a [ẞ] link would miss a [SS] definition).
function normalizeLabel(label) {
  return label.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss');
}

// Unicode whitespace (flanking: a non-breaking space counts as
// whitespace, so `* a *` with NBSP around `a` is not emphasis).
function isWsCh(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\u00a0' ||
    ch === '\u1680' || (ch >= '\u2000' && ch <= '\u200a') || ch === '\u202f' ||
    ch === '\u205f' || ch === '\u3000';
}

// Length of the run of `ch` starting at i.
function runLength(s, i, ch) {
  let j = i;
  while (j < s.length && s[j] === ch) j++;
  return j - i;
}

// Skip spaces/tabs/newlines. Returns the new index.
function skipWs(s, i) {
  while (i < s.length && isSpaceCh(s[i])) i++;
  return i;
}

// First word of a trimmed string (fence info language), without a split.
function firstWord(s) {
  let a = 0;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a++;
  let b = a;
  while (b < s.length && s[b] !== ' ' && s[b] !== '\t') b++;
  return s.slice(a, b);
}

// ---------------------------------------------------------------- inline scanners

// Parse a link destination starting at s[i] (after '(' or after `]:`).
// Returns [dest, nextIndex] or null. Handles <...> and bare destinations
// with balanced parens. A bare destination may run to the end of the
// text (a reference definition's destination need not be followed by
// ')' or whitespace).
function readDest(s, i) {
  const n = s.length;
  if (i >= n) return null;
  if (s[i] === '<') {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return [out, j + 1];
      if (c === '\\' && j + 1 < n && asciiPunct(s[j + 1])) {
        out += s[j + 1];
        j += 2;
      } else {
        out += c;
        j++;
      }
    }
    return null;
  }
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
    } else if (c === '\\' && j + 1 < n && asciiPunct(s[j + 1])) {
      out += s[j + 1];
      j += 2;
    } else {
      out += c;
      j++;
    }
  }
  return [out, j];
}

// Parse a link title starting at s[i]. Returns [title, nextIndex] or
// null. Titles are "...", '...', or (...) with backslash escapes; they
// may span lines.
function readTitle(s, i) {
  const n = s.length;
  if (i >= n) return null;
  const q = s[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = s[j];
      if (c === q) return [out, j + 1];
      if (c === '\\' && j + 1 < n && asciiPunct(s[j + 1])) {
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
      } else if (c === '\\' && j + 1 < n && asciiPunct(s[j + 1])) {
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

// Parse an inline link `(dest "title")` starting at s[i] === '('.
// Returns {dest, title, next} or null. A title must be separated from
// the destination by whitespace; a failed inline link does not
// deactivate the opener (the text may still be a shortcut reference).
function readInlineLink(s, i) {
  const n = s.length;
  if (s[i] !== '(') return null;
  let j = skipWs(s, i + 1);
  if (j >= n) return null;
  if (s[j] === ')') return { dest: '', title: null, next: j + 1 };
  const d = readDest(s, j);
  if (!d) return null;
  const dest = d[0];
  j = d[1];
  if (j < n && s[j] === ')') return { dest, title: null, next: j + 1 };
  if (j >= n || !isSpaceCh(s[j])) return null;
  j = skipWs(s, j);
  if (j >= n) return null;
  if (s[j] === ')') return { dest, title: null, next: j + 1 };
  const t = readTitle(s, j);
  if (!t) return null;
  j = skipWs(s, t[1]);
  if (j >= n || s[j] !== ')') return null;
  return { dest, title: t[0], next: j + 1 };
}

// Scan a link label starting at s[i] === '['. Returns [label,
// nextIndex] where nextIndex is just past the matching ']', or null. A
// label ends at the FIRST unescaped ']' (labels do not nest: the text
// up to that ']' is the label, even if it contains an unmatched '[').
// An unescaped '[' inside a label makes it unbalanced: not a label.
// The returned text is raw (backslashes preserved) so that a label with
// an escape does not match one without it.
function readLabel(s, i) {
  const n = s.length;
  let j = i + 1;
  let label = '';
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && asciiPunct(s[j + 1])) {
      label += c + s[j + 1];
      j += 2;
    } else if (c === '[') {
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

// Does a raw link label contain a backtick run that marked's label
// regex cannot match? In a label, a backtick run must either open a code
// span whose content has no backticks (closing run of any length, first
// one wins) or be a `` run at the very end of the label. A run like the
// opening `` of `` a ` b `` pairs with the inner single backtick,
// leaving the closing `` unmatched, so the link never forms (the text
// still renders the code span via the normal tokenizer rule).
function labelHasBadTicks(label) {
  const n = label.length;
  let i = 0;
  while (i < n) {
    // a backslash escape is not a backtick: `\`` in a label is an
    // escaped backtick, and marked's label regex consumes it as one
    if (label[i] === '\\' && i + 1 < n && asciiPunct(label[i + 1])) { i += 2; continue; }
    if (label[i] !== '`') { i++; continue; }
    const len = runLength(label, i, '`');
    let j = i + len;
    let closer = -1;
    while (j < n) {
      if (label[j] === '`') { closer = j; break; }
      j++;
    }
    if (closer !== -1) {
      i = closer + runLength(label, closer, '`');
      continue;
    }
    if (len >= 2 && i + len === n) return false;
    return true;
  }
  return false;
}

// ASCII letter / digit helpers used by the tag scanners (regex .test
// per character is measurably slower in these hot loops).
function alphaCode(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function alnumCode(c) { return (c >= 48 && c <= 57) || alphaCode(c); }
function tagNameCode(c) { return alnumCode(c) || c === 45; }
function attrNameCode(c) { return alnumCode(c) || c === 95 || c === 46 || c === 58 || c === 45; }
function wsCode(c) { return c === 32 || c === 9 || c === 10; }

// Is the char at s[i] the start of an HTML tag, comment, etc.? Returns
// the end index or -1. Validated per CommonMark: attribute names are
// [a-zA-Z_:][a-zA-Z0-9_.:-]*, a '/' must sit directly before '>', a
// closing tag takes no attributes, and a comment may not start with '>'
// or '->', contain '--', or end with '-'.
function scanTag(s, i) {
  const n = s.length;
  if (s[i] !== '<' || i + 1 >= n) return -1;
  const c1 = s[i + 1];
  if (c1 === '!' && s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    if (s[i + 4] === '>' || s.startsWith('->', i + 4)) return -1;
    const end = s.indexOf('-->', i + 4);
    if (end === -1) return -1;
    if (s[end - 1] === '-') return -1;
    return end + 3;
  }
  if (c1 === '?') {
    const end = s.indexOf('?>', i + 2);
    if (end === -1) return -1;
    return end + 2;
  }
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
  let j = i + 1;
  const closing = s[j] === '/';
  if (closing) j++;
  if (j >= n || !alphaCode(s.charCodeAt(j))) return -1;
  while (j < n && tagNameCode(s.charCodeAt(j))) j++;
  // after the tag name only whitespace, '/', or '>' may follow (so
  // `<https://...>` is an autolink, not a tag)
  if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '/' && s[j] !== '>') return -1;
  if (closing) {
    while (j < n && wsCode(s.charCodeAt(j))) j++;
    return j < n && s[j] === '>' ? j + 1 : -1;
  }
  for (;;) {
    while (j < n && wsCode(s.charCodeAt(j))) j++;
    if (j >= n) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/') return j + 1 < n && s[j + 1] === '>' ? j + 2 : -1;
    if (!alphaCode(s.charCodeAt(j)) && s[j] !== '_' && s[j] !== ':') return -1;
    while (j < n && attrNameCode(s.charCodeAt(j))) j++;
    while (j < n && wsCode(s.charCodeAt(j))) j++;
    if (j < n && s[j] === '=') {
      j++;
      while (j < n && wsCode(s.charCodeAt(j))) j++;
      if (j >= n) return -1;
      if (s[j] === '"' || s[j] === "'") {
        const q = s[j];
        j++;
        while (j < n && s[j] !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        const vs = j;
        while (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '"' &&
               s[j] !== "'" && s[j] !== '=' && s[j] !== '<' && s[j] !== '>' && s[j] !== '`') j++;
        if (j === vs) return -1;
      }
      if (j < n && s[j] !== ' ' && s[j] !== '\t' && s[j] !== '\n' && s[j] !== '/' && s[j] !== '>') return -1;
    }
  }
}

const EMAIL_INLINE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*$/;

// Autolink <scheme:...> or <email>. Returns [href, text, next] or null.
function scanAutolink(s, i) {
  const n = s.length;
  if (s[i] !== '<') return null;
  let j = i + 1;
  let k = j;
  if (k < n && alphaCode(s.charCodeAt(k))) {
    k++;
    while (k < n) {
      const c = s.charCodeAt(k);
      if (alnumCode(c) || c === 43 || c === 46 || c === 45) k++;
      else break;
    }
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
  let end = j;
  while (end < n && s[end] !== '>' && s[end] !== ' ' && s[end] !== '\n' && s[end] !== '<') end++;
  if (end < n && s[end] === '>') {
    const text = s.slice(i + 1, end);
    if (EMAIL_INLINE.test(text)) {
      return ['mailto:' + text, text, end + 1];
    }
  }
  return null;
}

// marked's GFM autolink backpedal: non-punct runs, balanced (...) groups,
// a bare & (not an entity at the end), and mid-string trailing
// punctuation only.
const GFM_BACKPEDAL = /^(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/;
// GFM email (marked's rule), as sticky regexes so no slice of the rest
// of the string is needed: local@domain with at least one dot in the
// domain, labels not ending in '-', and not followed by a word char or
// '-'. The trailing-underscore form is used only when an active '_'
// opener is on the stack (the '_' after the email closes emphasis and
// marked's tokenizer never lets the email regex see it).
const GFM_EMAIL = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/y;
const GFM_EMAIL_U = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![A-Za-z0-9-])/y;

// Case-insensitive prefix test without allocating a lowercased slice.
function startsWithCI(s, i, word) {
  for (let k = 0; k < word.length; k++) {
    if (i + k >= s.length) return false;
    let a = s.charCodeAt(i + k);
    let b = word.charCodeAt(k);
    if (a >= 65 && a <= 90) a += 32;
    if (b >= 65 && b <= 90) b += 32;
    if (a !== b) return false;
  }
  return true;
}

// GFM extended autolink at s[i]: www. / scheme://. `prev` is the
// previous char ('' at start). Returns [href, text, next] or null.
function scanGfmLink(s, i, prev) {
  const n = s.length;
  let isWww = false;
  const start = i;
  if (s.startsWith('www.', i)) {
    // www. must be preceded by start, whitespace, or one of *_~(
    if (prev !== '' && !isSpaceCh(prev) && prev !== '*' && prev !== '_' && prev !== '~' && prev !== '(') return null;
    isWww = true;
  } else {
    if (!startsWithCI(s, i, 'http://') && !startsWithCI(s, i, 'https://') && !startsWithCI(s, i, 'ftp://')) return null;
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
    const ent = decodeEntity(text, ampIdx);
    if (ent && ent[1] === text.length) {
      text = text.slice(0, ampIdx);
      end = start + text.length;
    }
  }
  // marked's GFM backpedal: a regex matched from the start, repeated
  // until stable. It keeps runs of non-punct chars, balanced (...) groups,
  // and mid-string punctuation, but drops a '(' that never closes and any
  // trailing punctuation. ']' and '}' are ordinary chars here and kept.
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
    if (!/^www\.[^\s]*\.[^\s.]+$/.test(text) && !/^www\.[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(text)) return null;
    return ['http://' + text, text, end];
  }
  return [text, text, end];
}

// GFM email autolink: word@domain.tld starting at s[i] (i is the start
// of the word). Sticky regex: no slice of the tail of s is allocated.
function scanGfmEmail(s, i, allowUnderscore) {
  const re = allowUnderscore ? GFM_EMAIL_U : GFM_EMAIL;
  re.lastIndex = i;
  const m = re.exec(s);
  if (!m) return null;
  const text = m[0];
  return ['mailto:' + text, text, i + text.length];
}

// Will the '[' opener at src position `openPos` (the '[' itself) form
// a link when its ']' is reached? Used to decide whether a GFM autolink
// or email inside link text must be suppressed: marked tokenizes the
// link atomically, so inner GFM forms only when the outer link does NOT
// form. Returns true when an inline link, a full reference, or a
// shortcut reference would form (including the label-backtick veto,
// which kills the link).
function linkWillForm(s, openPos, cx) {
  const lab = readLabel(s, openPos);
  if (!lab) return false;
  const close = lab[1] - 1;
  const labelText = s.slice(openPos + 1, close);
  if (labelHasBadTicks(labelText)) return false;
  const after = lab[1];
  if (after < s.length && s[after] === '(') {
    return readInlineLink(s, after) !== null;
  }
  if (after < s.length && s[after] === '[') {
    const lab2 = readLabel(s, after);
    if (!lab2) return false;
    const key = lab2[0] === '' ? normalizeLabel(labelText) : normalizeLabel(lab2[0]);
    return cx.refs.has(key);
  }
  return cx.refs.has(normalizeLabel(labelText));
}

// ---------------------------------------------------------------- emphasis

// A delimiter record in the inline parser's output/stack. `srcIdx` is
// the run's start in the source (for the veto-range and emStrong
// checks); `pos` is the '[' position for link/image openers.
function makeDelim(ch, len, open, close, idx, img, srcIdx) {
  return { ch, len, orig: len, open, close, active: true, idx, img: !!img,
    ot: null, ct: null, srcIdx, pos: -1, pairedFar: -1, bUsedFirst: -1 };
}

// Render one output entry (string or delimiter record) to HTML. A
// record's opening tags are ordered outermost-first (the pair whose
// closer is farthest right, ties broken by smaller use first — an <em>
// formed from a run wraps a <strong> from the same run); its closing
// tags are ordered innermost-first (the pair whose opener is nearest,
// ties broken by larger use first). Pairs may form outer-first, so the
// order cannot rely on formation order.
function renderEntry(e) {
  if (typeof e === 'string') return e;
  if (e.ch === '[') return e.img ? '![' : '[';
  let ot = '';
  const otArr = e.ot;
  if (otArr) {
    if (otArr.length > 1) otArr.sort((a, b) => (b.far - a.far) || (a.use - b.use));
    for (const t of otArr) ot += '<' + t.tag + '>';
  }
  let ct = '';
  const ctArr = e.ct;
  if (ctArr) {
    if (ctArr.length > 1) ctArr.sort((a, b) => (b.near - a.near) || (b.use - a.use));
    for (const t of ctArr) ct += '</' + t.tag + '>';
  }
  // a closer run's leftover delimiters split by marked's raw span: the
  // pair consumes the run's FIRST bUsed delimiters (bUsed of the first
  // pair that claimed this run as a closer), and the pair's text keeps
  // the first (bUsed - use) of them, so they render INSIDE the pair
  // (`two*</strong>`); the remaining (orig - bUsed) delimiters lie
  // outside the pair's raw and render AFTER the closing tag (`foo</strong>*`)
  let inLeft = 0;
  let outLeft = e.len;
  if (ctArr && ctArr.length > 0 && e.bUsedFirst >= 0) {
    let usedByCloser = 0;
    for (const t of ctArr) usedByCloser += t.use;
    inLeft = Math.max(0, e.bUsedFirst - usedByCloser);
    if (inLeft > e.len) inLeft = e.len;
    outLeft = e.len - inLeft;
  }
  return e.ch.repeat(inLeft) + ct + e.ch.repeat(outLeft) + ot;
}

// Render output entries [from, to) to HTML.
function renderRange(out, from, to) {
  let s = '';
  for (let i = from; i < to; i++) s += renderEntry(out[i]);
  return s;
}

// marked's emStrong scan, adapted to the delimiter stack: decide whether
// opener `op` (at stack index `oi`) and closer `cl` (at stack index `ci`)
// may pair. `src` is the inline source text. Returns the number of
// delimiters to consume (1 for <em>, 2 for <strong>), or 0 when the
// pair must not form.
//
// The accounting mirrors marked's emStrong: `m` starts at the opener's
// ORIGINAL length and grows by every opener-type run between the two
// (their ORIGINAL lengths — a strong already formed from them still
// counts, because marked scans the raw text), and shrinks by every
// closer-type run. An ambiguous run (can both open and close) is
// skipped — its length added to `f` — when y%3 != 0 and (y+len)%3 == 0,
// where y is the opener's ORIGINAL length (marked's y is the whole run,
// including delimiters already spent on an inner pair). The closer
// itself goes through the same rule-of-3 check when it is ambiguous
// (or a closer-only run while the opener could also close, `rFlag`),
// and its ORIGINAL length is what `m` subtracts. The pair forms only
// when m <= 0 after the closer is consumed; the usable closer length
// is min(cl.orig, cl.orig + m + f). Only the final use is capped by
// the delimiters still available (op.len / cl.len).
function emPairUse(op, cl, stack, oi, ci, src) {
  const ch = op.ch;
  // y is the opener run's length as marked sees it: the ORIGINAL run
  // length when the closer lies after every pair the opener has already
  // formed (the pair is marked's single scan of the raw text), but the
  // LEFTOVER length when the closer lies inside such a pair's span
  // (the pair is formed in the re-lex of that pair's text, where the
  // leftover delimiters are the whole run — e.g. `____foo__ bar__`
  // re-lexes `__foo__ bar` with a 2-long opener, not 4-long)
  const y = cl.srcIdx <= op.pairedFar ? op.len : op.orig;
  if (op.len <= 0 || cl.len <= 0) return 0;
  // marked's emStrong RDelim regex has a leading alternative that
  // swallows a `__...*...__` span (for `*` scans) or a `**..._...**`
  // span (for `_` scans) at the very start of the scan, so a delimiter
  // run inside it never counts as an opener or a closer. The span must
  // start at the first `*`/`_` after the opener, with no `*`/`_` before
  // it, and the inner run must be a single delimiter.
  let skipA = -1;
  let skipB = -1;
  if (ch === '*' || ch === '_') {
    const open2 = ch === '*' ? '__' : '**';
    const inner = ch === '*' ? '*' : '_';
    let q = op.srcIdx + op.orig;
    while (q < src.length && src[q] !== '*' && src[q] !== '_') q++;
    if (q < src.length && src.startsWith(open2, q)) {
      let r = q + 2;
      while (r < src.length && src[r] !== '*' && src[r] !== '_') r++;
      if (r < src.length && src[r] === inner && src[r + 1] !== inner) {
        let s2 = r + 1;
        while (s2 < src.length && src[s2] !== '*' && src[s2] !== '_') s2++;
        if (s2 < src.length && src.startsWith(open2, s2)) {
          skipA = q;
          skipB = s2 + 2;
        }
      }
    }
  }
  if (skipA !== -1 && cl.srcIdx >= skipA && cl.srcIdx < skipB) return 0;
  // rFlag: the opener could also close (marked's R): the char before it
  // is non-whitespace and the char after it is punctuation, or (for '*')
  // the char before it is not punctuation.
  const before = op.srcIdx > 0 ? src[op.srcIdx - 1] : '';
  const after = op.srcIdx + op.orig < src.length ? src[op.srcIdx + op.orig] : '';
  const rFlag = !!op.close && before !== '' && !isWsCh(before) &&
    (isPunctCh(after) || (ch === '*' && !isPunctCh(before)));
  // scan the opener's accounting up to the closer at stack index `j`:
  // `m`/`f` mirror marked's emStrong scan (opener-type runs add, closer
  // -type runs subtract, ambiguous runs are skipped into `f` by the
  // rule of 3). `skip` means the closer at `j` itself is rule-of-3
  // -skipped for this opener and cannot be its pair.
  function scanTo(j) {
    const c = stack[j];
    if (c.open && c.close) {
      if (y % 3 !== 0 && (y + c.orig) % 3 === 0) return { skip: true };
    } else if (rFlag && c.close && !c.open) {
      if (y % 3 !== 0 && (y + c.orig) % 3 === 0) return { skip: true };
    }
    let m2 = y;
    let f2 = 0;
    for (let k = oi + 1; k < j; k++) {
      const r = stack[k];
      if (r.ch !== ch || r.ch === '[' || r.orig === 0) continue;
      if (skipA !== -1 && r.srcIdx >= skipA && r.srcIdx < skipB) continue;
      const len = r.orig;
      if (r.open && !r.close) {
        m2 += len;
      } else if (r.close && !r.open) {
        if (rFlag && y % 3 !== 0 && (y + len) % 3 === 0) f2 += len;
        else m2 -= len;
      } else if (r.open && r.close) {
        if (y % 3 !== 0 && (y + len) % 3 === 0) f2 += len;
        else m2 -= len;
      }
    }
    m2 -= c.orig;
    return { m: m2, f: f2, skip: false };
  }
  const res = scanTo(ci);
  if (res.skip) return null;
  const m = res.m;
  const f = res.f;
  if (m > 0) {
    // not enough closers for the full opener run: marked keeps scanning
    // for a later closer and only retries the run's suffix when the scan
    // exhausts. But the suffix retry is also how a strong's leftover
    // delimiter pairs on (e.g. `**foo* bar*` is two ems, not one): the
    // retry is wrong only when the later full-run pair would be a
    // STRONG (use 2) — then the suffix-first decomposition gives two
    // ems where marked gives one strong. When the later pair would be
    // an em (use 1) the two decompositions agree, so the retry stands.
    for (let j = ci + 1; j < stack.length; j++) {
      const c2 = stack[j];
      if (c2.ch !== ch || c2.ch === '[' || !c2.active || !c2.close || c2.len === 0) continue;
      if (skipA !== -1 && c2.srcIdx >= skipA && c2.srcIdx < skipB) continue;
      const r2 = scanTo(j);
      if (r2.skip || r2.m > 0) continue;
      const b2 = Math.min(c2.orig, c2.orig + r2.m + r2.f);
      if (b2 < 1) continue;
      const useLater = Math.min(op.len, c2.len, b2, 2);
      if (useLater === 2) return null;
    }
    // no later closer pairs as a strong: retry the run's suffix as a
    // shorter opener (e.g. `**foo*` pairs its second `*` with the
    // closer, leaving the first `*` literal). The pair forms with the
    // balanced length, or not at all.
    const eff = op.len - m;
    if (eff < 1) return null;
    return { use: Math.min(eff, cl.len, 2), bUsed: cl.orig };
  }
  const bUsed = Math.min(cl.orig, cl.orig + m + f);
  if (bUsed < 1) return null;
  return { use: Math.min(op.len, cl.len, bUsed, 2), bUsed };
}

// Process emphasis delimiters in `stack` above index `bottom`
// (exclusive), scanning closers left to right (the spec order: the first
// closer is matched first, so an inner pair forms before an outer one).
// Mutates `out` entries via the records' ot/ct. `vetoed` is a list of
// [start, end) source ranges (labels whose link was vetoed for bad
// backticks): a pair whose opener and closer both lie inside one such
// range stays literal.
//
// Two differences from a plain delimiter stack: pairs must pass
// emPairUse (marked's scan), and when a pair forms the records between
// opener and closer are NOT removed — the scan restarts just after the
// opener so an inner pair that the outer pair consumed (e.g. `***a**b*`)
// can still form from the leftover delimiters.
function processEmphasis(stack, bottom, out, src, vetoed) {
  const hasVeto = vetoed.length > 0;
  let cur = bottom + 1;
  while (cur < stack.length) {
    const closer = stack[cur];
    if (!closer.active || closer.ch === '[' || !closer.close || closer.len === 0) {
      cur++;
      continue;
    }
    let found = -1;
    let use = 0;
    let bUsed = 0;
    // openers are tried farthest-first (outermost first): marked tries
    // the leftmost opener first and its scan claims the closer, so an
    // inner opener must not steal a closer the outer opener would pair
    // with (e.g. `**a *b **c**d* e**` pairs the outer `**` as strong)
    for (let oi = bottom + 1; oi < cur; oi++) {
      const op = stack[oi];
      if (!op.active || op.ch === '[' || op.ch !== closer.ch || !op.open || op.len === 0) continue;
      // the odd rule: skip this opener when the match would use a single
      // delimiter (an <em>, not a <strong>), either side can both open
      // and close, and their original lengths sum odd (the closer is
      // saved as an opener for a later match)
      const u0 = Math.min(op.len, closer.len, 2);
      const odd =
        u0 === 1 && ((op.open && op.close) || (closer.open && closer.close)) &&
        (op.orig + closer.orig) % 2 === 1;
      if (odd) continue;
      // vetoed-label range: marked masks a failed link's whole span in
      // its emphasis scan, so a delimiter inside a vetoed label cannot
      // pair with anything — inside the label or outside it (e.g. the
      // `_an` opener in a vetoed `[cache _an ..._ escape](...)` must not
      // pair with a later `_` closer)
      if (hasVeto) {
        let inVeto = false;
        for (let v = 0; v < vetoed.length; v++) {
          const a = vetoed[v][0];
          const b = vetoed[v][1];
          if ((op.srcIdx >= a && op.srcIdx < b) || (closer.srcIdx >= a && closer.srcIdx < b)) { inVeto = true; break; }
        }
        if (inVeto) continue;
      }
      const r = emPairUse(op, closer, stack, oi, cur, src);
      if (!r) continue;
      found = oi;
      use = r.use;
      bUsed = r.bUsed;
      break;
    }
    if (found < 0) {
      cur++;
      continue;
    }
    const opener = stack[found];
    const tag = opener.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    opener.len -= use;
    (opener.ot || (opener.ot = [])).push({ tag, far: closer.idx, use });
    // the farthest closer this opener has paired with: a later pairing
    // whose closer lies at or before it is a re-lex inner pair (its y
    // is the leftover length), not a continuation of the raw scan
    if (closer.srcIdx > opener.pairedFar) opener.pairedFar = closer.srcIdx;
    closer.len -= use;
    (closer.ct || (closer.ct = [])).push({ tag, near: opener.idx, use });
    // the first pair to claim this run as a closer is the outermost
    // one; its bUsed fixes where the run's leftover delimiters render
    if (closer.bUsedFirst < 0) closer.bUsedFirst = bUsed;
    if (opener.len === 0) opener.active = false;
    if (closer.len === 0) {
      closer.active = false;
      cur++;
    }
    // Records strictly between opener and closer cannot form pairs
    // outside this span (marked tokenizes the pair's content
    // recursively): drop them from the stack, EXCEPT same-char
    // emphasis records, which may still pair with the opener's
    // leftover delimiters (e.g. `***a**b*`) — and even when already
    // paired they still count in a later outer opener's emStrong
    // accounting, so inactive ones stay too. The closer itself is
    // outside the range and stays (inactive records are skipped by
    // the scan, but still counted by emPairUse). Their output entries
    // stay, so they still render literally.
    let closerIdx = closer.len === 0 ? cur - 1 : cur;
    let w = found + 1;
    while (w < closerIdx) {
      const r = stack[w];
      if (r.ch === opener.ch) { w++; continue; }
      stack.splice(w, 1);
      cur--;
      closerIdx--;
    }
    // restart just after the opener: the kept records between opener and
    // closer may still form inner pairs from leftover delimiters
    cur = found + 1;
  }
}

// Plain-text rendering of a source range (for image alt text): render
// it as inline HTML, strip the tags, and unescape the entities the
// renderer produced.
function unescapeEntities(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_m, e) =>
    e === 'amp' ? '&' : e === 'lt' ? '<' : e === 'gt' ? '>' : e === 'quot' ? '"' : "'");
}

function plainText(src, cx) {
  const html = inlineParse(src, cx);
  // an <img> in the rendered text contributes its alt text
  const withAlt = html.replace(/<img src="[^"]*" alt="([^"]*)"[^>]*>/g, '$1');
  return unescapeEntities(withAlt.replace(/<[^>]*>/g, ''));
}

// ---------------------------------------------------------------- inline parser

// One regex for the next inline-significant position: a special char,
// or a GFM autolink start (www. / scheme://). A single exec replaces
// the two separate scans the old code ran per plain-text jump.
const NEXT_SPECIAL = /[\\`*_~[\]!<&@\n]|www\.|https?:\/\/|ftp:\/\//gi;

// Index of the next inline-significant position at or after `from`:
// the next special char, or the next GFM autolink start if it comes
// first. Plain text between here and there needs no per-character
// dispatch.
function nextSpecial(src, from) {
  NEXT_SPECIAL.lastIndex = from;
  const m = NEXT_SPECIAL.exec(src);
  return m ? m.index : src.length;
}

// The nearest active '[' opener in the stack, or null.
function openBracket(stack) {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].ch === '[' && stack[k].active) return stack[k];
  }
  return null;
}

// Does the stack hold an active '[' opener? (Scanned from the end:
// the nearest opener decides.)
function hasOpenBracket(stack) {
  for (let k = stack.length - 1; k >= 0; k--) {
    if (stack[k].ch === '[' && stack[k].active) return true;
  }
  return false;
}

// The inline parser: renders one leaf block's text to HTML.
function inlineParse(src, cx) {
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
  // source ranges of labels whose link was vetoed for bad backticks:
  // emphasis with both ends inside one such range stays literal.
  const vetoed = [];
  const flush = (to) => {
    if (to > t0) out.push(escHtml(src.slice(t0, to)));
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
        } else if (asciiPunct(d)) {
          // the backslash is dropped; the char joins the plain run
          // (it is already literal in the source, so just skip the
          // backslash by flushing up to i and pushing the escaped char)
          flush(i);
          out.push(escHtml(d));
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
      const len = runLength(src, i, '`');
      let j = i + len;
      let found = -1;
      while (j < n) {
        const k = src.indexOf('`', j);
        if (k === -1) break;
        const rl = runLength(src, k, '`');
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
      const inLink = hasOpenBracket(stack);
      if (inLink) {
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
            // the label matches: consume opening run, content, and
            // closer run as literal text so the closer is not
            // re-processed as a new opener. Remember the mismatch on
            // the opener: marked's emphasis masking suppresses
            // emphasis after such a link until the next code span.
            for (let k = stack.length - 1; k >= 0; k--) {
              if (stack[k].ch === '[' && stack[k].active) { stack[k].mismatch = true; stack[k].mismatchLen = len; break; }
            }
            i = anyTick + runLength(src, anyTick, '`');
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
      out.push('<code>' + escHtml(content) + '</code>');
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
      const len = runLength(src, i, c);
      // emphasis suppressed after a mismatched-backtick link until the
      // next code span: leave the run in the plain-text run. But NOT
      // inside link text — marked tokenizes a link's label recursively
      // (a fresh, unmasked scan), so `*fast*` in a later link's label
      // still forms emphasis even while the outer text is suppressed.
      if (suppressEmph && !hasOpenBracket(stack)) {
        i += len;
        continue;
      }
      // flanking, inlined (no array allocation): left/right-flanking
      // per the CommonMark rules.
      const before = i > 0 ? src[i - 1] : '';
      const after = i + len < n ? src[i + len] : '';
      const beforeWs = before === '' ? true : isWsCh(before);
      const afterWs = after === '' ? true : isWsCh(after);
      const beforePunct = before === '' ? false : isPunctCh(before);
      const afterPunct = after === '' ? false : isPunctCh(after);
      const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
      const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
      let open;
      let close;
      if (c === '_') {
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
      const rec = makeDelim(c, len, open, close, out.length, false, i);
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
      const rec = makeDelim('[', 0, false, false, out.length, img, pos);
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
        const link = readInlineLink(src, i + 1);
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
        const lab = readLabel(src, i + 1);
        if (lab) {
          // the label for lookup is the raw text, normalized; for the
          // empty-label case use the link text's raw text (formatting
          // and escapes preserved: [*foo* bar] matches [*foo* bar],
          // not [foo bar]; [bar\\] matches [bar\\], not [bar\])
          const key = lab[0] === '' ? normalizeLabel(src.slice(opener.pos + 1, i)) : normalizeLabel(lab[0]);
          const ref = cx.refs.get(key);
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
        const ref = cx.refs.get(key);
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
      // code span whose content holds a backtick) never forms a link;
      // remember the label's range so emphasis inside it stays literal
      if (labelHasBadTicks(src.slice(opener.pos + 1, i))) {
        vetoed.push([opener.pos + 1, i]);
        stack.splice(p, 1);
        i++;
        continue;
      }
      // flush the link text run into `out` before rendering it
      flush(i);
      // process emphasis inside the link text
      processEmphasis(stack, p, out, src, vetoed);
      const textHtml = renderRange(out, opener.idx + 1, out.length);
      out.length = opener.idx;
      if (opener.img) {
        const alt = escAttr(plainText(src.slice(opener.pos + 1, i), cx));
        out.push(
          '<img src="' + encodeHref(dest) + '" alt="' + alt + '"' +
          (title !== null ? ' title="' + escAttr(title) + '"' : '') + '>',
        );
      } else {
        out.push(
          '<a href="' + encodeHref(dest) + '"' +
          (title !== null ? ' title="' + escAttr(title) + '"' : '') + '>' + textHtml + '</a>',
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
          const rl = runLength(src, k, '`');
          let j2 = k + rl;
          let okSpan = false;
          while (j2 < n) {
            const k2 = src.indexOf('`', j2);
            if (k2 === -1) break;
            if (runLength(src, k2, '`') === rl) { okSpan = true; break; }
            j2 = k2 + runLength(src, k2, '`');
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
      const e = decodeEntity(src, i);
      if (e) {
        flush(i);
        // named entities pass through verbatim; numeric decodes get escaped
        out.push(e[2] ? e[0] : escHtml(e[0]));
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
        out.push('<a href="' + encodeHref(auto[0]) + '">' + escAttr(auto[1]) + '</a>');
        i = auto[2];
        t0 = i;
        continue;
      }
      const tagEnd = scanTag(src, i);
      if (tagEnd !== -1) {
        // marked's tag tokenizer tracks <a> tags on the lexer state:
        // an `<a ...>` tag sets inLink (suppressing later GFM autolinks
        // until a `</a>` clears it), and the state persists across
        // blocks — an unclosed `<a>` suppresses every later bare URL
        // and email in the document
        const tag = src.slice(i, tagEnd);
        if (/^<a /i.test(tag)) cx.inLink = true;
        else if (/^<\/a>/i.test(tag)) cx.inLink = false;
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
    // never forms inside link text that WILL form a link (marked
    // tokenizes the link atomically, so a link cannot contain a link);
    // but when the outer link does not form, the bare URL inside its
    // label still links. Angle autolinks <...> DO nest, so only the
    // GFM forms are suppressed here.
    if (((c === 'w' || c === 'W') && startsWithCI(src, i, 'www.')) ||
        ((c === 'h' || c === 'H') && (startsWithCI(src, i, 'http://') || startsWithCI(src, i, 'https://'))) ||
        ((c === 'f' || c === 'F') && startsWithCI(src, i, 'ftp://'))) {
      const br = openBracket(stack);
      const suppressed = cx.inLink || (br !== null && linkWillForm(src, br.pos, cx));
      if (!suppressed) {
        const prev = i > 0 ? src[i - 1] : '';
        const g = scanGfmLink(src, i, prev);
        if (g) {
          flush(i);
          out.push('<a href="' + encodeHref(g[0]) + '">' + escAttr(g[1]) + '</a>');
          i = g[2];
          t0 = i;
          continue;
        }
      }
      i = nextSpecial(src, i + 1);
      continue;
    }
    // --- GFM email autolink: look back for a word start at '@'.
    // Suppressed inside link text that will form a link, like the GFM
    // bare-URL autolink.
    if (c === '@') {
      const br = openBracket(stack);
      const suppressed = cx.inLink || (br !== null && linkWillForm(src, br.pos, cx));
      if (!suppressed) {
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
                if (pb === '' || isSpaceCh(pb) || pb === '*' || pb === '_' || pb === '~' || pb === '(') {
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
            out.push('<a href="' + encodeHref(href) + '">' + escAttr(text) + '</a>');
            i = end;
            t0 = i;
            continue;
          }
        }
      }
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
    // --- plain text: jump to the next significant position (start
    // after i: the char here is plain, or a '!' not followed by '[',
    // which nextSpecial would otherwise return unchanged)
    i = nextSpecial(src, i + 1);
  }
  flush(n);
  processEmphasis(stack, -1, out, src, vetoed);
  return renderRange(out, 0, out.length);
}

// ---------------------------------------------------------------- blocks

// A fenced-code opener at the start of `s`: {char, len, info}, or null.
// Backtick fences may not contain a backtick in the info string.
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

// An ATX heading at the start of `s`: {level, text}, or null. A closing
// sequence of #'s is stripped only when preceded by whitespace.
function matchATX(s) {
  if (s[0] !== '#') return null;
  let level = 0;
  while (level < s.length && s[level] === '#') level++;
  if (level > 6) return null;
  if (level === s.length) return { level, text: '' };
  const c = s[level];
  if (c !== ' ' && c !== '\t') return null;
  // text = s after the marker, trimmed at both ends; a closing run of
  // #'s preceded by whitespace is stripped (a text of only #'s is empty).
  let a = level + 1;
  while (a < s.length && (s[a] === ' ' || s[a] === '\t')) a++;
  let b = s.length;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  let text = s.slice(a, b);
  if (text.length > 0) {
    let h = text.length;
    while (h > 0 && text[h - 1] === '#') h--;
    if (h === 0) text = '';
    else if (h < text.length && (text[h - 1] === ' ' || text[h - 1] === '\t')) {
      let e = h;
      while (e > 0 && (text[e - 1] === ' ' || text[e - 1] === '\t')) e--;
      text = text.slice(0, e);
    }
  }
  return { level, text };
}

// A thematic break: 3+ of the same -, *, _ with only spaces/tabs.
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

// A setext underline: 1 for '=', 2 for '-', 0 otherwise. The line must
// be a run of one char plus trailing spaces/tabs only.
function matchSetext(s) {
  if (s.length === 0) return 0;
  const c = s[0];
  if (c !== '=' && c !== '-') return 0;
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

// HTML block type (1-7) for a line's content, or 0. `forInterrupt`
// when the line follows a paragraph (type 7 cannot interrupt one).
function htmlBlockType(s, forInterrupt) {
  if (s[0] !== '<') return 0;
  const m1 = /^<(script|pre|style|textarea)([ \t>]|$)/i.exec(s);
  if (m1) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (s.startsWith('<!') && s.length > 2 && s[2] >= 'A' && s[2] <= 'Z') return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  let j = 1;
  if (s[j] === '/') j++;
  if (j < s.length && alphaCode(s.charCodeAt(j))) {
    const nameStart = j;
    while (j < s.length && tagNameCode(s.charCodeAt(j))) j++;
    if (BLOCK_TAGS.has(s.slice(nameStart, j).toLowerCase())) {
      if (j >= s.length) return 6;
      const c = s[j];
      if (c === ' ' || c === '\t' || c === '>') {
        if (scanTag(s, 0) !== -1) return 6;
        // the tag closes on this line but is not a valid tag
        let e = s.length;
        while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
        if (e > 0 && s[e - 1] === '>') return 0;
        return 6;
      }
      if (c === '/' && s[j + 1] === '>') return 6;
    }
  }
  // type 7 (cannot interrupt a paragraph): a complete tag alone on the line
  if (!forInterrupt) {
    const tagEnd = scanTag(s, 0);
    if (tagEnd !== -1 && blankLine(s.slice(tagEnd))) return 7;
  }
  return 0;
}

// Parse a link reference definition starting at lines[k]. Returns the
// number of lines consumed, or 0 when the lines do not form a
// definition. The label may span lines; the destination may be <...> or
// bare; a title may follow on the same line or the next line (at most
// one newline separates it from the destination). First definition
// wins for a label.
function tryParseRefDef(lines, k, cx) {
  const line = lines[k];
  const v = indentOf(line);
  const ind = (v / IND_SHIFT) | 0;
  const idx = v - ind * IND_SHIFT;
  if (ind >= 4 || line[idx] !== '[') return 0;
  const text = lines.slice(k).join('\n');
  const lab = readLabel(text, idx);
  if (!lab || text[lab[1]] !== ':') return 0;
  const key = normalizeLabel(lab[0]);
  if (key === '' || key.length > 999) return 0;
  let pos = lab[1] + 1;
  pos = skipWs(text, pos);
  if (pos >= text.length) return 0;
  const d = readDest(text, pos);
  if (!d) return 0;
  pos = d[1];
  // only whitespace (or the end) may follow the destination
  if (pos < text.length && !isSpaceCh(text[pos])) return 0;
  let title = null;
  let p2 = pos;
  while (p2 < text.length && (text[p2] === ' ' || text[p2] === '\t')) p2++;
  if (p2 < text.length && text[p2] === '\n') {
    p2++;
    while (p2 < text.length && (text[p2] === ' ' || text[p2] === '\t')) p2++;
  }
  let endPos = pos;
  if (p2 < text.length) {
    const t = readTitle(text, p2);
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
  if (!cx.refs.has(key)) cx.refs.set(key, { dest: d[0], title });
  return consumed;
}

// Split a table row on unescaped pipes; trim cells. Marked's table
// split only respects `\|` escapes, so a `|` inside a code span IS a
// cell separator (code spans are not protected here).
function splitTableRow(line) {
  const cells = [];
  const n = line.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const c = line[i];
    if (c === '\\' && i + 1 < n && line[i + 1] === '|') {
      i += 2;
      continue;
    }
    if (c === '|') {
      cells.push(line.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  cells.push(line.slice(start));
  let ls = 0;
  while (ls < n && (line[ls] === ' ' || line[ls] === '\t')) ls++;
  let le = n;
  while (le > ls && (line[le - 1] === ' ' || line[le - 1] === '\t')) le--;
  if (line[ls] === '|' && cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (line[le - 1] === '|' && cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  for (let k = 0; k < cells.length; k++) {
    let cell = cells[k].trim();
    if (cell.indexOf('\\|') !== -1) cell = cell.replace(/\\\|/g, '|');
    cells[k] = cell;
  }
  return cells;
}

// Parse a table delimiter row; returns alignments or null.
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

// A list marker at the start of `s` (content after 0-3 indent), or
// null. `startCol` is the marker's absolute column.
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

// Can the line's block start interrupt a paragraph? Dispatched on the
// first character: most paragraph lines start with a letter, and no
// block start can begin with one, so they return false without calling
// any matcher.
function canInterruptParagraph(s, inItem) {
  const c0 = s.charCodeAt(0);
  if (c0 === 35) return !!matchATX(s); // '#'
  if (c0 === 96 || c0 === 126) return !!matchFence(s); // '`' '~'
  if (c0 === 42 || c0 === 45 || c0 === 95) { // '*' '-' '_'
    if (isHr(s)) return true;
    const m = matchListMarker(s);
    if (!m || m.empty) return false;
    return true; // a bullet always interrupts
  }
  if (c0 === 60) return !!htmlBlockType(s, true); // '<'
  if (c0 === 62) return true; // '>'
  if (c0 === 43 || (c0 >= 48 && c0 <= 57)) { // '+' or digit
    const m = matchListMarker(s);
    if (!m || m.empty) return false;
    if (m.type === 'bullet') return true;
    // an ordered list can interrupt a paragraph only when it starts with 1
    // — except inside a list item, where any start number interrupts
    // (marked: "- foo\n  bar\n  5. baz" nests the "5." list)
    return inItem ? true : m.start === 1;
  }
  return false;
}

// Can the line continue a paragraph (lazy continuation)? A setext
// underline cannot be a lazy continuation line.
function isParaContinuation(line) {
  const v = indentOf(line);
  if (indIdx(v) === line.length) return false;
  if (indCol(v) >= 4) return true;
  const s = line.slice(indIdx(v));
  return !canInterruptParagraph(s);
}

// Track fenced-code state for lazy-continuation decisions while
// collecting container lines. `st` is {inFence, char, len}.
function trackFence(line, st) {
  const v = indentOf(line);
  if (indCol(v) >= 4) return;
  const s = line.slice(indIdx(v));
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
    if (len >= st.len && blankLine(s.slice(len))) st.inFence = false;
  }
}

// ---------------------------------------------------------------- block parsers

// Indented code block. In collect mode only the end index is needed:
// no text is built or escaped.
function parseIndentedCode(lines, i, hi, out, collect) {
  let j = i;
  if (collect) {
    while (j < hi) {
      const line = lines[j];
      if (blankLine(line)) { j++; continue; }
      if (indCol(indentOf(line)) >= 4) j++;
      else break;
    }
    return j;
  }
  const code = [];
  while (j < hi) {
    const line = lines[j];
    if (blankLine(line)) {
      // a blank line keeps its whitespace minus the 4-column code indent
      code.push(stripCols(line, 4));
      j++;
      continue;
    }
    if (indCol(indentOf(line)) >= 4) {
      code.push(stripCols(line, 4));
      j++;
    } else break;
  }
  while (code.length && code[code.length - 1].trim() === '') code.pop();
  const text = code.length ? code.join('\n') + '\n' : '';
  out.push('<pre><code>' + escHtml(text) + '</code></pre>\n');
  return j;
}

// Fenced code block. In collect mode only the closing fence is scanned.
function parseFenced(lines, i, hi, out, fence, fenceIndentChars, collect) {
  let j = i + 1;
  if (collect) {
    while (j < hi) {
      const line = lines[j];
      const v = indentOf(line);
      if (indCol(v) < 4) {
        const s = line.slice(indIdx(v));
        if (s[0] === fence.char) {
          let len = 0;
          while (len < s.length && s[len] === fence.char) len++;
          if (len >= fence.len && blankLine(s.slice(len))) { j++; break; }
        }
      }
      j++;
    }
    return j;
  }
  const content = [];
  // marked's Dt: a backtick fence removes up to the opener's leading-
  // whitespace CHARACTER count from each content line that starts with
  // whitespace (a tab counts as one character, not four columns); a
  // tilde fence's opener never matches that pattern, so tilde fences
  // keep their content lines as-is
  const dedent = fence.char === '~' ? 0 : fenceIndentChars;
  while (j < hi) {
    const line = lines[j];
    const v = indentOf(line);
    if (indCol(v) < 4) {
      const s = line.slice(indIdx(v));
      if (s[0] === fence.char) {
        let len = 0;
        while (len < s.length && s[len] === fence.char) len++;
        if (len >= fence.len && blankLine(s.slice(len))) {
          j++;
          break;
        }
      }
    }
    // content lines are dedented by the opening fence's indent
    // (backtick fences only; tilde fences keep content as-is)
    content.push(dedent ? dtDedent(line, dedent) : line);
    j++;
  }
  const lang = unescapeBackslash(firstWord(fence.info.trim()));
  // the text is the lines joined by '\n'; a trailing '\n' is added
  // only when the last line is non-empty (a trailing blank line already
  // ends the joined text with '\n')
  const text = content.length ? content.join('\n') + (content[content.length - 1] !== '' ? '\n' : '') : '';
  out.push(
    '<pre><code' + (lang ? ' class="language-' + escAttr(lang) + '"' : '') + '>' +
    escHtml(text) + '</code></pre>\n',
  );
  return j;
}

// HTML block. In collect mode only the end line is found.
function parseHtmlBlock(lines, i, hi, out, type, collect) {
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
      if (blankLine(line)) break;
    }
    j++;
  }
  if (collect) return j;
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
    (type <= 5 ? nextLine !== '' : !blankLine(nextLine));
  const atEndWithTerm = j === lines.length && lines.isTop && lines.term;
  if (nextIsContent || atEndWithTerm) text += '\n';
  out.push(text);
  return j;
}

// Is the last block in qlines a paragraph (so a lazy line may continue
// it)? A lazy continuation can only continue a paragraph. An indented
// code block (every line indented 4+ back to the block start) is not a
// paragraph; neither is a last line that itself starts a heading, fence,
// hr, HTML block, list or blockquote.
function lastBlockIsPara(qlines) {
  const L = qlines[qlines.length - 1];
  if (L === '') return false;
  const lv = indentOf(L);
  const lind = (lv / IND_SHIFT) | 0;
  const lidx = lv - lind * IND_SHIFT;
  // a nested blockquote line: strip its '>' markers and judge the
  // innermost content line (the nested quote's parser will handle the
  // lazy continuation)
  if (lind < 4 && L[lidx] === '>') {
    let inner = L;
    for (;;) {
      const iv = indentOf(inner);
      const iind = (iv / IND_SHIFT) | 0;
      const iidx = iv - iind * IND_SHIFT;
      if (iind >= 4 || inner[iidx] !== '>') break;
      inner = stripCols(inner, iind + 1 + ((inner[iidx + 1] === ' ' || inner[iidx + 1] === '\t') ? 1 : 0));
    }
    const iv2 = indentOf(inner);
    const iind2 = (iv2 / IND_SHIFT) | 0;
    const iidx2 = iv2 - iind2 * IND_SHIFT;
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
    const pv = indentOf(prev);
    const pind = (pv / IND_SHIFT) | 0;
    const pidx = pv - pind * IND_SHIFT;
    if (pind < 4) {
      const ps = prev.slice(pidx);
      if (ps[0] === '>' || matchATX(ps) || matchFence(ps) || isHr(ps) || htmlBlockType(ps, true) || matchListMarker(prev, pidx)) break;
      return true; // a paragraph line: this line continues it
    }
    k--;
  }
  return false; // indented code
}

function parseBlockquote(lines, i, hi, out, cx, collect, inItem) {
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
    const v = indentOf(line);
    const ind = (v / IND_SHIFT) | 0;
    const idx = v - ind * IND_SHIFT;
    if (ind < 4 && line[idx] === '>') {
      // strip '>' plus one following space/tab; stripCols handles a
      // straddling tab and re-expands surviving leading tabs
      const stripped = stripCols(line, ind + 1 + ((line[idx + 1] === ' ' || line[idx + 1] === '\t') ? 1 : 0));
      qlines.push(stripped);
      trackFence(stripped, st);
      chunkStart = true;
      j++;
    } else if (blankLine(line)) {
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
  if (collect) {
    parseBlocks(qlines, 0, qlines.length, [], cx, false, true, inItem);
    return j;
  }
  const inner = [];
  parseBlocks(qlines, 0, qlines.length, inner, cx, false, false, inItem);
  out.push('<blockquote>\n' + inner.join('') + '</blockquote>\n');
  return j;
}

function renderTable(headCells, aligns, rows, out, cx) {
  const cols = headCells.length;
  out.push('<table>\n<thead>\n<tr>\n');
  for (let c = 0; c < cols; c++) {
    const a = aligns[c];
    out.push('<th' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(headCells[c], cx) + '</th>\n');
  }
  out.push('</tr>\n</thead>\n');
  if (rows.length > 0) {
    out.push('<tbody>');
    for (const row of rows) {
      out.push('<tr>\n');
      for (let c = 0; c < cols; c++) {
        const a = aligns[c];
        const cell = c < row.length ? row[c] : '';
        out.push('<td' + (a ? ' align="' + a + '"' : '') + '>' + inlineParse(cell, cx) + '</td>\n');
      }
      out.push('</tr>\n');
    }
    out.push('</tbody>');
  }
  out.push('</table>\n');
}

function parseParagraph(lines, i, hi, out, cx, tight, collect, inItem) {
  const plines = [];
  let j = i;
  let setextLevel = 0;
  // set once the second line is collected: this paragraph is a GFM
  // table (its second line is a delimiter row)
  let isTable = false;
  while (j < hi) {
    const line = lines[j];
    const v = indentOf(line);
    const ind = (v / IND_SHIFT) | 0;
    const idx = v - ind * IND_SHIFT;
    if (idx === line.length) {
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
    if (j > i && ind < 4) {
      const s = line.slice(idx);
      // a lazy line is a paragraph continuation: it cannot be a setext
      // underline or interrupt the paragraph
      const isLazy = lines.noInterrupt && lines.noInterrupt.has(j);
      // a lazy setext-like line inside a blockquote is paragraph text,
      // not an underline (marked: a setext underline cannot be lazy)
      // a table row can never be a setext underline: marked's table
      // rule swallows later lines as rows until a blank line
      const se = (isTable || isLazy || (lines.noSetext && lines.noSetext.has(j))) ? 0 : matchSetext(s);
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
      isTable = indCol(indentOf(plines[1])) < 4 && !!parseDelimiterRow(plines[1]);
    }
    j++;
  }
  // strip link reference definitions from the start
  let start = 0;
  while (start < plines.length) {
    const consumed = tryParseRefDef(plines, start, cx);
    if (consumed === 0) break;
    start += consumed;
  }
  const rest = start === 0 ? plines : plines.slice(start);
  if (collect) return setextLevel ? (rest.length === 0 ? j : j + 1) : j;
  if (setextLevel) {
    if (rest.length === 0) return j; // only defs: leave the setext line for the caller
    // setext heading text is trimmed at both ends (leading spaces of the
    // first line and trailing spaces of the last line go; a continuation
    // line's leading spaces stay)
    const text = rest.join('\n').replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
    out.push('<h' + setextLevel + '>' + inlineParse(text, cx) + '</h' + setextLevel + '>\n');
    return j + 1;
  }
  if (rest.length === 0) return j; // only definitions, no output
  // GFM table? The delimiter row must be indented less than 4 columns.
  if (rest.length >= 2) {
    const aligns = indCol(indentOf(rest[1])) < 4 ? parseDelimiterRow(rest[1]) : null;
    if (aligns) {
      const headCells = splitTableRow(rest[0]);
      if (aligns.length === headCells.length) {
        const rows = [];
        for (let r = 2; r < rest.length; r++) rows.push(splitTableRow(rest[r]));
        renderTable(headCells, aligns, rows, out, cx);
        return j;
      }
    }
  }
  const text = rest.join('\n');
  if (tight) out.push(inlineParse(text, cx));
  else out.push('<p>' + inlineParse(text, cx) + '</p>\n');
  return j;
}

function parseListItem(lines, i, hi, m) {
  const firstContent = stripCols(lines[i], m.contentCol);
  const itemLines = [firstContent];
  const st = { inFence: false, char: '', len: 0 };
  trackFence(firstContent, st);
  // whether any content line has been collected inside the fence yet
  let fenceContent = false;
  let j = i + 1;
  let loose = false;
  while (j < hi) {
    const line = lines[j];
    if (blankLine(line)) {
      // an empty item ends at a blank line: content after it is not
      // part of the item
      let hasContent = false;
      for (const l of itemLines) if (l !== '') { hasContent = true; break; }
      if (!hasContent) break;
      let k = j;
      while (k < hi && blankLine(lines[k])) k++;
      if (k >= hi) break;
      if (indCol(indentOf(lines[k])) < m.contentCol) break;
      // blank line(s) inside the item, followed by indented content.
      // it only makes this item loose if it separates two blocks at
      // this item's own level: if the following content is indented and
      // a nested list (or its continuation) is already open in this
      // item, the blank line belongs to the nested list, not this item.
      // blank lines inside a fenced code block never loosen the item.
      if (hasContent && !st.inFence) {
        const stripped = stripCols(lines[k], m.contentCol);
        const sind = indCol(indentOf(stripped));
        let nestedOpen = false;
        for (let t = itemLines.length - 1; t >= 0; t--) {
          const l = itemLines[t];
          if (l === '') continue;
          const lv = indentOf(l);
          const lind = (lv / IND_SHIFT) | 0;
          const lidx = lv - lind * IND_SHIFT;
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
    if (indCol(indentOf(line)) >= m.contentCol) {
      const stripped = stripCols(line, m.contentCol, true);
      itemLines.push(stripped);
      if (st.inFence) fenceContent = true;
      trackFence(stripped, st);
      j++;
      continue;
    }
    // Inside a fenced code block, a line indented below the item's
    // content column is fence content — but only once some content has
    // been collected, and only if it is not the closing fence. A
    // closing-fence line below the content column ends the item (the
    // fence stays unclosed inside it, and the line opens a new fence at
    // the top level), and so does a first content line below the content
    // column (the fence is empty in marked: doc-13/17/38). This is the
    // doc-13 mechanism: a fence whose first content line sits at
    // column 0 is empty, and a fence-looking line after it swallows
    // the rest of the input — including the link reference definitions
    // at the end of the document.
    if (st.inFence) {
      const cv = indentOf(line);
      const cidx = indIdx(cv);
      const cs = line.slice(cidx);
      let isClose = false;
      if (cs[0] === st.char) {
        let len = 0;
        while (len < cs.length && cs[len] === st.char) len++;
        if (len >= st.len && blankLine(cs.slice(len))) isClose = true;
      }
      if (isClose || !fenceContent) break;
      // strip only leading whitespace (stripCols would eat non-space
      // characters of a column-0 fence content line: "function" -> "nction")
      const stripped = stripIndentWs(line, m.contentCol);
      itemLines.push(stripped);
      fenceContent = true;
      trackFence(stripped, st);
      j++;
      continue;
    }
    // a list marker at this level starts a new item (or a new list):
    // it ends this item, it is not a lazy continuation of its paragraph
    const mv = indentOf(line);
    const mind = (mv / IND_SHIFT) | 0;
    const midx = mv - mind * IND_SHIFT;
    if (mind < 4 && matchListMarker(line.slice(midx), mind)) break;
    if (itemLines.length > 0 && itemLines[itemLines.length - 1] !== '' && isParaContinuation(line)) {
      // a lazy line indented 4+ columns loses 4 columns (it is not
      // indented code inside a paragraph); a lazy line indented less
      // keeps its spaces
      const ind2 = indCol(mv);
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

function parseList(lines, i, hi, out, cx, first, collect) {
  const items = [];
  let j = i;
  let loose = false;
  while (j < hi) {
    let k = j;
    let blanks = 0;
    while (k < hi && blankLine(lines[k])) {
      blanks++;
      k++;
    }
    if (k >= hi) break;
    const kv = indentOf(lines[k]);
    const ind = (kv / IND_SHIFT) | 0;
    const idx = kv - ind * IND_SHIFT;
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
  if (collect) {
    for (const item of items) {
      parseBlocks(item.lines, 0, item.lines.length, [], cx, loose ? false : true, true, true);
    }
    return j;
  }
  if (first.type === 'bullet') out.push('<ul>\n');
  else out.push(first.start === 1 ? '<ol>\n' : '<ol start="' + first.start + '">\n');
  for (const item of items) {
    const itemOut = [];
    parseBlocks(item.lines, 0, item.lines.length, itemOut, cx, loose ? false : true, false, true);
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

// The block dispatcher. Lines are dispatched on their first content
// character: each block start can only begin with certain characters,
// so an ordinary paragraph line (letter, digit, quote, ...) reaches
// parseParagraph without paying for the fence/ATX/hr/HTML/list matcher
// calls the old code ran on every line.
function parseBlocks(lines, lo, hi, out, cx, tight, collect, inItem) {
  let i = lo;
  while (i < hi) {
    const line = lines[i];
    const v = indentOf(line);
    const ind = (v / IND_SHIFT) | 0;
    const idx = v - ind * IND_SHIFT;
    if (idx === line.length) {
      i++;
      continue;
    }
    if (ind >= 4) {
      i = parseIndentedCode(lines, i, hi, out, collect);
      continue;
    }
    const s = line.slice(idx);
    const c0 = s.charCodeAt(0);
    if (c0 === 96 || c0 === 126) { // '`' '~'
      const fence = matchFence(s);
      if (fence) {
        i = parseFenced(lines, i, hi, out, fence, idx, collect);
        continue;
      }
    } else if (c0 === 35) { // '#'
      const atx = matchATX(s);
      if (atx) {
        if (!collect) out.push('<h' + atx.level + '>' + inlineParse(atx.text, cx) + '</h' + atx.level + '>\n');
        i++;
        continue;
      }
    } else if (c0 === 42 || c0 === 45 || c0 === 95) { // '*' '-' '_'
      if (isHr(s)) {
        if (!collect) out.push('<hr>\n');
        i++;
        continue;
      }
      const listM = matchListMarker(s, ind);
      if (listM) {
        i = parseList(lines, i, hi, out, cx, listM, collect);
        continue;
      }
    } else if (c0 === 60) { // '<'
      const htmlType = htmlBlockType(s, false);
      if (htmlType) {
        i = parseHtmlBlock(lines, i, hi, out, htmlType, collect);
        continue;
      }
    } else if (c0 === 62) { // '>'
      i = parseBlockquote(lines, i, hi, out, cx, collect, inItem);
      continue;
    } else if (c0 === 43 || (c0 >= 48 && c0 <= 57)) { // '+' or digit
      const listM = matchListMarker(s, ind);
      if (listM) {
        i = parseList(lines, i, hi, out, cx, listM, collect);
        continue;
      }
    }
    i = parseParagraph(lines, i, hi, out, cx, tight, collect, inItem);
  }
}

// The entry point: render `markdown` exactly as marked 18.1.3 does by default.
export function parse(markdown) {
  const src = markdown.indexOf('\r') === -1 ? markdown : markdown.replace(/\r\n|\r/g, '\n');
  const lines = src.split('\n');
  const term = src.endsWith('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.term = term;
  lines.isTop = true;
  const cx = { refs: new Map(), inLink: false };
  // Phase 1: collect link reference definitions (a use may precede its
  // definition), without rendering. Phase 2 renders with them available.
  parseBlocks(lines, 0, lines.length, [], cx, false, true);
  const out = [];
  parseBlocks(lines, 0, lines.length, out, cx, false, false);
  return out.join('');
}
