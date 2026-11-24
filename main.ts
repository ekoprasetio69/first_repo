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

/* ---- SPEC.md sections 3 and 5: file lines and tier matching ---- */

interface FileModel { br: string; lines: string[]; final: boolean; }
function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { br, lines: parts, final };
}
function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}
const lead = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0]! : ''; };
const tierKey = (s: string, tier: number): string => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/, '') : s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
function findTierFrom(fileLines: string[], O: string[], from: number, strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const pos: number[] = [];
    for (let i = from; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) if (tierKey(fileLines[i + j]!, tier) !== tierKey(O[j]!, tier)) { ok = false; break; }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier, positions: pos };
  }
  return null;
}
const findTier = (fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null => findTierFrom(fileLines, O, 0, strict);
/** N with context lines written as the file's own matched line, tier-2 re-indentation for the rest. */
function buildReplacement(O: string[], N: string[], ctx: Map<number, number>, fileLines: string[], occ: number, tier: number): string[] {
  const F = O.length > 0 ? lead(fileLines[occ]!) : '';
  const P = O.length > 0 ? lead(O[0]!) : '';
  return N.map((line, j) => {
    if (ctx.has(j)) return fileLines[occ + ctx.get(j)!]!;
    if (tier !== 2) return line;
    if (line === '' || line.trim() === '') return line;
    return line.startsWith(P) ? F + line.slice(P.length) : line;
  });
}
/** Build O/N from body lines whose first character is the marker (' ', '-', '+'). */
function onFromBody(body: string[]): { O: string[]; N: string[]; ctx: Map<number, number> } {
  const O: string[] = []; const N: string[] = []; const ctx = new Map<number, number>();
  for (const l of body) {
    if (l === '') { O.push(''); N.push(''); ctx.set(N.length - 1, O.length - 1); }
    else if (l.startsWith(' ')) { O.push(l.slice(1)); N.push(l.slice(1)); ctx.set(N.length - 1, O.length - 1); }
    else if (l.startsWith('-')) O.push(l.slice(1));
    else if (l.startsWith('+')) N.push(l.slice(1));
  }
  return { O, N, ctx };
}
/** True when a '\' line follows the hunk/chunk's last context or '+' line. */
function noNewlineAfterLast(body: string[]): boolean {
  let last = -1;
  for (let i = 0; i < body.length; i++) if (body[i]!.startsWith(' ') || body[i]!.startsWith('+')) last = i;
  return last >= 0 && last + 1 < body.length && body[last + 1]!.startsWith('\\');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
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

/* ---- SPEC.md section 6: unified diffs ---- */

interface Hunk { A: number; O: string[]; N: string[]; ctx: Map<number, number>; noNL: boolean; }
interface Section { oldPath: string | null; newPath: string | null; isCreate: boolean; isDelete: boolean; hunks: Hunk[]; }
function unifiedPath(raw: string): string | null {
  let p = raw;
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}
function applyHunks(model: FileModel, hunks: Hunk[], path: string, strict: boolean): FileModel {
  let lines = model.lines.slice();
  let final = model.final;
  let d = 0;
  for (const h of hunks) {
    if (h.O.length > 0) {
      const found = findTier(lines, h.O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let occ = found.positions[0]!;
      for (const pos of found.positions) if (Math.abs(pos - target) < Math.abs(occ - target)) occ = pos;
      const atEnd = occ + h.O.length === lines.length;
      const repl = buildReplacement(h.O, h.N, h.ctx, lines, occ, found.tier);
      lines.splice(occ, h.O.length, ...repl);
      if (atEnd) final = !h.noNL;
      d += h.N.length - h.O.length;
    } else {
      const insertPos = Math.min(Math.max(h.A + d, 0), lines.length);
      const atEnd = insertPos === lines.length;
      lines.splice(insertPos, 0, ...h.N);
      if (atEnd) final = !h.noNL;
      d += h.N.length;
    }
  }
  return { br: model.br, lines, final };
}
function unifiedEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const sections: Section[] = [];
  let i = 0;
  const n = lines.length;
  const diffRe = /^diff --git a\/([^ ]+) b\/([^ ]+)$/;
  while (i < n) {
    const l = lines[i]!;
    let sec: Section | null = null;
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    if (l.startsWith('diff --git ')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      diffOld = m[1]!; diffNew = m[2]!;
      sec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
      i++;
    } else if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      sec = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
      sections.push(sec);
    } else if (l.startsWith('@@')) {
      throw new Exit2(`error: parse ${i + 1}`);
    } else { i++; continue; }
    // header phase
    let oldSet = false; let newSet = false;
    let renameFrom: string | null = null; let renameTo: string | null = null;
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('@@')) break;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
      if (h.startsWith('--- ')) {
        if (oldSet || newSet) break;
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (h.startsWith('+++ ')) { i++; continue; }
      if (h.startsWith('rename from ')) renameFrom = h.slice('rename from '.length).trim();
      else if (h.startsWith('rename to ')) renameTo = h.slice('rename to '.length).trim();
      else if (h.startsWith('new file mode')) sec.isCreate = true;
      else if (h.startsWith('deleted file mode')) sec.isDelete = true;
      i++;
    }
    // consume a ---/+++ header pair if this section started with one, or in header phase
    // (handled below in the hunk loop's section start: re-scan header lines for ---/+++)
    // hunk / prose loop, still belonging to this section
    let headerConsumed = false;
    while (i < n) {
      const h = lines[i]!;
      if (h.startsWith('diff --git ')) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && headerConsumed) break;
      if (h.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ') && !headerConsumed) {
        sec.oldPath = unifiedPath(h.slice(4)); sec.newPath = unifiedPath(lines[i + 1]!.slice(4));
        oldSet = true; newSet = true; headerConsumed = true; i += 2; continue;
      }
      if (h.startsWith('--- ') && !headerConsumed) throw new Exit2(`error: parse ${i + 2}`);
      if (!h.startsWith('@@')) { i++; continue; }
      const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(h);
      if (hm === null) throw new Exit2(`error: parse ${i + 1}`);
      const A = parseInt(hm[1]!, 10);
      i++;
      const body: string[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\') || b === '') { body.push(b); i++; }
        else break;
      }
      while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
      const { O, N, ctx } = onFromBody(body);
      sec.hunks.push({ A, O, N, ctx, noNL: noNewlineAfterLast(body) });
      headerConsumed = true;
    }
    if (!oldSet && !newSet) {
      sec.oldPath = renameFrom ?? diffOld;
      sec.newPath = renameTo ?? diffNew;
    } else {
      if (sec.oldPath === null && renameFrom !== null) sec.oldPath = renameFrom;
      if (sec.newPath === null && renameTo !== null) sec.newPath = renameTo;
      if (sec.oldPath === null && diffOld !== null && sec.newPath !== null) sec.oldPath = diffOld;
      if (sec.newPath === null && diffNew !== null && sec.oldPath !== null) sec.newPath = diffNew;
    }
    // A section started from a ---/+++ pair without diff --git: paths already set above.
    // A diff --git section whose header pair was consumed in the hunk loop is set there.
  }
  const edits: Edit[] = [];
  for (const sec of sections) {
    const oldP = sec.oldPath; const newP = sec.newPath;
    const path = oldP ?? newP;
    if (path === null) throw new Exit2('error: parse 1');
    edits.push((tree) => {
      for (const p of [oldP, newP]) if (p !== null && !safe(p)) throw new Fail('unsafe', p);
      if (sec.isDelete) {
        if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
        tree.now.set(oldP!, null);
        return;
      }
      if (sec.isCreate) {
        if (tree.get(newP!) !== null) throw new Fail('exists', newP!);
        const plus: string[] = [];
        let noNL = false;
        for (const h of sec.hunks) {
          // '+' lines of this hunk, in body order: recompute from N minus context is not possible here,
          // so use the hunk's N lines that are not context lines.
          for (let j = 0; j < h.N.length; j++) if (!h.ctx.has(j)) plus.push(h.N[j]!);
          if (h.noNL) noNL = true;
        }
        // Only the last hunk's trailing '\' decides the final break; recompute: last hunk with a '+' line.
        noNL = false;
        for (let k = sec.hunks.length - 1; k >= 0; k--) {
          const h = sec.hunks[k]!;
          if (h.N.some((_, j) => !h.ctx.has(j))) { noNL = h.noNL; break; }
        }
        tree.now.set(newP!, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const model = parseFile(tree.get(oldP)!);
        const out = applyHunks(model, sec.hunks, oldP, strict);
        tree.now.set(oldP, null);
        tree.now.set(newP, serializeFile(out));
        moves.push([oldP, newP]);
        return;
      }
      const p = oldP ?? newP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      const model = parseFile(tree.get(p)!);
      const out = applyHunks(model, sec.hunks, p, strict);
      tree.now.set(p, serializeFile(out));
    });
  }
  return edits;
}

/* ---- SPEC.md section 7: SEARCH/REPLACE blocks ---- */

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const searchIdx = i;
    let eq = -1; let end = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    for (let j = eq + 1; j < n; j++) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    if (end < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    let path: string | null = null;
    for (let k = searchIdx - 1; k >= prevEnd; k--) {
      const t = lines[k]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, end);
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
      const model = parseFile(cur);
      const found = findTier(model.lines, oldLines, strict);
      if (found === null) throw new Fail('no-match', p);
      if (found.positions.length !== 1) throw new Fail('ambiguous', p);
      const occ = found.positions[0]!;
      const repl = buildReplacement(oldLines, newLines, new Map(), model.lines, occ, found.tier);
      const outLines = model.lines.slice();
      outLines.splice(occ, oldLines.length, ...repl);
      tree.now.set(p, serializeFile({ br: model.br, lines: outLines, final: model.final }));
    });
    prevPath = p;
    prevEnd = end + 1;
    i = end + 1;
  }
  return edits;
}

/* ---- SPEC.md section 8: V4A patches ---- */

interface VChunk { anchor: string | null; O: string[]; N: string[]; ctx: Map<number, number>; eof: boolean; }
function v4aEdits(lines: string[], strict: boolean, moves: [string, string][]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) if (!blank(lines[k]!)) { last = k; break; }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    if (blank(lines[i]!)) { i++; continue; }
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const fileLines: string[] = [];
      while (i < last && !isSectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        const b = lines[i]!;
        if (b.startsWith('+')) { fileLines.push(b.slice(1)); i++; }
        else if (b === '') { fileLines.push(''); i++; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') fileLines.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
    } else if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && !isSectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        if (blank(lines[i]!)) { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (l.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const p = l.slice('*** Update File: '.length).trim();
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) { moveTo = lines[i]!.slice('*** Move to: '.length).trim(); i++; }
      const chunks: VChunk[] = [];
      while (i < last && !isSectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
        if (blank(lines[i]!)) {
          // A blank line is a body line of the next chunk unless what follows it
          // is a section start, the end of the patch, or a new chunk header.
          let k = i;
          while (k < last && blank(lines[k]!)) k++;
          if (k >= last || isSectionStart(lines[k]!) || lines[k]!.trim() === '*** End Patch' || lines[k]!.startsWith('@@')) { i = k; continue; }
          // otherwise fall through and start a chunk at this blank line
        }
        let anchor: string | null = null;
        if (lines[i]!.startsWith('@@')) { anchor = lines[i]!.slice(2).trim(); i++; }
        const body: string[] = [];
        let eof = false;
        while (i < last && !isSectionStart(lines[i]!) && lines[i]!.trim() !== '*** End Patch') {
          const b = lines[i]!;
          if (b.startsWith('@@')) break;
          if (b === '*** End of File') { eof = true; i++; break; }
          if (b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b === '') { body.push(b); i++; }
          else throw new Exit2(`error: parse ${i + 1}`);
        }
        while (body.length > 0 && (body[body.length - 1] === '' || body[body.length - 1] === ' ')) body.pop();
        const { O, N, ctx } = onFromBody(body);
        chunks.push({ anchor, O, N, ctx, eof });
        if (eof) {
          // a chunk after an end-of-file chunk starts fresh; loop continues
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
        const cur = tree.get(p);
        if (cur === null) throw new Fail('missing', p);
        if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
        const model = parseFile(cur);
        let fileLines = model.lines.slice();
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null && ch.anchor !== '') {
            let foundAt = -1;
            for (const tier of strict ? [0] : [0, 1, 2]) {
              for (let k = cursor; k < fileLines.length; k++) if (tierKey(fileLines[k]!, tier) === tierKey(ch.anchor, tier)) { foundAt = k; break; }
              if (foundAt >= 0) break;
            }
            if (foundAt < 0) throw new Fail('no-match', p);
            cursor = foundAt + 1;
          }
          if (ch.O.length > 0) {
            const found = findTierFrom(fileLines, ch.O, cursor, strict);
            if (found === null) throw new Fail('no-match', p);
            let occ: number | null = null;
            if (ch.eof) {
              for (const pos of found.positions) if (pos + ch.O.length === fileLines.length) { occ = pos; break; }
              if (occ === null) throw new Fail('no-match', p);
            } else occ = found.positions[0]!;
            const repl = buildReplacement(ch.O, ch.N, ch.ctx, fileLines, occ, found.tier);
            fileLines.splice(occ, ch.O.length, ...repl);
            cursor = occ + repl.length;
          } else {
            const insertPos = ch.eof ? fileLines.length : cursor;
            fileLines.splice(insertPos, 0, ...ch.N);
            cursor = insertPos + ch.N.length;
          }
        }
        const out = serializeFile({ br: model.br, lines: fileLines, final: model.final });
        if (moveTo !== null) {
          tree.now.set(p, null);
          tree.now.set(moveTo, out);
          moves.push([p, moveTo]);
        } else tree.now.set(p, out);
      });
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
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
  const moves: [string, string][] = [];
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict, moves);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict, moves);
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
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const paired = new Set<string>();
  const rows: { key: string; text: string }[] = [];
  for (const [oldP, newP] of moves) {
    if (tree.now.has(oldP) && tree.now.get(oldP) === null && tree.original(oldP) !== null && tree.now.has(newP) && tree.now.get(newP) !== null && tree.original(newP) === null) {
      paired.add(oldP); paired.add(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (paired.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // Write moved files even when their row was emitted as R above.
  for (const p of [...tree.now.keys()]) {
    if (!paired.has(p) || check) continue;
    const now = tree.now.get(p)!;
    if (now === null) rmSync(p, { force: true });
    else { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, now); }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
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
