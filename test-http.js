'use strict';
/**
 * Integration tests — the real program, started as a child process and driven over HTTP.
 *
 *   npm test
 *
 * Everything in test.js is a function called directly. Nothing there could have caught
 * the nine-second freeze that opening the Environment panel used to cause, because that
 * was not a wrong answer from any one function: it was what the whole program did while
 * one of them was working. This file is for that class of problem.
 *
 * Three rules it has to keep, since it runs on a machine that is doing real work:
 *
 *   - it never touches the real ~/.portdash; the child gets a temporary HOME
 *   - it never signals anything of yours; the sandbox's memory limits are set so high
 *     the watchdog still runs and samples but can never reach a threshold
 *   - it never leaves a process behind; the child is killed from an exit hook, and any
 *     service the tests start is killed by process group from the same place
 *
 * It also builds its own project rather than using whatever is registered on this
 * machine. A test that leans on the developer's setup passes or fails for reasons that
 * have nothing to do with the code.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

let child = null;         // the PortDash under test
let started = [];         // pgids of anything the tests asked it to start
let UI = 0, APP = 0, TOKEN = '', HOME = '', boot = '';

/** Nothing survives this file, however it ends — a thrown assertion, a crash, ^C. */
function cleanup() {
  for (const pgid of started.splice(0)) { try { process.kill(-pgid, 'SIGKILL'); } catch (e) {} }
  if (child && !child.killed) { try { child.kill('SIGKILL'); } catch (e) {} }
  child = null;
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(1); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ask the OS for a port nothing is using. Hard-coding one makes the suite fail on a
    machine that happens to be using it, in a way that looks like a bug in the code. */
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const request = (method, url, body) => new Promise((resolve) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const headers = TOKEN === null ? {} : { 'X-Portdash-Token': TOKEN };
  if (data !== null) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
  const t0 = Date.now();
  const req = http.request({ host: '127.0.0.1', port: UI, path: url, method, headers }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => resolve({ code: res.statusCode, body: b, ms: Date.now() - t0 }));
  });
  req.on('error', (e) => resolve({ code: 0, body: e.message, ms: Date.now() - t0 }));
  req.setTimeout(60000, () => { req.destroy(); resolve({ code: 0, body: 'no answer', ms: Date.now() - t0 }); });
  if (data !== null) req.write(data);
  req.end();
});

const get = (url) => request('GET', url);
const post = (url, body) => request('POST', url, body || {});
const state = async () => JSON.parse((await get('/api/state')).body);

/** A home directory with one project in it, both invented here. */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'portdash-test-'));
  const root = path.join(home, '.portdash');
  fs.mkdirSync(root, { recursive: true });

  const proj = path.join(home, 'fixture-app');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'server.js'),
    `require('http').createServer((q, s) => s.end('ok')).listen(${APP}, '127.0.0.1');\n`);

  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    uiPort: UI,
    scanRoots: [],                      // never walk the disk of whoever is running this
    limits: {
      enabled: true,                    // still running, still sampling, still reporting
      projectRssMB: 1e9, hardRssMB: 1e9, nodeHeapMB: 3072,
      sysAvailFloorPct: 0, sysSwapCeilMB: 1e9, minVictimMB: 1e9,
      startBurst: 5, logMaxMB: 5
    }
  }, null, 2));
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify([
    { id: 'fixture', name: 'fixture-app', cwd: proj, cmd: 'node server.js', kind: 'node',
      port: APP, memMB: null, heapMB: null, pinned: false }
  ], null, 2));
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  return home;
}

const registry = () => JSON.parse(fs.readFileSync(path.join(HOME, '.portdash', 'projects.json'), 'utf8'));
const setRegistry = (r) => fs.writeFileSync(path.join(HOME, '.portdash', 'projects.json'), JSON.stringify(r, null, 2));

describe('a running PortDash', () => {
  before(async () => {
    UI = await freePort();
    APP = await freePort();
    HOME = sandbox();

    child = spawn(process.execPath, [path.join(__dirname, 'portdash.js')], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { HOME }),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', (c) => { boot += c; });
    child.stderr.on('data', (c) => { boot += c; });

    TOKEN = null;                                   // no token yet; '/' doesn't need one
    for (let i = 0; i < 80; i++) {
      if ((await get('/')).code === 200) break;
      await sleep(250);
    }
    const page = (await get('/')).body;
    TOKEN = (/const TOKEN='([0-9a-f]+)'/.exec(page) || [])[1] || '';
    assert.ok(TOKEN, 'the page should hand the browser a token\n' + boot);
  });

  after(async () => {
    if (child && TOKEN) { try { await post('/api/stop', { id: 'fixture' }); } catch (e) {} }
    cleanup();
    if (HOME) fs.rmSync(HOME, { recursive: true, force: true });
  });

  it('serves the dashboard and says what it can start things with', () => {
    assert.match(boot, /PortDash → http:\/\/localhost:/);
    assert.match(boot, /Environment: /);
  });

  it('refuses an API call that has no token, and one with the wrong token', async () => {
    // The Host and Origin checks only ever stopped browsers. Any other process on this
    // machine could otherwise drive /api/save and /api/start, which together are
    // arbitrary command execution.
    const real = TOKEN;
    TOKEN = null;
    assert.equal((await get('/api/state')).code, 403);
    TOKEN = 'deadbeef';
    assert.equal((await get('/api/state')).code, 403);
    TOKEN = real;
    assert.equal((await get('/api/state')).code, 200);
  });

  it('reports the fixture project and the machine\'s other listeners', async () => {
    const s = await state();
    assert.equal(s.projects.length, 1);
    assert.equal(s.projects[0].name, 'fixture-app');
    assert.equal(s.projects[0].status, 'stopped');
    assert.ok(Array.isArray(s.others));
  });

  it('gives every other listener an owner', async () => {
    // "external" used to be the answer for everything PortDash didn't start, which is
    // not an answer. Whatever is listening on this machine, each row should name a
    // launchd job, an app, the process it came from, or admit it is detached.
    const s = await state();
    for (const o of s.others) {
      assert.ok(o.owner && o.owner.kind, 'no owner on ' + o.command + ':' + o.ports[0]);
      assert.match(o.owner.kind, /^(launchd|app|from|detached|portdash)$/);
      if (o.owner.kind === 'launchd') assert.ok(o.owner.stop, 'launchd row with no stop command');
    }
  });

  it('answers the environment panel without freezing the dashboard', async t => {
    // The regression this file exists for. doctor() probes seven tools; one that hangs
    // instead of answering used to hold the whole single-threaded server for its entire
    // timeout — nine seconds on the machine this was written on, while the panel that
    // exists to explain why things are slow was the slowest thing in the program.
    //
    // On a machine where every tool answers quickly there is nothing to detect here, so
    // the assertion is written to hold either way: a render issued mid-call must not be
    // delayed by it.
    const idle = await get('/api/state');
    const doctor = get('/api/doctor');           // deliberately not awaited
    await sleep(400);                            // it is in flight now
    const during = await get('/api/state');
    const d = await doctor;

    assert.equal(d.code, 200);
    const report = JSON.parse(d.body);
    assert.equal(report.tools.length, 7);
    assert.ok(report.path.length, 'doctor should report a PATH');

    assert.ok(during.ms < idle.ms + 1000,
      `a render took ${during.ms}ms during a ${d.ms}ms /api/doctor call, against ${idle.ms}ms idle `
      + '— the event loop is blocked, so something in doctor() went back to being synchronous');
  });

  // The three below run in order and share the fixture's state on purpose: starting,
  // colliding and stopping are one story, and splitting them reads better in a report
  // than one test with three names' worth of assertions in it.

  it('starts a project, and shows it in the very next render', async () => {
    const r = await post('/api/start', { id: 'fixture' });
    assert.equal(r.code, 200, r.body);
    const pid = JSON.parse(r.body).pid;
    started.push(pid);                           // detached, so pid is also the group

    // Not "eventually": immediately. The samples behind /api/state are dropped when
    // something is started, so a stale one cannot be served over the top of it.
    const row = (await state()).projects[0];
    assert.equal(row.status, 'running');
    assert.equal(row.pid, pid);
    assert.equal(row.owner.kind, 'portdash');

    for (let i = 0; i < 40 && !(await state()).projects[0].ports.includes(APP); i++) await sleep(150);
    assert.ok((await state()).projects[0].ports.includes(APP),
      'it should be listening on ' + APP);
    assert.equal((await get('/')).code, 200, 'the dashboard should still be answering');
  });

  it('refuses to start something else onto a port that is taken', async () => {
    // Registry changes are read from disk on every call, so adding one here is enough.
    const reg = registry();
    reg.push({ id: 'clash', name: 'clash', cwd: path.join(HOME, 'fixture-app'),
               cmd: 'node server.js', kind: 'node', port: APP,
               memMB: null, heapMB: null, pinned: false });
    setRegistry(reg);

    const r = await post('/api/start', { id: 'clash' });
    assert.equal(r.code, 400);
    const err = JSON.parse(r.body).error;
    assert.match(err, new RegExp('Port ' + APP + ' is already taken'));
    assert.match(err, /"fixture-app"/);           // names what holds it
    assert.match(err, /clear its "Default port"/); // and how to overrule the refusal

    setRegistry(registry().filter((p) => p.id !== 'clash'));
  });

  it('stops it, and the row goes back to stopped', async () => {
    assert.equal((await post('/api/stop', { id: 'fixture' })).code, 200);
    let row;
    for (let i = 0; i < 40; i++) {
      row = (await state()).projects[0];
      if (row.status === 'stopped') break;
      await sleep(150);
    }
    assert.equal(row.status, 'stopped');
    assert.equal(row.pid, null);
    started.length = 0;
  });

  it('ships a page whose script and markup agree', async () => {
    // The browser code is a string inside this file and nothing type-checks it. A
    // renamed dialog or a typo in an element id throws on page load, and every test
    // above would still pass because none of them opens a browser.
    const page = (await get('/')).body;
    const ids = new Set([...page.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
    const script = /<script>([\s\S]*)<\/script>/.exec(page)[1];
    const referenced = [...new Set([...script.matchAll(/\b([sdel]_[a-z_]+)\b/g)].map((m) => m[1]))];
    assert.ok(referenced.length > 5, 'expected the script to reach for several elements');
    for (const ref of referenced) assert.ok(ids.has(ref), `the script uses ${ref}, the page has no such id`);

    const dialogs = [...page.matchAll(/<dialog id="(\w+)"/g)].map((m) => m[1]);
    assert.equal(dialogs.length, new Set(dialogs).size, 'duplicate dialog id');
  });
});
