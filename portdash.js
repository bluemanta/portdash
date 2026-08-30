#!/usr/bin/env node
'use strict';
/**
 * PortDash — a visual control panel for local dev servers
 *
 * Zero dependencies, single file. Run:  node portdash.js
 * Then open:                            http://localhost:7777
 *
 * Config and data live under ~/.portdash/:
 *   config.json    scan roots, UI port, memory limits
 *   projects.json  the project registry (built by scanning, editable in the UI)
 *   state.json     bookkeeping for processes PortDash itself started
 *   logs/          per-project run logs
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync, spawn } = require('child_process');

const HOME = os.homedir();
const ROOT = path.join(HOME, '.portdash');
const F_CFG = path.join(ROOT, 'config.json');
const F_REG = path.join(ROOT, 'projects.json');
const F_STATE = path.join(ROOT, 'state.json');
const F_TOKEN = path.join(ROOT, 'token');
const F_SELFLOG = path.join(ROOT, 'portdash.log');
const D_LOGS = path.join(ROOT, 'logs');

const SHELL = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
const IS_MAC = process.platform === 'darwin';

const AGENT_LABEL = 'com.bluemanta.portdash';
const F_PLIST = path.join(HOME, 'Library', 'LaunchAgents', AGENT_LABEL + '.plist');

const DEFAULT_CFG = {
  uiPort: 7777,
  scanRoots: ['~/Documents/CodeProjects'],
  scanDepth: 3,
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
               'vendor', '.venv', 'venv', '__pycache__', 'target', '.cache', 'coverage'],

  // ------- Memory protection. Raise the numbers to loosen it, or set enabled:false to turn it off -------
  limits: {
    enabled: true,
    projectRssMB: 4096,        // a single project (whole process group) over this → auto-freeze
    hardRssMB: 10240,          // over this → kill it outright, no more mercy
    nodeHeapMB: 3072,          // injected as --max-old-space-size so node OOMs itself instead of taking down the box
    sysAvailFloorPct: 12,      // system available memory below this % → freeze the biggest offender
    sysSwapCeilMB: 4096,       // swap usage above this → same as above
    startBurst: 3,             // max starts per project within 60s (guards against crash-restart loops)
    logMaxMB: 5,               // rotate the log to .old if it's already bigger than this at startup
    selfLogMaxMB: 2            // rotate PortDash's own log at this size (matters when running as an agent)
  }
};

// ---------------------------------------------------------------- basics

function ensure() {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.mkdirSync(D_LOGS, { recursive: true });
}

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJSON(file, data) {
  ensure();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function expand(p) {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

const fmtMB = (mb) => (mb >= 1024 ? (mb / 1024).toFixed(1) + 'G' : Math.round(mb) + 'M');
const shorten = (p) => (p.startsWith(HOME) ? '~' + p.slice(HOME.length) : p);

/** Everything PortDash says about itself goes here as well as to stdout. As a launch
    agent stdout is discarded, so this file is the only record — and since nothing else
    ever truncates it, it has to rotate itself. */
function logLine(msg) {
  console.log(msg);
  try {
    ensure();
    const max = (getCfg().limits.selfLogMaxMB || 2) * 1048576;
    if (fs.existsSync(F_SELFLOG) && fs.statSync(F_SELFLOG).size > max) {
      fs.renameSync(F_SELFLOG, F_SELFLOG + '.old');
    }
    fs.appendFileSync(F_SELFLOG, `${new Date().toISOString()}  ${msg}\n`);
  } catch (e) { /* logging must never take the process down */ }
}

/** Shared secret for the local API, so another process on this machine can't drive
    PortDash just by knowing the port. Readable only by the owner. */
function getToken() {
  try {
    const t = fs.readFileSync(F_TOKEN, 'utf8').trim();
    if (t) return t;
  } catch (e) { /* fall through and mint one */ }
  ensure();
  const t = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(F_TOKEN, t, { mode: 0o600 });
  return t;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (e) {
    return (e && e.stdout) ? e.stdout : '';
  }
}

function idOf(cwd) {
  const h = crypto.createHash('md5').update(cwd).digest('hex').slice(0, 6);
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 24);
  return `${base}-${h}`;
}

function getCfg() {
  const raw = readJSON(F_CFG, {});
  const cfg = Object.assign({}, DEFAULT_CFG, raw);
  cfg.limits = Object.assign({}, DEFAULT_CFG.limits, raw.limits || {});
  return cfg;
}
const getReg = () => readJSON(F_REG, []);
const setReg = (r) => writeJSON(F_REG, r);

let managed = readJSON(F_STATE, {});
const saveManaged = () => writeJSON(F_STATE, managed);

// ---------------------------------------------------------------- alerts

let alerts = [];
const alertSeen = {};                 // don't flood with the same alert more than once per 60s
function alert_(level, text, projectId, key) {
  const k = key || (level + ':' + text);
  const now = Date.now();
  if (alertSeen[k] && now - alertSeen[k] < 60000) return;
  alertSeen[k] = now;
  alerts.unshift({ id: crypto.randomBytes(4).toString('hex'), t: now, level, text, projectId });
  alerts = alerts.slice(0, 20);
  logLine(`[${level === 'danger' ? 'action' : 'notice'}] ${text}`);
  if (projectId) {
    try {
      fs.appendFileSync(path.join(D_LOGS, projectId + '.log'),
        `\n***** ${new Date().toLocaleString()}  PortDash: ${text} *****\n`);
    } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- project scanning

function detectProject(dir) {
  const has = (f) => fs.existsSync(path.join(dir, f));

  if (has('package.json')) {
    const pkg = readJSON(path.join(dir, 'package.json'), {});
    const scripts = pkg.scripts || {};
    const key = ['dev', 'start', 'serve', 'develop'].find((k) => scripts[k]);
    const pm = has('pnpm-lock.yaml') ? 'pnpm'
             : has('yarn.lock') ? 'yarn'
             : (has('bun.lockb') || has('bun.lock')) ? 'bun'
             : 'npm';
    return { name: pkg.name || path.basename(dir), cmd: key ? `${pm} run ${key}` : '', kind: 'node' };
  }
  if (has('manage.py')) return { name: path.basename(dir), cmd: 'python3 manage.py runserver', kind: 'django' };
  if (has('pyproject.toml') || has('requirements.txt')) return { name: path.basename(dir), cmd: '', kind: 'python' };
  if (has('index.html')) {
    // Weak match: a root-level index.html also counts as a previewable static site,
    // but we keep walking below it looking for a "real" sub-project.
    return { name: path.basename(dir), cmd: 'python3 -m http.server 8000', kind: 'static', weak: true };
  }
  return null;
}

function walk(dir, depth, cfg, out) {
  if (depth > cfg.scanDepth) return;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }

  if (depth > 0) {
    const p = detectProject(dir);
    if (p) {
      out.push(Object.assign({}, p, { cwd: dir }));
      if (!p.weak) return;                 // stop drilling down once we get a strong match
    }
  }
  for (const it of items) {
    if (!it.isDirectory()) continue;
    if (it.name.startsWith('.')) continue;
    if (cfg.ignoreDirs.includes(it.name)) continue;
    walk(path.join(dir, it.name), depth + 1, cfg, out);
  }
}

function scanProjects() {
  const cfg = getCfg();
  const found = [];
  for (const r of cfg.scanRoots) walk(expand(r), 0, cfg, found);

  const reg = getReg();
  const known = new Set(reg.map((p) => p.cwd));
  let added = 0;
  for (const f of found) {
    if (known.has(f.cwd)) continue;        // never overwrite an already-registered project (keeps your edits)
    reg.push({ id: idOf(f.cwd), name: f.name, cwd: f.cwd, cmd: f.cmd, kind: f.kind,
               port: null, memMB: null, heapMB: null });
    added++;
  }
  setReg(reg);
  return { total: reg.length, added };
}

// ---------------------------------------------------------------- system inspection

function listeners() {
  const out = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN']);
  const rows = [], seen = new Set();
  for (const line of out.split('\n').slice(1)) {
    if (!line.trim()) continue;
    const t = line.trim().split(/\s+/);
    const pid = parseInt(t[1], 10);
    if (!pid) continue;
    let port = null;
    for (let i = t.length - 1; i >= 0; i--) {
      const m = /^(.*):(\d+)$/.exec(t[i]);
      if (m) { port = parseInt(m[2], 10); break; }
    }
    if (!port) continue;
    const key = pid + ':' + port;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ pid, port, command: t[0] });
  }
  return rows;
}

/** One pass over the whole process table: pid → info, and pgid → total RSS (MB) */
function processTable() {
  const out = run('ps', ['-Ao', 'pid=,pgid=,rss=,stat=,etime=,command=']);
  const byPid = {}, rssByPgid = {};
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = +m[1], pgid = +m[2], rssMB = +m[3] / 1024;
    byPid[pid] = { pid, pgid, rssMB, stat: m[4], etime: m[5], command: m[6] };
    rssByPgid[pgid] = (rssByPgid[pgid] || 0) + rssMB;
  }
  return { byPid, rssByPgid };
}

/** "MM:SS", "HH:MM:SS" or "DD-HH:MM:SS" → seconds. null if it doesn't parse. */
function etimeToSec(etime) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime || '').trim());
  if (!m) return null;
  const [, d, h, mm, ss] = m;
  return (+(d || 0)) * 86400 + (+(h || 0)) * 3600 + (+mm) * 60 + (+ss);
}

/**
 * Is the process now holding this pid still the one we started?
 *
 * PIDs get recycled, and a long-running agent will eventually see it happen. Our
 * process can only be replaced by one that started *after* ours exited, so a pid
 * whose elapsed time is meaningfully shorter than the age of our record belongs to
 * someone else. Getting this wrong means freezing or killing an unrelated process,
 * so anything we can't parse is treated as "not ours".
 */
function sameProcess(m, info) {
  if (!m || !info) return false;
  if (!m.startedAt) return true;              // records written before this check existed
  const elapsed = etimeToSec(info.etime);
  if (elapsed === null) return false;
  const expected = (Date.now() - m.startedAt) / 1000;
  return elapsed >= expected - 90;            // slack for clock skew and ps rounding
}

function cwdInfo(pids) {
  const map = {};
  if (!pids.length) return map;
  const out = run('lsof', ['-a', '-d', 'cwd', '-Fn', '-p', pids.join(',')]);
  let cur = null;
  for (const line of out.split('\n')) {
    if (line[0] === 'p') cur = line.slice(1).trim();
    else if (line[0] === 'n' && cur && !map[cur]) map[cur] = line.slice(1).trim();
  }
  return map;
}

/** System memory pressure. Any parse failure returns null — the watchdog would rather
    do nothing than act on a bad reading. */
function sysMem() {
  try {
    if (IS_MAC) {
      const vm = run('vm_stat', []);
      if (!vm) return null;
      const psz = +((/page size of (\d+) bytes/.exec(vm) || [, 4096])[1]);
      const g = (label) => {
        const m = new RegExp(label + ':\\s+(\\d+)').exec(vm);
        return m ? +m[1] : 0;
      };
      const free = g('Pages free'), active = g('Pages active'), inactive = g('Pages inactive'),
            spec = g('Pages speculative'), wired = g('Pages wired down'),
            compressed = g('Pages occupied by compressor'), purgeable = g('Pages purgeable');
      const total = free + active + inactive + spec + wired + compressed;
      if (!total) return null;
      const avail = free + inactive + spec + purgeable;
      const sw = /used = ([\d.]+)([MGK])/.exec(run('sysctl', ['-n', 'vm.swapusage']) || '');
      const swapUsedMB = sw ? +sw[1] * (sw[2] === 'G' ? 1024 : sw[2] === 'K' ? 1 / 1024 : 1) : 0;
      return {
        availPct: Math.round((avail / total) * 100),
        swapUsedMB: Math.round(swapUsedMB),
        totalMB: Math.round((total * psz) / 1048576)
      };
    }
    const mi = fs.readFileSync('/proc/meminfo', 'utf8');
    const kb = (k) => { const m = new RegExp('^' + k + ':\\s+(\\d+)', 'm').exec(mi); return m ? +m[1] : 0; };
    const total = kb('MemTotal'), avail = kb('MemAvailable');
    if (!total) return null;
    return {
      availPct: Math.round((avail / total) * 100),
      swapUsedMB: Math.round((kb('SwapTotal') - kb('SwapFree')) / 1024),
      totalMB: Math.round(total / 1024)
    };
  } catch (e) { return null; }
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

// System daemons and sandboxed GUI apps report a cwd of "/" or somewhere under
// ~/Library — registering those would just put a junk entry in the registry, so
// don't offer it. Checked on the server too, not just hidden in the UI.
const SYS_PREFIXES = ['/System', '/Library', '/usr', '/bin', '/sbin', '/opt', '/Applications', '/private'];
function registrable(cwd) {
  if (!cwd || cwd === '/' || cwd === HOME) return false;
  if (!path.basename(cwd)) return false;
  if (SYS_PREFIXES.some((p) => cwd === p || cwd.startsWith(p + '/'))) return false;
  const lib = path.join(HOME, 'Library');
  if (cwd === lib || cwd.startsWith(lib + '/')) return false;
  return true;
}

/** Drop records whose process is gone, or whose pid now belongs to someone else.
    Returns true if anything was removed. */
function pruneManaged(byPid) {
  let dirty = false;
  for (const [id, m] of Object.entries(managed)) {
    const info = byPid[m.pid];
    if (!info || !sameProcess(m, info)) { delete managed[id]; dirty = true; }
  }
  return dirty;
}

// ---------------------------------------------------------------- state aggregation

function buildState() {
  const cfg = getCfg();
  const reg = getReg();
  const L = listeners();
  const { byPid, rssByPgid } = processTable();

  if (pruneManaged(byPid)) saveManaged();

  const C = cwdInfo([...new Set(L.map((r) => r.pid))]);
  const claimed = new Set();

  const projects = reg.map((p) => {
    let pid = null, source = null;
    const m = managed[p.id];
    if (m && byPid[m.pid]) { pid = m.pid; source = 'managed'; }
    if (!pid) {
      const hit = L.find((r) => C[r.pid] === p.cwd);
      if (hit) { pid = hit.pid; source = 'external'; }
    }

    let status = 'stopped', ports = [], etime = null, pgid = null, rssMB = null;
    if (pid) {
      const info = byPid[pid] || {};
      pgid = info.pgid || pid;
      etime = info.etime || null;
      status = (info.stat && info.stat.startsWith('T')) ? 'paused' : 'running';
      rssMB = Math.round(rssByPgid[pgid] || info.rssMB || 0);
      ports = [...new Set(L.filter((r) => byPid[r.pid] && byPid[r.pid].pgid === pgid).map((r) => r.port))]
                .sort((a, b) => a - b);
      L.forEach((r) => { if (byPid[r.pid] && byPid[r.pid].pgid === pgid) claimed.add(r.pid); });
    }

    return Object.assign({}, p, {
      cwdShort: shorten(p.cwd), status, pid, pgid, ports, etime, source, rssMB,
      memLimit: p.memMB || cfg.limits.projectRssMB,
      openPort: ports[0] || p.port || null
    });
  });

  // Group unclaimed listeners by process group, the same way projects are grouped —
  // one row per process, ports collected, so a process on several ports isn't listed
  // repeatedly with its group memory counted once per port.
  const otherByPgid = new Map();
  for (const r of L) {
    if (claimed.has(r.pid) || r.pid === process.pid) continue;
    const info = byPid[r.pid] || {};
    const pgid = info.pgid || r.pid;
    let row = otherByPgid.get(pgid);
    if (!row) {
      const exe = (info.command || '').trim().split(/\s+/)[0];
      const cwd = C[r.pid] || '';
      row = {
        pid: r.pid, pgid, ports: [],
        command: exe ? path.basename(exe) : r.command,
        cmdline: info.command || '', etime: info.etime || '',
        rssMB: Math.round(rssByPgid[pgid] || info.rssMB || 0),
        cwd, cwdShort: cwd ? shorten(cwd) : '',
        registrable: registrable(cwd),
        paused: !!(info.stat && info.stat.startsWith('T'))
      };
      otherByPgid.set(pgid, row);
    }
    if (!row.ports.includes(r.port)) row.ports.push(r.port);
  }
  const others = [...otherByPgid.values()]
    .map((o) => { o.ports.sort((a, b) => a - b); return o; })
    .sort((a, b) => a.ports[0] - b.ports[0]);

  return { projects, others, alerts, sys: sysMem(), limits: cfg.limits, now: Date.now() };
}

// ---------------------------------------------------------------- process control

function signalGroup(pgid, sig) {
  try { process.kill(-pgid, sig); return true; } catch (e) { /* fall through */ }
  try { process.kill(pgid, sig); return true; } catch (e) { return false; }
}

const starting = new Set();          // projects currently starting up, guards against double-clicks
const startLog = {};                 // id → recent start timestamps, guards against crash-restart loops

function rotateLog(file, maxMB) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > maxMB * 1048576) {
      fs.renameSync(file, file + '.old');
    }
  } catch (e) { /* ignore */ }
}

function startProject(id) {
  const lim = getCfg().limits;
  const p = getReg().find((x) => x.id === id);
  if (!p) throw new Error('Project not found');
  if (!p.cmd) throw new Error('No start command configured for this project — click "Edit" and set one (e.g. npm run dev)');
  if (!fs.existsSync(p.cwd)) throw new Error('Directory does not exist: ' + p.cwd);

  // --- Guard against double-clicks: the UI only refreshes every 2.5s, so two quick clicks
  //     would otherwise really start two instances ---
  if (starting.has(id)) throw new Error('Already starting, hang on');

  // --- Re-check real state right before starting instead of trusting the cache ---
  const cur = buildState().projects.find((x) => x.id === id);
  if (cur && cur.pid) throw new Error(`Already running (pid ${cur.pid}) — use "Restart" instead`);

  // --- Guard against crash-restart loops: a project that keeps failing to start and gets
  //     retried is the classic path to a memory avalanche ---
  const now = Date.now();
  startLog[id] = (startLog[id] || []).filter((t) => now - t < 60000);
  if (lim.enabled && startLog[id].length >= lim.startBurst) {
    throw new Error(`Already started ${lim.startBurst} times in the last minute. Check "Logs" to see why it won't come up instead of forcing it again`);
  }

  // --- Refuse to start anything new while the system is already tight on memory ---
  const sm = sysMem();
  if (lim.enabled && sm && sm.availPct < lim.sysAvailFloorPct) {
    throw new Error(`Only ${sm.availPct}% memory available — stop something first`);
  }

  ensure();
  const logFile = path.join(D_LOGS, id + '.log');
  rotateLog(logFile, lim.logMaxMB);
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toLocaleString()}  start: ${p.cmd} =====\n`);

  // --- Cap node's heap so it OOMs itself instead of taking the whole system down ---
  const env = Object.assign({}, process.env, { FORCE_COLOR: '0' });
  const heap = p.heapMB || lim.nodeHeapMB;
  if (lim.enabled && heap && !/max-old-space-size/.test(env.NODE_OPTIONS || '')) {
    env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ` --max-old-space-size=${heap}`).trim();
  }

  const child = spawn(SHELL, ['-lc', p.cmd], {
    cwd: p.cwd,
    detached: true,                  // its own process group, so signals reach the whole child tree
    stdio: ['ignore', fd, fd],
    env
  });
  child.unref();

  starting.add(id);
  setTimeout(() => starting.delete(id), 3000);
  startLog[id].push(now);
  managed[id] = { pid: child.pid, pgid: child.pid, startedAt: now, cmd: p.cmd };
  saveManaged();
  return { pid: child.pid, heapLimitMB: lim.enabled ? heap : null };
}

function resolveTarget(body) {
  if (body.pid) {
    const t = processTable().byPid[body.pid];
    return { pid: +body.pid, pgid: t ? t.pgid : +body.pid };
  }
  const st = buildState().projects.find((p) => p.id === body.id);
  if (!st || !st.pid) throw new Error('This project is not currently running');
  return { pid: st.pid, pgid: st.pgid };
}

function stopTarget(body) {
  const { pid, pgid } = resolveTarget(body);
  signalGroup(pgid, 'SIGCONT');            // thaw first, or a frozen process never sees the TERM
  signalGroup(pgid, 'SIGTERM');
  setTimeout(() => { if (alive(pid)) signalGroup(pgid, 'SIGKILL'); }, 3000);
  if (body.id) { delete managed[body.id]; saveManaged(); }
  return { ok: true };
}

const waitGone = (pid, ms) => new Promise((resolve) => {
  const t0 = Date.now();
  const tick = () => (!alive(pid) || Date.now() - t0 > ms) ? resolve() : setTimeout(tick, 200);
  tick();
});

async function restartProject(id) {
  const st = buildState().projects.find((p) => p.id === id);
  if (st && st.pid) {
    signalGroup(st.pgid, 'SIGCONT');
    signalGroup(st.pgid, 'SIGTERM');
    await waitGone(st.pid, 5000);
    if (alive(st.pid)) { signalGroup(st.pgid, 'SIGKILL'); await waitGone(st.pid, 2000); }
    delete managed[id]; saveManaged();
  }
  await new Promise((r) => setTimeout(r, 500));   // give the port a moment to actually free up
  return startProject(id);
}

// ---------------------------------------------------------------- memory watchdog

function watchdog() {
  const lim = getCfg().limits;
  if (!lim.enabled) return;

  const reg = getReg();
  const { byPid, rssByPgid } = processTable();
  const running = [];

  // Nothing else prunes when running headless — buildState() only executes while a
  // dashboard is open — so a stale pid could otherwise linger here indefinitely and
  // eventually be matched against an unrelated process.
  if (pruneManaged(byPid)) saveManaged();

  for (const [id, m] of Object.entries(managed)) {
    const info = byPid[m.pid];
    if (!info) continue;
    const p = reg.find((x) => x.id === id);
    if (!p) continue;
    running.push({
      id, name: p.name, pgid: info.pgid,
      rss: Math.round(rssByPgid[info.pgid] || info.rssMB || 0),
      paused: !!(info.stat && info.stat.startsWith('T')),
      limit: p.memMB || lim.projectRssMB
    });
  }

  // 1) hard per-project limit → kill outright
  for (const r of running) {
    if (r.rss > lim.hardRssMB) {
      signalGroup(r.pgid, 'SIGKILL');
      delete managed[r.id]; saveManaged();
      alert_('danger', `"${r.name}" hit ${fmtMB(r.rss)}, over the hard limit of ${fmtMB(lim.hardRssMB)} — force-stopped.`, r.id, 'hard:' + r.id);
    }
  }

  // 2) soft per-project limit → freeze (preserves the crash scene so you can inspect logs before deciding)
  for (const r of running) {
    if (!r.paused && r.rss > r.limit && r.rss <= lim.hardRssMB) {
      signalGroup(r.pgid, 'SIGSTOP');
      alert_('danger', `"${r.name}" reached ${fmtMB(r.rss)}, over its limit of ${fmtMB(r.limit)} — auto-frozen. The process is still there; check the logs, then "Resume" or "Stop".`, r.id, 'soft:' + r.id);
    }
  }

  // 3) system-wide pressure → freeze whoever's using the most (only touches processes PortDash
  //    itself started; anything else just gets a warning)
  const sm = sysMem();
  if (!sm) return;
  const low = sm.availPct < lim.sysAvailFloorPct;
  const swapping = sm.swapUsedMB > lim.sysSwapCeilMB;
  if (!low && !swapping) return;

  const victim = running.filter((r) => !r.paused).sort((a, b) => b.rss - a.rss)[0];
  const why = low ? `only ${sm.availPct}% memory available` : `swap usage at ${fmtMB(sm.swapUsedMB)}`;
  if (victim) {
    signalGroup(victim.pgid, 'SIGSTOP');
    alert_('danger', `${why} — froze "${victim.name}" (${fmtMB(victim.rss)}), the biggest consumer, to protect the system.`, victim.id, 'sys:' + victim.id);
  } else {
    alert_('warn', `${why}, but the top consumer wasn't started by PortDash — you'll need to handle it yourself.`, null, 'sys:none');
  }
}

// ---------------------------------------------------------------- HTTP

function json(res, code, data) {
  const b = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': b.length });
  res.end(b);
}

const readBody = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
});

// Three layers, because the API can spawn processes:
// - Host check blocks DNS-rebinding (attacker domain resolved to 127.0.0.1)
// - Origin check blocks plain cross-site form/fetch requests
// - the token blocks other *local* processes, which the first two do nothing about.
//   It lives in a custom header, so a cross-origin request carrying it would need a
//   CORS preflight this server never approves.
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const TOKEN = getToken();

function tokenOk(req, u) {
  const sent = req.headers['x-portdash-token'] || u.searchParams.get('token') || '';
  const a = Buffer.from(String(sent));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isTrustedRequest(req, u) {
  if (!LOCAL_HOST_RE.test(req.headers.host || '')) return false;
  const origin = req.headers.origin;
  if (origin && !LOCAL_HOST_RE.test(origin.replace(/^https?:\/\//, ''))) return false;
  return tokenOk(req, u);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  if (!LOCAL_HOST_RE.test(req.headers.host || '')) { res.writeHead(400); return res.end('bad host'); }
  try {
    if (u.pathname === '/') {
      // The page is what hands the token to the browser, so it stays unauthenticated —
      // it exposes nothing on its own, and every /api route below requires the token.
      const b = Buffer.from(HTML.replace('__PORTDASH_TOKEN__', TOKEN));
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length,
        'Cache-Control': 'no-store'
      });
      return res.end(b);
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }

    if (u.pathname.startsWith('/api/') && !isTrustedRequest(req, u)) {
      res.writeHead(403); return res.end('forbidden');
    }

    if (u.pathname === '/api/state') return json(res, 200, buildState());

    if (u.pathname === '/api/logs') {
      const f = path.join(D_LOGS, path.basename(String(u.searchParams.get('id'))) + '.log');
      let text = '(No logs yet. Logs are only recorded for services started through PortDash.)';
      if (fs.existsSync(f)) {
        const size = fs.statSync(f).size, cap = 200 * 1024;
        const len = Math.min(size, cap);
        const fd = fs.openSync(f, 'r');
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, Math.max(0, size - cap));
        fs.closeSync(fd);
        text = buf.toString('utf8');
      }
      const b = Buffer.from(text);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': b.length });
      return res.end(b);
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      if (u.pathname === '/api/scan')    return json(res, 200, scanProjects());
      if (u.pathname === '/api/start')   return json(res, 200, startProject(body.id));
      if (u.pathname === '/api/stop')    return json(res, 200, stopTarget(body));
      if (u.pathname === '/api/restart') return json(res, 200, await restartProject(body.id));
      if (u.pathname === '/api/pause')   return json(res, 200, { ok: signalGroup(resolveTarget(body).pgid, 'SIGSTOP') });
      if (u.pathname === '/api/resume')  return json(res, 200, { ok: signalGroup(resolveTarget(body).pgid, 'SIGCONT') });
      if (u.pathname === '/api/dismiss') { alerts = alerts.filter((a) => a.id !== body.alertId); return json(res, 200, { ok: true }); }

      if (u.pathname === '/api/save') {
        const reg = getReg();
        const p = reg.find((x) => x.id === body.id);
        if (!p) throw new Error('Project not found');
        if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
        if (typeof body.cmd === 'string') p.cmd = body.cmd.trim();
        p.port = body.port ? parseInt(body.port, 10) : null;
        p.memMB = body.memMB ? parseInt(body.memMB, 10) : null;
        p.heapMB = body.heapMB ? parseInt(body.heapMB, 10) : null;
        setReg(reg);
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/register') {
        if (!body.cwd) throw new Error("Couldn't determine this process's working directory, can't register it");
        if (!registrable(body.cwd)) throw new Error(`${body.cwd} doesn't look like a project directory — it's a system or sandboxed-app path`);
        const reg = getReg();
        if (reg.some((x) => x.cwd === body.cwd)) throw new Error('This directory is already registered');
        const d = detectProject(body.cwd) || { name: path.basename(body.cwd), cmd: '', kind: 'unknown' };
        reg.push({ id: idOf(body.cwd), name: d.name, cwd: body.cwd, cmd: d.cmd, kind: d.kind,
                   port: body.port || null, memMB: null, heapMB: null });
        setReg(reg);
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/remove') {
        setReg(getReg().filter((x) => x.id !== body.id));
        delete managed[body.id]; saveManaged();
        return json(res, 200, { ok: true });
      }
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    json(res, 400, { error: e.message || String(e) });
  }
});

// ---------------------------------------------------------------- frontend

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PortDash</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e4e7ec;--tx:#1a1d21;--dim:#6b7280;
  --run:#10b981;--pause:#f59e0b;--stop:#9ca3af;--accent:#2563eb;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1d2024;--line:#2c3036;--tx:#e8eaed;--dim:#9aa1ab}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
.wrap{max-width:1060px;margin:0 auto;padding:26px 20px 60px}
header{display:flex;align-items:baseline;gap:13px;margin-bottom:18px;flex-wrap:wrap}
h1{font-size:20px;margin:0;letter-spacing:-.2px}
.sub{color:var(--dim);font-size:13px}
.spacer{flex:1}
button{font:inherit;cursor:pointer;border:1px solid var(--line);background:var(--card);
  color:var(--tx);border-radius:7px;padding:5px 11px;transition:.12s}
button:hover{border-color:var(--accent);color:var(--accent)}
button.p{background:var(--accent);border-color:var(--accent);color:#fff}
button.p:hover{opacity:.88;color:#fff}
button.d:hover{border-color:var(--danger);color:var(--danger)}
h2{font-size:13px;color:var(--dim);font-weight:600;margin:26px 0 10px;letter-spacing:.3px}
.row{background:var(--card);border:1px solid var(--line);border-radius:10px;
  padding:13px 15px;margin-bottom:8px;display:flex;align-items:center;gap:13px}
.row.hot{border-color:color-mix(in srgb,var(--pause) 55%,var(--line))}
.dot{width:8px;height:8px;border-radius:50%;flex:none}
.dot.running{background:var(--run);box-shadow:0 0 0 3px color-mix(in srgb,var(--run) 22%,transparent)}
.dot.paused{background:var(--pause);box-shadow:0 0 0 3px color-mix(in srgb,var(--pause) 22%,transparent)}
.dot.stopped{background:var(--stop)}
.main{flex:1;min-width:0}
.nm{font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.meta{color:var(--dim);font-size:12px;margin-top:3px;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.tag{font-size:11px;padding:1px 7px;border-radius:20px;border:1px solid var(--line);color:var(--dim);font-weight:400}
.tag.port{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 35%,var(--line));font-family:ui-monospace,Menlo,monospace}
.tag.mem{font-family:ui-monospace,Menlo,monospace}
.tag.mem.warn{color:var(--pause);border-color:color-mix(in srgb,var(--pause) 45%,var(--line))}
.tag.mem.bad{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--line))}
.acts{display:flex;gap:6px;flex:none;flex-wrap:wrap;justify-content:flex-end}
.empty{color:var(--dim);padding:22px;text-align:center;border:1px dashed var(--line);border-radius:10px}
.alert{border-radius:10px;padding:11px 14px;margin-bottom:8px;display:flex;gap:10px;
  align-items:flex-start;border:1px solid;font-size:13px}
.alert.danger{background:color-mix(in srgb,var(--danger) 10%,var(--card));border-color:color-mix(in srgb,var(--danger) 40%,var(--line))}
.alert.warn{background:color-mix(in srgb,var(--pause) 10%,var(--card));border-color:color-mix(in srgb,var(--pause) 40%,var(--line))}
.alert .x{margin-left:auto;cursor:pointer;color:var(--dim);border:0;background:none;padding:0 4px}
.bar{height:4px;border-radius:3px;background:var(--line);overflow:hidden;width:44px;display:inline-block;vertical-align:middle}
.bar i{display:block;height:100%;background:var(--run)}
.bar i.warn{background:var(--pause)} .bar i.bad{background:var(--danger)}
dialog{border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--tx);
  padding:20px;max-width:min(760px,92vw);width:100%}
dialog::backdrop{background:rgba(0,0,0,.45)}
label{display:block;font-size:12px;color:var(--dim);margin:12px 0 4px}
input{width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--tx);font:inherit}
.two{display:flex;gap:12px}.two>div{flex:1}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:12px;max-height:56vh;
  overflow:auto;font:12px/1.6 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
.err{background:var(--danger);color:#fff;padding:9px 14px;border-radius:8px;position:fixed;bottom:20px;
  left:50%;transform:translateX(-50%);z-index:9;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:80vw}
</style></head><body>
<div class="wrap">
  <header>
    <h1>PortDash</h1>
    <span class="sub" id="stat">Loading…</span>
    <span class="spacer"></span>
    <span class="sub" id="sys"></span>
    <button onclick="scan()">Rescan</button>
  </header>
  <div id="alerts"></div>
  <h2>My projects</h2>
  <div id="projects"></div>
  <h2>Other processes on listening ports</h2>
  <div id="others"></div>
</div>

<dialog id="edit">
  <div style="font-weight:600;margin-bottom:4px">Edit project</div>
  <div class="sub" id="e_cwd" style="font-size:12px"></div>
  <label>Name</label><input id="e_name">
  <label>Start command (runs in the project directory)</label><input id="e_cmd" placeholder="npm run dev">
  <div class="two">
    <div><label>Default port</label><input id="e_port" placeholder="optional"></div>
    <div><label>Memory limit MB (auto-freeze past this)</label><input id="e_mem" placeholder="leave blank for default"></div>
    <div><label>Node heap limit MB</label><input id="e_heap" placeholder="leave blank for default"></div>
  </div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
    <button onclick="edit.close()">Cancel</button>
    <button class="p" onclick="saveEdit()">Save</button>
  </div>
</dialog>

<dialog id="logs">
  <div style="display:flex;align-items:center;margin-bottom:10px">
    <div style="font-weight:600" id="l_title">Logs</div><span class="spacer"></span>
    <button onclick="logs.close()">Close</button>
  </div>
  <pre id="l_body"></pre>
</dialog>

<script>
const TOKEN='__PORTDASH_TOKEN__';
const STATE={byId:{}};
let editingId=null, logId=null;

const authed=(p)=>fetch(p,{headers:{'X-Portdash-Token':TOKEN}});

function toast(m){
  document.querySelectorAll('.err').forEach(e=>e.remove());
  const d=document.createElement('div'); d.className='err'; d.textContent=m;
  document.body.appendChild(d); setTimeout(()=>d.remove(),5000);
}
async function api(p,b){
  const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json','X-Portdash-Token':TOKEN},body:JSON.stringify(b||{})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){ toast(j.error||'Action failed'); throw new Error(j.error); }
  return j;
}
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const gb=mb=>mb>=1024?(mb/1024).toFixed(1)+'G':mb+'M';

async function act(p,b){ await api(p,b); setTimeout(load,350); }
async function scan(){ const r=await api('/api/scan'); toast('Scan complete, '+r.added+' new project(s)'); load(); }
function open_(port){ window.open('http://localhost:'+port,'_blank'); }

function openEdit(p){
  editingId=p.id; e_cwd.textContent=p.cwdShort; e_name.value=p.name;
  e_cmd.value=p.cmd||''; e_port.value=p.port||''; e_mem.value=p.memMB||''; e_heap.value=p.heapMB||'';
  edit.showModal();
}
async function saveEdit(){
  await api('/api/save',{id:editingId,name:e_name.value,cmd:e_cmd.value,port:e_port.value,
                         memMB:e_mem.value,heapMB:e_heap.value});
  edit.close(); load();
}
async function showLogs(p){
  logId=p.id; l_title.textContent='Logs · '+p.name; l_body.textContent='Loading…'; logs.showModal();
  l_body.textContent=await (await authed('/api/logs?id='+encodeURIComponent(p.id))).text();
  l_body.scrollTop=l_body.scrollHeight;
}
async function remove(p){
  if(!confirm('Remove "'+p.name+'" from the registry? (this won\\'t touch your project files)'))return;
  await act('/api/remove',{id:p.id});
}

function btn(a,id,label,cls){
  return '<button class="'+(cls||'')+'" data-act="'+a+'" data-id="'+id+'">'+label+'</button>';
}
function memTag(rss,limit){
  if(!rss) return '';
  const pct=limit?rss/limit:0;
  const cls=pct>=.85?'bad':pct>=.6?'warn':'';
  const w=Math.min(100,Math.round(pct*100));
  return '<span class="tag mem '+cls+'">'+gb(rss)
    +' <span class="bar"><i class="'+cls+'" style="width:'+w+'%"></i></span></span>';
}

function projectRow(p){
  const label={running:'running',paused:'frozen',stopped:'stopped'}[p.status];
  const ports=p.ports.map(x=>'<span class="tag port">:'+x+'</span>').join('');
  let acts='';
  if(p.status==='stopped') acts=btn('start',p.id,'Start','p');
  else if(p.status==='running')
    acts=(p.openPort?'<button data-act="open" data-port="'+p.openPort+'">Open</button>':'')
        +btn('pause',p.id,'Pause')+btn('restart',p.id,'Restart')+btn('stop',p.id,'Stop','d');
  else acts=btn('resume',p.id,'Resume','p')+btn('stop',p.id,'Stop','d');
  acts+=btn('logs',p.id,'Logs')+btn('edit',p.id,'Edit')+btn('remove',p.id,'×','d');
  const badge=p.source==='external'?'<span class="tag">external</span>':'';
  const cmdTxt=p.cmd?esc(p.cmd):'<span style="color:var(--pause)">no start command configured</span>';
  const hot=(p.rssMB&&p.memLimit&&p.rssMB/p.memLimit>=.6)?' hot':'';
  return '<div class="row'+hot+'"><span class="dot '+p.status+'"></span><div class="main">'
    +'<div class="nm">'+esc(p.name)+ports+memTag(p.rssMB,p.memLimit)+badge+'</div>'
    +'<div class="meta">'+esc(p.cwdShort)+'  ·  '+cmdTxt
    +(p.etime?'  ·  '+label+' '+esc(p.etime):'')+'</div></div>'
    +'<div class="acts">'+acts+'</div></div>';
}

function otherRow(o){
  const ports=o.ports.map(x=>'<span class="tag port">:'+x+'</span>').join('');
  let acts='<button data-act="open" data-port="'+o.ports[0]+'">Open</button>'
    +'<button data-act="'+(o.paused?'resume':'pause')+'" data-pid="'+o.pid+'">'+(o.paused?'Resume':'Pause')+'</button>'
    +'<button class="d" data-act="stop" data-pid="'+o.pid+'">Stop</button>';
  if(o.registrable) acts+='<button data-act="register" data-cwd="'+esc(o.cwd)+'" data-port="'+o.ports[0]+'">Register</button>';
  return '<div class="row"><span class="dot '+(o.paused?'paused':'running')+'"></span><div class="main">'
    +'<div class="nm">'+esc(o.command)+ports
    +'<span class="tag">pid '+o.pid+'</span>'+(o.rssMB?'<span class="tag mem">'+gb(o.rssMB)+'</span>':'')+'</div>'
    +'<div class="meta">'+esc(o.cwdShort||o.cmdline||'')+'</div></div>'
    +'<div class="acts">'+acts+'</div></div>';
}

document.addEventListener('click', async (e)=>{
  const b=e.target.closest('button[data-act]'); if(!b) return;
  const a=b.dataset.act, id=b.dataset.id||null, pid=b.dataset.pid?+b.dataset.pid:null;
  if(a==='open')     return open_(b.dataset.port);
  if(a==='edit')     return openEdit(STATE.byId[id]);
  if(a==='logs')     return showLogs(STATE.byId[id]);
  if(a==='remove')   return remove(STATE.byId[id]);
  if(a==='dismiss')  return act('/api/dismiss',{alertId:b.dataset.alert});
  if(a==='register') return act('/api/register',{cwd:b.dataset.cwd,port:+b.dataset.port});
  const M={start:'/api/start',stop:'/api/stop',pause:'/api/pause',resume:'/api/resume',restart:'/api/restart'};
  if(M[a]) return act(M[a], id?{id:id}:{pid:pid});
});

async function load(){
  let s; try{ s=await (await authed('/api/state')).json(); }catch(e){ return; }
  STATE.byId={}; s.projects.forEach(p=>STATE.byId[p.id]=p);

  const run=s.projects.filter(p=>p.status==='running').length;
  const pau=s.projects.filter(p=>p.status==='paused').length;
  stat.textContent=s.projects.length+' project(s) · '+run+' running'
    +(pau?' · '+pau+' frozen':'')+' · '+s.others.length+' other port(s) in use';

  if(s.sys){
    const c=s.sys.availPct<20?'var(--danger)':s.sys.availPct<35?'var(--pause)':'var(--dim)';
    sys.innerHTML='<span style="color:'+c+'">'+s.sys.availPct+'% memory available</span>'
      +(s.sys.swapUsedMB>512?' · swap '+gb(s.sys.swapUsedMB):'');
  }

  alerts.innerHTML=(s.alerts||[]).map(a=>'<div class="alert '+a.level+'"><div>'+esc(a.text)+'</div>'
    +'<button class="x" data-act="dismiss" data-alert="'+a.id+'">×</button></div>').join('');

  const ord={running:0,paused:1,stopped:2};
  projects.innerHTML = s.projects.length
    ? s.projects.slice().sort((a,b)=>ord[a.status]-ord[b.status]||a.name.localeCompare(b.name))
        .map(projectRow).join('')
    : '<div class="empty">No projects registered yet. Click "Rescan" above, or edit scanRoots in ~/.portdash/config.json.</div>';
  others.innerHTML = s.others.length ? s.others.map(otherRow).join('')
    : '<div class="empty">No other processes are listening on a port.</div>';
  if(logs.open&&logId) l_body.textContent=await (await authed('/api/logs?id='+encodeURIComponent(logId))).text();
}
load(); setInterval(load,2500);
</script></body></html>`;

// ---------------------------------------------------------------- launch agent

const PLIST = (nodeBin, script, logFile) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${script}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`;

function launchctl(args) {
  try {
    execFileSync('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 });
    return true;
  } catch (e) { return false; }
}

function installAgent() {
  if (!IS_MAC) {
    console.error('--install-agent is macOS-only (it writes a LaunchAgent).');
    console.error('On Linux, write a systemd --user unit that runs: ' + process.execPath + ' ' + __filename);
    process.exit(1);
  }
  // An npx copy lives in a cache npm is free to clear, which would leave the agent
  // pointing at a path that no longer exists.
  if (/[\\/]_npx[\\/]/.test(__filename)) {
    console.error('Refusing to install: this copy is running from the npx cache, which npm may delete.');
    console.error('Install it properly first:  npm install -g @bluemanta/portdash');
    process.exit(1);
  }
  ensure();
  fs.mkdirSync(path.dirname(F_PLIST), { recursive: true });
  // launchd keeps its redirect fd open across our own rotation, so point it at a
  // separate file from the one logLine() manages.
  const agentLog = path.join(ROOT, 'agent.out.log');
  fs.writeFileSync(F_PLIST, PLIST(process.execPath, __filename, agentLog));

  launchctl(['bootout', `gui/${process.getuid()}/${AGENT_LABEL}`]);   // ignore failure: may not be loaded
  const ok = launchctl(['bootstrap', `gui/${process.getuid()}`, F_PLIST]) ||
             launchctl(['load', '-w', F_PLIST]);
  if (!ok) {
    console.error(`Wrote ${F_PLIST}, but launchctl wouldn't load it. Load it manually with:`);
    console.error(`  launchctl bootstrap gui/$(id -u) ${F_PLIST}`);
    process.exit(1);
  }
  console.log(`Installed. PortDash now starts at login and keeps the memory watchdog running.`);
  console.log(`  plist:  ${F_PLIST}`);
  console.log(`  log:    ${F_SELFLOG}`);
  console.log(`  remove: portdash --uninstall-agent`);
}

function uninstallAgent() {
  if (!IS_MAC) { console.error('--uninstall-agent is macOS-only.'); process.exit(1); }
  launchctl(['bootout', `gui/${process.getuid()}/${AGENT_LABEL}`]) || launchctl(['unload', '-w', F_PLIST]);
  if (fs.existsSync(F_PLIST)) fs.unlinkSync(F_PLIST);
  console.log('Uninstalled. Services already running are unaffected.');
}

// ---------------------------------------------------------------- boot

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`PortDash — a visual control panel for local dev servers

  portdash                    start the dashboard and watchdog
  portdash --install-agent    run at login as a background LaunchAgent (macOS)
  portdash --uninstall-agent  remove the LaunchAgent
  portdash --version          print the version

Config, logs and the API token live in ~/.portdash/`);
  process.exit(0);
}
if (argv.includes('--version') || argv.includes('-v')) {
  console.log(readJSON(path.join(__dirname, 'package.json'), { version: 'unknown' }).version);
  process.exit(0);
}
if (argv.includes('--install-agent')) { installAgent(); process.exit(0); }
if (argv.includes('--uninstall-agent')) { uninstallAgent(); process.exit(0); }

ensure();
if (!fs.existsSync(F_CFG)) writeJSON(F_CFG, DEFAULT_CFG);
if (!fs.existsSync(F_REG)) logLine(`First run: found ${scanProjects().added} project(s)`);

const cfg0 = getCfg();
let watchdogTimer = null;
let bindTries = 0;

server.listen(cfg0.uiPort, '127.0.0.1', () => {
  bindTries = 0;
  // Only once we own the port, so a second copy waiting to bind never runs a
  // competing watchdog against the same processes.
  if (!watchdogTimer) watchdogTimer = setInterval(watchdog, 2000);

  const sm = sysMem();
  logLine(`PortDash → http://localhost:${cfg0.uiPort}`);
  logLine(`  Memory protection: ${cfg0.limits.enabled ? 'on' : 'off'}` +
    (cfg0.limits.enabled
      ? ` (freeze at ${cfg0.limits.projectRssMB}M / kill at ${cfg0.limits.hardRssMB}M per project, node heap ${cfg0.limits.nodeHeapMB}M)`
      : ''));
  if (sm) logLine(`  System: ${sm.availPct}% available of ${(sm.totalMB / 1024).toFixed(0)}G, swap used ${sm.swapUsedMB}M`);
  logLine(`  Config: ${F_CFG}`);
  console.log(`  Ctrl+C to quit (won't affect services already started)\n`);
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  // Exiting here would make launchd restart us immediately and spin. Wait instead:
  // usually it's another PortDash, and if that one goes away we take over.
  bindTries++;
  const wait = Math.min(60, 5 * Math.min(bindTries, 12));
  if (bindTries === 1) {
    logLine(`Port ${cfg0.uiPort} is in use — retrying every ${wait}s. Change uiPort in ${F_CFG} to use another.`);
  }
  setTimeout(() => server.listen(cfg0.uiPort, '127.0.0.1'), wait * 1000);
});
