import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockFrame } from '../src/core/index.js';

const Q = 128;

/** Feeds `reported` frames in order and returns the frame each block was placed on. */
const run = (reported: number[], bf = new BlockFrame()) => reported.map(r => bf.at(r, Q));

test('BlockFrame: an honest clock passes straight through', () => {
  const bf = new BlockFrame();
  assert.deepEqual(run([0, 128, 256, 384], bf), [0, 128, 256, 384]);
  assert.equal(bf.stale, 0);
  assert.equal(bf.resyncs, 0);
  assert.equal(bf.next(999), 512);
});

test('BlockFrame: the first block believes its frame, wherever it is', () => {
  assert.deepEqual(run([5 * Q, 6 * Q]), [5 * Q, 6 * Q]);
  assert.equal(new BlockFrame().next(77), 77);
});

test("BlockFrame: Chrome's repeated frame (once, then four in a row) is placed where the block really is", () => {
  const bf = new BlockFrame();
  // Truth: 0, Q, 2Q ... Chrome reports Q twice, then 3Q (the jump), then 5Q five times, then 10Q.
  const got = run([0, Q, Q, 3 * Q, 4 * Q, 5 * Q, 5 * Q, 5 * Q, 5 * Q, 5 * Q, 10 * Q], bf);
  assert.deepEqual(got, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(b => b * Q));
  assert.equal(bf.stale, 5);
  assert.equal(bf.resyncs, 0);
});

test('BlockFrame: a report ahead of the count is believed (one block really skipped)', () => {
  const bf = new BlockFrame();
  assert.deepEqual(run([0, Q, 2 * Q, 4 * Q, 5 * Q], bf), [0, Q, 2 * Q, 4 * Q, 5 * Q]);
  assert.equal(bf.resyncs, 1);
});

test('BlockFrame: frames really skipped (the node was not pulled) resync to the reported frame', () => {
  const bf = new BlockFrame();
  assert.deepEqual(run([0, Q, 48000 * 3, 48000 * 3 + Q], bf), [0, Q, 144000, 144000 + Q]);
  assert.equal(bf.resyncs, 1);
});

test('BlockFrame: a report far behind, or behind for longer than any stale run, is a real discontinuity', () => {
  const far = new BlockFrame();
  run([20 * Q, 21 * Q, 22 * Q], far);
  // 23 blocks behind the count at once: more than MAX_STALE_BLOCKS.
  assert.equal(far.at(0, Q), 0);
  assert.equal(far.resyncs, 1);
  assert.equal(far.at(Q, Q), Q);

  // A count one block ahead of a steady clock (its first report was a block ahead): believed again after the run.
  const off = new BlockFrame();
  off.at(Q, Q);
  const n = BlockFrame.MAX_STALE_BLOCKS;
  for (let b = 1; b <= n; b++) assert.equal(off.at(b * Q, Q), (b + 1) * Q);
  assert.equal(off.at((n + 1) * Q, Q), (n + 1) * Q);
  assert.equal(off.resyncs, 1);
  assert.equal(off.at((n + 2) * Q, Q), (n + 2) * Q);
});

test('BlockFrame: reset forgets the count', () => {
  const bf = new BlockFrame();
  run([0, Q, Q], bf);
  bf.reset();
  assert.equal(bf.at(Q, Q), Q);
});

test('BlockFrame: other block lengths', () => {
  assert.deepEqual(new BlockFrame().at(0, 256), 0);
  const bf = new BlockFrame();
  assert.deepEqual([0, 256, 256, 768].map(r => bf.at(r, 256)), [0, 256, 512, 768]);
});
