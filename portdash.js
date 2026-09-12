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

// If PortDash's own directory is registered as a project, that row is PortDash itself.
// Matching it by working directory the way external servers are matched doesn't work:
// under launchd our cwd is "/", not wherever the script lives.
const SELF_DIR = path.dirname(__filename);

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
    sysSwapCeilMB: 4096,       // swap this high *while memory is also tight* counts as thrashing
    minVictimMB: 1024,         // never freeze something smaller than this for system pressure — it wouldn't help
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

/** Write through a temp file and rename, which is atomic on the same filesystem.
    writeFileSync truncates first, so being interrupted mid-write would leave a partial
    file — and readJSON falls back to a default on parse errors, meaning a crash at the
    wrong moment would silently discard the whole project registry. */
function writeJSON(file, data) {
  ensure();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing useful to do */ }
    throw e;
  }
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

function run(cmd, args, opts) {
  try {
    return execFileSync(cmd, args, Object.assign({
      encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 8000,
      stdio: ['ignore', 'pipe', 'ignore']
    }, opts || {}));
  } catch (e) {
    return (e && e.stdout) ? e.stdout : '';
  }
}

// ---------------------------------------------------------------- environment
//
// Started from a terminal, PortDash inherits whatever that terminal had, and every dev
// server it launches works. Started at login by launchd (or systemd), it gets a bare
// PATH of /usr/bin:/bin:/usr/sbin:/sbin — and then `npm run dev` fails with "command
// not found" for anyone whose node lives in nvm, Homebrew, Volta, asdf or fnm, which is
// almost everyone. The tools are installed; this process just can't see them.
//
// So don't guess where anything lives: ask the user's own shell what it sees, once, at
// startup. It answers correctly whatever the machine is set up like. Everything below
// this point is fallback for when it doesn't answer — a shell we don't recognise, a
// startup file that errors out, a config that hangs. Each layer is worse than the one
// above but better than nothing, and the last one is exactly today's behaviour, so this
// can degrade all the way down without making anything worse than it already is.

const ENV_MARK = '__PORTDASH_ENV__';

/** Environment variables the shell reports about *its own* run, which would be wrong or
    meaningless for a service started later from a different directory. */
const ENV_DROP = ['PWD', 'OLDPWD', 'SHLVL', '_', 'ENV_MARK'];

/** Directories where the popular version managers and package managers put their
    binaries. Only used when a shell can't be read — a rough map of where things usually
    are, for machines whose shell config is broken or unusual. */
function knownToolDirs() {
  const dirs = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',      // Homebrew, Apple silicon
    '/usr/local/bin', '/usr/local/sbin',            // Homebrew on Intel, and manual installs
    '/opt/local/bin',                               // MacPorts
    path.join(HOME, '.local', 'bin'),
    path.join(HOME, '.volta', 'bin'),
    path.join(HOME, '.bun', 'bin'),
    path.join(HOME, '.deno', 'bin'),
    path.join(HOME, '.cargo', 'bin'),
    path.join(HOME, '.asdf', 'shims'),
    path.join(HOME, '.pyenv', 'shims'),
    path.join(HOME, '.rbenv', 'shims')
  ];
  // nvm and fnm keep one directory per installed version; take the newest.
  for (const base of [path.join(HOME, '.nvm', 'versions', 'node'),
                      path.join(HOME, 'Library', 'Application Support', 'fnm', 'node-versions')]) {
    try {
      const vs = fs.readdirSync(base).filter((v) => /^v\d/.test(v))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (vs.length) {
        const bin = path.join(base, vs[vs.length - 1], 'bin');
        // fnm nests one level deeper than nvm does
        dirs.unshift(fs.existsSync(bin) ? bin : path.join(base, vs[vs.length - 1], 'installation', 'bin'));
      }
    } catch (e) { /* not installed */ }
  }
  return dirs.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } });
}

/** Find an executable on a PATH without spawning anything. */
function whichIn(env, cmd) {
  for (const dir of String((env && env.PATH) || '').split(':')) {
    if (!dir) continue;
    const f = path.join(dir, cmd);
    try {
      const st = fs.statSync(f);
      if (st.isFile() && (st.mode & 0o111)) return f;
    } catch (e) { /* next */ }
  }
  return null;
}

/** Append the known directories to a PATH, without disturbing the order of what's
    already there — the user's own choice of node version has to keep winning. */
function withKnownDirs(env) {
  const have = String(env.PATH || '').split(':');
  const extra = knownToolDirs().filter((d) => !have.includes(d));
  if (!extra.length) return env;
  return Object.assign({}, env, { PATH: have.concat(extra).filter(Boolean).join(':') });
}

/**
 * Ask one shell to print its environment.
 *
 * -i matters as much as -l: a login shell reads .zprofile/.zshenv, but nvm, pyenv, asdf
 * and friends install themselves into .zshrc, which is only read by an *interactive*
 * shell. Reading just the login files is how this problem hides — the shell starts fine
 * and reports a PATH, it's simply missing everything the user actually installed.
 *
 * The flags are passed separately rather than bundled as "-ilc" because not every shell
 * parses a bundle. The output is fenced between markers so that a startup file printing
 * a banner, a version notice or a prompt can't be mistaken for an environment variable.
 */
function envFromShell(shellPath) {
  if (!shellPath) return null;
  try { if (!fs.statSync(shellPath).isFile()) return null; } catch (e) { return null; }
  const out = run(shellPath, ['-i', '-l', '-c', `echo ${ENV_MARK}; /usr/bin/env; echo ${ENV_MARK}`],
                  { timeout: 5000 });
  const i = out.indexOf(ENV_MARK), j = out.lastIndexOf(ENV_MARK);
  if (i < 0 || j <= i) return null;

  const env = {};
  let key = null;
  for (const line of out.slice(i + ENV_MARK.length, j).split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (m) { key = m[1]; env[key] = m[2]; }
    else if (key) env[key] += '\n' + line;     // a variable whose value spans lines
  }
  if (!env.PATH) return null;
  for (const k of ENV_DROP) delete env[k];
  return env;
}

/** Work down the layers until something usable comes back. Never throws: the worst case
    returns what this process already had, which is what PortDash used before any of
    this existed. */
function resolveEnv() {
  const t0 = Date.now();
  const done = (env, via, shell) => ({ env, via, shell: shell || null, ms: Date.now() - t0,
                                       hasNode: !!whichIn(env, 'node') });

  const shells = [process.env.SHELL, IS_MAC ? '/bin/zsh' : '/bin/bash', '/bin/bash', '/bin/sh']
    .filter((s, i, a) => s && a.indexOf(s) === i);

  for (const sh of shells) {
    const env = envFromShell(sh);
    if (!env) continue;
    // A shell answered, but its PATH has no node on it — a half-broken startup file, or
    // a version manager that only activates for a real terminal. Top it up rather than
    // handing back an environment that is going to fail at the first Start.
    if (!whichIn(env, 'node')) {
      const topped = withKnownDirs(env);
      if (whichIn(topped, 'node')) return done(topped, 'shell+known', sh);
    }
    return done(env, 'shell', sh);
  }

  const patched = withKnownDirs(Object.assign({}, process.env));
  if (patched.PATH !== process.env.PATH) return done(patched, 'known');
  return done(Object.assign({}, process.env), 'inherited');
}

let shellEnv = null;
const getEnv = () => (shellEnv || (shellEnv = resolveEnv()));
const refreshEnv = () => (shellEnv = resolveEnv());

function envSummary(e) {
  const how = { shell: `read from ${path.basename(e.shell || 'shell')}`,
                'shell+known': `read from ${path.basename(e.shell || 'shell')}, topped up with the usual install locations`,
                known: 'guessed from the usual install locations (no shell would answer)',
                inherited: 'inherited from whatever launched PortDash (no shell would answer)' }[e.via];
  return `Environment: ${how} in ${e.ms}ms — node ${e.hasNode ? 'found' : 'NOT found'}`;
}

/** The tools a dev server is usually started by. Reported whether or not they're
    present: "python3 missing" is only alarming if you have a Python project, and the
    person reading this knows which they have and PortDash doesn't. */
const DOCTOR_TOOLS = ['node', 'npm', 'pnpm', 'yarn', 'bun', 'python3', 'git'];

/** One screen that answers "what can PortDash actually see?" — so a bug report is a
    screenshot instead of twenty questions. */
function doctor() {
  const e = getEnv();
  const tools = DOCTOR_TOOLS.map((name) => {
    const bin = whichIn(e.env, name);
    let version = null;
    if (bin) {
      // Every tool answers --version in its own format ("v24.13.0", "Python 3.9.6",
      // "git version 2.50.1 (Apple Git-155)") — pull out the number and drop the prose.
      // Generous timeout: npm's first run on a cold cache can take seconds, and a blank
      // version next to a tool that is plainly installed reads like a bug.
      const raw = run(bin, ['--version'], { timeout: 6000, env: e.env }).trim().split('\n')[0] || '';
      const m = /\d+\.\d+[\w.+-]*/.exec(raw);
      version = m ? m[0] : (raw.slice(0, 40) || null);
    }
    return { name, found: !!bin, path: bin, version };
  });
  return {
    ok: e.hasNode,
    via: e.via,
    shell: e.shell,
    ms: e.ms,
    summary: envSummary(e),
    path: String(e.env.PATH || '').split(':').filter(Boolean),
    tools,
    // Worth saying before anything breaks: a project tree inside a sync folder produces
    // read errors that look like random build failures, and nobody connects the two.
    roots: getCfg().scanRoots.map(expand).map((r) => ({ root: shorten(r), synced: syncedFolder(r) })),
    portdash: {
      version: readJSON(path.join(__dirname, 'package.json'), {}).version || 'unknown',
      script: __filename,
      uiPort: getCfg().uiPort,
      agentInstalled: fs.existsSync(F_PLIST),
      // ppid 1 means whatever started us has already exited or handed us to the init
      // process — in practice, launchd at login rather than a terminal.
      startedBy: process.ppid === 1 ? 'login agent / background' : 'terminal',
      platform: `${process.platform} ${os.release()}`,
      node: process.version
    }
  };
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
function alert_(level, text, projectId, key, action) {
  const k = key || (level + ':' + text);
  const now = Date.now();
  if (alertSeen[k] && now - alertSeen[k] < 60000) return;
  alertSeen[k] = now;
  alerts.unshift({ id: crypto.randomBytes(4).toString('hex'), t: now, level, text, projectId, action });
  alerts = alerts.slice(0, 20);
  logLine(`[${level === 'danger' ? 'action' : 'notice'}] ${text}`);
  if (projectId) {
    try {
      fs.appendFileSync(path.join(D_LOGS, projectId + '.log'),
        `\n***** ${new Date().toLocaleString()}  PortDash: ${text} *****\n`);
    } catch (e) { /* ignore */ }
  }
}

// ---------------------------------------------------------------- start failures
//
// What a dev server prints when it dies on the first second is written for whoever wrote
// it, not for whoever is trying to use it. "zsh:1: command not found: npm" is a complete
// explanation if you already know what a PATH is, and a dead end if you don't. Match the
// handful of ways a start actually fails and say what to do about each; anything that
// doesn't match falls through to the raw output, which is still better than silence.

/** Name the cloud-sync folder a path sits inside, or null. ~/Desktop and ~/Documents
    only count when macOS is actually syncing them, which this directory reveals. */
function syncedFolder(cwd) {
  if (!cwd) return null;
  const icloudDesktop = fs.existsSync(path.join(HOME, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Desktop'));
  const roots = [
    [path.join(HOME, 'Library', 'Mobile Documents'), 'iCloud Drive'],
    [path.join(HOME, 'Dropbox'), 'Dropbox'],
    [path.join(HOME, 'OneDrive'), 'OneDrive'],
    [path.join(HOME, 'Google Drive'), 'Google Drive'],
    [path.join(HOME, 'Library', 'CloudStorage'), 'a cloud drive']
  ];
  if (icloudDesktop) {
    roots.push([path.join(HOME, 'Documents'), 'iCloud Drive (your synced Documents folder)']);
    roots.push([path.join(HOME, 'Desktop'), 'iCloud Drive (your synced Desktop folder)']);
  }
  for (const [dir, label] of roots) if (cwd === dir || cwd.startsWith(dir + path.sep)) return label;
  return null;
}

/** The last non-empty line, which is where a failing command puts its complaint. */
function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\[[0-9;]*m/g, '').trim());
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i] && !lines[i].startsWith('=====')) return lines[i];
  return '';
}

/** Which command a shell is complaining about. Every shell words this differently and
    puts its own name in the line, so match each shape separately rather than with one
    alternation — a combined pattern happily reports "zsh:1" as the missing command.
      zsh   zsh:1: command not found: vite
      bash  bash: line 1: vite: command not found
      dash  sh: 1: vite: not found            */
function missingCommand(t) {
  const pats = [/command not found:\s*(\S+)/i, /([^\s:]+):\s*command not found/i, /([^\s:]+):\s*not found/i];
  for (const re of pats) {
    const m = re.exec(t);
    if (m && m[1]) return m[1].replace(/[.,:;'"]+$/, '');
  }
  return null;
}

function diagnose(output, code, project) {
  const t = String(output || '');
  const name = project ? project.name : 'The service';

  const nf = missingCommand(t);
  if (nf || code === 127) {
    const cmd = nf || (project && project.cmd || '').split(/\s+/)[0] || 'that command';
    return {
      text: `"${name}" couldn't start: ${cmd} isn't on the PATH PortDash is using. That usually means PortDash was launched at login and can't see the tools your terminal can. Recheck the environment, then start it again.`,
      action: { act: 'recheck-env', label: 'Recheck environment' }
    };
  }
  if (/EADDRINUSE|address already in use|port .*already in use/i.test(t)) {
    // Only look on the line that complains. A stack trace is full of file:line numbers
    // that look exactly like ports, and the first one wins if you scan the whole output.
    const line = t.split('\n').find((l) => /EADDRINUSE|already in use/i.test(l)) || '';
    const port = (/(?::|\bport\s+)(\d{2,5})(?!\d)/i.exec(line) || [])[1] || (project && project.port) || null;
    return { text: `"${name}" couldn't start: port ${port || 'it wants'} is already taken. Look under "Other processes on listening ports" below for what's on it, and stop that first.` };
  }
  // A read the filesystem refused rather than a program that failed. Almost always a
  // project living in an iCloud/Dropbox/OneDrive folder: a bundler opens hundreds of
  // files at once, the sync daemon owns them, and the kernel gives up on the pile-up.
  // Nothing is broken, and trying again often works — which is exactly why it reads as
  // a random, unattributable failure until someone names the cause.
  if (/resource deadlock avoided|Unknown system error -11|EDEADLK|Resource temporarily unavailable/i.test(t)) {
    const where = project && syncedFolder(project.cwd);
    return { text: `"${name}" couldn't start: the filesystem refused a read ("resource deadlock avoided"). `
      + (where ? `This project is inside ${where}, and a folder that syncs to the cloud can't keep up with the thousands of files a build reads at once. Moving the project outside it fixes this for good. `
               : `This usually happens when a project sits in a cloud-synced folder (iCloud Drive, Dropbox, OneDrive). `)
      + `It's intermittent — starting it again will often just work.` };
  }
  // Match on whole words: "node_modules" followed loosely by "not" also matches the
  // "not" inside "Cannot", which turns any error mentioning a path under node_modules
  // into a confident, wrong "your dependencies aren't installed".
  if (/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Cannot find module|Cannot find package|node_modules[^\n]*\bnot found\b/i.test(t)) {
    return { text: `"${name}" couldn't start: its dependencies aren't installed. Open a terminal in the project folder and run the install command for it (npm install, pnpm install, yarn) once, then try again.` };
  }
  if (/Missing script|npm ERR! Missing script|Unknown command|command ".*" not found/i.test(t)) {
    return { text: `"${name}" couldn't start: "${(project && project.cmd) || 'the start command'}" isn't something this project knows how to run. Click "Edit" and set the command you'd type yourself.` };
  }
  if (/no such file or directory|ENOENT/i.test(t)) {
    return { text: `"${name}" couldn't start: something it needs isn't where it expected. Check "Logs" for the full output — the missing path is named there.` };
  }
  const tail = lastLine(t);
  return { text: `"${name}" started and exited immediately${code === null || code === undefined ? '' : ` (exit code ${code})`}.` + (tail ? ` It said: ${tail.slice(0, 200)}` : ' It printed nothing — check "Logs".') };
}

/** Read what was appended to a log after `from`, capped at `max` bytes.
    Diagnosing from the tail of the whole file instead would read whatever the *previous*
    run left there — a start that fails on a busy port gets reported as the missing
    command from an hour ago, which is worse than saying nothing. */
function logSlice(file, from, max) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.min(Math.max(from, 0), size);
    const len = Math.min(size - start, max);
    if (len <= 0) return '';
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (e) { return ''; }
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
    return { name: path.basename(dir), cmd: staticCmd(8000), kind: 'static', weak: true };
  }
  return null;
}

const staticCmd = (port) => `python3 -m http.server ${port}`;

/** A port at or above 8000 that nothing in the registry has claimed, either as its
    recorded port or as one baked into its start command.

    Scanning recognises every static site by the same rule and so generates the same
    command for all of them. On a machine with ten of them that means ten projects that
    cannot run at the same time, failing with EADDRINUSE on a command the person never
    chose and has no reason to suspect. */
function freeStaticPort(reg) {
  const taken = new Set();
  for (const p of reg) {
    if (p.port) taken.add(+p.port);
    const m = /\bhttp\.server\s+(\d+)/.exec(p.cmd || '');
    if (m) taken.add(+m[1]);
  }
  let n = 8000;
  while (taken.has(n)) n++;
  return n;
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

  // Entries written by an earlier scan all carry the same static command. Repair the
  // ones that are still exactly as generated — no recorded port, and a command nobody
  // has touched — because that is PortDash's own bad guess rather than anyone's choice.
  // Anything edited is left alone, which is the same promise the loop below keeps.
  // Two passes. Clearing each stale command only as its own entry is repaired leaves it
  // claimed by all the entries after it, so 8000 stays occupied until the last one —
  // and the port everybody expects ends up on whichever project happens to be last.
  const stale = reg.filter((p) => p.kind === 'static' && !p.port && p.cmd === staticCmd(8000));
  for (const p of stale) p.cmd = '';
  for (const p of stale) { p.port = freeStaticPort(reg); p.cmd = staticCmd(p.port); }
  const repaired = stale.length;

  let added = 0;
  for (const f of found) {
    if (known.has(f.cwd)) continue;        // never overwrite an already-registered project (keeps your edits)
    const port = f.kind === 'static' ? freeStaticPort(reg) : null;
    reg.push({ id: idOf(f.cwd), name: f.name, cwd: f.cwd,
               cmd: port ? staticCmd(port) : f.cmd, kind: f.kind,
               port, memMB: null, heapMB: null, pinned: false });
    added++;
  }
  setReg(reg);
  return { total: reg.length, added, repaired };
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

/** One pass over the whole process table: pid → info, and pgid → total RSS (MB).
    ppid is here for ownership: walking up from a listening process is the only way to
    answer "who started this", and it costs nothing on a pass we already make. */
function processTable() {
  const out = run('ps', ['-Ao', 'pid=,ppid=,pgid=,rss=,stat=,etime=,command=']);
  const byPid = {}, rssByPgid = {};
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], pgid = +m[3], rssMB = +m[4] / 1024;
    byPid[pid] = { pid, ppid, pgid, rssMB, stat: m[5], etime: m[6], command: m[7] };
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

// ---------------------------------------------------------------- other instances
//
// A second PortDash on one machine is not hypothetical: a test run with an isolated
// HOME, a copy started from a terminal that outlived the terminal, an npx invocation
// nobody stopped. Each process only ever recognises *itself* (SELF_DIR), so a sibling
// shows up under "Other processes on listening ports" as an anonymous node row that
// looks exactly like a dev server — which is how one goes unnoticed for days.
//
// Two of them sharing one ~/.portdash is the case that does damage: each holds the
// managed registry in memory from its own startup and writes the whole object back,
// so whichever saves last drops the other's records — and a service with no record
// left has no memory limit any more. Two watchdogs also decide independently what to
// freeze. So the older process keeps the watchdog and the younger stands down:
// comparing elapsed time needs no lock file, and both sides reach the same answer.
//
// A sibling with its own HOME can't corrupt anything, but it is still running ps and
// vm_stat every two seconds to supervise nothing, so it gets said out loud once.

/** Is this command line a running PortDash? Matched on the script the interpreter was
    given rather than on the whole line — "vim portdash.js" is not another instance. */
function isPortdash(cmdline) {
  const parts = String(cmdline || '').trim().split(/\s+/);
  if (!/(^|\/)node$/.test(parts[0] || '')) return false;
  const script = parts.slice(1).find((a) => a[0] !== '-');
  return !!script && /(^|\/)portdash\.js$/.test(script);
}

/** Which ~/.portdash a process is using — the only thing that decides whether a sibling
    is dangerous or merely wasteful. An unreadable environment (another user, or ps
    declining) counts as "not ours": standing down on a guess would silently drop the
    memory protection this program exists to provide. */
const rootSeen = {};
function rootOf(pid) {
  if (!(pid in rootSeen)) {
    const m = /(?:^|\s)HOME=(\S+)/.exec(run('ps', ['eww', '-p', String(pid)]));
    rootSeen[pid] = m ? path.join(m[1], '.portdash') : null;
  }
  return rootSeen[pid];
}

function otherInstances(byPid) {
  for (const k of Object.keys(rootSeen)) if (!byPid[k]) delete rootSeen[k];   // pids get reused
  const out = [];
  for (const info of Object.values(byPid)) {
    if (info.pid === process.pid || !isPortdash(info.command)) continue;
    out.push({ pid: info.pid, etime: info.etime, root: rootOf(info.pid) });
  }
  return out;
}

const sibSaid = new Set();          // once per process, not once a minute forever

/** The instance that should be supervising instead of this one, if any. Siblings that
    can't interfere are reported here too, since this is the one place that sees them. */
function supersededBy(byPid) {
  const mine = process.uptime();
  for (const s of otherInstances(byPid)) {
    if (s.root !== ROOT) {
      if (!sibSaid.has(s.pid)) {
        sibSaid.add(s.pid);
        alert_('warn', `Another PortDash is running (pid ${s.pid}), with its own settings under ${s.root ? shorten(s.root) : 'a home directory this one can\'t read'}. It can't see your projects and isn't supervising anything, but it still scans this machine every two seconds. It's listed below under "Other processes" — stop it there.`,
               null, 'sib:' + s.pid);
      }
      continue;
    }
    const theirs = etimeToSec(s.etime);
    if (theirs === null) continue;
    // Older wins. Ages within a couple of seconds of each other — both just started —
    // fall back to the lower pid, so the two never both stand down.
    if (theirs > mine + 2 || (Math.abs(theirs - mine) <= 2 && s.pid < process.pid)) return s;
  }
  return null;
}

// ---------------------------------------------------------------- ownership
//
// A Stop that doesn't stick is the most confusing thing a control panel can do, and it
// is the normal outcome for anything launchd supervises: postgres is back a second
// later and it looks like PortDash is broken. The dashboard has always known whether
// *it* started something; what it could never say is who started everything else, so
// every one of those rows was labelled "external" and left at that.
//
// Two cheap sources answer it properly. `launchctl list` maps pid to job label in
// about five milliseconds, which names the supervisor exactly — homebrew.mxcl.
// postgresql@16 — and therefore names the command that really stops it. For anything
// launchd doesn't claim, walking up ppid to the last ancestor before launchd names the
// terminal, editor or script the process was started from. What's left is genuinely
// detached: its parent is gone and nothing will bring it back.

/** pid → launchd job label, for jobs in this user's gui domain. Root daemons need a
    privileged launchctl and simply don't show up here, which is the right failure: this
    only claims launchd supervision when it can prove it. */
function launchdJobs() {
  const map = {};
  for (const line of run('launchctl', ['list']).split('\n')) {
    const t = line.split('\t');
    if (t.length < 3) continue;
    const pid = parseInt(t[0], 10);        // "-" for a job that isn't currently running
    if (pid) map[pid] = t[2].trim();
  }
  return map;
}

const INTERPRETER = /^(node|nodejs|python|python3|ruby|perl|sh|bash|zsh|fish|deno|bun)$/;

/** A name worth putting on a row. An app bundle is named by the bundle rather than by
    the Electron helper buried inside it, and an interpreter is named by the script it
    is running — "node" on its own tells you nothing about which node. */
function procName(cmdline) {
  const app = /\/([^/]+)\.app\//.exec(cmdline || '');
  if (app) return app[1];
  const parts = String(cmdline || '').trim().split(/\s+/);
  const exe = path.basename(parts[0] || '');
  if (INTERPRETER.test(exe)) {
    const script = parts.slice(1).find((a) => a[0] !== '-' && /\.\w+$/.test(a));
    if (script) return path.basename(script);
  }
  return exe || 'unknown';
}

/** Everything above this process up to launchd, nearest first. The seen set is for
    a ppid cycle, which shouldn't exist but would hang the dashboard if it did. */
function ancestors(pid, byPid) {
  const out = [], seen = new Set([pid]);
  let cur = byPid[pid];
  while (cur && cur.ppid > 1 && !seen.has(cur.ppid)) {
    seen.add(cur.ppid);
    const up = byPid[cur.ppid];
    if (!up) break;
    out.push(up);
    cur = up;
  }
  return out;
}

/** What actually stops a launchd job. Homebrew's wrapper is worth naming separately:
    it's the command a Homebrew user already has in their fingers, and unlike a bare
    bootout it also stops the job coming back at the next login. */
function stopCommand(label) {
  const brew = /^homebrew\.mxcl\.(.+)$/.exec(label);
  return brew ? `brew services stop ${brew[1]}` : `launchctl bootout gui/$(id -u)/${label}`;
}

/** Who is responsible for starting and stopping this process. */
function ownerOf(pid, byPid, jobs) {
  const up = ancestors(pid, byPid);
  for (const p of [pid].concat(up.map((x) => x.pid))) {
    // Checked before the job lookup, because PortDash is itself a launchd job when it
    // runs as a login agent: without this, anything it started walks up, matches our own
    // label, and the dashboard advises stopping PortDash to stop a dev server.
    if (p === process.pid) return { kind: 'portdash' };
    const label = jobs[p];
    if (!label) continue;
    // A GUI app is a launchd job too, but quitting the app is what stops it and it does
    // not come back on its own — "launchd will restart this" would be a lie. The same
    // branch covers a dev server started from an editor's built-in terminal, where the
    // app is the ancestor rather than the process itself.
    if (/^application\./.test(label)) return { kind: 'app', label: procName((byPid[p] || {}).command) };
    // Apple's own agents are listed like anything else and would otherwise be handed a
    // perfectly correct command for switching off part of the system until next login.
    return { kind: 'launchd', label, stop: stopCommand(label), system: /^com\.apple\./.test(label) };
  }
  const top = up[up.length - 1];
  if (top) return { kind: 'from', label: procName(top.command), pid: top.pid };
  return { kind: 'detached' };
}

// ---------------------------------------------------------------- sampling
//
// Everything the dashboard shows came from shelling out, synchronously, inside the
// request that asked for it: two lsof calls, a ps and a launchctl per /api/state, per
// open tab, every 2.5 seconds — while the watchdog independently ran its own ps and
// vm_stat every 2. The numbers are small (about 170ms of subprocesses per render) but
// the shape is wrong, and it's the shape that blocks what comes next: a health probe
// has to wait on a socket, and nothing that waits can happen inside a function whose
// result is a return value.
//
// So sample into a cache and read from it. Two tiers, because they have different
// customers. The process table and system memory are what the watchdog acts on, so
// they are taken fresh on every watchdog tick whether or not anyone is watching — a
// memory guard deciding from a stale reading is the one thing not worth saving a
// subprocess over. Listening ports, working directories and launchd jobs are only
// needed to draw a row, so they are taken on demand and reused briefly.
//
// Net effect while a dashboard is open: renders land shortly after a watchdog tick and
// reuse its process table instead of taking their own. Net effect with nothing open:
// exactly what it was before, which is the state this thing spends most of its life in.

const FRESH_MS = 1500;
let procSample = null, portSample = null;

/** Process table and system memory. Pass true when a stale answer would be wrong
    rather than merely late: the watchdog, and anything about to signal a pid. */
function procs(fresh) {
  if (!fresh && procSample && Date.now() - procSample.t < FRESH_MS) return procSample;
  const { byPid, rssByPgid } = processTable();
  return (procSample = { t: Date.now(), byPid, rssByPgid, sys: sysMem() });
}

/** Listening sockets, their working directories, and the launchd job table. Only ever
    needed to render, so nothing takes this on a timer. */
function ports(fresh) {
  if (!fresh && portSample && Date.now() - portSample.t < FRESH_MS) return portSample;
  const L = listeners();
  return (portSample = {
    t: Date.now(), L, jobs: launchdJobs(),
    C: cwdInfo([...new Set(L.map((r) => r.pid))])
  });
}

/** The samples describe a process table that no longer exists. */
function invalidate() { procSample = portSample = null; }

// ---------------------------------------------------------------- state aggregation

/** `fresh` forces both samples to be retaken. Rendering doesn't need it — a row that is
    up to a second and a half behind is invisible next to a 2.5s poll — but anything
    about to act on a pid does, which is why the callers that signal ask for it. */
function buildState(fresh) {
  const cfg = getCfg();
  const reg = getReg();
  const { byPid, rssByPgid, sys } = procs(fresh);
  const { L, C, jobs } = ports(fresh);

  if (pruneManaged(byPid)) saveManaged();

  const claimed = new Set();

  const projects = reg.map((p) => {
    let pid = null, source = null;
    if (p.cwd === SELF_DIR) { pid = process.pid; source = 'self'; }
    const m = managed[p.id];
    if (!pid && m && byPid[m.pid]) { pid = m.pid; source = 'managed'; }
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

    // "external" was only ever an admission that PortDash didn't know. Now that it can
    // find out, say which terminal, editor, script or launchd job it belongs to.
    const owner = source === 'self' ? { kind: 'self' }
                : source === 'managed' ? { kind: 'portdash' }
                : pid ? ownerOf(pid, byPid, jobs) : null;

    return Object.assign({}, p, {
      cwdShort: shorten(p.cwd), status, pid, pgid, ports, etime, source, rssMB, owner,
      pinned: !!p.pinned,
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
      const cwd = C[r.pid] || '';
      row = {
        pid: r.pid, pgid, ports: [],
        // procName rather than the basename of the first whitespace-separated token:
        // half of ~/Library/Application Support is one path with a space in it, and
        // splitting on whitespace names every one of those processes "Application".
        command: procName(info.command) || r.command,
        cmdline: info.command || '', etime: info.etime || '',
        rssMB: Math.round(rssByPgid[pgid] || info.rssMB || 0),
        cwd, cwdShort: cwd ? shorten(cwd) : '',
        registrable: registrable(cwd),
        owner: ownerOf(r.pid, byPid, jobs),
        // Without this a sibling is an anonymous "node" row, indistinguishable from a
        // dev server, and stopping the right one becomes guesswork.
        portdash: isPortdash(info.command),
        paused: !!(info.stat && info.stat.startsWith('T'))
      };
      otherByPgid.set(pgid, row);
    }
    if (!row.ports.includes(r.port)) row.ports.push(r.port);
  }
  const others = [...otherByPgid.values()]
    .map((o) => { o.ports.sort((a, b) => a - b); return o; })
    .sort((a, b) => a.ports[0] - b.ports[0]);

  return { projects, others, alerts, sys, limits: cfg.limits, now: Date.now() };
}

// ---------------------------------------------------------------- process control

function signalGroup(pgid, sig) {
  // kill(-0) and kill(0) both mean "everyone in *our* process group" — that would
  // signal PortDash itself and whatever shell launched it. Nothing below pid 2 is
  // ever a legitimate target either.
  if (!Number.isInteger(pgid) || pgid < 2) return false;
  // Whatever the samples say about this process group, it isn't true any more. Doing it
  // here rather than in each caller also covers the watchdog's own freezes and kills.
  const sent = () => { invalidate(); return true; };
  try { process.kill(-pgid, sig); return sent(); } catch (e) { /* fall through */ }
  try { process.kill(pgid, sig); return sent(); } catch (e) { return false; }
}

const isSelfProject = (id) => { const p = getReg().find((x) => x.id === id); return !!(p && p.cwd === SELF_DIR); };

/** PortDash can't be driven from its own dashboard. Stopping it hands control to whatever
    supervises it (launchd restarts it, a shell doesn't), and SIGSTOP would freeze the only
    process able to deliver the SIGCONT — the dashboard would be gone with no way back. */
function refuseSelf(st) {
  if (st && st.source === 'self') {
    throw new Error('That row is PortDash itself — start and stop it wherever it was launched from (launchctl, or the terminal you ran it in), not from here.');
  }
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
  refuseSelf({ source: p.cwd === SELF_DIR ? 'self' : null });
  if (!p.cmd) throw new Error('No start command configured for this project — click "Edit" and set one (e.g. npm run dev)');
  if (!fs.existsSync(p.cwd)) throw new Error('Directory does not exist: ' + p.cwd);

  // --- Guard against double-clicks: the UI only refreshes every 2.5s, so two quick clicks
  //     would otherwise really start two instances ---
  if (starting.has(id)) throw new Error('Already starting, hang on');

  // --- Re-check real state right before starting instead of trusting the cache ---
  const st = buildState(true);
  const cur = st.projects.find((x) => x.id === id);
  if (cur && cur.pid) throw new Error(`Already running (pid ${cur.pid}) — use "Restart" instead`);

  // --- Say who is on the port before letting it fail on the port ---
  // PortDash can't make a program listen somewhere else, but it does know what is
  // already there, and finding that out afterwards from an EADDRINUSE in a log is a
  // worse version of the same answer. The recorded port is a prediction, not a fact,
  // so the refusal has to say how to overrule it.
  if (p.port) {
    const other = st.projects.find((x) => x.id !== id && x.ports.includes(p.port));
    const proc = other ? null : st.others.find((o) => o.ports.includes(p.port));
    if (other || proc) {
      const who = other ? `"${other.name}"` : `${proc.command} (pid ${proc.pid})`;
      throw new Error(`Port ${p.port} is already taken by ${who}. Stop that first — or if "${p.name}" doesn't actually use port ${p.port}, clear its "Default port" under "Edit".`);
    }
  }

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
  // Where this run's output begins, so a failure is diagnosed from what *it* printed.
  let logFrom = 0;
  try { logFrom = fs.fstatSync(fd).size; } catch (e) { /* diagnose from the whole tail */ }

  // --- Run it in the environment the user's own terminal would give it, not the one
  //     launchd gave us (see resolveEnv) ---
  const env = Object.assign({}, getEnv().env, { FORCE_COLOR: '0' });
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
  // A start that fails does so within the first second, and until now it did it silently:
  // the row went back to "stopped" and the reason sat in a log file nobody thought to
  // open. Watch just long enough to catch that, and turn whatever it printed into an
  // alert. Anything still alive after this window is a real start and is left alone.
  child.on('exit', (code) => {
    if (Date.now() - now > 4000) return;
    const d = diagnose(logSlice(logFile, logFrom, 8192), code, p);
    if (managed[id] && managed[id].pid === child.pid) { delete managed[id]; saveManaged(); }
    alert_('danger', d.text, id, 'exit:' + id, d.action);
  });
  child.unref();                     // unref only stops the child holding the event loop
                                     // open; the exit listener above still fires
  fs.closeSync(fd);                  // the child holds its own dup; keeping ours leaks one fd per start

  starting.add(id);
  setTimeout(() => starting.delete(id), 3000);
  startLog[id].push(now);
  managed[id] = { pid: child.pid, pgid: child.pid, startedAt: now, cmd: p.cmd };
  saveManaged();
  invalidate();                      // there is a process now that wasn't there a moment ago
  return { pid: child.pid, heapLimitMB: lim.enabled ? heap : null };
}

function resolveTarget(body) {
  if (body.pid !== undefined && body.pid !== null && body.pid !== '') {
    const pid = Number(body.pid);
    if (!Number.isInteger(pid) || pid < 2) throw new Error(`Not a valid pid: ${body.pid}`);
    refuseSelf({ source: pid === process.pid ? 'self' : null });
    const t = procs(true).byPid[pid];
    return { pid, pgid: t ? t.pgid : pid };
  }
  // Fresh: the pid resolved here is about to be signalled, and a pid read from a sample
  // taken a second ago may belong to something else by now.
  const st = buildState(true).projects.find((p) => p.id === body.id);
  refuseSelf(st);
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
  const st = buildState(true).projects.find((p) => p.id === id);
  refuseSelf(st);
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
  // Always fresh: this is the reading the freeze and kill decisions are made from, and
  // it is also the sample a render landing in the next second and a half will reuse.
  const { byPid, rssByPgid, sys: sm } = procs(true);

  // Another PortDash that has been up longer and shares this ~/.portdash is already
  // doing this work. Freezing and killing from both would be bad enough; both writing
  // state.json from their own startup snapshot is worse, because the loser's services
  // quietly lose their memory limit. Serve the dashboard, leave the supervising alone.
  const boss = supersededBy(byPid);
  if (boss) {
    if (!sibSaid.has(boss.pid)) {
      sibSaid.add(boss.pid);
      alert_('warn', `Another PortDash (pid ${boss.pid}) has been running longer and uses the same ${shorten(ROOT)}, so it keeps the memory watchdog and this one only shows the dashboard. Two of them would fight over the same processes and overwrite each other's records. Stop one.`,
             null, 'sib:shared:' + boss.pid);
    }
    return;
  }

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

  // 3) system-wide pressure → freeze whoever's using the most (only touches processes
  //    PortDash itself started; anything else just gets a warning)
  if (!sm) return;

  // Free memory is the signal that actually matters. Swap usage on its own is not:
  // macOS never gives swap back, so once anything has paged out the total stays high
  // for the rest of the uptime. Treating that as an emergency means freezing something
  // every 2 seconds on a machine that is perfectly healthy. Swap only counts as
  // thrashing when memory is tight at the same time.
  const low = sm.availPct < lim.sysAvailFloorPct;
  const thrashing = sm.swapUsedMB > lim.sysSwapCeilMB && sm.availPct < lim.sysAvailFloorPct * 2;
  if (!low && !thrashing) return;

  const victim = running.filter((r) => !r.paused).sort((a, b) => b.rss - a.rss)[0];
  const why = low ? `only ${sm.availPct}% memory available`
                  : `swap at ${fmtMB(sm.swapUsedMB)} with only ${sm.availPct}% memory available`;

  // Freezing a process that isn't actually holding much won't give the system anything
  // back — it just breaks the user's work for nothing.
  if (victim && victim.rss >= lim.minVictimMB) {
    signalGroup(victim.pgid, 'SIGSTOP');
    alert_('danger', `${why} — froze "${victim.name}" (${fmtMB(victim.rss)}), the biggest consumer, to protect the system.`, victim.id, 'sys:' + victim.id);
  } else if (victim) {
    alert_('warn', `${why}, but the biggest thing PortDash started is only "${victim.name}" (${fmtMB(victim.rss)}) — freezing it wouldn't help, so it's been left alone.`, null, 'sys:small');
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
    if (u.pathname === '/api/doctor') return json(res, 200, doctor());

    if (u.pathname === '/api/logs') {
      const id = String(u.searchParams.get('id'));
      // PortDash doesn't start itself, so it has no file in logs/ — its own log is the
      // one that actually answers "why did the dashboard restart".
      const f = isSelfProject(id) ? F_SELFLOG : path.join(D_LOGS, path.basename(id) + '.log');
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
      if (u.pathname === '/api/recheck-env') {
        const e = refreshEnv();
        logLine('Rechecked. ' + envSummary(e));
        return json(res, 200, { ok: true, hasNode: e.hasNode, summary: envSummary(e) });
      }

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
      if (u.pathname === '/api/pin') {
        const reg = getReg();
        const p = reg.find((x) => x.id === body.id);
        if (!p) throw new Error('Project not found');
        p.pinned = !!body.pinned;
        // A pinned row is there to be a clickable address, so it needs a port even when
        // the project is stopped. If none was ever configured, borrow the one it is
        // listening on right now — that is the address the user just pinned.
        if (p.pinned && !p.port) {
          const st = buildState().projects.find((x) => x.id === body.id);
          if (st && st.ports.length) p.port = st.ports[0];
        }
        setReg(reg);
        return json(res, 200, { ok: true, pinned: p.pinned });
      }
      if (u.pathname === '/api/register') {
        if (!body.cwd) throw new Error("Couldn't determine this process's working directory, can't register it");
        if (!registrable(body.cwd)) throw new Error(`${body.cwd} doesn't look like a project directory — it's a system or sandboxed-app path`);
        const reg = getReg();
        if (reg.some((x) => x.cwd === body.cwd)) throw new Error('This directory is already registered');
        const d = detectProject(body.cwd) || { name: path.basename(body.cwd), cmd: '', kind: 'unknown' };
        // This one is already listening, so its port is a fact rather than a guess — a
        // generated static command should name that port instead of the generic 8000.
        const port = body.port || (d.kind === 'static' ? freeStaticPort(reg) : null);
        reg.push({ id: idOf(body.cwd), name: d.name, cwd: body.cwd, kind: d.kind,
                   cmd: (d.kind === 'static' && port) ? staticCmd(port) : d.cmd,
                   port, memMB: null, heapMB: null, pinned: false });
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
button.star{padding:5px 8px;line-height:1}
button.star.on{color:var(--pause);border-color:color-mix(in srgb,var(--pause) 45%,var(--line))}
button.star.on:hover{color:var(--pause)}
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
.tag.port.idle{color:var(--dim);border-color:var(--line)}
.tag.mem{font-family:ui-monospace,Menlo,monospace}
.tag.mem.warn{color:var(--pause);border-color:color-mix(in srgb,var(--pause) 45%,var(--line))}
.tag.mem.bad{color:var(--danger);border-color:color-mix(in srgb,var(--danger) 45%,var(--line))}
.tag.sup{color:var(--pause);border-color:color-mix(in srgb,var(--pause) 45%,var(--line))}
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
.alert .go{margin-left:auto;flex:none;align-self:center}
.chk{display:flex;align-items:baseline;gap:9px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.chk:last-child{border-bottom:0}
.chk .k{width:82px;flex:none;color:var(--dim);font-size:12px}
.chk .v{font-family:ui-monospace,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chk .no{color:var(--dim)}
.ok{color:var(--run)} .bad{color:var(--danger)}
.note{font-size:12px;color:var(--dim);margin:14px 0 4px;font-weight:600}
.err{background:var(--danger);color:#fff;padding:9px 14px;border-radius:8px;position:fixed;bottom:20px;
  left:50%;transform:translateX(-50%);z-index:9;box-shadow:0 4px 16px rgba(0,0,0,.2);max-width:80vw}
</style></head><body>
<div class="wrap">
  <header>
    <h1>PortDash</h1>
    <span class="sub" id="stat">Loading…</span>
    <span class="spacer"></span>
    <span class="sub" id="sys"></span>
    <button onclick="showDoctor()">Environment</button>
    <button onclick="scan()">Rescan</button>
  </header>
  <div id="alerts"></div>
  <div id="pinwrap" hidden>
    <h2>Pinned</h2>
    <div id="pins"></div>
  </div>
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
  <div class="sub" style="font-size:12px;margin-top:8px">
    Default port is the address PortDash opens, pins and checks for conflicts before
    starting. It does not change what the program listens on — that comes from the start
    command or the project's own config. Leave it blank if you're not sure.
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

<dialog id="doc">
  <div style="display:flex;align-items:center;margin-bottom:4px">
    <div style="font-weight:600">Environment</div><span class="spacer"></span>
    <button onclick="recheckEnv()">Recheck</button>
    <button onclick="doc.close()" style="margin-left:6px">Close</button>
  </div>
  <div class="sub" style="font-size:12px;margin-bottom:14px">
    What PortDash can see when it starts your services. If something here is missing, that's
    why a service won't start — screenshot this when reporting a problem.
  </div>
  <div id="d_body">Checking…</div>
</dialog>

<dialog id="sup">
  <div style="font-weight:600;margin-bottom:4px">Supervised by launchd</div>
  <div class="sub" style="font-size:12px" id="s_who"></div>
  <div class="note">Stopping it from here won't stick</div>
  <div class="sub" style="font-size:13px;margin-bottom:10px">
    launchd starts this job again as soon as it exits, so the row turns green a moment later
    and it looks like nothing happened. Run this in a terminal instead:
  </div>
  <pre id="s_cmd" style="max-height:none"></pre>
  <div class="sub" id="s_sys" hidden style="font-size:13px;margin-top:10px;color:var(--danger)">
    This is one of macOS's own agents, not a dev server. That command works, but it switches
    off part of the system until you log in again — it's almost certainly not what you want.
  </div>
  <div style="display:flex;gap:8px;align-items:center;margin-top:18px">
    <button class="d" id="s_anyway">Stop anyway</button>
    <span class="spacer"></span>
    <button onclick="copyCmd()">Copy command</button>
    <button class="p" onclick="sup.close()">Close</button>
  </div>
</dialog>

<script>
const TOKEN='__PORTDASH_TOKEN__';
const STATE={byId:{},byPid:{}};
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
async function scan(){
  const r=await api('/api/scan');
  toast('Scan complete, '+r.added+' new project(s)'
    +(r.repaired?' · gave '+r.repaired+' static site(s) a port of their own':''));
  load();
}
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
async function showDoctor(){
  d_body.textContent='Checking…'; doc.showModal(); renderDoctor();
}
async function renderDoctor(){
  let d; try{ d=await (await authed('/api/doctor')).json(); }catch(e){ d_body.textContent='Could not read the environment.'; return; }
  const row=(k,v,cls)=>'<div class="chk"><span class="k">'+k+'</span><span class="v '+(cls||'')+'">'+v+'</span></div>';
  const tool=t=>row(t.name, t.found
      ? '<span class="ok">✓</span> '+esc(t.version||'installed')+' <span class="no">· '+esc(t.path)+'</span>'
      : '<span class="no">not found</span>');
  d_body.innerHTML=
     '<div class="chk"><span class="k">Status</span><span class="v '+(d.ok?'ok':'bad')+'">'
       +(d.ok?'✓ Node.js is visible — services should start':'✗ Node.js is NOT visible — Node projects will fail to start')+'</span></div>'
    +row('How', esc(d.summary.replace(/^Environment: /,'')))
    +(d.roots||[]).filter(r=>r.synced).map(r=>row('Storage',
        '<span class="bad">'+esc(r.root)+' is in '+esc(r.synced)+'</span>'
        +'<div class="no" style="white-space:normal;font-family:inherit;margin-top:3px">Cloud-synced folders struggle with the thousands of small files in node_modules — builds there fail with read errors that look random. Moving your projects out of it avoids that.</div>')).join('')
    +'<div class="note">Tools</div>'+d.tools.map(tool).join('')
    +'<div class="note">PortDash</div>'
    +row('Version', esc(d.portdash.version))
    +row('Started by', esc(d.portdash.startedBy)+(d.portdash.agentInstalled?' · login agent installed':''))
    +row('Script', esc(d.portdash.script))
    +row('Node', esc(d.portdash.node)+' · '+esc(d.portdash.platform))
    +'<div class="note">PATH ('+d.path.length+' entries)</div>'
    +'<pre style="max-height:22vh">'+d.path.map(esc).join('\\n')+'</pre>';
}
async function recheckEnv(){
  d_body.textContent='Rechecking…';
  const r=await api('/api/recheck-env');
  toast(r.hasNode?'Environment rechecked — Node.js found':'Environment rechecked — still no Node.js');
  renderDoctor(); load();
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

// Every row says who owns its lifecycle. Nothing is shown for the ordinary case —
// PortDash started it — because a badge on every single row stops being read.
function ownerTag(o){
  if(!o||o.kind==='portdash') return '';
  if(o.kind==='self')    return '<span class="tag">self</span>';
  if(o.kind==='launchd') return '<span class="tag sup">launchd · '+esc(o.label)+'</span>';
  if(o.kind==='app')     return '<span class="tag">'+esc(o.label)+'</span>';
  if(o.kind==='from')    return '<span class="tag">from '+esc(o.label)+'</span>';
  return '<span class="tag">detached</span>';
}
let supTarget=null;
function showSup(o,target){
  supTarget=target; s_who.textContent=o.label; s_cmd.textContent=o.stop;
  s_sys.hidden=!o.system; sup.showModal();
}
async function copyCmd(){
  try{ await navigator.clipboard.writeText(s_cmd.textContent); toast('Command copied'); }
  catch(e){ toast('Copy failed — select the text and copy it instead'); }
}
s_anyway.onclick=async()=>{ sup.close(); await act('/api/stop',supTarget); };

function pinBtn(p){
  return '<button class="star'+(p.pinned?' on':'')+'" data-act="pin" data-id="'+p.id+'"'
    +' data-pinned="'+(p.pinned?1:0)+'" title="'+(p.pinned?'Unpin':'Pin to the top')+'">'
    +(p.pinned?'★':'☆')+'</button>';
}

function projectRow(p){
  const label={running:'running',paused:'frozen',stopped:'stopped'}[p.status];
  // A stopped project has no live port, but its configured one is still the address
  // you go to — show it dimmed so a pinned row is useful before you press Start.
  const ports=p.ports.length
    ? p.ports.map(x=>'<span class="tag port">:'+x+'</span>').join('')
    : (p.port?'<span class="tag port idle">:'+p.port+'</span>':'');
  const openBtn=p.openPort?'<button data-act="open" data-port="'+p.openPort+'">Open</button>':'';
  // Something launchd supervises can't be stopped from here in any way that lasts, so
  // the button opens an explanation and the command that does work.
  const stopBtn=(p.owner&&p.owner.kind==='launchd')
    ? btn('supervised',p.id,'Stop…','d') : btn('stop',p.id,'Stop','d');
  let acts='';
  // The self row gets no lifecycle buttons: whatever supervises PortDash owns them.
  if(p.source==='self') acts=openBtn;
  else if(p.status==='stopped') acts=openBtn+btn('start',p.id,'Start','p');
  else if(p.status==='running')
    acts=openBtn+btn('pause',p.id,'Pause')+btn('restart',p.id,'Restart')+stopBtn;
  else acts=btn('resume',p.id,'Resume','p')+stopBtn;
  acts+=pinBtn(p)+btn('logs',p.id,'Logs')+btn('edit',p.id,'Edit')+btn('remove',p.id,'×','d');
  const badge=ownerTag(p.owner);
  const cmdTxt=p.source==='self'?'serving this dashboard'
             :p.cmd?esc(p.cmd):'<span style="color:var(--pause)">no start command configured</span>';
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
    +((o.owner&&o.owner.kind==='launchd')
        ? '<button class="d" data-act="supervised" data-pid="'+o.pid+'">Stop…</button>'
        : '<button class="d" data-act="stop" data-pid="'+o.pid+'">Stop</button>');
  if(o.registrable) acts+='<button data-act="register" data-cwd="'+esc(o.cwd)+'" data-port="'+o.ports[0]+'">Register</button>';
  return '<div class="row"><span class="dot '+(o.paused?'paused':'running')+'"></span><div class="main">'
    +'<div class="nm">'+esc(o.command)+ports
    +(o.portdash?'<span class="tag">another PortDash</span>':'')+ownerTag(o.owner)
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
  if(a==='pin')      return act('/api/pin',{id:id,pinned:b.dataset.pinned!=='1'});
  if(a==='supervised'){
    const o=id?STATE.byId[id]:STATE.byPid[pid];
    if(o&&o.owner) showSup(o.owner, id?{id:id}:{pid:pid});
    return;
  }
  if(a==='recheck-env'){
    b.disabled=true; b.textContent='Rechecking…';
    const r=await api('/api/recheck-env');
    toast(r.hasNode?'Environment rechecked — Node.js found. Try starting it again.'
                   :'Environment rechecked — still no Node.js. Open "Environment" for details.');
    if(r.hasNode) await api('/api/dismiss',{alertId:b.dataset.alert});
    return load();
  }
  const M={start:'/api/start',stop:'/api/stop',pause:'/api/pause',resume:'/api/resume',restart:'/api/restart'};
  if(M[a]) return act(M[a], id?{id:id}:{pid:pid});
});

async function load(){
  let s; try{ s=await (await authed('/api/state')).json(); }catch(e){ return; }
  STATE.byId={}; s.projects.forEach(p=>STATE.byId[p.id]=p);
  STATE.byPid={}; s.others.forEach(o=>STATE.byPid[o.pid]=o);

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
    +(a.action?'<button class="go" data-act="'+esc(a.action.act)+'" data-alert="'+a.id+'">'+esc(a.action.label)+'</button>':'')
    +'<button class="x" data-act="dismiss" data-alert="'+a.id+'">×</button></div>').join('');

  // Pinned rows keep the same place whatever they are doing — sorting them by status
  // would move them around as things start and stop, which defeats the point.
  const pinned=s.projects.filter(p=>p.pinned).sort((a,b)=>a.name.localeCompare(b.name));
  const rest=s.projects.filter(p=>!p.pinned);
  pinwrap.hidden=!pinned.length;
  pins.innerHTML=pinned.map(projectRow).join('');

  const ord={running:0,paused:1,stopped:2};
  projects.innerHTML = rest.length
    ? rest.slice().sort((a,b)=>ord[a.status]-ord[b.status]||a.name.localeCompare(b.name))
        .map(projectRow).join('')
    : (pinned.length
        ? '<div class="empty">Everything else is pinned above.</div>'
        : '<div class="empty">No projects registered yet. Click "Rescan" above, or edit scanRoots in ~/.portdash/config.json.</div>');
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

  // Check now, while the person is still here and remembers doing this. Running at login
  // is exactly the case where PortDash stops seeing the tools a terminal would give it,
  // and the symptom — Start doing nothing — shows up days later, looking like a bug in
  // PortDash rather than a consequence of this command.
  console.log('');
  const d = doctor();
  console.log(`Checking what PortDash will be able to start your services with:`);
  for (const t of d.tools) {
    if (!t.found && !['node', 'npm'].includes(t.name)) continue;   // only nag about the essentials
    console.log(`  ${t.found ? '✓' : '✗'} ${t.name.padEnd(8)} ${t.found ? (t.version || '') + '  ' + t.path : 'not found'}`);
  }
  console.log(`  (${d.summary.replace(/^Environment: /, '')})`);
  if (!d.ok) {
    console.log('');
    console.log(`WARNING: PortDash can't see Node.js, so starting Node projects will fail with`);
    console.log(`"command not found". Open the dashboard, click "Environment", and use "Recheck"`);
    console.log(`after fixing your shell setup — or start PortDash from a terminal instead.`);
  }
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
  const e = getEnv();
  logLine(`  ${envSummary(e)}`);
  if (!e.hasNode) {
    alert_('warn', "PortDash can't find Node.js in the environment it would start services with, so Node projects will fail to start. Open \"Environment\" to see what it can see.",
           null, 'env:nonode', { act: 'recheck-env', label: 'Recheck environment' });
  }
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
