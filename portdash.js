#!/usr/bin/env node
'use strict';
/**
 * PortDash — 本地开发服务可视化控制台
 *
 * 零依赖单文件。运行:  node portdash.js
 * 然后打开:            http://localhost:7777
 *
 * 配置与数据都在 ~/.portdash/ 下:
 *   config.json    扫描目录、UI 端口、内存限额
 *   projects.json  项目登记表（扫描生成，可在界面上改）
 *   state.json     由 PortDash 拉起的进程记录
 *   logs/          每个项目的运行日志
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
const D_LOGS = path.join(ROOT, 'logs');

const SHELL = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
const IS_MAC = process.platform === 'darwin';

const DEFAULT_CFG = {
  uiPort: 7777,
  scanRoots: ['~/Documents/CodeProjects'],
  scanDepth: 3,
  ignoreDirs: ['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt',
               'vendor', '.venv', 'venv', '__pycache__', 'target', '.cache', 'coverage'],

  // ------- 内存保护。想更宽松就把数字调大，想关掉把 enabled 设 false -------
  limits: {
    enabled: true,
    projectRssMB: 4096,        // 单个项目（整个进程组）占用超过这个 → 自动冻结
    hardRssMB: 10240,          // 超过这个 → 直接强杀，不再客气
    nodeHeapMB: 3072,          // 给 node 注入 --max-old-space-size，让它自己 OOM 而不是拖垮系统
    sysAvailFloorPct: 12,      // 系统可用内存低于这个百分比 → 冻结当前最占内存的项目
    sysSwapCeilMB: 4096,       // swap 用量超过这个 → 同上
    startBurst: 3,             // 60 秒内同一个项目最多启动几次（防崩溃重启循环）
    logMaxMB: 5                // 启动时日志超过这个就先归档
  }
};

// ---------------------------------------------------------------- 基础工具

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

// ---------------------------------------------------------------- 告警

let alerts = [];
const alertSeen = {};                 // 同一类告警 60 秒内不重复刷屏
function alert_(level, text, projectId, key) {
  const k = key || (level + ':' + text);
  const now = Date.now();
  if (alertSeen[k] && now - alertSeen[k] < 60000) return;
  alertSeen[k] = now;
  alerts.unshift({ id: crypto.randomBytes(4).toString('hex'), t: now, level, text, projectId });
  alerts = alerts.slice(0, 20);
  console.log(`[${level === 'danger' ? '干预' : '提醒'}] ${text}`);
  if (projectId) {
    try {
      fs.appendFileSync(path.join(D_LOGS, projectId + '.log'),
        `\n***** ${new Date().toLocaleString()}  PortDash: ${text} *****\n`);
    } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 项目扫描

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
    // 弱匹配：根目录有 index.html 也算一个可预览的静态站，但仍继续往下找真正的子项目
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
      if (!p.weak) return;                 // 强匹配命中后不再往下钻
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
    if (known.has(f.cwd)) continue;        // 已登记的不覆盖（保留你改过的命令和限额）
    reg.push({ id: idOf(f.cwd), name: f.name, cwd: f.cwd, cmd: f.cmd, kind: f.kind,
               port: null, memMB: null, heapMB: null });
    added++;
  }
  setReg(reg);
  return { total: reg.length, added };
}

// ---------------------------------------------------------------- 系统探测

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

/** 一次拿全系统进程表，得到 pid→信息 与 pgid→内存合计（MB） */
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

/** 系统内存水位。任何一步解析失败都返回 null —— 看门狗宁可不动，也不能误判 */
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

// ---------------------------------------------------------------- 状态汇总

function buildState() {
  const cfg = getCfg();
  const reg = getReg();
  const L = listeners();
  const { byPid, rssByPgid } = processTable();

  let dirty = false;
  for (const [id, m] of Object.entries(managed)) {
    if (!byPid[m.pid]) { delete managed[id]; dirty = true; }
  }
  if (dirty) saveManaged();

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

  const others = L.filter((r) => !claimed.has(r.pid) && r.pid !== process.pid).map((r) => {
    const info = byPid[r.pid] || {};
    const exe = (info.command || '').trim().split(/\s+/)[0];
    return {
      pid: r.pid, pgid: info.pgid || r.pid, port: r.port,
      command: exe ? path.basename(exe) : r.command,
      cmdline: info.command || '', etime: info.etime || '',
      rssMB: Math.round(rssByPgid[info.pgid] || info.rssMB || 0),
      cwd: C[r.pid] || '', cwdShort: C[r.pid] ? shorten(C[r.pid]) : '',
      paused: !!(info.stat && info.stat.startsWith('T'))
    };
  }).sort((a, b) => a.port - b.port);

  return { projects, others, alerts, sys: sysMem(), limits: cfg.limits, now: Date.now() };
}

// ---------------------------------------------------------------- 进程控制

function signalGroup(pgid, sig) {
  try { process.kill(-pgid, sig); return true; } catch (e) { /* fall through */ }
  try { process.kill(pgid, sig); return true; } catch (e) { return false; }
}

const starting = new Set();          // 正在启动中的项目，防连点
const startLog = {};                 // id → 最近的启动时间戳，防崩溃重启循环

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
  if (!p) throw new Error('项目不存在');
  if (!p.cmd) throw new Error('这个项目还没配启动命令，点「编辑」填一个（比如 npm run dev）');
  if (!fs.existsSync(p.cwd)) throw new Error('目录不存在：' + p.cwd);

  // --- 防连点：界面 2.5 秒才刷新一次，连点两下会真的起两份 ---
  if (starting.has(id)) throw new Error('正在启动中，等一下');

  // --- 起之前重新确认一次实际状态，而不是信任缓存 ---
  const cur = buildState().projects.find((x) => x.id === id);
  if (cur && cur.pid) throw new Error(`已经在跑了（pid ${cur.pid}），要重来请点「重启」`);

  // --- 防崩溃重启循环：起不来的项目被反复拉起，是最典型的内存雪崩 ---
  const now = Date.now();
  startLog[id] = (startLog[id] || []).filter((t) => now - t < 60000);
  if (lim.enabled && startLog[id].length >= lim.startBurst) {
    throw new Error(`1 分钟内已经启动 ${lim.startBurst} 次了。先点「日志」看它为什么起不来，别再硬拉`);
  }

  // --- 系统内存已经紧张时，不许再起新服务 ---
  const sm = sysMem();
  if (lim.enabled && sm && sm.availPct < lim.sysAvailFloorPct) {
    throw new Error(`系统可用内存只剩 ${sm.availPct}%，先停掉点东西再启动`);
  }

  ensure();
  const logFile = path.join(D_LOGS, id + '.log');
  rotateLog(logFile, lim.logMaxMB);
  const fd = fs.openSync(logFile, 'a');
  fs.writeSync(fd, `\n===== ${new Date().toLocaleString()}  启动: ${p.cmd} =====\n`);

  // --- 给 node 套堆上限：让它自己 OOM 退出，而不是把系统内存吃光 ---
  const env = Object.assign({}, process.env, { FORCE_COLOR: '0' });
  const heap = p.heapMB || lim.nodeHeapMB;
  if (lim.enabled && heap && !/max-old-space-size/.test(env.NODE_OPTIONS || '')) {
    env.NODE_OPTIONS = ((env.NODE_OPTIONS || '') + ` --max-old-space-size=${heap}`).trim();
  }

  const child = spawn(SHELL, ['-lc', p.cmd], {
    cwd: p.cwd,
    detached: true,                  // 自成进程组，信号能覆盖整棵子进程树
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
  if (!st || !st.pid) throw new Error('这个项目当前没在运行');
  return { pid: st.pid, pgid: st.pgid };
}

function stopTarget(body) {
  const { pid, pgid } = resolveTarget(body);
  signalGroup(pgid, 'SIGCONT');            // 先解冻，否则被冻住的进程收不到 TERM
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
  await new Promise((r) => setTimeout(r, 500));   // 给端口一点释放时间
  return startProject(id);
}

// ---------------------------------------------------------------- 内存看门狗

function watchdog() {
  const lim = getCfg().limits;
  if (!lim.enabled) return;

  const reg = getReg();
  const { byPid, rssByPgid } = processTable();
  const running = [];

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

  // 1) 单项目硬上限 → 直接强杀
  for (const r of running) {
    if (r.rss > lim.hardRssMB) {
      signalGroup(r.pgid, 'SIGKILL');
      delete managed[r.id]; saveManaged();
      alert_('danger', `「${r.name}」吃到 ${fmtMB(r.rss)}，超过硬上限 ${fmtMB(lim.hardRssMB)}，已强制停止。`, r.id, 'hard:' + r.id);
    }
  }

  // 2) 单项目软上限 → 冻结（保留现场，你可以先看日志再决定）
  for (const r of running) {
    if (!r.paused && r.rss > r.limit && r.rss <= lim.hardRssMB) {
      signalGroup(r.pgid, 'SIGSTOP');
      alert_('danger', `「${r.name}」内存到了 ${fmtMB(r.rss)}，超过限额 ${fmtMB(r.limit)}，已自动冻结。进程还在，看完日志可以「恢复」或「停止」。`, r.id, 'soft:' + r.id);
    }
  }

  // 3) 系统水位 → 冻结当前最占内存的那个（只动 PortDash 自己起的，别人的只提醒）
  const sm = sysMem();
  if (!sm) return;
  const low = sm.availPct < lim.sysAvailFloorPct;
  const swapping = sm.swapUsedMB > lim.sysSwapCeilMB;
  if (!low && !swapping) return;

  const victim = running.filter((r) => !r.paused).sort((a, b) => b.rss - a.rss)[0];
  const why = low ? `系统可用内存只剩 ${sm.availPct}%` : `swap 已用 ${fmtMB(sm.swapUsedMB)}`;
  if (victim) {
    signalGroup(victim.pgid, 'SIGSTOP');
    alert_('danger', `${why}，已冻结当前最占内存的「${victim.name}」（${fmtMB(victim.rss)}）来保住系统。`, victim.id, 'sys:' + victim.id);
  } else {
    alert_('warn', `${why}，但占内存的不是 PortDash 启动的进程，需要你自己处理。`, null, 'sys:none');
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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    if (u.pathname === '/') {
      const b = Buffer.from(HTML);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': b.length });
      return res.end(b);
    }
    if (u.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (u.pathname === '/api/state') return json(res, 200, buildState());

    if (u.pathname === '/api/logs') {
      const f = path.join(D_LOGS, path.basename(String(u.searchParams.get('id'))) + '.log');
      let text = '（还没有日志。日志只在通过 PortDash 启动时才会记录。）';
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
        if (!p) throw new Error('项目不存在');
        if (typeof body.name === 'string' && body.name.trim()) p.name = body.name.trim();
        if (typeof body.cmd === 'string') p.cmd = body.cmd.trim();
        p.port = body.port ? parseInt(body.port, 10) : null;
        p.memMB = body.memMB ? parseInt(body.memMB, 10) : null;
        p.heapMB = body.heapMB ? parseInt(body.heapMB, 10) : null;
        setReg(reg);
        return json(res, 200, { ok: true });
      }
      if (u.pathname === '/api/register') {
        if (!body.cwd) throw new Error('拿不到这个进程的工作目录，没法登记');
        const reg = getReg();
        if (reg.some((x) => x.cwd === body.cwd)) throw new Error('这个目录已经登记过了');
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

// ---------------------------------------------------------------- 前端

const HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PortDash</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--line:#e4e7ec;--tx:#1a1d21;--dim:#6b7280;
  --run:#10b981;--pause:#f59e0b;--stop:#9ca3af;--accent:#2563eb;--danger:#dc2626}
@media (prefers-color-scheme:dark){:root{--bg:#15171a;--card:#1d2024;--line:#2c3036;--tx:#e8eaed;--dim:#9aa1ab}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--tx);
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
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
    <span class="sub" id="stat">加载中…</span>
    <span class="spacer"></span>
    <span class="sub" id="sys"></span>
    <button onclick="scan()">重新扫描</button>
  </header>
  <div id="alerts"></div>
  <h2>我的项目</h2>
  <div id="projects"></div>
  <h2>其他占用端口的进程</h2>
  <div id="others"></div>
</div>

<dialog id="edit">
  <div style="font-weight:600;margin-bottom:4px">编辑项目</div>
  <div class="sub" id="e_cwd" style="font-size:12px"></div>
  <label>名称</label><input id="e_name">
  <label>启动命令（在项目目录下执行）</label><input id="e_cmd" placeholder="npm run dev">
  <div class="two">
    <div><label>默认端口</label><input id="e_port" placeholder="可选"></div>
    <div><label>内存上限 MB（超了自动冻结）</label><input id="e_mem" placeholder="留空用默认"></div>
    <div><label>Node 堆上限 MB</label><input id="e_heap" placeholder="留空用默认"></div>
  </div>
  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
    <button onclick="edit.close()">取消</button>
    <button class="p" onclick="saveEdit()">保存</button>
  </div>
</dialog>

<dialog id="logs">
  <div style="display:flex;align-items:center;margin-bottom:10px">
    <div style="font-weight:600" id="l_title">日志</div><span class="spacer"></span>
    <button onclick="logs.close()">关闭</button>
  </div>
  <pre id="l_body"></pre>
</dialog>

<script>
const STATE={byId:{}};
let editingId=null, logId=null;

function toast(m){
  document.querySelectorAll('.err').forEach(e=>e.remove());
  const d=document.createElement('div'); d.className='err'; d.textContent=m;
  document.body.appendChild(d); setTimeout(()=>d.remove(),5000);
}
async function api(p,b){
  const r=await fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})});
  const j=await r.json().catch(()=>({}));
  if(!r.ok){ toast(j.error||'操作失败'); throw new Error(j.error); }
  return j;
}
const esc=s=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const gb=mb=>mb>=1024?(mb/1024).toFixed(1)+'G':mb+'M';

async function act(p,b){ await api(p,b); setTimeout(load,350); }
async function scan(){ const r=await api('/api/scan'); toast('扫描完成，新增 '+r.added+' 个项目'); load(); }
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
  logId=p.id; l_title.textContent='日志 · '+p.name; l_body.textContent='读取中…'; logs.showModal();
  l_body.textContent=await (await fetch('/api/logs?id='+encodeURIComponent(p.id))).text();
  l_body.scrollTop=l_body.scrollHeight;
}
async function remove(p){
  if(!confirm('把「'+p.name+'」从登记表里删掉？（不会动你的项目文件）'))return;
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
  const label={running:'运行中',paused:'已冻结',stopped:'未运行'}[p.status];
  const ports=p.ports.map(x=>'<span class="tag port">:'+x+'</span>').join('');
  let acts='';
  if(p.status==='stopped') acts=btn('start',p.id,'启动','p');
  else if(p.status==='running')
    acts=(p.openPort?'<button data-act="open" data-port="'+p.openPort+'">打开</button>':'')
        +btn('pause',p.id,'暂停')+btn('restart',p.id,'重启')+btn('stop',p.id,'停止','d');
  else acts=btn('resume',p.id,'恢复','p')+btn('stop',p.id,'停止','d');
  acts+=btn('logs',p.id,'日志')+btn('edit',p.id,'编辑')+btn('remove',p.id,'×','d');
  const badge=p.source==='external'?'<span class="tag">外部启动</span>':'';
  const cmdTxt=p.cmd?esc(p.cmd):'<span style="color:var(--pause)">未配置启动命令</span>';
  const hot=(p.rssMB&&p.memLimit&&p.rssMB/p.memLimit>=.6)?' hot':'';
  return '<div class="row'+hot+'"><span class="dot '+p.status+'"></span><div class="main">'
    +'<div class="nm">'+esc(p.name)+ports+memTag(p.rssMB,p.memLimit)+badge+'</div>'
    +'<div class="meta">'+esc(p.cwdShort)+'  ·  '+cmdTxt
    +(p.etime?'  ·  '+label+' '+esc(p.etime):'')+'</div></div>'
    +'<div class="acts">'+acts+'</div></div>';
}

function otherRow(o){
  let acts='<button data-act="open" data-port="'+o.port+'">打开</button>'
    +'<button data-act="'+(o.paused?'resume':'pause')+'" data-pid="'+o.pid+'">'+(o.paused?'恢复':'暂停')+'</button>'
    +'<button class="d" data-act="stop" data-pid="'+o.pid+'">停止</button>';
  if(o.cwd) acts+='<button data-act="register" data-cwd="'+esc(o.cwd)+'" data-port="'+o.port+'">登记</button>';
  return '<div class="row"><span class="dot '+(o.paused?'paused':'running')+'"></span><div class="main">'
    +'<div class="nm">'+esc(o.command)+'<span class="tag port">:'+o.port+'</span>'
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
  let s; try{ s=await (await fetch('/api/state')).json(); }catch(e){ return; }
  STATE.byId={}; s.projects.forEach(p=>STATE.byId[p.id]=p);

  const run=s.projects.filter(p=>p.status==='running').length;
  const pau=s.projects.filter(p=>p.status==='paused').length;
  stat.textContent=s.projects.length+' 个项目 · '+run+' 个运行中'
    +(pau?' · '+pau+' 个已冻结':'')+' · 另有 '+s.others.length+' 个端口被占用';

  if(s.sys){
    const c=s.sys.availPct<20?'var(--danger)':s.sys.availPct<35?'var(--pause)':'var(--dim)';
    sys.innerHTML='<span style="color:'+c+'">内存可用 '+s.sys.availPct+'%</span>'
      +(s.sys.swapUsedMB>512?' · swap '+gb(s.sys.swapUsedMB):'');
  }

  alerts.innerHTML=(s.alerts||[]).map(a=>'<div class="alert '+a.level+'"><div>'+esc(a.text)+'</div>'
    +'<button class="x" data-act="dismiss" data-alert="'+a.id+'">×</button></div>').join('');

  const ord={running:0,paused:1,stopped:2};
  projects.innerHTML = s.projects.length
    ? s.projects.slice().sort((a,b)=>ord[a.status]-ord[b.status]||a.name.localeCompare(b.name))
        .map(projectRow).join('')
    : '<div class="empty">还没有登记任何项目。点右上角「重新扫描」，或改 ~/.portdash/config.json 里的 scanRoots。</div>';
  others.innerHTML = s.others.length ? s.others.map(otherRow).join('')
    : '<div class="empty">没有其他进程在监听端口。</div>';
  if(logs.open&&logId) l_body.textContent=await (await fetch('/api/logs?id='+encodeURIComponent(logId))).text();
}
load(); setInterval(load,2500);
</script></body></html>`;

// ---------------------------------------------------------------- 启动

ensure();
if (!fs.existsSync(F_CFG)) writeJSON(F_CFG, DEFAULT_CFG);
if (!fs.existsSync(F_REG)) console.log(`首次运行：扫描到 ${scanProjects().added} 个项目`);

const cfg0 = getCfg();
setInterval(watchdog, 2000);   // 2 秒一轮：太慢的话失控进程能在两次检查之间多吃好几个 G

server.listen(cfg0.uiPort, '127.0.0.1', () => {
  const sm = sysMem();
  console.log(`\n  PortDash → http://localhost:${cfg0.uiPort}\n`);
  console.log(`  内存保护: ${cfg0.limits.enabled ? '开' : '关'}` +
    (cfg0.limits.enabled
      ? `（单项目 ${cfg0.limits.projectRssMB}M 冻结 / ${cfg0.limits.hardRssMB}M 强杀，node 堆 ${cfg0.limits.nodeHeapMB}M）`
      : ''));
  if (sm) console.log(`  当前系统: 可用 ${sm.availPct}% / 共 ${(sm.totalMB / 1024).toFixed(0)}G，swap 已用 ${sm.swapUsedMB}M`);
  console.log(`  配置: ${F_CFG}`);
  console.log(`  按 Ctrl+C 退出（不会影响已启动的服务）\n`);
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`端口 ${cfg0.uiPort} 被占用了。改 ${F_CFG} 里的 uiPort 换一个。`);
    process.exit(1);
  }
  throw e;
});
