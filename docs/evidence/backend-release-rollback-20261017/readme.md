# Compatible backend release rollback: public testnet

On clean `9967734624cd70bebf4bb60992791efc5a36cdc5`, the actual managed backend was stopped, moved back to retained compatible release `efb6f5d4181114457cf3d62077c5d624b9fef9b3`, recovered from the existing checkpoint/ordered WAL, and then fast-forwarded back to `996773462`. Both real transitions passed. This is application source rollback under pinned Bun1.4.0, not a Bun executable downgrade or an old-format reader. Studio main remained unchanged during the drill. No production source, contracts, storage format, credentials, access policy or data were changed for this proof.

The first diagnostic failed in1.727s: a plain source archive is not an executable deployment artifact because the canonical orchestrator requires actual Git provenance (`ORCHESTRATOR_GIT_FINGERPRINT_FAILED`). That check was retained. The real deployment checkout, verified Git bundle and exact source archives provide the artifact. The bundle requires the retained base90b4408c; `git bundle verify` passed. The actual backend delta is the same price-band formula moved to a shared helper, with its callers updated; protocol/storage/contracts/dependency pins are unchanged. Current web builds remained installed byte-for-byte, so this is specifically backend rollback with compatible current clients.

| Boundary | Result | Wall seconds |
| --- | --- | --- |
| Invalid expected source SHA | Named rejection before any stop/write |1.938|
| Current source/financial/web preservation |27 Account views,3 Runtime frames,1486 files; verified bundle |18.893|
| Backend rollback |996773462 → efb6f5d41; recovery31.400s |39.226|
| Historical/current financial comparison after rollback |3/3 hubs,27 views exact |13.159|
| Actual HTTPS browser on rollback backend |8/8; real Account worker,14 relay frames, no page/HTTP/request errors |27.852|
| Fresh preservation before return |28 Account views including browser-created Account |3.374|
| Return to current backend |efb6f5d41 →996773462; recovery31.640s |39.456|
| Historical/current financial comparison after return |3/3 hubs,28 views exact |14.081|
| Actual HTTPS browser after return |8/8; real Account worker,16 relay frames, zero errors |31.205|
| Final canonical operator health |3 hubs,1 tower,0 open incidents; exact clean source |0.936|

The separate command records include final browser and health timings. All heavy commands held local and remote capacity-one locks with60s budgets. Each transition drained the exact7-process Runtime tree before changing source; both new trees use the same pinned Bun. The server PID moved1069917→1074154→1075424. Other PM2 owners, protected file hashes/modes and all1486 web files remained unchanged. Each transition has zero occurrences of all7 recorded crash/quiesce/shutdown/forced-kill failure markers. No reset marker, `reset --hard`, `git clean`, force push, new branch or worktree was used.

Financial checks read production RemoteRuntimeAdapter historical views and Runtime frame hashes/post-state hashes, then compare current Account roots, balances and credit limits exactly. One Account per hub advanced by one linked post-restart `set_credit_limit` frame with unchanged financial root; the complete previous/new frames are retained privately in the remote evidence directory. This explicit signed-frame explanation was required; balances were not compared with tolerances. The second transition uses a fresh baseline, including the new Account created during the first real browser run.

## Executed operator commands and reuse boundaries

The exact scripts are attached and hash-indexed. `run-phase.sh rollback` invoked `switch.py rollback 9967734624cd70bebf4bb60992791efc5a36cdc5` under the existing remote stand. After preservation and owner/PID/clean-main/hidden-index/ancestry/format/web checks, the script ran:

```bash
pm2 stop xln-server
git reset --keep efb6f5d4181114457cf3d62077c5d624b9fef9b3
pm2 restart xln-server --no-treekill --kill-timeout 60000
```

The exact return command was `run-phase.sh restore`, selecting the preserved current release with `git -c merge.autostash=false merge --ff-only --no-overwrite-ignore 9967734624cd70bebf4bb60992791efc5a36cdc5` between the same managed stop/start. These are recorded operations, not instructions to run the three unguarded commands alone. The scripts intentionally reject repeated phases and changed process/source identity. A future rollback must first create a fresh evidence directory and current financial snapshot, verify the target's compatibility and preserved source bundle, and bind the exact current managed PID. Never reuse this successful record as permission to roll back an incompatible schema or unknown dirty checkout. Do not push the deployment checkout backward.

Local artifacts: `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/backend-rollback/`. Remote private logs, complete state/frame proofs and source/web archives: `/root/xln-deployment-evidence/996773462/backend-rollback/`. Screenshots and F12/worker/relay evidence are preserved for both phases. The source archives are byte preservation; they cannot replace the required real Git checkout.

This closes the compatible backend release rollback drill for current996773462 on chain31337. It does not prove arbitrary future-version rollback, schema migration, Sepolia/mainnet settlement or a one-hour soak. Full aggregate release/browser, funded public-chain exit/dispute, uninterrupted required soak and MacBook synchronization remain open. Irreversible mainnet activation still needs the owner's decision.
