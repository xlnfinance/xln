# Prove staged Ignition composition with canonical XLN Hanko

Type: prototype
Status: resolved
Blocked by: None

## Question

Can one Ignition deployment identity execute ten base operations, construct the canonical Foundation Hanko from deployed addresses, append the stablecoin-registration Future, and recover after process interruption without duplicate transactions or changing the first action nonce?

## Answer

Yes for the measured local operation-4 and operation-11 mined-before-receipt cuts. Each actual SIGKILL was followed by a new process using the same journal. Both cases completed with eleven successful intended stack transactions, Foundation nonce 1 and no new transaction on a complete rerun. The operation-11 Hanko bytes were identical before and after interruption. The probe waited at receipt depth 11 and completed at depth 12.

Historical result: the owner deleted the local evidence and machine result on 2026-11-13. The throwaway prototype source is outside this production commit; no prototype branch or commit was created. The resolved status and measurements above record the earlier composition result, not current production acceptance. Fresh owning checks are required before the next deployment or completion claim. Reorg and all remaining failure cases are still unrun.

## Comments

2026-11-11: The owner explicitly requested a prototype on a local node. A runnable CLI with real HTTP Anvil, real contracts, native Ignition journal and canonical Hanko was used instead of the skill's generic HTML state-machine demo. No production executor, UI, shared catalog or public deployment was changed.
