# PortDash

A visual control panel for local dev servers. Single file, zero dependencies — just Node's built-in modules.

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

**Platform**: built and tested on macOS. The Linux code path (`/proc/meminfo`, `lsof`, `ps`) is implemented but not yet verified on a real machine — issues and PRs welcome. Windows isn't supported.

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
- **Logs**: anything PortDash starts gets its output recorded under `~/.portdash/logs/`, viewable right in the UI
- **Recognizes servers you started yourself** — if you ran a dev server by hand in a terminal, PortDash matches it to the right project by working directory and lets you control it too

## Memory protection (so one runaway service can't take the whole machine down)

A watchdog scans the full system process table every 2 seconds, through five gates:

| Gate | Trigger | Action |
|---|---|---|
| Node heap cap | `NODE_OPTIONS=--max-old-space-size` injected at start | node OOMs itself instead of exhausting system memory |
| Per-project soft limit | process group RSS > `projectRssMB` (default 4G) | SIGSTOP freeze, preserves the crash scene, alert shown in the UI |
| Per-project hard limit | > `hardRssMB` (default 10G) | SIGKILL immediately, no more mercy |
| System-wide pressure | available memory < 12%, or swap usage > 4G | freezes whichever project is using the most memory right now; if the offender wasn't started by PortDash, you just get a warning |
| Start-burst gate | memory already tight, or the same project started more than 3 times in 60s | refuses to start, tells you to check the logs first |

**Freezing is not killing.** The process is still there — after reading the logs you can "Resume" and keep going, or "Stop" and call it done.

All thresholds live under `limits` in `~/.portdash/config.json`; individual projects can also override them in the UI.
Set `limits.enabled` to `false` if you'd rather it stay out of your way entirely.

## Configuration

Everything lives under `~/.portdash/`:

| File | Purpose |
|---|---|
| `config.json` | scan roots (`scanRoots`), UI port (`uiPort`), scan depth (`scanDepth`), memory limits (`limits`) |
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
- If the port is busy PortDash waits and retries rather than exiting, and only starts its watchdog once it owns the port, so a second copy never competes with the first
- The UI only listens on 127.0.0.1 — it's not exposed to your LAN

## License

MIT
