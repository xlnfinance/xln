# 14: Prepare the public five-run and recovery budget

Type: implementation
Category: enhancement
Completed: no
Status: ready-for-agent
Blocked by: 11 - Separate operator funding

Prepare a read-only public plan for five sequential 1-USDC journeys on the
selected funded stand. This follows the owner-approved single-run closure of
[05](05-public-preflight-and-gas-plan.md) and
[06](06-public-sepolia-arbitrum-proof.md) on 2026-11-19. The existing five-run
capital decision and [original funded Runtime restore](12-public-rpc-capacity-and-funded-catchup.md)
provide the funded baseline.

## Acceptance criteria

- [ ] Reconcile the original funded reserves after restore. Keep the once-only
      operator funding, the source user's five 1-USDC deposits, and the
      cumulative gas reservations separately measurable.
- [ ] Before each run, require both operators ready, an executable quote for
      the full 1 USDC, effective signed tariff, exact target credit, available
      reserve net of obligations, user principal, and payer nonces and ETH.
      Require the preceding run's effects to be resolved before admission.
- [ ] Estimate and separate the native reservation for all 15 source user,
      five target Hub and five target user nonce slots. Record fee and posted
      gas assumptions, estimation prerequisites, and applicable Arbitrum
      posting costs. Re-estimate each signed call after its prerequisite state
      is confirmed.
- [ ] Identify recovery limits by payer, chain, signed obligation and gas.
      Use the same WAL and existing nonce/fee grant for accepted work. Prepare
      separate numeric caps for additional calls such as new-nonce retries,
      forced dispute or finalization when required.
- [ ] Verify eligible and blocked outcomes. Produce an unsigned plan bound to
      the candidate, catalog, identities, anchors, run IDs and limits. Obtain
      separate owner approval before any public financial execution.

## Evidence

At the single-run per-slot caps, the five-run reservations would be 0.009 ETH
for the source user, 0.00025 ETH for the target Hub and 0.00035 ETH for the
target user. These are illustrative ceilings. The final plan requires refreshed
estimates and separate funding and recovery budgets.

- [Five-run capital and gas decision](../../../docs/runtime/usdc-poc-capital-plan.md)
- [Single-run payer caps and gas observations](../../../docs/evidence/ts-usdc-cross-j-poc/fresh-ubkyjm-journey-preflight.json)
- [Recovery matrix](../../../docs/evidence/ts-usdc-cross-j-poc/local-evidence.md#interrupted-recoveryjson)
- [Retained fresh-demo recovery and reuse evidence](05-public-preflight-and-gas-plan.md#recovery-evidence-for-follow-up)
