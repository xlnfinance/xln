# Tutorial replay visibility and RPC response compression

This candidate fixes two observed production boundaries on top of
`3d15dbda87f74b8e32ba6af59cc8f2471fa4bad9`. The accompanying source hashes bind the
tested files; this record alone is not evidence that the candidate is deployed.

## Observed failures and changes

On the actual public mobile wallet, clicking Settings → Replay reached the `pay`
chapter but left its guide above the viewport: scrollY 2637, card top −2518px,
bottom −2367px. The earlier 104 recorded public tutorial checks verified chapter
transitions, completion, restart and reload; they did not establish visibility of
the restarted guide. The new check waits for the real card animation to finish
and requires its full bounding box to be inside the viewport without an extra
scroll or click. The canonical guide scrolls its unanimated section into view
when the chapter or route changes; typing and periodic guide updates do not
trigger this effect. The same current-format profile then passed with scrollY 0,
card top 118.77px, bottom 269.84px, zero errors and zero extra faucet grants.

Public startup observations also recorded 1160 bulk RPC responses carrying
260,928,418 encoded bytes, all without Content-Encoding. The real Nginx
reproduction found a concrete MIME defect: the orchestrator emitted
`application/json, application/json` because differently cased header keys were
combined. One lowercase Content-Type owner removes the duplicate. The canonical
deployment helper enables bounded JSON gzip only on the existing RPC locations,
preserves their orchestrator upstream and rejects ambiguous/conflicting blocks.
It reloads Nginx even when disk bytes already match, so an interrupted prior
configuration write does not leave old workers serving silently.

## Focused evidence

| Boundary                          | Result                   | Scope                                                                                          |
| --------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------- |
| RPC/configuration L1              | 109/109; 1859 assertions | Includes exact MIME and canonical route preservation                                           |
| Updated owning fixture discovery  | 57/57; 1027 assertions   | Overlaps the L1 suite; counts must not be added as distinct tests                              |
| Real Nginx → orchestrator → Anvil | 15/15; 3.288s            | Both RPC routes, exact decoded bytes, RPC denylist and batch limit                             |
| Exact funded tutorial rerun       | 1/1; 160.150s wrapper    | Actual Pay, Swap, Activity and Finish with the required real market maker                      |
| Whole owning React tutorial suite | 5/5; 263.975s wrapper    | Strict browser health; desktop/mobile Replay, no extra grants, unrelated WETH credit rejection |
| Same mobile Replay artifact       | 1/1; 14.264s browser     | Actual public backend with candidate assets; not a deployed-public claim                       |

The real compression test held the one-machine stand lock. For each route,
224,507 identity bytes became 20,291 gzip bytes: 90.96197% fewer bytes. The decoded
body remained byte-exact, SHA256
`30226949dc3686f20e1ebf43a780a33391cf6942eb1f09439ee9c2547871a07a`.
This is a response-size measurement, not an end-to-end public startup result.

The first owning tutorial rerun exposed a missing fixture requirement: its
market maker was disabled and the real orderbook had zero offers. The owning
test now declares and checks the canonical market-maker requirement. No fake
offers, disabled assertions, retries or skips were added. The exact failed
scenario passed before the five-test suite was expanded again.

## Release boundary

Exact `bun run test:unit` passed 5502 tests with 0 failures, 1 existing conditional
Rust semantic-completeness skip and 677,288 assertions in 1413.164s. Exact
`bun run test` passed 5/5 RPC scenarios and 1/1 Chromium scenario with 0 skips in
150.307s. Both commands recorded unchanged source. The existing Rust skip does
not establish complete Rust parity. A current `bun run check` and the checked committed SHA are required
before push/deploy. The public Replay/whole tutorial/boot checks must be repeated
against the served version after publication. Frontend publication can preserve
the running financial backend; the MIME fix requires a later checked backend
activation with current full-release and retained checkpoint/WAL recovery proof.

No protocol, durable schema, contract, dependency or frozen-core file changed in
this candidate. Current backend activation, all required financial release gates,
public Ethereum/native TRON acceptance and the uninterrupted soak remain separate.
No mainnet-readiness claim is made.

Raw private evidence remains under
`/Users/zigota/agent-jobs/xln-prod-rescue-20261019`. The public artifact allowlist
excludes browser profiles, seeds, credentials, wallet storage, WAL and complete
financial-state dumps. Source/log digests and sanitized result records are the
durable evidence included here.
