# Mac Studio test machine

The Mac Studio is the only machine for builds, tests, stands and agents (AGENTS.md).
The MacBook controls it remotely. This page records how to reach it, what it should
measure, and how to recognise and fix the throttled state found on 2026-10-26.

## Hardware and access

- Apple M3 Ultra (`Mac15,14`): 24 performance + 8 efficiency cores, 512 GB RAM,
  3.6 TB SSD, FileVault ON. Repo at `/Users/zigota/xln`, user `zigota`.
- From the MacBook: `ssh mac-studio`. This is `ProxyJump studio-relay`
  (`xln.finance`) to `127.0.0.1:22222`; see `~/.ssh/macstudio.conf`.
- The reverse tunnel is the system daemon `com.egor.mac-studio-tunnel`
  (RunAtLoad + KeepAlive, runs as `zigota`). It comes back after a reboot without a GUI login.
- Fallback remote desktop: RustDesk and Jump Desktop, both system daemons. Screen Sharing
  (port 5900) is on: `ssh -f -N -L 5901:127.0.0.1:5900 mac-studio && open vnc://127.0.0.1:5901`.
- Turning the Red Shield VPN on or off changes routing and kills the reverse tunnel for
  about 15 minutes (SSH shows `banner exchange` timeouts). KeepAlive restores it; just wait.
- Passwordless root diagnostics only (`/etc/sudoers.d/xln-diag`):
  `sudo -n /usr/bin/powermetrics`, `/usr/sbin/spindump`, `/usr/bin/taskinfo`.
  Nothing else runs as root without the owner typing the password.
- The public testnet (`xln.finance`) does not run on the Studio. User services on the
  Studio (hermes and openclaw gateways, `chatgpt.roster.*` with a zrok share, `com.xln.whisper`)
  are user LaunchAgents: after a reboot they start only when someone logs into the GUI
  (RustDesk).

## Expected performance

Benchmark, single Bun process (`bun -e`) running a 1e8-iteration modulo loop:

```sh
bun -e 'let t=performance.now();let x=0;for(let i=0;i<1e8;i++)x=(x+i*7)%1000003;console.log(Math.round(performance.now()-t))'
```

| Machine / state | 1 copy | 16 copies (each) | 24 copies (each) | `taskpolicy -c background` |
|---|---|---|---|---|
| Studio, healthy (after reboot 2026-10-26) | ~350 ms | ~360 ms | ~365 ms | ~800 ms |
| Studio, throttled (before) | ~1030 ms | ~2400 ms | ~3300 ms | ~1040 ms (same as default) |
| MacBook M1 Max | ~550 ms | n/a | n/a | ~1160 ms |

E2E on a healthy Studio (`bun run test:e2e:full`, 16 lanes, MM x4, reset x1):

- Single isolated stack: ~20 s total. For example the screenshot smoke is health ~10 s,
  pw ~7 s. It took 87 s while throttled.
- Full 158-target run: TBD (first healthy run 2026-10-26, see `.logs/claude-20261026/e2e-full-9.log`).
- While throttled, 16 lanes overloaded the 8 usable cores (blank pages, 30 s UI
  timeouts) and a full run took ~2 h.

## Throttled state: symptoms and fix

Symptoms, all measured on 2026-10-26 after 12 days of uptime:

- The single-copy benchmark ran ~3x slower than healthy, and equal to the
  `taskpolicy -c background` clamp.
- Throughput saturated at ~8 copies.
- `sudo -n powermetrics -n 1 -i 2000 --samplers cpu_power` under load showed:
  - all P-clusters at 0 MHz and 100% idle;
  - E-clusters at 100% load at their minimum frequency (1.0-1.3 GHz);
  - CPU power ~0.5 W.
- Thermal pressure was Nominal, the power source was AC, there was no UPS, and
  `lowpowermode` was 0.

Ruled out:

- Rosetta, a VM, Low Power Mode, the ssh/GUI/launchd launch context, QoS policy
  (`taskinfo` showed default roles), offline cores and the recommended-core mask.

Fix: a FileVault-preserving reboot that the owner starts and authenticates:

```sh
ssh -t mac-studio 'sudo fdesetup authrestart'
```

It asks for the sudo password, then the FileVault user name (`zigota`, not root) and
that user's password. SSH returns about 1-2 minutes later.

After the reboot, log `zigota` into the GUI (RustDesk or Jump Desktop) before any browser E2E.
Without a GUI session there is no display/notification service and Chrome for Testing crashes
mid-test (`NSNotificationCenter connection invalid`, `CVDisplayLinkCreateWithCGDisplay failed`,
then `signal 10 BUS_ADRALN`). User services also start only after this login, including the
Red Shield VPN app: without it Codex fails with `workspace routing discovery failed`, OpenRouter
returns `403 Access denied by security policy` and Z.ai times out, so every quorum leg is INCOMPLETE.

Before rebooting:

- Make sure no stale user LaunchAgents with `RunAtLoad` would start at login.
- 122 `com.xln.*` job agents from earlier controllers were moved to
  `~/Library/LaunchAgents.disabled-20261027` on 2026-10-26.
- Only `com.xln.studio-native-guard`, `com.xln.studio-prod-rescue-guard` and
  `com.xln.whisper` remain.

## Housekeeping

- Agents keep scratch copies of the repo under `/tmp`, each 6-45 GB. A reboot clears them.
- External model reviews (Codex, GLM via pi `zai-coding-cn`, Gemini/Kimi via OpenRouter) and
  the 3-AI quorum runner live in `~/agent-jobs/claude-ext-20261026/` (`quorum.sh`, `ask.ts`,
  `smoke-legs.sh`). Smoke-test every leg on a known answer before trusting a quorum.
