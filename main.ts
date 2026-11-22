// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

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

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, in patch order: [old, new]. Used to print `R` lines. */
  readonly moves: Array<[string, string]> = [];
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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

/* ---- section 5: matching lines (three tiers) ---- */

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFileText(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function renderFileText(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesFrom(fileLines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const nO = o.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(fileLines[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** First tier with an occurrence at or after `from`; the first such occurrence. */
function firstTierFrom(fileLines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  for (const t of tiersToTry(strict)) {
    const occ = occurrencesFrom(fileLines, o, t, from);
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

/** All occurrences at the first tier with any. */
function tierOccurrences(fileLines: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiersToTry(strict)) {
    const occ = occurrencesFrom(fileLines, o, t, 0);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** An end-of-file occurrence: only the position ending at the file's last line. */
function eofTier(fileLines: string[], o: string[], from: number, strict: boolean): { tier: number; pos: number } | null {
  const pos = fileLines.length - o.length;
  if (pos < from) return null;
  for (const t of tiersToTry(strict)) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(fileLines[pos + j]!, t) !== normLine(o[j]!, t)) {
        ok = false;
        break;
      }
    }
    if (ok) return { tier: t, pos };
  }
  return null;
}

interface NLine {
  text: string;
  /** index into O when this is a context line, else null */
  ctx: number | null;
}

function splitItems(items: { kind: 'ctx' | 'old' | 'new'; text: string }[]): { o: string[]; n: NLine[] } {
  const o: string[] = [];
  const n: NLine[] = [];
  let oIdx = 0;
  for (const it of items) {
    if (it.kind === 'ctx') {
      o.push(it.text);
      n.push({ text: it.text, ctx: oIdx });
      oIdx++;
    } else if (it.kind === 'old') {
      o.push(it.text);
      oIdx++;
    } else {
      n.push({ text: it.text, ctx: null });
    }
  }
  return { o, n };
}

/** The lines replacing O at position `pos` (context lines are the file's own). */
function buildReplacement(fileLines: string[], pos: number, oLines: string[], nLines: NLine[], tier: number): string[] {
  const out: string[] = [];
  const f = fileLines[pos] === undefined ? '' : leadWs(fileLines[pos]!);
  const p = oLines.length === 0 ? '' : leadWs(oLines[0]!);
  for (const n of nLines) {
    if (n.ctx !== null) {
      out.push(fileLines[pos + n.ctx]!);
    } else if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) {
      out.push(f + n.text.slice(p.length));
    } else {
      out.push(n.text);
    }
  }
  return out;
}

/* ---- section 6: unified diffs ---- */

interface UItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  rawEmpty: boolean;
  backslashAfter: boolean;
}
interface UHunk {
  a: number;
  items: UItem[];
}
interface USection {
  diffX: string | undefined;
  diffY: string | undefined;
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
  pairSet: boolean;
}

function headerPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseDiffGit(line: string): { x: string; y: string } | null {
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line);
  if (m === null) return null;
  return { x: m[1]!, y: m[2]! };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function isBodyLine(line: string): boolean {
  return line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\';
}

function lastCtxOrNewBackslash(h: UHunk): boolean {
  for (let i = h.items.length - 1; i >= 0; i--) {
    const it = h.items[i]!;
    if (it.kind === 'ctx' || it.kind === 'new') return it.backslashAfter;
  }
  return false;
}

function applyUnifiedHunk(f: FileText, h: UHunk, d: number, strict: boolean, path: string): { file: FileText; dLen: number } {
  const { o, n } = splitItems(h.items);
  if (o.length > 0) {
    const found = tierOccurrences(f.lines, o, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.occ[0]!;
    for (const pos of found.occ) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const replacement = buildReplacement(f.lines, best, o, n, found.tier);
    const lines = [...f.lines.slice(0, best), ...replacement, ...f.lines.slice(best + o.length)];
    const runsToEnd = best + o.length === f.lines.length;
    return { file: { lines, br: f.br, final: runsToEnd ? !lastCtxOrNewBackslash(h) : f.final }, dLen: replacement.length - o.length };
  }
  const at = Math.min(h.a + d, f.lines.length);
  const ins = n.map((x) => x.text);
  const lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
  const runsToEnd = at === f.lines.length;
  return { file: { lines, br: f.br, final: runsToEnd ? !lastCtxOrNewBackslash(h) : f.final }, dLen: ins.length };
}

function unifiedSectionEdit(s: USection, strict: boolean): Edit {
  const oldPath = s.pairOld !== undefined ? s.pairOld : s.renameFrom !== undefined ? s.renameFrom : s.diffX;
  const newPath = s.pairNew !== undefined ? s.pairNew : s.renameTo !== undefined ? s.renameTo : s.diffY;
  const isCreation = oldPath === null || s.newFile;
  const isDeletion = newPath === null || s.delFile;
  return (tree) => {
    if (oldPath !== undefined && oldPath !== null && !safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (newPath !== undefined && newPath !== null && !safe(newPath)) throw new Fail('unsafe', newPath);
    if (isCreation) {
      const np = newPath as string;
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const lines: string[] = [];
      let noFinal = false;
      for (const h of s.hunks) {
        for (const it of h.items) {
          if (it.kind === 'new') {
            lines.push(it.text);
            noFinal = it.backslashAfter;
          }
        }
      }
      tree.now.set(np, lines.length === 0 ? '' : lines.join('\n') + (noFinal ? '' : '\n'));
      return;
    }
    if (isDeletion) {
      const op = oldPath as string;
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
      return;
    }
    const op = oldPath as string;
    const np = newPath as string;
    const cur = tree.get(op);
    if (cur === null) throw new Fail('missing', op);
    const isMove = op !== np;
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    let f = parseFileText(cur);
    let d = 0;
    for (const h of s.hunks) {
      const r = applyUnifiedHunk(f, h, d, strict, op);
      f = r.file;
      d += r.dLen;
    }
    const out = renderFileText(f);
    if (isMove) {
      tree.now.set(np, out);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, out);
    }
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let section: USection | null = null;
  let hunk: UHunk | null = null;
  let inHeader = false;
  const endBody = (): void => {
    if (hunk !== null) {
      while (hunk.items.length > 0 && hunk.items[hunk.items.length - 1]!.rawEmpty) hunk.items.pop();
      hunk = null;
    }
  };
  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx]!;
    const next = idx + 1 < lines.length ? lines[idx + 1]! : undefined;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        endBody();
        continue;
      }
      if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
        endBody();
        continue;
      }
      if (isBodyLine(line)) {
        if (line.startsWith('\\')) {
          const items = hunk.items;
          if (items.length > 0) items[items.length - 1]!.backslashAfter = true;
        } else if (line === '') {
          hunk.items.push({ kind: 'ctx', text: '', rawEmpty: true, backslashAfter: false });
        } else {
          const kind = line[0] === ' ' ? 'ctx' : line[0] === '-' ? 'old' : 'new';
          hunk.items.push({ kind, text: line.slice(1), rawEmpty: false, backslashAfter: false });
        }
        idx++;
        continue;
      }
      endBody();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${idx + 1}`);
      section = { diffX: dg.x, diffY: dg.y, pairOld: undefined, pairNew: undefined, renameFrom: undefined, renameTo: undefined, newFile: false, delFile: false, hunks: [], pairSet: false };
      sections.push(section);
      inHeader = true;
      idx++;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = headerPath(line);
        const newP = headerPath(next);
        if (section !== null && inHeader && !section.pairSet) {
          section.pairOld = oldP;
          section.pairNew = newP;
          section.pairSet = true;
        } else {
          section = { diffX: undefined, diffY: undefined, pairOld: oldP, pairNew: newP, renameFrom: undefined, renameTo: undefined, newFile: false, delFile: false, hunks: [], pairSet: true };
          sections.push(section);
          inHeader = true;
        }
        idx += 2;
        continue;
      }
      if (section !== null && inHeader) throw new Exit2(`error: parse ${idx + 2}`);
      idx++;
      continue;
    }
    if (line.startsWith('+++ ') && section !== null && inHeader && !section.pairSet) {
      section.pairNew = headerPath(line);
      section.pairSet = true;
      idx++;
      continue;
    }
    if (section !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        section.renameFrom = line.slice(12).trim();
        idx++;
        continue;
      }
      if (line.startsWith('rename to ')) {
        section.renameTo = line.slice(10).trim();
        idx++;
        continue;
      }
      if (line.startsWith('new file mode')) {
        section.newFile = true;
        idx++;
        continue;
      }
      if (line.startsWith('deleted file mode')) {
        section.delFile = true;
        idx++;
        continue;
      }
    }
    if (line.startsWith('@@')) {
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${idx + 1}`);
      if (section === null) throw new Exit2(`error: parse ${idx + 1}`);
      hunk = { a: Number(m[1]), items: [] };
      section.hunks.push(hunk);
      inHeader = false;
      idx++;
      continue;
    }
    idx++;
  }
  endBody();
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

/* ---- section 7: SEARCH/REPLACE blocks ---- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let lastReplaceEnd = -1;
  while (i < lines.length) {
    let s = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > lastReplaceEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (oldLines.length === 0) {
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const f = parseFileText(cur);
      const found = tierOccurrences(f.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.occ.length > 1) throw new Fail('ambiguous', p);
      const pos = found.occ[0]!;
      const nLines: NLine[] = newLines.map((t) => ({ text: t, ctx: null }));
      const replacement = buildReplacement(f.lines, pos, oldLines, nLines, found.tier);
      const outLines = [...f.lines.slice(0, pos), ...replacement, ...f.lines.slice(pos + oldLines.length)];
      tree.now.set(p, renderFileText({ lines: outLines, br: f.br, final: f.final }));
    });
    prevPath = path;
    lastReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

/* ---- section 8: V4A patches ---- */

interface VItem {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  rawBlank: boolean;
}
interface VChunk {
  anchor: string | null;
  eof: boolean;
  items: VItem[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  line: number;
  addLines: { text: string; rawBlank: boolean }[];
  moveTo: string | null;
  chunks: VChunk[];
  chunk: VChunk | null;
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice(14).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice(17).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice(17).trim() };
  return null;
}

function applyV4aChunk(f: FileText, chunk: VChunk, cursor: number, strict: boolean, path: string): { file: FileText; cursor: number } {
  const { o, n } = splitItems(chunk.items);
  let cur = cursor;
  if (chunk.anchor !== null) {
    const a = firstTierFrom(f.lines, [chunk.anchor], cur, strict);
    if (a === null) throw new Fail('no-match', path);
    cur = a.pos + 1;
  }
  if (o.length === 0) {
    const at = chunk.eof ? f.lines.length : cur;
    const ins = n.map((x) => x.text);
    const lines = [...f.lines.slice(0, at), ...ins, ...f.lines.slice(at)];
    return { file: { lines, br: f.br, final: f.final }, cursor: at + ins.length };
  }
  const found = chunk.eof ? eofTier(f.lines, o, cur, strict) : firstTierFrom(f.lines, o, cur, strict);
  if (found === null) throw new Fail('no-match', path);
  const replacement = buildReplacement(f.lines, found.pos, o, n, found.tier);
  const lines = [...f.lines.slice(0, found.pos), ...replacement, ...f.lines.slice(found.pos + o.length)];
  return { file: { lines, br: f.br, final: f.final }, cursor: found.pos + replacement.length };
}

function v4aSectionEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const lines = s.addLines.map((l) => l.text);
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, lines.length === 0 ? '' : lines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    return (tree) => {
      if (!safe(s.path)) throw new Fail('unsafe', s.path);
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
    };
  }
  const moveTo = s.moveTo;
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const cur = tree.get(s.path);
    if (cur === null) throw new Fail('missing', s.path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = parseFileText(cur);
    let cursor = 0;
    for (const chunk of s.chunks) {
      const r = applyV4aChunk(f, chunk, cursor, strict, s.path);
      f = r.file;
      cursor = r.cursor;
    }
    const out = renderFileText(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(s.path, null);
      tree.moves.push([s.path, moveTo]);
    } else {
      tree.now.set(s.path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let section: VSection | null = null;
  const closeSection = (): void => {
    if (section === null) return;
    if (section.kind === 'add') {
      while (section.addLines.length > 0 && section.addLines[section.addLines.length - 1]!.rawBlank) section.addLines.pop();
    } else if (section.kind === 'update') {
      if (section.moveTo === null && section.chunks.length === 0) throw new Exit2(`error: parse ${section.line}`);
      if (section.chunk !== null) {
        const items = section.chunk.items;
        while (items.length > 0 && items[items.length - 1]!.rawBlank) items.pop();
      }
    }
    edits.push(v4aSectionEdit(section, strict));
    section = null;
  };
  let idx = first + 1;
  while (idx < last) {
    const line = lines[idx]!;
    const start = v4aSectionStart(line);
    if (start !== null) {
      closeSection();
      section = { kind: start.kind, path: start.path, line: idx + 1, addLines: [], moveTo: null, chunks: [], chunk: null };
      idx++;
      continue;
    }
    if (section === null) {
      if (blank(line)) {
        idx++;
        continue;
      }
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (section.kind === 'add') {
      if (line === '') {
        section.addLines.push({ text: '', rawBlank: true });
        idx++;
        continue;
      }
      if (line.startsWith('+')) {
        section.addLines.push({ text: line.slice(1), rawBlank: false });
        idx++;
        continue;
      }
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (section.kind === 'delete') {
      if (blank(line)) {
        idx++;
        continue;
      }
      throw new Exit2(`error: parse ${idx + 1}`);
    }
    if (line === '*** End of File') {
      if (section.chunk === null) throw new Exit2(`error: parse ${idx + 1}`);
      section.chunk.eof = true;
      section.chunk = null;
      idx++;
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (section.moveTo !== null || section.chunks.length > 0 || section.chunk !== null) throw new Exit2(`error: parse ${idx + 1}`);
      section.moveTo = line.slice(13).trim();
      idx++;
      continue;
    }
    if (line.startsWith('@@')) {
      const chunk: VChunk = { anchor: line.slice(2).trim(), eof: false, items: [] };
      section.chunks.push(chunk);
      section.chunk = chunk;
      idx++;
      continue;
    }
    if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+') {
      if (section.chunk === null) {
        if (section.chunks.length > 0) {
          if (blank(line)) {
            idx++;
            continue;
          }
          throw new Exit2(`error: parse ${idx + 1}`);
        }
        const chunk: VChunk = { anchor: null, eof: false, items: [] };
        section.chunks.push(chunk);
        section.chunk = chunk;
      }
      const rawBlank = blank(line);
      if (line === '') section.chunk.items.push({ kind: 'ctx', text: '', rawBlank });
      else if (line[0] === ' ') section.chunk.items.push({ kind: 'ctx', text: line.slice(1), rawBlank });
      else if (line[0] === '-') section.chunk.items.push({ kind: 'old', text: line.slice(1), rawBlank: false });
      else section.chunk.items.push({ kind: 'new', text: line.slice(1), rawBlank: false });
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  closeSection();
  return edits;
}

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
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = new Map<string, string | null>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.set(p, now);
  }
  const rows: { key: string; line: string }[] = [];
  const consumed = new Set<string>();
  for (const [old, nw] of tree.moves) {
    if (changed.get(old) === null && changed.get(nw) !== null && changed.get(nw) !== undefined) {
      rows.push({ key: nw, line: `R ${old} -> ${nw}` });
      consumed.add(old);
      consumed.add(nw);
    }
  }
  for (const [p, now] of changed) {
    if (consumed.has(p)) continue;
    rows.push({ key: p, line: `${now === null ? 'D' : tree.original(p) === null ? 'A' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const [p, now] of changed) {
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
