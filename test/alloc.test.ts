// cancelsRecall must not allocate (the spec and CHANGELOG say so). A child process runs it in the interpreter
// (--no-opt --no-maglev: no optimiser can escape-analyse an allocation away) with a 1 MB semi-space, so even a few
// bytes per call would trigger scavenges, and counts GCs with a PerformanceObserver. An allocating control in the
// same child must GC, which shows the check can see allocation. After Astrid's probe (astrid-sync/nc-clock-4-probes).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const protocolUrl = new URL('../src/protocol.js', import.meta.url).href;
const child = `
import { PerformanceObserver } from 'node:perf_hooks';
const { cancelsRecall, envelope } = await import(${JSON.stringify(protocolUrl)});
const mk = (b, from, seq) => envelope({ type: 'snapshot', slot: 0, ...b }, from, 1, seq, 0);
const recall = mk({ op: 'recall', slot: 2, atBeat: 8 }, 'a', 5);
const cases = [mk({ op: 'cancel', slot: -1 }, 'a', 6), mk({ op: 'cancel', slot: 2, recallSeq: 5 }, 'a', 6), mk({ op: 'cancel', slot: 3 }, 'a', 6),
  mk({ op: 'cancel', slot: -1, recallSeq: 4 }, 'a', 6), mk({ op: 'cancel', slot: -1 }, 'b', 6), mk({ op: 'recall', slot: 2 }, 'a', 6)];
let gcs = 0;
new PerformanceObserver(l => { gcs += l.getEntries().length; }).observe({ entryTypes: ['gc'] });
const pause = () => new Promise(r => setTimeout(r, 30));
function run(fn, n) { let acc = 0; for (let i = 0; i < n; i++) acc += fn(cases[i % 6], recall) ? 1 : 0; return acc; }
const control = (c, r) => ({ c, r }).c.from === r.from;
const out = {};
for (const [name, fn] of [['control', control], ['cancelsRecall', cancelsRecall]]) {
  run(fn, 1000); globalThis.gc(); await pause(); gcs = 0;
  const acc = run(fn, ${2_000_000});
  await pause();
  out[name] = { gcs, acc };
}
console.log(JSON.stringify(out));
`;

test('cancelsRecall allocates nothing: 0 GCs over 2M interpreted calls on a 1 MB semi-space (an allocating control GCs)', t => {
  const r = spawnSync(process.execPath, ['--no-opt', '--no-maglev', '--max-semi-space-size=1', '--expose-gc', '--input-type=module', '-e', child],
    { encoding: 'utf8', timeout: 60_000 });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, { gcs: number; acc: number }>;
  t.diagnostic(`alloc check: ${JSON.stringify(out)}`);
  assert.ok(out.control.gcs > 0, `control must GC (got ${out.control.gcs}), else the check can't see allocation`);
  assert.equal(out.cancelsRecall.gcs, 0, 'cancelsRecall triggered GCs');
  assert.equal(out.cancelsRecall.acc, 666_668, 'the calls really ran (2 of 6 cases match)');
});
