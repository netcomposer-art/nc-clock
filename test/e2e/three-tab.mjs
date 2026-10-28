// Three-tab independent-stop e2e (nc-clock 0.5.0). Instruments run this same harness in their own suites.
//
//   node test/e2e/three-tab.mjs [port]        # serves this repo, opens examples/three-tab/ in three tabs
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs  (default: import 'playwright-core')
//
// From another suite:
//   import { runThreeTab } from '<nc-clock>/test/e2e/three-tab.mjs';
//   const result = await runThreeTab({ browser, urls: [urlA, urlB, urlC] });   // throws on a failed check
//
// Each URL is an instrument tab exposing `window.ncE2E` (see examples/three-tab/tab.js):
//   play(), stop()          press Play / Stop (local, independent)
//   state()                 { playing, running, leader, term, swing, anchor, tempo, startTime }
//   takeOnsets()            beats scheduled since the last call: [{ beat, time }], time in shared seconds
// Tabs must share one BroadcastChannel (same origin and browser context), start on a constant tempo, and must
// not change tempo during the run.
//
// Scenario: start A, B, C; stop B (A and C keep the grid); stop the leader (it hands off to a playing tab, anchor
// unchanged, term up); restart B (it lands on the grid); stop the rest one by one (the session ends with the last).
// Timing: every onset against the session grid, and every beat two tabs both scheduled against each other, pooled:
// p95 <= 1 ms and max <= 3 ms (the NC sync standard).

const SYNC_P95_MS = 1, SYNC_MAX_MS = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function stats(values) {
  const s = values.map(Math.abs).sort((a, b) => a - b);
  if (!s.length) return { n: 0, p95: 0, max: 0 };
  return { n: s.length, p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))], max: s[s.length - 1] };
}

export async function runThreeTab({ browser, context = null, urls, settleMs = 1500, log = () => {} }) {
  if (!urls || urls.length !== 3) throw new Error('runThreeTab: three URLs');
  const ctx = context ?? await browser.newContext();
  const pages = [];
  const names = ['A', 'B', 'C'];
  const checks = [];
  const check = (ok, what) => { checks.push({ ok: !!ok, what }); log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); };
  try {
    for (const url of urls) {
      const page = await ctx.newPage();
      page.on('pageerror', e => log(`pageerror ${e.message}`));
      await page.goto(url);
      await page.waitForFunction(() => !!window.ncE2E, null, { timeout: 15000 });
      pages.push(page);
      await sleep(400);
    }
    await sleep(800);
    const tab = Object.fromEntries(names.map((n, i) => [n, pages[i]]));
    const call = (n, fn) => tab[n].evaluate(f => window.ncE2E[f](), fn);
    const states = async () => Object.fromEntries(await Promise.all(names.map(async n => [n, await call(n, 'state')])));
    const onsets = {}; for (const n of names) onsets[n] = [];
    const collect = async phase => { for (const n of names) for (const o of await call(n, 'takeOnsets')) onsets[n].push({ ...o, phase }); };
    const leaderName = st => names.filter(n => st[n].leader);

    let st = await states();
    check(leaderName(st).length === 1, `one leader at start (${leaderName(st).join(',')})`);

    // 1. Start A, B, C.
    await call('A', 'play'); await sleep(600);
    await call('B', 'play'); await sleep(300);
    await call('C', 'play'); await sleep(settleMs); await collect('start');
    st = await states();
    const ref = { anchor: st.A.anchor, tempo: st.A.tempo, startTime: st.A.startTime };
    check(names.every(n => st[n].playing && st[n].running), 'A, B and C play');
    check(names.every(n => st[n].startTime === ref.startTime), 'one run: B and C joined the grid (no restart)');

    // 2. Stop B: A and C carry on.
    await call('B', 'stop'); await call('B', 'takeOnsets'); await sleep(settleMs); await collect('B stopped');
    st = await states();
    check(!st.B.playing && st.A.playing && st.C.playing, 'Stop in B stops only B');
    check(names.every(n => st[n].running && st[n].startTime === ref.startTime), 'the session grid runs on, unchanged');
    check(onsets.B.filter(o => o.phase === 'B stopped').length === 0, 'B schedules nothing after its Stop');

    // 3. Stop the leader: it hands off to a playing tab.
    const L = leaderName(st)[0], termBefore = st[L].term;
    await call(L, 'stop'); await sleep(settleMs); await collect('leader stopped');
    st = await states();
    const L2 = leaderName(st);
    check(L2.length === 1 && L2[0] !== L && st[L2[0]].playing, `leader ${L} stopped: the lead went to playing ${L2.join(',')}`);
    check(L2.length === 1 && st[L2[0]].term > termBefore, `term ${termBefore} -> ${L2.length ? st[L2[0]].term : '?'}`);
    check(names.every(n => JSON.stringify(st[n].anchor) === JSON.stringify(ref.anchor) && JSON.stringify(st[n].tempo) === JSON.stringify(ref.tempo)), 'anchor and tempo map unchanged');
    const swings = new Set(names.map(n => st[n].swing));
    check(swings.size === 1, `one session swing (${[...swings].join(',')})`);

    // 4. Restart B: it joins on the grid.
    await call('B', 'play'); await sleep(settleMs); await collect('B rejoined');
    st = await states();
    check(st.B.playing && st.B.startTime === ref.startTime, 'B rejoined the running grid');
    check(onsets.B.some(o => o.phase === 'B rejoined'), 'B schedules beats again');

    // 5. Stop each playing tab; the session ends with the last.
    let left = names.filter(n => st[n].playing);
    while (left.length) {
      const n = left.shift();
      await call(n, 'stop'); await sleep(400);
      st = await states();
      if (left.length) check(names.every(m => st[m].running), `${n} stopped, ${left.join(',')} still play: session runs`);
    }
    await sleep(300); st = await states();
    check(names.every(n => !st[n].running && !st[n].playing), 'last Stop ends the session everywhere');
    await collect('end');

    // Timing: onsets against the session grid, and the same beat across tabs.
    const bpm = ref.tempo[0].bpm, spb = 60 / bpm;
    const expected = beat => ref.anchor.time + (beat - ref.anchor.beat) * spb;
    const gridErr = [], crossErr = [];
    const byBeat = new Map();
    for (const n of names) for (const o of onsets[n]) {
      gridErr.push((o.time - expected(o.beat)) * 1000);
      const list = byBeat.get(o.beat) ?? []; list.push(o.time); byBeat.set(o.beat, list);
    }
    for (const list of byBeat.values()) for (let i = 1; i < list.length; i++) crossErr.push((list[i] - list[0]) * 1000);
    const pooled = stats([...gridErr, ...crossErr]);
    check(onsets.A.length > 4 && onsets.C.length > 4, `onsets A ${onsets.A.length}, B ${onsets.B.length}, C ${onsets.C.length}`);
    check(pooled.p95 <= SYNC_P95_MS && pooled.max <= SYNC_MAX_MS, `sync gate: pooled p95 ${pooled.p95.toFixed(4)} ms, max ${pooled.max.toFixed(4)} ms (n ${pooled.n})`);
    const result = { ok: checks.every(c => c.ok), checks, timing: { grid: stats(gridErr), cross: stats(crossErr), pooled }, onsets: Object.fromEntries(names.map(n => [n, onsets[n].length])) };
    if (!result.ok) { const err = new Error(`three-tab e2e failed: ${checks.filter(c => !c.ok).map(c => c.what).join('; ')}`); err.result = result; throw err; }
    return result;
  } finally {
    for (const p of pages) await p.close().catch(() => {});
    if (!context) await ctx.close().catch(() => {});
  }
}

// CLI: serve this repo and run against examples/three-tab/.
if (import.meta.url === `file://${process.argv[1]}`) {
  const { createServer } = await import('node:http');
  const { createReadStream, existsSync, statSync } = await import('node:fs');
  const { extname, join, normalize } = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const root = fileURLToPath(new URL('../..', import.meta.url));
  if (!existsSync(join(root, 'dist/index.js'))) { console.error('Run `npm run build` first.'); process.exit(2); }
  const port = Number(process.argv[2] ?? process.env.PORT ?? 5611);
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.map': 'application/json' };
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^([/\\])+/, '');
    if (path.includes('..')) { res.writeHead(400); return res.end(); }
    let file = join(root, path);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  const pwPath = process.env.PLAYWRIGHT_CORE;
  const pw = pwPath ? await import(pathToFileURL(pwPath).href) : await import('playwright-core');
  const browser = await (pw.chromium ?? pw.default.chromium).launch();
  const base = `http://127.0.0.1:${port}/examples/three-tab/?channel=nc-sync-e2e-${Date.now()}`;
  const urls = [`${base}&app=A&id=a&swing=0.62`, `${base}&app=B&id=b`, `${base}&app=C&id=c`];
  let code = 0;
  try {
    const result = await runThreeTab({ browser, urls, log: line => console.log(line) });
    console.log(JSON.stringify({ ok: result.ok, timing: result.timing, onsets: result.onsets }));
  } catch (e) {
    console.error(e.message); if (e.result) console.log(JSON.stringify({ ok: false, timing: e.result.timing }));
    code = 1;
  } finally { await browser.close(); server.close(); }
  process.exit(code);
}
