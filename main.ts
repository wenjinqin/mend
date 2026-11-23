// mend: one patch tool for every AI edit format.
//
// Applies an edit written by an AI model to a tree of text files. The patch
// is read in one of four formats -- a unified diff (often with wrong line
// numbers), SEARCH/REPLACE blocks, the V4A patch format, or text-editor tool
// calls as JSON -- and every file is changed or nothing is. The whole
// contract is SPEC.md in the kit this entry was built from.
//
// Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
// with the working directory as the root of the tree. PATCH is the patch
// file, or standard input when it is absent or `-`. Node 22 and its
// standard library alone; no network, no randomness, no wall clock.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed from each, and no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no `\`, and none of its segments is empty, `.` or `..`. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------
// Files: lines, line break, final break
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  finalBreak: boolean;
}

/** Split a file's text into its lines. The break is CRLF when the first line feed follows a carriage return, LF otherwise. */
function parseFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { lines: parts, br, finalBreak };
}

/** Write a file's state back. A file of no lines is written empty. */
function serializeFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

const leadingWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};
const rtrimWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

// ---------------------------------------------------------------------------
// The tree as the edits leave it
// ---------------------------------------------------------------------------

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;
type MoveRecorder = (oldPath: string, newPath: string) => void;

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC.md section 5)
// ---------------------------------------------------------------------------

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rtrimWs(a) === rtrimWs(b);
  return trimWs(a) === trimWs(b);
}

/** Every 0-based position at or after `from` where O matches the file's lines at the tier. Occurrences may overlap. */
function occurrences(lines: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const last = lines.length - O.length;
  for (let i = from; i <= last; i++) {
    let ok = true;
    for (let k = 0; k < O.length; k++) {
      if (!lineEq(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at least once (at or after `from`), with its positions. Null when it occurs at no tier. */
function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: a context line (the file's own matched line, index into O) or an added line (the patch's text). */
interface NewLine {
  ctx: number | null;
  text: string;
}

/**
 * Resolve N against the file's matched lines at `pos`: a context line is
 * written as the file's own matched line, never the patch's. At tier 2 every
 * other line is re-indented from the patch's indent to the file's indent.
 */
function resolveNew(fileLines: string[], pos: number, O: string[], N: NewLine[], tier: number): string[] {
  const out: string[] = [];
  let p = '';
  let f = '';
  if (tier === 2 && O.length > 0) {
    p = leadingWs(O[0]!);
    f = leadingWs(fileLines[pos]!);
  }
  for (const nl of N) {
    if (nl.ctx !== null) {
      out.push(fileLines[pos + nl.ctx]!);
      continue;
    }
    let t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) t = f + t.slice(p.length);
    out.push(t);
  }
  return out;
}

/** A body line of a unified hunk or a V4A chunk: context, old, new, or a `\` marker line. */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'backslash';
  text: string;
  /** True when the patch line itself was blank (empty or only whitespace). */
  blankPatch: boolean;
}

function bodyLine(l: string): BodyLine {
  if (l.startsWith(' ')) return { kind: 'ctx', text: l.slice(1), blankPatch: blank(l) };
  if (l.startsWith('-')) return { kind: 'old', text: l.slice(1), blankPatch: false };
  if (l.startsWith('+')) return { kind: 'new', text: l.slice(1), blankPatch: false };
  if (l.startsWith('\\')) return { kind: 'backslash', text: l.slice(1), blankPatch: false };
  return { kind: 'ctx', text: '', blankPatch: true };
}

/** Split a hunk or chunk body into its old lines O and its new lines N. */
function splitBody(body: BodyLine[]): { O: string[]; N: NewLine[] } {
  const O: string[] = [];
  const N: NewLine[] = [];
  for (const b of body) {
    if (b.kind === 'ctx') {
      O.push(b.text);
      N.push({ ctx: O.length - 1, text: b.text });
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ ctx: null, text: b.text });
    }
  }
  return { O, N };
}

// ---------------------------------------------------------------------------
// Format detection (section 4)
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// JSON edits (section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when it is not one. A wrong command or a missing or mistyped key is a parse fault. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = parseFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      const lines = [...f.lines];
      lines.splice(line, 0, ...add);
      tree.now.set(p, serializeFile({ lines, br: f.br, finalBreak: f.finalBreak }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6)
// ---------------------------------------------------------------------------

interface UnifiedHunk {
  a: number;
  body: BodyLine[];
}

interface UnifiedSection {
  pairOld: string | null;
  pairNew: string | null;
  pairSeen: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: UnifiedHunk[];
}

/** The path named by a `--- ` or `+++ ` line: text after the four characters, up to the first tab, surrounding spaces removed. */
function headerPath(l: string): string | null {
  const raw = l.slice(4);
  const tab = raw.indexOf('\t');
  const t = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseHunk(lines: string[], i: number): { hunk: UnifiedHunk; next: number } {
  const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
  if (!m) throw new Exit2(`error: parse ${i + 1}`);
  const raw: string[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
      raw.push(l);
      j++;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  return { hunk: { a: parseInt(m[1]!, 10), body: raw.map(bodyLine) }, next: j };
}

/** True when a `\` line follows the hunk's last context or `+` line: the result then ends without a line break. */
function hunkNoNewline(hunk: UnifiedHunk): boolean {
  const body = hunk.body;
  for (let k = body.length - 1; k >= 0; k--) {
    if (body[k]!.kind === 'ctx' || body[k]!.kind === 'new') {
      return body[k + 1] !== undefined && body[k + 1]!.kind === 'backslash';
    }
  }
  return false;
}

/** Apply one hunk to a file's state. `d` is the running length change of this section's hunks so far. */
function applyUnifiedHunk(f: FileState, hunk: UnifiedHunk, d: number, strict: boolean, path: string): { state: FileState; d: number } {
  const { O, N } = splitBody(hunk.body);
  const marker = hunkNoNewline(hunk);
  if (O.length > 0) {
    const found = findTier(f.lines, O, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = hunk.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const made = resolveNew(f.lines, best, O, N, found.tier);
    const runsToEnd = best + O.length === f.lines.length;
    const state: FileState = {
      lines: [...f.lines.slice(0, best), ...made, ...f.lines.slice(best + O.length)],
      br: f.br,
      finalBreak: runsToEnd ? !marker : f.finalBreak,
    };
    return { state, d: d + N.length - O.length };
  }
  const ins = Math.min(hunk.a + d, f.lines.length);
  const made = N.map((nl) => nl.text);
  const state: FileState = {
    lines: [...f.lines.slice(0, ins), ...made, ...f.lines.slice(ins)],
    br: f.br,
    finalBreak: ins === f.lines.length ? !marker : f.finalBreak,
  };
  return { state, d: d + N.length };
}

function unifiedSectionEdit(sec: UnifiedSection, strict: boolean, recordMove: MoveRecorder): Edit {
  const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  return (tree) => {
    const isCreate = sec.isCreate || oldPath === null;
    const isDelete = !isCreate && (sec.isDelete || newPath === null);
    if (isCreate) {
      if (newPath === null) return;
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      let marker = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let bi = body.length - 1; bi >= 0; bi--) {
          if (body[bi]!.kind === 'new') {
            marker = body[bi + 1] !== undefined && body[bi + 1]!.kind === 'backslash';
            break outer;
          }
        }
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (marker ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (oldPath === null) return;
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.now.set(oldPath, null);
      return;
    }
    if (oldPath === null || newPath === null) return;
    if (oldPath !== newPath) {
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      const text = tree.get(oldPath);
      if (text === null) throw new Fail('missing', oldPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      let f = parseFile(text);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyUnifiedHunk(f, h, d, strict, oldPath);
        f = r.state;
        d = r.d;
      }
      tree.now.set(newPath, serializeFile(f));
      tree.now.set(oldPath, null);
      recordMove(oldPath, newPath);
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const text = tree.get(oldPath);
    if (text === null) throw new Fail('missing', oldPath);
    let f = parseFile(text);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUnifiedHunk(f, h, d, strict, oldPath);
      f = r.state;
      d = r.d;
    }
    tree.now.set(oldPath, serializeFile(f));
  };
}

function unifiedEdits(lines: string[], strict: boolean, recordMove: MoveRecorder): Edit[] {
  const sections: UnifiedSection[] = [];
  let cur: UnifiedSection | null = null;
  let state: 'header' | 'hunks' = 'header';
  const fresh = (): UnifiedSection => ({
    pairOld: null,
    pairNew: null,
    pairSeen: false,
    renameFrom: null,
    renameTo: null,
    diffOld: null,
    diffNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const o = headerPath(l);
      const nw = headerPath(lines[i + 1]!);
      if (state === 'header' && cur !== null && !cur.pairSeen) {
        cur.pairOld = o;
        cur.pairNew = nw;
        cur.pairSeen = true;
      } else {
        cur = fresh();
        cur.pairOld = o;
        cur.pairNew = nw;
        cur.pairSeen = true;
        sections.push(cur);
        state = 'header';
      }
      i += 2;
      continue;
    }
    if (cur !== null && state === 'header') {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        state = 'hunks';
        i = h.next;
        continue;
      }
      if (l.startsWith('rename from ')) {
        cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        cur.isCreate = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        cur.isDelete = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (cur !== null) {
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedSectionEdit(s, strict, recordMove));
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7)
// ---------------------------------------------------------------------------

interface SearchBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SearchBlock[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const l = lines[j]!;
        if (blank(l)) continue;
        if (l.trim().startsWith('```')) continue;
        path = l.trim();
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      let eq = -1;
      for (let k = i + 1; k < n; k++) {
        const t = lines[k]!.trimEnd();
        if (t === '=======') {
          eq = k;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${i + 1}`);
      let rep = -1;
      for (let k = eq + 1; k < n; k++) {
        if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = k;
          break;
        }
      }
      if (rep < 0) throw new Exit2(`error: parse ${i + 1}`);
      blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep + 1;
      i = rep + 1;
      continue;
    }
    i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => {
    return (tree: Tree) => {
      if (!safe(b.path)) throw new Fail('unsafe', b.path);
      if (b.oldLines.length === 0) {
        if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
        tree.now.set(b.path, b.newLines.length === 0 ? '' : `${b.newLines.join('\n')}\n`);
        return;
      }
      const text = tree.get(b.path);
      if (text === null) throw new Fail('missing', b.path);
      const f = parseFile(text);
      const found = findTier(f.lines, b.oldLines, strict);
      if (found === null) throw new Fail('no-match', b.path);
      if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
      const pos = found.pos[0]!;
      const made = resolveNew(f.lines, pos, b.oldLines, b.newLines.map((t) => ({ ctx: null, text: t })), found.tier);
      tree.now.set(
        b.path,
        serializeFile({ lines: [...f.lines.slice(0, pos), ...made, ...f.lines.slice(pos + b.oldLines.length)], br: f.br, finalBreak: f.finalBreak }),
      );
    };
  });
}

// ---------------------------------------------------------------------------
// V4A patches (section 8)
// ---------------------------------------------------------------------------

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
}

const isV4aSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

/** Apply one V4A chunk, with the cursor that starts at line 0 and moves past the lines written. */
function applyV4aChunk(f: FileState, chunk: V4aChunk, cursor: number, strict: boolean, path: string): { state: FileState; cursor: number } {
  let cur = cursor;
  if (chunk.anchor !== null) {
    const found = findTier(f.lines, [chunk.anchor], strict, cur);
    if (found === null) throw new Fail('no-match', path);
    cur = found.pos[0]! + 1;
  }
  const { O, N } = splitBody(chunk.body);
  if (O.length === 0) {
    const ins = chunk.eof ? f.lines.length : cur;
    const made = N.map((nl) => nl.text);
    return {
      state: { lines: [...f.lines.slice(0, ins), ...made, ...f.lines.slice(ins)], br: f.br, finalBreak: f.finalBreak },
      cursor: ins + made.length,
    };
  }
  const tiers = strict ? [0] : [0, 1, 2];
  let chosen: { tier: number; pos: number } | null = null;
  for (const t of tiers) {
    const occ = occurrences(f.lines, O, t, cur).filter((p) => !chunk.eof || p + O.length === f.lines.length);
    if (occ.length > 0) {
      chosen = { tier: t, pos: occ[0]! };
      break;
    }
  }
  if (chosen === null) throw new Fail('no-match', path);
  const made = resolveNew(f.lines, chosen.pos, O, N, chosen.tier);
  return {
    state: {
      lines: [...f.lines.slice(0, chosen.pos), ...made, ...f.lines.slice(chosen.pos + O.length)],
      br: f.br,
      finalBreak: f.finalBreak,
    },
    cursor: chosen.pos + made.length,
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean, recordMove: MoveRecorder): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      const r = applyV4aChunk(f, ch, cursor, strict, path);
      f = r.state;
      cursor = r.cursor;
    }
    if (moveTo !== null) {
      tree.now.set(moveTo, serializeFile(f));
      tree.now.set(path, null);
      recordMove(path, moveTo);
    } else {
      tree.now.set(path, serializeFile(f));
    }
  };
}

function v4aEdits(lines: string[], strict: boolean, recordMove: MoveRecorder): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = n - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      const content: { text: string; fromPlus: boolean }[] = [];
      let j = i + 1;
      while (j < last) {
        const x = lines[j]!;
        if (isV4aSectionStart(x)) break;
        if (x.startsWith('+')) {
          content.push({ text: x.slice(1), fromPlus: true });
          j++;
          continue;
        }
        if (blank(x)) {
          content.push({ text: '', fromPlus: false });
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      while (content.length > 0 && !content[content.length - 1]!.fromPlus) content.pop();
      const made = content.map((c) => c.text);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, made.length === 0 ? '' : `${made.join('\n')}\n`);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      let j = i + 1;
      while (j < last) {
        const x = lines[j]!;
        if (isV4aSectionStart(x)) break;
        if (blank(x)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
      i = j;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      let moveTo: string | null = null;
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let seenBody = false;
      let j = i + 1;
      while (j < last) {
        const x = lines[j]!;
        if (isV4aSectionStart(x)) break;
        if (x.startsWith('*** Move to: ')) {
          if (moveTo === null && chunks.length === 0 && cur === null && !seenBody) {
            moveTo = x.slice('*** Move to: '.length).trim();
            j++;
            continue;
          }
          throw new Exit2(`error: parse ${j + 1}`);
        }
        if (x.trim() === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${j + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          j++;
          continue;
        }
        if (x.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const anchorText = x.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [], eof: false };
          seenBody = true;
          j++;
          continue;
        }
        if (x.startsWith(' ') || x.startsWith('-') || x.startsWith('+') || x === '') {
          if (blank(x) && cur === null) {
            j++;
            continue;
          }
          if (cur === null) {
            if (chunks.length === 0) {
              cur = { anchor: null, body: [], eof: false };
            } else {
              throw new Exit2(`error: parse ${j + 1}`);
            }
          }
          cur.body.push(bodyLine(x));
          seenBody = true;
          j++;
          continue;
        }
        if (blank(x)) {
          j++;
          continue;
        }
        throw new Exit2(`error: parse ${j + 1}`);
      }
      if (cur !== null) {
        while (cur.body.length > 0 && cur.body[cur.body.length - 1]!.blankPatch) cur.body.pop();
        chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${i + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict, recordMove));
      i = j;
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------------------------------------------------------------------------
// Running the patch (sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const moves: [string, string][] = [];
  const recordMove: MoveRecorder = (o, nw) => {
    moves.push([o, nw]);
  };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, recordMove);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict, recordMove);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  const seenMoves = new Set<string>();
  for (const [o, nw] of moves) {
    const key = o + "\0" + nw;
    if (seenMoves.has(key)) continue;
    seenMoves.add(key);
    if (tree.original(o) !== null && tree.original(nw) === null && tree.get(o) === null && tree.get(nw) !== null) {
      rows.push({ key: nw, line: `R ${o} -> ${nw}` });
      suppressed.add(o);
      suppressed.add(nw);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
