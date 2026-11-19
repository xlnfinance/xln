# 13: Build the public execution report from exact nonce receipts

Type: implementation
Category: bug
Completed: yes
Status: ready-for-agent
Blocked by: None

## Problem

The public run `fresh-w4vgds-1usdc-20261118-guarded` confirmed all five
transactions and paid 0.899801 USDC to the user's Arbitrum Sepolia wallet.
After finalization, the payout function requested 224 blocks through
`eth_getLogs`. The archive provider allowed 10 blocks per request and
returned HTTP 400. The CLI exited before writing its report.

The public report already resolves all five authorized nonce slots, then
queries a second block range for the target receipts and scans the source
blocks again. On the recorded run, the target range in the report would
have covered 120 blocks. The retained reconciliation recovered the five
receipts by payer and nonce and matched the payout against the user WAL.

[Public execution evidence](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-public-demo-executed.json)
· [Payout function](../../../core/scenarios/usdc-poc/external-payout.ts#L86)
· [Public report](../../../jurisdictions/scripts/usdc-cross-j-preflight/execution/flow/receipt-report.ts)

## Acceptance criteria

- [x] Build the public report from the three source-user slots and the
      two target slots for the selected run ID. Reuse `readNonceReceipt`
      and the authorized call validator. Use those exact results for ingress,
      cover, and payout evidence from finalization through report output.
- [x] Verify the chain and canonical block hash, successful receipt,
      payer, nonce, and authorized calldata. For each Entity batch, match
      `HankoBatchProcessed` from the expected Depository to the Entity, batch
      hash, and Entity nonce. Verify the exact USDC deposit and withdrawal
      transfers, payer ETH accounting, and settled route with zero remainder.
- [x] Exercise the public CLI on the existing two-chain local stand with
      `eth_getLogs` requests limited to 10 blocks. Complete a journey whose
      target report spans more than 10 blocks. Rebuild the report for the same
      run ID with the same five transaction hashes and 0.899801 USDC payout,
      with unchanged payer nonces.
- [x] Verify that the owning standalone and interrupted-recovery scenarios
      still produce their documented evidence. Run the applicable verification
      profile and record the command results.

## Verification

The [owning regression](../../../core/__tests__/market/startup/usdc-public-journey.test.ts)
reproduced the previous failure after withdrawal finalization. The target RPC
rejected the receipt search across 20 blocks with a 10-block limit.

The fixed CLI completed five one-USDC runs on two local Anvil chains. Run 1
used source blocks 39, 41 and 44 and target blocks 43 and 59, a target span
of 17 blocks inclusive. Rebuilding Run 1 after Run 5 produced the same five
transaction hashes and the same 899,801-unit payout. Payer nonces stayed
at 15 for the source user, 5 for the target Hub and 5 for the target user.

The CLI regression passed 1 test with 70 assertions. The standalone run paid
899,801 units with receipts and a matching Transfer. The recovery matrix
passed 3 cases with 8 interrupted processes, with payouts of 899,801 and
899,900 units and an expired partial clear. The repository check passed
3 short gates, 38 source gates and 10 soundcheck gates. Deployment types passed.

```sh
bun run stand:run --reason usdc-exact-receipts-regression --wait-ms 0 --timeout-ms 240000 -- \
  bun test core/__tests__/market/startup/usdc-public-journey.test.ts
bun run stand:run --reason usdc-exact-receipts-standalone --wait-ms 0 --timeout-ms 180000 -- \
  bun core/scripts/operations/production/local-prod-smoke.ts --external-payout
bun run stand:run --reason usdc-exact-receipts-recovery --wait-ms 0 --timeout-ms 180000 -- \
  bun core/scenarios/usdc-poc/recovery-run.ts
bun run check
bun node_modules/@typescript/native/bin/tsc -p tsconfig.deployment.json --noEmit --checkers 4
```

Local candidate based on HEAD `b2dceb3438ff2582cee0c5741fe4a0528f5cbd26`.
The final CLI fixture recorded candidate digest
`aeba1893e56e24232365afb5df76d05c82ed951e6520aba9c731ae802f7bb073`.

## Related tickets

- [08 — Public financial CLI](08-public-financial-cli.md) implemented the
  execution and nonce recovery path.
- [06 — Public Sepolia-to-Arbitrum proof](06-public-sepolia-arbitrum-proof.md)
  owns the public journey and its acceptance evidence.
