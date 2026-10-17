# Public testnet pinned-runtime deployment and recovery

The deployed, clean application is `33260898b968f1b6c70ea0b702048f1997598466`.
This is Ethereum/Anvil testnet evidence, not Sepolia financial proof or mainnet readiness.

The canonical deployment functions built the web archive in 17.888s. Its SHA256 was
checked after upload, then all 1,338 installed files were checked against the archive.
Source advanced with the existing clean-main fast-forward guard. Only xln-server and
xln-watchtower were stopped and restarted; existing Anvil, Sepolia and unrelated PM2
owners were preserved. Seeds, keys and their modes matched the preserved hashes.
No data reset, key replacement, global runtime replacement or access-policy change occurred.

Eight actual required processes now use the verified app-scoped Bun 1.4.0 binary:
orchestrator, three hubs, market maker, custody daemon, custody service and watchtower.
Their executable paths were read from /proc, including after the later restart.
The existing global Bun remains 1.3.14. PM2 saved the scoped PATH; its prior dump and
process environment are preserved privately outside source. The first observer expected
an extra standalone custody wrapper and failed after startup; current orchestrator code
launches the two custody children directly. The corrected read-only observation passed
without another restart. The failing command remains in the archive.

## Actual current-format recovery

Before each stop, canonical Runtime adapter reads captured the committed Runtime frames
and Account states. After stop, zero open store handles were required before backup.
Current checkpoints and WAL were retained. All backup bytes are preserved on both hosts
outside source with mode 0600; archive digests are recorded in the operator evidence.
No raw database, seed or PM2 environment is included in this documentation archive.

After the toolchain switch, all three historical/current comparisons passed in
5.962, 17.298 and 15.997s. A second real shutdown/restart on Bun 1.4.0 completed in
45.053s command time, with managed recovery taking 39.357s. It emitted zero NAPI fatal,
Bun crash or panic markers. The old 1.3.14 stop had crash headers for all four financial
runtimes. This is one observed successful 1.4.0 restart, not a general crash fix or soak.

The second restart's comparisons passed in 5.859, 18.064 and 15.937s. Across 22 Account
views, the exact historical Runtime frame hashes/state hashes and historical Account
states match; current financial roots, balances and credit limits also match. A new
custody credit-policy frame per hub links the old frame, with unchanged financial root.
Twenty-two views are not a claim of 22 unique economic Accounts. This comparison does
not substitute for ordered-outbox replay evidence.

Peer-close warnings and one MM `quiesce.post_failed` warning remain in the private
shutdown log; therefore this is not a warning-free shutdown claim. Exact-source canonical
operator health passed in 1.192s: three hubs, self relay, one watchtower, zero open incidents.
The incident journal was not reset or cleared during this deployment.

## Browser and remaining boundaries

Real public HTTPS gateway passed all eight checks in 39.233s: /app wallet redirect,
fresh embedded wallet and Account workers, exact runtime/worker MIME and hashes,
relay traffic, deep-route reload/unlock, pinned compiler preview with unavailable
arbitrary admission, and preserved observer graph. Console/page/HTTP errors: zero.
Actual runtime and worker hashes are in results.json. Both host stands covered the run.

The earlier full financial local browser remains 1/1 on clean 33260898b; full check
passed 38 source plus three top gates and the installed verifier passed before push.
Public reserve broadcast still returns 403 under the explicit read-only RPC policy;
the narrow unapplied owner-decision proposal remains pending. No unsafe RPC flag or
alternate signing path was introduced. The earlier unexplained public reload timeout,
aggregate release/full-browser evidence, Sepolia financial/dispute proofs, compatible
rollback, uninterrupted one-hour soak and MacBook catch-up remain open.

Exact commands, exits, durations, assertions and bounded operator procedures are in
command-evidence.tar.gz. Private backups and original job artifacts remain under the
xln-mainnet-autonomy-20261017 job directory and /root/xln-deployment-evidence/33260898b.
