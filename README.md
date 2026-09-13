# PortDash

A visual control panel for local dev servers. Single file, zero dependencies — just Node's built-in modules.

[![tests](https://github.com/bluemanta/portdash/actions/workflows/test.yml/badge.svg)](https://github.com/bluemanta/portdash/actions/workflows/test.yml)

[中文说明](README.zh-CN.md)

## Run it

```bash
npx @bluemanta/portdash
```

or clone and run directly:

```bash
git clone https://github.com/bluemanta/portdash.git
cd portdash
node portdash.js
```

Then open http://localhost:7777

**Platform**: built for macOS, where all of it works. The Linux path — `/proc/meminfo` instead of `vm_stat`, and no `launchctl`, so ownership falls back to walking parent processes — now runs the whole test suite on every push and passes it. That is verification, not mileage: nobody has yet lived with it on Linux the way this was lived with on a Mac, so issues and PRs are welcome. Windows isn't supported.

## Keeping the watchdog on (optional)

The memory watchdog only protects you while PortDash is running. Quit it and your dev
servers keep going — unwatched. To keep it on in the background:

```bash
npm install -g @bluemanta/portdash
portdash --install-agent
```

That installs a macOS LaunchAgent that starts at login and restarts on failure. It runs as
you, never as root — it has to be the same user to signal your processes, and root would
give it far more reach than it needs. Remove it with `portdash --uninstall-agent`.

Two caveats worth knowing:

- It records the path of the `node` that installed it. If that's an nvm-managed version you
  later remove, the agent breaks — reinstall it, or point it at a stable Node.
- Frozen services are quiet. A SIGSTOPped server doesn't crash or log, it just stops
  responding, which is confusing if you've forgotten something is watching. Check
  `~/.portdash/portdash.log` when a service goes unresponsive for no obvious reason.

## macOS permissions (Full Disk Access, Photos, Contacts…)

If a service works when you run it in Terminal but fails under PortDash with
`Operation not permitted`, this is why.

macOS grants privacy permissions to the *responsible process* — the app at the root of the
launch chain — not to the binary doing the work. Child processes inherit that identity.
Being detached and in its own process group does **not** break the inheritance; only the
identity at the root matters.

So the fix depends on how PortDash itself was started:

| PortDash started from | Responsible process | What to do |
|---|---|---|
| Terminal.app / iTerm | that terminal | nothing — it inherits whatever you already granted the terminal |
| Another app (an editor, an AI agent, a launcher) | that app | grant the permission to that app, or start PortDash from your terminal instead |
| `--install-agent` | the `node` binary | grant the permission to `node` directly |

Under the launch agent there's no terminal to inherit from, so grant it to Node itself:
System Settings → Privacy & Security → Full Disk Access → `+` → <kbd>⌘⇧G</kbd> → the output of
`which node`.

Two things to weigh before doing that:

- It grants that permission to **every** Node program you run, not just PortDash. That's a
  wider grant than most people expect, and macOS offers no finer granularity here.
- Use a stable interpreter path. A version-managed Node (nvm, asdf) changes path on every
  upgrade, and the grant doesn't follow it.

## What it does

- **See** every process listening on a port, grouped by project, with live memory usage per group
- **Control** start / pause / resume / restart / stop — signals go to the whole process group, so everything `npm run dev` spawns gets caught too
- **Pause means pause**: SIGSTOP freezes the process in place. Memory and ports stay held. Resuming (SIGCONT) is instant
- **Pin** the handful you open every day with the ☆ button — they sit in their own section at the top, in the same place whether they're running or not, with a clickable address either way
- **Logs**: anything PortDash starts gets its output recorded under `~/.portdash/logs/`, viewable right in the UI
- **Recognizes servers you started yourself** — if you ran a dev server by hand in a terminal, PortDash matches it to the right project by working directory and lets you control it too
- **Says who owns each service**: the terminal, editor or script it was started from, or the launchd job supervising it. Anything launchd supervises can't be stopped from a dashboard in a way that lasts — it's back a second later — so those rows show you the command that does work (`brew services stop postgresql@16`) instead of a button that appears to do nothing
- **Starts things in the environment you'd expect**: PortDash reads your own shell's environment at startup, so nvm / Homebrew / Volta / asdf / pyenv installs are visible even when it's running as a background login agent, where the inherited PATH is otherwise almost empty
- **Says what went wrong**: a service that dies on startup raises an alert that names the cause — missing command, port already taken, dependencies not installed — instead of leaving the reason in a log file
- **Environment panel**: what PortDash can actually see (shell, node, npm, pnpm, yarn, bun, python3, git, and the full PATH), with a Recheck button. Screenshot it when reporting a problem
- **Running isn't the same as usable.** A green dot used to mean only that a process existed. PortDash asks the port instead: a dev server still compiling reads as *starting*, one that is listening but never answers reads as *not answering*, and *ready* means something actually replied. Any HTTP response counts, 404 and 500 included — a 404 on `/` is a server that is up and routing. Anything that turns out not to speak HTTP is checked with a plain TCP connect from then on, so a database registered as a project doesn't collect a protocol error in its log every few seconds
- **Ports it can't invent.** "Default port" is the address PortDash opens, pins and checks — it does not change what your program listens on, and the dialog says so. When a project has one recorded, PortDash checks nothing else is already on it before starting and names what is, rather than letting the start fail with `EADDRINUSE` inside the child. Static sites found by scanning each get their own port instead of all being handed `8000`
- **Other people's programs stay theirs.** The "other processes" list shows everything on a listening port, but only offers to stop the ones that might be yours. macOS's own agents and running apps get no lifecycle buttons: ControlCenter holds `:5000`, and a Pause button on that row is a SIGSTOP on your menu bar

## Memory protection (so one runaway service can't take the whole machine down)

A watchdog scans the full system process table every 2 seconds, through five gates:

| Gate | Trigger | Action |
|---|---|---|
| Node heap cap | `NODE_OPTIONS=--max-old-space-size` injected at start | node OOMs itself instead of exhausting system memory |
| Per-project soft limit | process group RSS > `projectRssMB` (default 4G), unless that project is exempt | SIGSTOP freeze, preserves the crash scene, alert with a way back |
| Per-project hard limit | > `hardRssMB` (default 10G) | SIGKILL immediately, no more mercy |
| System-wide pressure | available memory < 12%, or swap usage > 4G | freezes whichever project is using the most memory right now; if the offender wasn't started by PortDash, you just get a warning |
| Start-burst gate | memory already tight, or the same project started more than 3 times in 60s | refuses to start, tells you to check the logs first |

**Freezing is not killing.** The process is still there, holding its memory and its ports — after reading the logs you can resume it and keep going, or stop it and call it done.

The alert that announces a freeze carries both ways out. **Resume** puts it back as it was. The second button — **Allow 8.0G and resume** for a project on the 4G default, since it offers twice what it had — raises that project's own limit and thaws it in one step. Doing those separately would mean thawing something that is still over its limit, and the watchdog would freeze it again two seconds later.

For something that legitimately gets heavy — a scan, an import, a long build — **"never freeze this one"** under "Edit" turns off its own limit for good. The hard limit still applies, because that one exists to stop a runaway taking the machine down, and so does the system-wide gate: that fires on a fact about the machine rather than a guess about your project.

All thresholds live under `limits` in `~/.portdash/config.json`; individual projects can also override them in the UI.
Set `limits.enabled` to `false` if you'd rather it stay out of your way entirely.

## Configuration

Everything lives under `~/.portdash/`:

| File | Purpose |
|---|---|
| `config.json` | scan roots (`scanRoots`), UI port (`uiPort`), scan depth (`scanDepth`), memory limits (`limits`), and how long a service may take to answer before the row stops saying "starting" (`readyGraceSec`, default 60s — raise it if a cold first build here really is slower than that) |
| `projects.json` | the project registry. Auto-generated on first run; later rescans only add, never overwrite |
| `state.json` | bookkeeping for processes PortDash itself started |
| `token` | API token, generated on first run, mode `0600` |
| `portdash.log` | PortDash's own output, rotated at 2MB |
| `logs/` | one log file per project, auto-archived to `.old` once it passes 5MB |

The start command is guessed from `package.json`'s `scripts` at scan time (`dev` > `start` > `serve`). If it guessed wrong, fix it with "Edit" in the UI — it won't be overwritten after that.

## Security

The API can start processes, so it's locked down on three axes: the `Host` header must be
local (blocks DNS rebinding), a cross-site `Origin` is rejected, and every `/api/` request
must carry the token from `~/.portdash/token` in an `X-Portdash-Token` header. The first two
stop a web page from reaching it; the token is what stops *other processes on your machine*,
which matters more once it's running full time as an agent.

To drive it from a script:

```bash
curl -H "X-Portdash-Token: $(cat ~/.portdash/token)" http://localhost:7777/api/state
```

## Notes

- Quitting PortDash doesn't stop services it already started — they keep running in the background, and PortDash re-adopts them on the next launch
- The watchdog only auto-acts on processes PortDash itself started; it won't touch anything you ran by hand
- PIDs get recycled, so a record is only trusted while the process holding that pid is still as old as the record — otherwise it's dropped rather than risk signalling a stranger
- If the port is busy PortDash waits and retries rather than exiting, and only starts its watchdog once it owns the port. It also recognises another PortDash anywhere on the machine: when two share a `~/.portdash` the older one keeps the watchdog and the younger one just serves its dashboard, so they never freeze things independently or overwrite each other's records
- The UI only listens on 127.0.0.1 — it's not exposed to your LAN

## Development

```bash
npm test
```

Two layers. `test.js` calls the small pieces directly — the decisions that are invisible
in the code, like why an app is named by its bundle and not by the binary inside it, or
why one line has to come before another. `test-http.js` starts a real PortDash as a child
process and drives it over HTTP, which is the only layer that can see a problem like a
synchronous call freezing the dashboard: that isn't a wrong answer from any one function.

The tests never touch your real `~/.portdash` — the child gets a temporary `HOME` and a
project invented for the occasion — and the sandbox's memory limits are set high enough
that the watchdog still runs and samples but can never reach a threshold, so the suite has
no way to signal anything on the machine running it.

The built-in test runner needs Node 18 or newer. PortDash itself still runs on 16, and
none of this ships: `files` in `package.json` is what goes to npm.

## License

MIT
