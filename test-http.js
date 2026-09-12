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
let UI = 0, APP = 0, TCPP = 0, WEDGE = 0, TOKEN = '', HOME = '', boot = '';

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

/** A home directory with three projects in it, all invented here: one that serves HTTP,
    one that accepts a connection and hangs up without a word — a database, as far as a
    health check can tell — and one that accepts and then says nothing at all, which is
    what a wedged dev server looks like from outside. */
function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'portdash-test-'));
  const root = path.join(home, '.portdash');
  fs.mkdirSync(root, { recursive: true });

  const fixture = (id, port, body) => {
    const dir = path.join(home, id);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'server.js'), body + '\n');
    return { id, name: id, cwd: dir, cmd: 'node server.js', kind: 'node',
             port, memMB: null, heapMB: null, pinned: false };
  };

  fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({
    uiPort: UI,
    scanRoots: [],                      // never walk the disk of whoever is running this
    // Two seconds instead of sixty, so "it has had long enough" is reachable in a test.
    readyGraceSec: 2,
    limits: {
      enabled: true,                    // still running, still sampling, still reporting
      projectRssMB: 1e9, hardRssMB: 1e9, nodeHeapMB: 3072,
      sysAvailFloorPct: 0, sysSwapCeilMB: 1e9, minVictimMB: 1e9,
      startBurst: 5, logMaxMB: 5
    }
  }, null, 2));
  fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify([
    fixture('fixture-app', APP,
      `require('http').createServer((q, s) => s.end('ok')).listen(${APP}, '127.0.0.1');`),
    fixture('tcp-only', TCPP,
      `require('net').createServer((s) => s.end()).listen(${TCPP}, '127.0.0.1');`),
    fixture('wedged', WEDGE,
      `require('net').createServer(() => {}).listen(${WEDGE}, '127.0.0.1');`)
  ], null, 2));
  fs.writeFileSync(path.join(root, 'state.json'), '{}');
  return home;
}

/** One project's row, by id — the tests must not depend on the order of the registry. */
const row = async (id) => (await state()).projects.find((p) => p.id === id);

/** Poll a row until `ok` is happy with it, or give up and return the last one seen so
    the assertion that follows can say what it actually got. */
async function until(id, ok, tries) {
  let last = null;
  for (let i = 0; i < (tries || 60); i++) {
    last = await row(id);
    if (last && ok(last)) return last;
    await sleep(200);
  }
  return last;
}

async function start(id) {
  const r = await post('/api/start', { id });
  assert.equal(r.code, 200, 'starting ' + id + ': ' + r.body);
  started.push(JSON.parse(r.body).pid);       // detached, so pid is also the group
}

const registry = () => JSON.parse(fs.readFileSync(path.join(HOME, '.portdash', 'projects.json'), 'utf8'));
const setRegistry = (r) => fs.writeFileSync(path.join(HOME, '.portdash', 'projects.json'), JSON.stringify(r, null, 2));

describe('a running PortDash', () => {
  before(async () => {
    UI = await freePort();
    APP = await freePort();
    TCPP = await freePort();
    WEDGE = await freePort();
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
    for (const id of ['fixture-app', 'tcp-only', 'wedged']) {
      if (child && TOKEN) { try { await post('/api/stop', { id }); } catch (e) {} }
    }
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

  it('reports the fixture projects and the machine\'s other listeners', async () => {
    const s = await state();
    assert.equal(s.projects.length, 3);
    assert.ok(s.projects.every((p) => p.status === 'stopped'));
    // Nothing to ask a stopped project about, so nothing is claimed about it.
    assert.ok(s.projects.every((p) => p.health === null));
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
    await start('fixture-app');

    // Not "eventually": immediately. The samples behind /api/state are dropped when
    // something is started, so a stale one cannot be served over the top of it.
    const r = await row('fixture-app');
    assert.equal(r.status, 'running');
    assert.ok(r.pid);
    assert.equal(r.owner.kind, 'portdash');

    const listening = await until('fixture-app', (x) => x.ports.includes(APP));
    assert.ok(listening.ports.includes(APP), 'it should be listening on ' + APP);
    assert.equal((await get('/')).code, 200, 'the dashboard should still be answering');
  });

  it('says a service is ready only once the port has actually answered', async () => {
    // The point of the whole check: "running" is a fact about the process table, and
    // "ready" is a fact about whether the thing can be used. This one is both.
    const r = await until('fixture-app', (x) => x.health && x.health.state === 'ready');
    assert.equal(r.health.state, 'ready', JSON.stringify(r.health));
    assert.equal(r.health.via, 'http');
    assert.equal(r.health.port, APP);
  });

  it('does not call a service broken for failing to speak HTTP', async () => {
    // A database accepts the connection and hangs up. It is not answering HTTP and it
    // is not supposed to; reporting it as unreachable would be a false alarm on every
    // non-web service anyone registers.
    await start('tcp-only');
    const r = await until('tcp-only', (x) => x.health && x.health.state === 'ready');
    assert.equal(r.health.state, 'ready', JSON.stringify(r.health));
    assert.equal(r.health.via, 'tcp');
    assert.equal((await post('/api/stop', { id: 'tcp-only' })).code, 200);
  });

  it('catches the one ps cannot: listening, accepting, never answering', async () => {
    // The wedged dev server. The process is alive, the port is open, lsof is happy and
    // ps is happy — and the page never loads. Before this check the row was green.
    await start('wedged');
    const open = await until('wedged', (x) => x.ports.includes(WEDGE));
    assert.ok(open.ports.includes(WEDGE), 'it should be listening on ' + WEDGE);

    // Under the grace it is "starting", because a service that has just come up and is
    // still compiling looks exactly like this and must not be called broken.
    assert.match(String((open.health || {}).state), /^(starting|checking)$/);

    const r = await until('wedged', (x) => x.health && x.health.state === 'unreachable');
    assert.equal(r.health.state, 'unreachable', JSON.stringify(r.health));
    assert.match(r.health.why, new RegExp('no answer from :' + WEDGE));
    assert.equal(r.status, 'running', 'the process is alive; that was never in doubt');
    assert.equal((await post('/api/stop', { id: 'wedged' })).code, 200);
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
    assert.equal((await post('/api/stop', { id: 'fixture-app' })).code, 200);
    const r = await until('fixture-app', (x) => x.status === 'stopped');
    assert.equal(r.status, 'stopped');
    assert.equal(r.pid, null);
    assert.equal(r.health, null, 'a stopped row should claim nothing about its health');
    started.length = 0;
  });

  it('serves a tab icon, without a token, to a page that asks for it', async () => {
    // A browser fetches this straight from the <link>, before any of our script has run,
    // so it carries no token. Behind the token check it would be a silently broken icon.
    assert.match((await get('/')).body, /<link rel="icon" href="\/favicon\.svg"/);

    const real = TOKEN;
    TOKEN = null;
    const icon = await get('/favicon.svg');
    const ico = await get('/favicon.ico');
    TOKEN = real;

    assert.equal(icon.code, 200);
    assert.match(icon.body, /^<svg /);
    assert.match(icon.body, /viewBox="0 0 32 32"/);
    assert.equal(ico.code, 204, 'browsers that ask for .ico anyway should get nothing, not a 404');
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
