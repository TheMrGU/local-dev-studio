// lib/diff.js — a hand-written line differ. Myers' O(ND) shortest-edit-script
// algorithm ("An O(ND) Difference Algorithm and Its Variations", 1986), the
// same core as git's default diff. Deliberately no dependency: the whole thing
// is this file, and the versions history view is its only customer.
'use strict';

/** Split text into lines. A trailing newline doesn't create a phantom line. */
function toLines(text) {
  const lines = String(text).split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

// Beyond this many total lines the O(ND) walk can get quadratic on unrelated
// content (think minified bundles); a whole-file replace is honest and instant.
const MAX_LINES = 40000;

/**
 * Line diff of two texts.
 * @returns {Array<{type:'same'|'del'|'add', a?:number, b?:number, line:string}>}
 *   ops in order; `a`/`b` are 1-based line numbers on their side.
 */
function diffLines(aText, bText) {
  const a = toLines(aText);
  const b = toLines(bText);
  const N = a.length;
  const M = b.length;
  if (N + M === 0) return [];
  if (N + M > MAX_LINES) {
    return [
      ...a.map((line, i) => ({ type: 'del', a: i + 1, line })),
      ...b.map((line, i) => ({ type: 'add', b: i + 1, line })),
    ];
  }

  // Forward pass: furthest-reaching x per diagonal k, one V per edit depth d.
  const max = N + M;
  const offset = max;
  const v = new Array(2 * max + 2).fill(0);
  const trace = [];
  let depth = -1;
  outer:
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];        // down: an insertion from b
      } else {
        x = v[offset + k - 1] + 1;    // right: a deletion from a
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }  // the snake
      v[offset + k] = x;
      if (x >= N && y >= M) { depth = d; break outer; }
    }
  }

  // Backtrack from (N, M) through the saved Vs to recover the script.
  const ops = [];
  let x = N;
  let y = M;
  for (let d = depth; d > 0; d--) {
    const vd = trace[d];
    const k = x - y;
    const prevK = (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1]))
      ? k + 1
      : k - 1;
    const prevX = vd[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { ops.push({ type: 'same', a: x, b: y, line: a[x - 1] }); x--; y--; }
    if (x === prevX) { ops.push({ type: 'add', b: y, line: b[y - 1] }); y--; }
    else { ops.push({ type: 'del', a: x, line: a[x - 1] }); x--; }
  }
  while (x > 0 && y > 0) { ops.push({ type: 'same', a: x, b: y, line: a[x - 1] }); x--; y--; }
  return ops.reverse();
}

/**
 * The ops grouped for display: changes stay visible, long unchanged runs
 * collapse to a 'skip' segment (its lines included, so a view can expand it),
 * with `context` unchanged lines kept on each side of every change.
 * @returns {{changed: boolean, segments: Array<{kind:'change'|'context'|'skip', lines: object[]}>}}
 */
function diffSegments(aText, bText, context = 3) {
  const ops = diffLines(aText, bText);
  if (!ops.some(op => op.type !== 'same')) return { changed: false, segments: [] };

  const blocks = [];
  for (const op of ops) {
    const kind = op.type === 'same' ? 'context' : 'change';
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind) last.lines.push(op);
    else blocks.push({ kind, lines: [op] });
  }

  const segments = [];
  blocks.forEach((block, i) => {
    if (block.kind === 'change') { segments.push(block); return; }
    const lead = i === 0 ? 0 : context;                      // below the previous change
    const tail = i === blocks.length - 1 ? 0 : context;      // above the next change
    // Collapsing one or two lines saves nothing — keep short runs whole.
    if (block.lines.length <= lead + tail + 2) { segments.push(block); return; }
    if (lead) segments.push({ kind: 'context', lines: block.lines.slice(0, lead) });
    segments.push({ kind: 'skip', lines: block.lines.slice(lead, block.lines.length - tail) });
    if (tail) segments.push({ kind: 'context', lines: block.lines.slice(block.lines.length - tail) });
  });
  return { changed: true, segments };
}

module.exports = { diffLines, diffSegments };
