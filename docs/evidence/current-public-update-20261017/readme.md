# Current public testnet update and web rollback

Checked and deployed source: `efb6f5d4181114457cf3d62077c5d624b9fef9b3`.
Previous live source: `33260898b968f1b6c70ea0b702048f1997598466`.
The public RPC reports Anvil chain31337. This is testnet validation, not mainnet
activation or a public Sepolia financial proof. This commit records evidence;
it does not change production code, financial semantics, formats or contracts.

## Update and current-format recovery

The canonical `deploy-platform.sh --remote xln.finance --frontend-only --production`
built and installed the published artifact in28.894s. Its existing remote-main guard
required a clean main and an exact published fast-forward. No reset, nginx change,
credential change or service restart occurred in that command. The previous compiled
web roots were preserved before installation, together with23 Account views and3
historical Runtime frame hashes/state hashes (7.900s).

A separate exact-owner PM2 restart used the existing parent-only shutdown policy,
`--no-treekill --kill-timeout 60000`, without `--update-env`. It completed36.624s;
managed recovery took31.824s. The server PID changed1014368→1045083. Anvil, watchtower,
the separate Sepolia watchtower and logrotate owners were unchanged. Protected file
hashes/modes were unchanged. All7 recorded crash/quiesce/shutdown failure counters
were zero. Existing current JDB/RDB stores were preserved, not regenerated.

The initial equality assertion on entire latest Account views failed1.414s. The
first mismatch was height7→8 with the same financial root and every balance/limit.
The existing historical comparison then passed for all3 hubs in10.628s: all23
historical Account states, all3 historical Runtime frames, and every current financial
root/balance/limit matched exactly. Each hub's one advanced Account linked the
preserved frame hash, contained only `set_credit_limit`, and was timestamped after
restart. This explains the new credit-policy frames without weakening historical
recovery assertions. Both the failed command and complete comparison evidence remain
in the archive. Account views are not unique economic operations.

## Exact delivered artifacts and reversible web installation

Initial public HTTPS verification passed8/8 in25.734s with a fresh embedded wallet,
real Account workers, relay traffic, deep-route reload/unlock, compiler preview with
financial admission unavailable, and graph observer. Console errors/warnings, page
errors, HTTP failures and request failures were all zero.

The existing `web-artifacts.sh` installer then restored the preserved previous web
archive (16.211s,1338 exact files). The same real browser verification passed8/8 in
25.762s. Finally, the saved current archive was reinstalled (8.718s,1385 exact files),
and browser verification passed8/8 in29.810s. Both phases checked actual public
`/ui/` HTML and its main JavaScript digest against their selected archive. Runtime
and Account-worker bytes/MIME were checked against the current canonical local build.
All browser issue counters remained zero. Every web-install phase preserved process
identities and protected file hashes/modes; no backend restart or data reset occurred.

Preserved archives are outside source on the host at
`/root/xln-deployment-evidence/efb6f5d41/current-update/`:

- `previous-web.tar.gz`: SHA256 `9eb715c0e843c03d858450a145f2aa33e2f78ef71669b8089b77f3c46b1f30f4`.
- `current-web.tar.gz`: SHA256 `bf4fed2b56f93ee3faf17e445d77ee2ec4cb18faed377e56c9f4367db1d640f9`.

Final exact-source operator health passed1.196s:3 hubs, self-relay,1 tower,0 open
incidents. The public backend and current web artifact remain on the checked source.
The financial engine, storage, contract, dependency and startup implementations were
unchanged between these two sources; the core production difference is an export of
an existing public stack-identity parser. This specific compatibility does not imply
that an arbitrary prior backend can read a later checkpoint/WAL.

## Limits and reproduction

This proves a web artifact rollback against the current backend, not backend binary
rollback. It does not replace loaded in-flight crash tests, ordered-outbox replay,
uninterrupted1hsoak, full integrated release/browser gates or public Sepolia proofs.
The public signed-broadcast403 policy decision remains open. Existing MacBook access
still failed at21:02UTC (2.095s); no service/access settings were changed.

`results.json` records exact commands, exits and durations. `proof.json` contains
safe public roots, comparisons, artifact digests and browser results.
`command-evidence.tar.gz` retains bounded procedures and actual outputs, including
failures; `sha256.json` identifies these artifacts. Private environments, tokens,
keys and databases are excluded. Procedures contain exact host/source/PID guards;
inspect current owners before adapting them, and never blindly reuse an old PID.
