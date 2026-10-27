import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// An AudioWorkletGlobalScope has no window, document, performance, timers or Worker.
const FORBIDDEN = ['window', 'document', 'performance', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'Worker', 'navigator', 'BroadcastChannel', 'localStorage', 'Date'];

test('core source never references browser-only globals', () => {
  const dir = ['src/core', 'lib/nc-clock/src/core'].map(d => join(process.cwd(), d)).find(d => existsSync(d));
  assert.ok(dir, 'core source found');
  for (const file of readdirSync(dir!).filter(f => f.endsWith('.ts'))) {
    const code = readFileSync(join(dir!, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const name of FORBIDDEN) assert.ok(!new RegExp(`\\b${name}\\b`).test(code), `${file} uses ${name}`);
  }
});

test('core runs in a worklet-like scope with no window, performance or timers', async () => {
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const name of FORBIDDEN.filter(n => n !== 'Date')) {
    saved.set(name, Object.getOwnPropertyDescriptor(g, name));
    try { Object.defineProperty(g, name, { value: undefined, configurable: true, writable: true }); } catch { /* not removable */ }
  }
  // AudioWorkletGlobalScope globals that do exist.
  g.currentTime = 1.5; g.sampleRate = 48000;
  try {
    assert.equal(typeof g.performance, 'undefined'); assert.equal(typeof g.setTimeout, 'undefined');
    const core = await import('../src/core/index.js');
    const clock = new core.NcClock({ bpm: 120, timebase: 'audio' });
    clock.play({ at: g.currentTime as number, beat: 0 });
    clock.setTempo({ bpm: 60, atBeat: 4 });
    const snap = JSON.parse(JSON.stringify(clock.toSnapshot()));
    const copy = core.fromSnapshot(snap);
    assert.equal(copy.timeAt(6), clock.transport.timeAt(6));
    assert.equal(copy.timeAt(6), 1.5 + 2 + 2);
    // Sample-frame scheduling as a worklet would do it.
    const frame = Math.round(copy.timeAt(5) * (g.sampleRate as number));
    assert.equal(frame, (1.5 + 2 + 1) * 48000);
  } finally {
    for (const [name, d] of saved) { if (d) Object.defineProperty(g, name, d); else delete g[name]; }
    delete g.currentTime; delete g.sampleRate;
  }
});
