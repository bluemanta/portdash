'use strict';
/**
 * Unit tests — the small pieces, no server, no processes signalled.
 *
 *   npm test          runs this and test-http.js, against a throwaway HOME
 *   node --test       the same thing, against your real one
 *
 * The tests need Node 18 or newer for the built-in runner. PortDash itself still runs
 * on 16, and none of this ships: package.json's "files" list is what goes to npm.
 *
 * What is here is not "every function". It is the decisions that are invisible in the
 * code: the places where the right answer looks like a bug, and the places where two
 * lines being in a particular order is the only thing between the dashboard and some
 * quietly terrible advice. If one of these fails, read its name before changing it —
 * several of them are deliberately asserting something surprising.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');

const pd = require('./portdash.js');

// --------------------------------------------------------------------- naming

describe('naming a process', () => {
  it('names an app by its bundle, not by the binary inside it', () => {
    // This one looks wrong: the app is called iTerm2 and the bundle is iTerm.app. It is
    // still the right rule, because the binary inside an Electron app is called
    // "Electron" and the bundle is the only place the real name appears.
    assert.equal(pd.procName('/Applications/iTerm.app/Contents/MacOS/iTerm2'), 'iTerm');
    assert.equal(pd.procName('/Applications/Visual Studio Code.app/Contents/MacOS/Electron'),
                 'Visual Studio Code');
  });

  it('survives a path with a space in it', () => {
    // Taking the first whitespace-separated token called every one of these
    // "Application", because half of ~/Library/Application Support is one such path.
    assert.equal(
      pd.procName('/Users/x/Library/Application Support/Setapp/Setapp.app/Contents/MacOS/SetappAgent'),
      'Setapp');
  });

  it('names an interpreter by the script it is running', () => {
    // "node" on a row tells you nothing; there are six of them.
    assert.equal(pd.procName('node scripts/preview-secret.mjs start'), 'preview-secret.mjs');
    assert.equal(pd.procName('/usr/bin/python3 /srv/app/manage.py runserver'), 'manage.py');
    assert.equal(pd.procName('node --inspect --enable-source-maps ./bin/server.js'), 'server.js');
  });

  it('falls back to the executable, and never to nothing', () => {
    assert.equal(pd.procName('/opt/homebrew/opt/postgresql@16/bin/postgres -D /x'), 'postgres');
    assert.equal(pd.procName('/bin/zsh'), 'zsh');
    assert.equal(pd.procName(''), 'unknown');
  });
});

// ------------------------------------------------------------ other instances

describe('telling another PortDash from everything else', () => {
  it('recognises a real one', () => {
    assert.equal(pd.isPortdash('/Users/x/.nvm/versions/node/v24.13.0/bin/node /x/portdash/portdash.js'), true);
    assert.equal(pd.isPortdash('node --inspect /x/portdash.js'), true);
  });

  it('does not mistake a file for a process', () => {
    // Matching the whole command line would have the dashboard telling you to kill the
    // editor you have the source open in.
    assert.equal(pd.isPortdash('vim portdash.js'), false);
    assert.equal(pd.isPortdash('grep -rn portdash.js .'), false);
    assert.equal(pd.isPortdash('/usr/bin/node /x/portdash.jsx'), false);
    assert.equal(pd.isPortdash('next-server (v15.5.15)'), false);
    assert.equal(pd.isPortdash(''), false);
  });
});

// --------------------------------------------------------------------- owners

/** A small process table: a dev server under npm under zsh under iTerm, a database
    launchd owns directly, an orphan, and a pair that point at each other. */
const TREE = {
  10: { pid: 10, ppid: 1,  command: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
  11: { pid: 11, ppid: 10, command: '/bin/zsh' },
  12: { pid: 12, ppid: 11, command: 'npm run dev' },
  13: { pid: 13, ppid: 12, command: 'node /x/next/dist/server.js' },
  20: { pid: 20, ppid: 1,  command: '/opt/homebrew/opt/postgresql@16/bin/postgres -D /x' },
  30: { pid: 30, ppid: 1,  command: 'node /x/orphan.js' },
  40: { pid: 40, ppid: 41, command: 'node /x/a.js' },
  41: { pid: 41, ppid: 40, command: 'node /x/b.js' }
};

describe('who owns a process', () => {
  it('walks up to the last process before launchd', () => {
    assert.deepEqual(pd.ancestors(13, TREE).map((p) => p.pid), [12, 11, 10]);
    assert.deepEqual(pd.ancestors(20, TREE), []);
  });

  it('does not hang on a parent loop', () => {
    // Should be impossible. Would freeze every render if it ever happened.
    assert.ok(pd.ancestors(40, TREE).length <= 2);
  });

  it('names a launchd job and the command that actually stops it', () => {
    assert.deepEqual(pd.ownerOf(20, TREE, { 20: 'homebrew.mxcl.postgresql@16' }), {
      kind: 'launchd',
      label: 'homebrew.mxcl.postgresql@16',
      stop: 'brew services stop postgresql@16',
      system: false
    });
  });

  it('finds a job on an ancestor, not just on the process itself', () => {
    // Postgres forks; the pid that holds the socket is often not the pid launchd knows.
    assert.equal(pd.ownerOf(13, TREE, { 10: 'com.example.runner' }).kind, 'launchd');
  });

  it('does not call a GUI app something launchd will restart', () => {
    // It is a launchd job, but quitting the app is what stops it and it does not come
    // back on its own. Telling someone to bootout their editor would be wrong.
    assert.deepEqual(pd.ownerOf(13, TREE, { 10: 'application.com.googlecode.iterm2.1.2' }),
                     { kind: 'app', label: 'iTerm' });
  });

  it('flags Apple\'s own agents', () => {
    // `launchctl bootout com.apple.controlcenter` is a correct command for switching
    // off the menu bar until next login. The UI needs to know to say so.
    assert.equal(pd.ownerOf(20, TREE, { 20: 'com.apple.controlcenter' }).system, true);
  });

  it('calls our own children ours, even though we are a launchd job too', () => {
    // THE ORDERING TRAP. ownerOf checks "is this us?" before it looks up the launchd
    // table. Swap those two lines and every service PortDash started walks up into
    // PortDash's own label, and the dashboard starts advising you to stop PortDash in
    // order to stop a dev server. Nothing about the code makes that order look
    // load-bearing.
    const mine = {
      [process.pid]: { pid: process.pid, ppid: 1, command: 'node /x/portdash.js' },
      50: { pid: 50, ppid: process.pid, command: '/bin/zsh -lc npm run dev' },
      51: { pid: 51, ppid: 50, command: 'node /x/server.js' }
    };
    assert.deepEqual(pd.ownerOf(51, mine, { [process.pid]: 'com.bluemanta.portdash' }),
                     { kind: 'portdash' });
  });

  it('knows an app by its own path when launchd has no record of it', () => {
    // A GUI app's helper whose parent has exited is reparented to launchd and looks
    // exactly like a stray dev server from the process table. They want opposite
    // treatment: one you stop from the dashboard, the other you quit from the app.
    const orphanedHelper = {
      77: { pid: 77, ppid: 1, command: '/Applications/BaiduNetdisk_mac.app/Contents/Frameworks/netdisk_service' }
    };
    assert.deepEqual(pd.ownerOf(77, orphanedHelper, {}), { kind: 'app', label: 'BaiduNetdisk_mac' });
    // ...and a real stray still reads as one.
    assert.deepEqual(pd.ownerOf(30, TREE, {}), { kind: 'detached' });
  });

  it('will not signal one of macOS\'s own agents, even when asked by pid', () => {
    // The menu bar holds :5000. The UI stops offering it, and this stops the raw-pid
    // route from being a way around that.
    assert.throws(() => pd.refuseSystemAgent(
      { kind: 'launchd', label: 'com.apple.controlcenter', system: true }, 684), /won't signal it/);
    // Everything else is still the user's business.
    assert.doesNotThrow(() => pd.refuseSystemAgent(
      { kind: 'launchd', label: 'homebrew.mxcl.postgresql@16', system: false }, 949));
    assert.doesNotThrow(() => pd.refuseSystemAgent({ kind: 'detached' }, 60571));
    assert.doesNotThrow(() => pd.refuseSystemAgent(null, 1234));
  });

  it('otherwise names what started it, or admits it is detached', () => {
    assert.deepEqual(pd.ownerOf(13, TREE, {}), { kind: 'from', label: 'iTerm', pid: 10 });
    assert.deepEqual(pd.ownerOf(30, TREE, {}), { kind: 'detached' });
    assert.deepEqual(pd.ownerOf(9999, TREE, {}), { kind: 'detached' });   // not a crash
  });

  it('turns a Homebrew label into the command a Homebrew user already knows', () => {
    assert.equal(pd.stopCommand('homebrew.mxcl.postgresql@16'), 'brew services stop postgresql@16');
    assert.equal(pd.stopCommand('com.example.thing'), 'launchctl bootout gui/$(id -u)/com.example.thing');
  });
});

// ----------------------------------------------------- which one keeps guard

describe('which PortDash keeps the watchdog', () => {
  const ROOT = path.join(os.homedir(), '.portdash');
  const me = { pid: process.pid, ppid: 1, etime: '00:00', command: 'node /x/portdash.js' };
  const other = (pid, etime) => ({ pid, ppid: 1, etime, command: '/usr/bin/node /x/portdash.js' });
  const reset = () => {
    pd.resetAlerts();
    pd._caches.sibSaid.clear();
    for (const k of Object.keys(pd._caches.rootSeen)) delete pd._caches.rootSeen[k];
  };

  it('stands down for an older one sharing the same settings', () => {
    reset();
    pd._caches.rootSeen[999999] = ROOT;
    const boss = pd.supersededBy({ [process.pid]: me, 999999: other(999999, '10:00:00') });
    assert.equal(boss && boss.pid, 999999);
  });

  it('never lets both stand down', () => {
    // Two started in the same second: age can't separate them, so the lower pid wins.
    // Drop this and a machine that starts two at boot ends up with no watchdog at all —
    // silently, because nothing is broken, it just isn't guarding any more.
    reset();
    pd._caches.rootSeen[999999] = ROOT;
    assert.equal(pd.supersededBy({ [process.pid]: me, 999999: other(999999, '00:00') }), null);
    reset();
    pd._caches.rootSeen[2] = ROOT;
    assert.equal(pd.supersededBy({ [process.pid]: me, 2: other(2, '00:00') }).pid, 2);
  });

  it('never hands over to one with its own settings, however old', () => {
    reset();
    pd._caches.rootSeen[997] = '/tmp/pd2/.portdash';
    assert.equal(pd.supersededBy({ [process.pid]: me, 997: other(997, '99:00:00') }), null);
    assert.equal(pd.getAlerts().length, 1);          // but it does say so
    pd.supersededBy({ [process.pid]: me, 997: other(997, '99:00:00') });
    assert.equal(pd.getAlerts().length, 1);          // once, not once a minute
  });

  it('gives the notice a button rather than sending it to a list', () => {
    // This is the whole bug. "Other processes" is built from listening sockets, and the
    // stray that actually happens is the one with no socket: default settings, found the
    // UI port taken, retrying the bind ever since. The notice used to end "stop it there"
    // and there was nothing there — a dead end at the one moment somebody wanted to act.
    reset();
    pd._caches.rootSeen[995] = '/tmp/pd3/.portdash';
    pd.supersededBy({ [process.pid]: me, 995: other(995, '99:00:00') });
    const [a] = pd.getAlerts();
    assert.deepEqual(a.actions, [{ act: 'stop-stray', pid: 995, label: 'Stop it' }]);
    assert.doesNotMatch(a.text, /Other processes/);
    // And it no longer claims the thing is busy: that timer only starts once a bind has
    // succeeded, so the instance being complained about is usually doing nothing at all.
    assert.doesNotMatch(a.text, /every two seconds/);
  });

  it('takes the notice back down when the process goes', () => {
    // How this was found: the notice was still on screen, naming a pid that had been gone
    // for an hour, telling someone to go and stop it. Nothing else prunes alerts, which is
    // right for "this froze" and wrong for "this is running". The button makes it worse
    // than untidy — pids get reused, so a stale one is aimed at a stranger.
    reset();
    pd._caches.rootSeen[994] = '/tmp/pd4/.portdash';
    pd.supersededBy({ [process.pid]: me, 994: other(994, '99:00:00') });
    assert.equal(pd.getAlerts().length, 1);
    pd.supersededBy({ [process.pid]: me });                    // 994 has exited
    assert.equal(pd.getAlerts().length, 0);
    // Withdrawn, not silenced: if another one shows up it is worth saying again, and the
    // 60-second dedupe window would otherwise swallow it.
    pd._caches.rootSeen[994] = '/tmp/pd4/.portdash';
    pd.supersededBy({ [process.pid]: me, 994: other(994, '99:00:00') });
    assert.equal(pd.getAlerts().length, 1);
  });

  it('names a temporary settings directory for what it is', () => {
    // A ~/.portdash under the system temp directory is not a configuration, it is what
    // `npm test` leaves behind. Saying so is the difference between a notice someone can
    // act on and one that sends them to look at a directory that no longer exists.
    assert.match(pd.strayOrigin(path.join(os.tmpdir(), 'portdash-x1/.portdash')),
                 /left behind by a test run/);
    // Spelled out rather than built from os.homedir(), because this suite runs with a
    // throwaway HOME under the temporary directory — the real home is the one thing here
    // that isn't available to compare against.
    assert.equal(pd.strayOrigin('/Users/someone/.portdash'), '');
    assert.equal(pd.strayOrigin(null), '');
  });

  it('will not press Stop on a pid that has stopped meaning what it meant', () => {
    // The notice can sit on screen for hours and the stray can exit in the middle of
    // that. Without this the button is a SIGTERM to the process group of whoever the
    // kernel handed the number to next. Checked against the process table at the moment
    // of the press, not against what was true when the notice was written.
    // Whatever ran this suite: certainly alive, certainly not a PortDash.
    assert.throws(() => pd.stopStray({ pid: process.ppid }), /no longer that PortDash/);
    assert.throws(() => pd.stopStray({ pid: 4194303 }), /isn't running any more/);
    assert.throws(() => pd.stopStray({ pid: process.pid }), /this PortDash/);
    assert.throws(() => pd.stopStray({ pid: 'nonsense' }), /Not a valid pid/);
  });

  it('says nothing about one that has only just appeared', () => {
    // Every run of this suite starts a PortDash with its own temporary home for a few
    // seconds, and posting a notice about each one turns the developer's dashboard into
    // a log of their own test runs. Observed happening, which is how this rule got
    // written. The row is tagged immediately regardless; only the alert waits for the
    // thing to prove it is actually sticking around.
    reset();
    pd._caches.rootSeen[998] = '/tmp/elsewhere/.portdash';
    assert.equal(pd.supersededBy({ [process.pid]: me, 998: other(998, '00:08') }), null);
    assert.equal(pd.getAlerts().length, 0);
  });

  it('treats a home it cannot read as someone else\'s', () => {
    // Standing down on a guess would switch off the memory protection this program
    // exists to provide. Two watchdogs is the safer way to be wrong.
    reset();
    pd._caches.rootSeen[996] = null;
    assert.equal(pd.supersededBy({ [process.pid]: me, 996: other(996, '99:00:00') }), null);
  });
});

// ------------------------------------------------------- notices about a condition

describe('a notice that describes the machine rather than an event', () => {
  it('stays one row while the condition lasts, with the numbers refreshed', () => {
    // What this replaces: eleven rows, one a minute, the same sentence with the
    // percentage a point apart each time, and the reader having to get through all of
    // them to work out they were one problem. Seen on a real dashboard.
    pd.resetAlerts();
    pd.standingAlert('warn', 'only 12% memory available', 'sys:none');
    pd.standingAlert('warn', 'only 11% memory available', 'sys:none');
    pd.standingAlert('warn', 'only 10% memory available', 'sys:none');
    assert.equal(pd.getAlerts().length, 1);
    assert.equal(pd.getAlerts()[0].text, 'only 10% memory available');
  });

  it('goes away when the condition does, and can come straight back', () => {
    // Coming straight back matters: the 60-second window that stops alert_ flooding would
    // otherwise swallow the next episode if it began within a minute of the last one
    // ending, and a machine that is thrashing does exactly that.
    pd.resetAlerts();
    pd.standingAlert('warn', 'only 10% memory available', 'sys:none');
    pd.dropAlert('sys:none');
    assert.equal(pd.getAlerts().length, 0);
    pd.standingAlert('warn', 'only 9% memory available', 'sys:none');
    assert.equal(pd.getAlerts().length, 1);
  });

  it('keeps the id it was given, so the × still works after a refresh', () => {
    // Refreshing in place means the row the browser is looking at is the same object. Give
    // it a new id and the dismiss button on screen points at an alert that no longer
    // exists, which reads as a button that does nothing.
    pd.resetAlerts();
    pd.standingAlert('warn', 'first', 'sys:none');
    const id = pd.getAlerts()[0].id;
    pd.standingAlert('warn', 'second', 'sys:none');
    assert.equal(pd.getAlerts()[0].id, id);
  });
});

describe('naming what is actually eating the memory', () => {
  // Grouped by pgid, because an app is thirty processes and thirty small numbers each
  // look innocent: 300 + 1400 + 1200 beats a single 1500, and none of the three on its
  // own does. The leader is the smallest of them, which is how a browser actually looks —
  // the process named after the app holds almost nothing and the tabs hold everything.
  const TABLE = {
    10: { pid: 10, ppid: 1, pgid: 10, rssMB: 300, command: '/Applications/Hog.app/Contents/MacOS/Hog' },
    11: { pid: 11, ppid: 10, pgid: 10, rssMB: 1400, command: '/Applications/Hog.app/Contents/Frameworks/Helper' },
    12: { pid: 12, ppid: 10, pgid: 10, rssMB: 1200, command: '/Applications/Hog.app/Contents/Frameworks/Helper' },
    20: { pid: 20, ppid: 1, pgid: 20, rssMB: 1500, command: '/usr/bin/lonely' }
  };
  const totals = (t) => Object.values(t).reduce((acc, p) => {
    acc[p.pgid] = (acc[p.pgid] || 0) + p.rssMB; return acc;
  }, {});

  it('names the heaviest group after the app, not after a helper process', () => {
    assert.deepEqual(pd.topConsumer(TABLE, totals(TABLE)), { pgid: 10, rss: 2900, name: 'Hog' });
  });

  it('falls back to the heaviest member when the group leader has already exited', () => {
    // A group outlives its leader, and a group with no name in the notice is no better
    // than the notice that never looked.
    const orphaned = Object.assign({}, TABLE);
    delete orphaned[10];
    assert.equal(pd.topConsumer(orphaned, totals(orphaned)).pgid, 10);
    assert.equal(pd.topConsumer(orphaned, totals(orphaned)).name, 'Hog');
  });

  it('does not fall over on an empty machine', () => {
    assert.equal(pd.topConsumer({}, {}), null);
  });

  it('sends you after the thing that is actually holding the memory', () => {
    // "Close something else, then resume it" is the right instruction and no help: which
    // something is the only part the reader doesn't already know.
    const hog = { pgid: 10, rss: 6553, name: 'ChatGPT' };
    assert.match(pd.freezeAdvice(hog, false), /ChatGPT is holding 6\.4G/);
    assert.match(pd.freezeAdvice(hog, false), /Free some of that/);
  });

  it('does not send you after the project it just froze', () => {
    // When the frozen project really is the machine's heaviest there is nothing else to
    // close, and saying its name and its size a second time in the same sentence reads as
    // though two separate things are at fault.
    const advice = pd.freezeAdvice({ pgid: 10, rss: 6553, name: 'ChatGPT' }, true);
    assert.doesNotMatch(advice, /ChatGPT|6\.4G/);
    assert.match(advice, /check its logs/i);
  });

  it('keeps the old wording when it has nothing to compare against', () => {
    assert.match(pd.freezeAdvice(null, false), /Close something else/);
  });

  it('names it in the refusal to start, too — that one has nowhere else to look', () => {
    // A refused start is a single line in a toast. There is no row to inspect and no log
    // to open afterwards, so "stop something first" is the whole of what the person gets.
    assert.match(pd.tooTightToStart(8, { pgid: 10, rss: 6553, name: 'ChatGPT' }),
                 /ChatGPT is holding 6\.4G/);
    assert.match(pd.tooTightToStart(8, null), /Stop something first/);
  });
});

describe('what a project has been told about itself', () => {
  const at = (id, key) => pd.alert_('danger', 'something about ' + id, id, key);

  it('forgets it once the project is told to do something different', () => {
    // The notice announcing a freeze carries its own Resume, and pressing that took the
    // notice with it. But the frozen row is sitting right there with a Resume of its own,
    // and that is the one a hand reaches for — after which the row says running and a red
    // notice above it still says the thing is frozen.
    pd.resetAlerts();
    at('app', 'soft:app');
    at('app', 'exit:app');
    at('other', 'soft:other');
    pd.clearProjectAlerts('app');
    assert.deepEqual(pd.getAlerts().map((a) => a.key), ['soft:other']);
  });

  it('lets the same thing be said again straight away', () => {
    // Start it, watch it fail on the same missing command a second later: that is a new
    // fact and has to be allowed through. The minute-long dedupe window would eat it.
    pd.resetAlerts();
    at('app', 'exit:app');
    pd.clearProjectAlerts('app');
    at('app', 'exit:app');
    assert.equal(pd.getAlerts().length, 1);
  });

  it('is not fooled into clearing everything by a call with no project', () => {
    // Stop, Pause and Resume also take a raw pid, for rows that are not projects. Those
    // alerts carry no projectId, and a null id must not match them.
    pd.resetAlerts();
    at('app', 'soft:app');
    pd.standingAlert('warn', 'the machine is busy', 'sys:none');
    pd.clearProjectAlerts(null);
    assert.equal(pd.getAlerts().length, 2);
  });
});

// ---------------------------------------------------------------------- ports

describe('a port for every static site', () => {
  it('starts at 8000 and fills the first gap', () => {
    assert.equal(pd.freeStaticPort([]), 8000);
    assert.equal(pd.freeStaticPort([{ port: 8000 }]), 8001);
    assert.equal(pd.freeStaticPort([{ port: 8000 }, { port: 8002 }]), 8001);
  });

  it('counts a port baked into a command, not just a recorded one', () => {
    // Scanning writes the port into the command. Reading only the port field would hand
    // the same one out twice, which is the bug this whole function exists to prevent.
    assert.equal(pd.freeStaticPort([{ cmd: pd.staticCmd(8000) }]), 8001);
    assert.equal(pd.freeStaticPort([{ cmd: 'npm run dev' }]), 8000);
  });
});

// ------------------------------------------------- explaining a failed start

describe('explaining a start that failed', () => {
  const project = { name: 'demo', cmd: 'vite', cwd: '/x/demo', port: null };

  it('finds the missing command whichever shell is complaining', () => {
    // Each shell words this differently and puts its own name in the line. One combined
    // pattern happily reports "zsh:1" as the name of the missing command.
    assert.equal(pd.missingCommand('zsh:1: command not found: vite'), 'vite');
    assert.equal(pd.missingCommand('bash: line 1: vite: command not found'), 'vite');
    assert.equal(pd.missingCommand('sh: 1: vite: not found'), 'vite');
  });

  it('offers the environment recheck when a command is missing', () => {
    const d = pd.diagnose('zsh:1: command not found: vite', 127, project);
    assert.match(d.text, /vite isn't on the PATH/);
    assert.deepEqual(d.actions, [{ act: 'recheck-env', label: 'Recheck environment' }]);
  });

  it('offers nothing to press when there is nothing useful to press', () => {
    // An alert with no actions is fine. One with a button that doesn't help is worse
    // than none, because it costs a click to find that out.
    assert.deepEqual(pd.diagnose('boom', 1, project).actions, undefined);
  });

  it('reads the port off the line that complains, not off a stack trace', () => {
    // A stack trace is full of file:line numbers that look exactly like ports, and the
    // first one wins if you scan the whole output.
    const out = [
      '    at Server.setupListenHandle [as _listen2] (node:net:1937:16)',
      '    at listenInCluster (node:net:2029:12)',
      'Error: listen EADDRINUSE: address already in use :::3000'
    ].join('\n');
    assert.match(pd.diagnose(out, 1, project).text, /port 3000 is already taken/);
  });

  it('does not read a stack trace as missing dependencies', () => {
    // "node_modules" followed loosely by "not" also matches the "not" inside "Cannot",
    // which turns any error mentioning a path under node_modules into a confident,
    // wrong "your dependencies aren't installed".
    const out = [
      "TypeError: Cannot read properties of undefined (reading 'root')",
      '    at /app/node_modules/vite/dist/node/chunks/dep-x.js:41:22'
    ].join('\n');
    assert.doesNotMatch(pd.diagnose(out, 1, project).text, /dependencies aren't installed/);
  });

  it('does say so when they really are missing', () => {
    assert.match(pd.diagnose("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite'", 1, project).text,
                 /dependencies aren't installed/);
  });

  it('quotes the line that matters, not the banner above it', () => {
    assert.equal(pd.lastLine('===== 1 Jan, start: npm run dev =====\nreal error\n\n'), 'real error');
    assert.equal(pd.lastLine('real error\n===== banner ====='), 'real error');
  });
});

// ------------------------------------------------------- running vs usable

describe('what a row should say about itself', () => {
  // healthFor turns one probe result plus the age of the process into the word on the
  // row. The probe is the easy half; this is where the judgement is, and all of it is
  // about not crying wolf at a service that is simply still starting up.
  const seed = (port, r) => { pd._caches.health[port] = Object.assign({ at: Date.now() }, r); };
  const forget = (port) => { delete pd._caches.health[port]; };
  const GRACE = 60;

  it('asks nothing of a project that is not running', () => {
    assert.equal(pd.healthFor('stopped', [], null, GRACE), null);
    // A frozen one is frozen by our own hand. It would probe as unreachable, and that
    // would read as a fault rather than as the state we deliberately put it in.
    assert.equal(pd.healthFor('paused', [3000], '01:00', GRACE), null);
  });

  it('gives a service that has not opened a port yet the benefit of the doubt', () => {
    assert.deepEqual(pd.healthFor('running', [], '00:05', GRACE),
                     { state: 'starting', why: 'no port open yet' });
  });

  it('stops giving it once the grace has run out', () => {
    const h = pd.healthFor('running', [], '10:00', GRACE);
    assert.equal(h.state, 'unreachable');
    assert.match(h.why, /not listening on any port/);
  });

  it('says so plainly before the first probe has come back', () => {
    forget(3000);
    assert.deepEqual(pd.healthFor('running', [3000], '10:00', GRACE), { state: 'checking', port: 3000 });
  });

  it('is ready when the port answered, whatever it answered with', () => {
    seed(3000, { open: true, answered: true, via: 'http', ms: 4 });
    assert.deepEqual(pd.healthFor('running', [3000], '10:00', GRACE),
                     { state: 'ready', port: 3000, via: 'http', ms: 4 });
    // A database is not broken for failing to speak HTTP.
    seed(5432, { open: true, answered: true, via: 'tcp', ms: 2 });
    assert.equal(pd.healthFor('running', [5432], '10:00', GRACE).state, 'ready');
  });

  it('calls a port that is open but silent starting, then not answering', () => {
    // The wedged dev server: listening, accepting connections, never replying. ps says
    // it is fine, and it is the case this whole check exists for.
    seed(3000, { open: true, answered: false, via: null, ms: 2000 });
    assert.equal(pd.healthFor('running', [3000], '00:05', GRACE).state, 'starting');
    const h = pd.healthFor('running', [3000], '10:00', GRACE);
    assert.equal(h.state, 'unreachable');
    assert.match(h.why, /no answer from :3000/);
  });

  it('judges the port it is actually on, not the one it was configured for', () => {
    // Probing a configured port a project isn't listening on would find whatever else
    // happens to be there and report this project as ready on the strength of it.
    seed(3000, { open: true, answered: true, via: 'http', ms: 1 });
    assert.equal(pd.healthFor('running', [], '00:01', GRACE).state, 'starting');
  });
});

// --------------------------------------------------- getting out of a freeze

describe('what to offer after freezing something', () => {
  it('offers twice what it had', () => {
    assert.equal(pd.roomierLimit(4096, 10240), 8192);
  });

  it('never offers a number the endpoint behind the button would refuse', () => {
    // Found by pressing the button. The notice computed "twice the current limit" and
    // the endpoint separately required at least MIN_LIMIT_MB, so a project on a 40M
    // limit was offered 80M and then told 80M was not a usable memory limit. Two places
    // deciding what counts as valid, and only one of them was consulted.
    for (const current of [1, 40, 100, 255, 256, 1024, 4096]) {
      const next = pd.roomierLimit(current, 10240);
      if (next !== null) assert.ok(next >= pd.MIN_LIMIT_MB, current + ' offered ' + next);
    }
    assert.equal(pd.roomierLimit(40, 10240), pd.MIN_LIMIT_MB);
  });

  it('offers nothing when there is no room left under the hard limit', () => {
    // Raising the soft limit to meet the hard one turns the next freeze into a kill.
    assert.equal(pd.roomierLimit(8192, 10240), null);
    assert.equal(pd.roomierLimit(10240, 10240), null);
    assert.equal(pd.roomierLimit(64, 200), null);
  });
});

// ------------------------------------------------- not signalling a stranger

describe('not signalling the wrong process', () => {
  it('reads every shape ps uses for elapsed time', () => {
    assert.equal(pd.etimeToSec('05:30'), 330);
    assert.equal(pd.etimeToSec('01:00:00'), 3600);
    assert.equal(pd.etimeToSec('2-03:00:00'), 183600);
    assert.equal(pd.etimeToSec('nonsense'), null);
  });

  it('disowns a pid that is younger than our record of it', () => {
    // PIDs get recycled, and a process that runs for weeks will see it happen. Getting
    // this wrong means freezing or killing something that has nothing to do with us.
    const hourOld = { pid: 1, startedAt: Date.now() - 3600 * 1000 };
    assert.equal(pd.sameProcess(hourOld, { etime: '00:30' }), false);
    assert.equal(pd.sameProcess(hourOld, { etime: '01:05:00' }), true);
  });

  it('treats an unreadable age as a stranger', () => {
    assert.equal(pd.sameProcess({ pid: 1, startedAt: Date.now() }, { etime: '??' }), false);
  });
});

// ------------------------------------------------------------ what to offer

describe('what can be registered as a project', () => {
  it('refuses system and sandbox paths', () => {
    // Daemons and sandboxed apps report a cwd of "/" or somewhere under ~/Library.
    // Offering Register on those just puts junk in the registry.
    for (const p of ['/', '/System/Library/x', '/usr/local/bin', '/Applications/Foo.app',
                     os.homedir(), path.join(os.homedir(), 'Library', 'Containers', 'x')]) {
      assert.equal(pd.registrable(p), false, p + ' should not be registrable');
    }
  });

  it('accepts an ordinary project directory', () => {
    assert.equal(pd.registrable(path.join(os.homedir(), 'Code', 'my-app')), true);
  });
});
