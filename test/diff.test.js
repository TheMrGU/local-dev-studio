// Unit tests for the hand-written Myers line differ (lib/diff.js).
// Plain node:test — run via `node --test test/` (part of `npm test`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { diffLines, diffSegments } = require('../lib/diff');

/** Rebuild each side from the ops — the ground truth for any edit script. */
function reconstruct(ops) {
  const a = ops.filter(op => op.type !== 'add').map(op => op.line);
  const b = ops.filter(op => op.type !== 'del').map(op => op.line);
  return { a: a.join('\n'), b: b.join('\n') };
}

test('identical inputs are all-same, empty inputs are empty', () => {
  const ops = diffLines('a\nb\nc', 'a\nb\nc');
  assert.equal(ops.length, 3);
  assert.ok(ops.every(op => op.type === 'same'));
  assert.deepEqual(diffLines('', ''), []);
});

test('a pure insertion and a pure deletion', () => {
  const ins = diffLines('a\nc', 'a\nb\nc');
  assert.deepEqual(ins.map(op => op.type), ['same', 'add', 'same']);
  assert.equal(ins[1].line, 'b');
  assert.equal(ins[1].b, 2);

  const del = diffLines('a\nb\nc', 'a\nc');
  assert.deepEqual(del.map(op => op.type), ['same', 'del', 'same']);
  assert.equal(del[1].line, 'b');
  assert.equal(del[1].a, 2);
});

test('a replacement is a delete plus an add', () => {
  const ops = diffLines('title: old', 'title: new');
  assert.deepEqual(ops.map(op => op.type), ['del', 'add']);
});

test('one side empty', () => {
  assert.ok(diffLines('', 'x\ny').every(op => op.type === 'add'));
  assert.ok(diffLines('x\ny', '').every(op => op.type === 'del'));
});

test('trailing newline does not create a phantom line', () => {
  assert.equal(diffLines('a\nb\n', 'a\nb').length, 2);
});

test('the edit script is minimal for the classic ABCABBA/CBABAC case', () => {
  // Myers' own worked example: shortest script has 5 edits (D = 5).
  const ops = diffLines('A\nB\nC\nA\nB\nB\nA', 'C\nB\nA\nB\nA\nC');
  const edits = ops.filter(op => op.type !== 'same').length;
  assert.equal(edits, 5);
});

test('ops always reconstruct both inputs exactly', () => {
  const cases = [
    ['a\nb\nc\nd', 'a\nx\nc\ny\nd\nz'],
    ['<html>\n<body>\n<h1>old</h1>\n</body>\n</html>', '<html>\n<body>\n<h1>new</h1>\n<p>added</p>\n</body>\n</html>'],
    ['one', 'entirely\ndifferent\ncontent'],
    ['', 'fresh'],
    ['gone', ''],
    ['same\nsame\nsame', 'same\nsame\nsame'],
  ];
  for (const [a, b] of cases) {
    const built = reconstruct(diffLines(a, b));
    assert.equal(built.a, a, `left side rebuilt for ${JSON.stringify([a, b])}`);
    assert.equal(built.b, b, `right side rebuilt for ${JSON.stringify([a, b])}`);
  }
});

test('line numbers are 1-based and sequential per side', () => {
  const ops = diffLines('a\nb\nc', 'a\nc\nd');
  const aNums = ops.filter(op => op.a).map(op => op.a);
  const bNums = ops.filter(op => op.b).map(op => op.b);
  assert.deepEqual(aNums, [1, 2, 3]);
  assert.deepEqual(bNums, [1, 2, 3]);
});

test('segments collapse long unchanged runs and keep context', () => {
  const middle = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const a = `start\n${middle}\nend`;
  const b = `START\n${middle}\nEND`;
  const { changed, segments } = diffSegments(a, b, 3);
  assert.equal(changed, true);
  const skip = segments.find(seg => seg.kind === 'skip');
  assert.ok(skip, 'a skip segment exists');
  assert.equal(skip.lines.length, 24, '30 unchanged minus 3 context each side');
  assert.ok(skip.lines.every(op => op.type === 'same'));
  const contexts = segments.filter(seg => seg.kind === 'context');
  assert.ok(contexts.every(seg => seg.lines.length <= 3));
});

test('segments report unchanged files as unchanged', () => {
  const { changed, segments } = diffSegments('a\nb', 'a\nb');
  assert.equal(changed, false);
  assert.deepEqual(segments, []);
});

test('short unchanged runs stay visible instead of collapsing', () => {
  const { segments } = diffSegments('x\na\nb\ny', 'X\na\nb\nY', 3);
  assert.ok(!segments.some(seg => seg.kind === 'skip'));
});
