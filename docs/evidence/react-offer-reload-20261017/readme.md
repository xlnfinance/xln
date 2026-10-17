# Exact React resting-offer recovery

Baseline main `4d78d9aeb836be6ef84c87d1efc3dd321df496f0` failed the original named WETH/USDC offer-reload scenario in57.097s at the retired Svelte `context-current` dropdown, before any financial action. The current test now imports the canonical React wallet, funds the actual H1 Account and uses the existing real resting-limit helper. Six unused Svelte-only sizing/unlock helpers were removed after their last callers disappeared. All17 root swap test identities/order remain unchanged.

The shared resting-limit test now always reloads and password-unlocks before cancellation. It checks the same Runtime and Entity identities, exact Account root/height/balances/holds and complete order history, then the same published own bid price/size and visible obligation. It never recreates or resubmits the offer. Delivery drains through the existing queue assertion, moved unchanged to the shared evidence reader used by both cancellation and resting-limit tests. No production transition, wallet, storage, Rust, compiler, contract or protocol implementation changed.

The original price rule remains best ask minus0.01USDC, with order value at most25USDC. The measured surviving obligation is22.504410USDC for0.009WETH at2500.4900. All amounts/root/history are exactly equal before and after reload; no tolerance. Following cancellation, the same offer has one zero-fill cancel resolution, restored spendable balance, no holds, no published own bid and no visible cancel action. Screenshots show the restored published2500.4900 bid and its exact0.009WETH size beside the open obligation.

| Verification | Result | Seconds |
| --- | --- | --- |
| Original offer-reload, current React path |1/1 |48.951|
| Manual edited limit, now including recovery |1/1 |49.631|
| Within-band resting limit, now including recovery |1/1 |34.617|
| Shared mobile cancellation with both reloads |1/1 |40.371|
| Same-options strict type comparison |35→34 existing diagnostics,0 new; modified shared helpers0 |9.383|

The first type comparison identified two newly unused parsing helpers after the obsolete caller was deleted; they were removed, not suppressed. The34 remaining pre-existing root-file diagnostics are explicitly not a whole-file type pass. Existing project gates are unchanged. The broader checks and clean committed run are recorded in the publication artifact and installed verifier result.

All browser runs use the canonical real isolated launcher, actual RPC/relay, Account worker and current checkpoint/ordered WAL, strict browser health, capacity-one stand and60s wall budget. No fake feeds, financial state injection, test skip or timeout increase. The related runs are separate named cases on the same frozen source/build, not a claim that all17 root cases or the aggregate release suite passed. Full release/browser, funded public-chain exit/dispute, required uninterrupted soak and MacBook synchronization remain open. Compatible backend rollback has independent published evidence; it is not a substitute for this browser recovery test.

Artifacts and exact command logs: `/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/swap-offer-reload/` and sibling `swap-offer-reload-*-boundary/` directories. Full reports, trace where retained, runtime/build identities, decoded financial evidence and screenshots remain there. The committed source hash manifest and command records bind this slice; the later clean-HEAD verifier supplies exact release SHA evidence.
