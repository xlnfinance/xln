# Prove a one-USDC reserve roundtrip on Ethereum Sepolia and Arbitrum Sepolia

Status: ready-for-agent
Created: 2026-11-11
Source: former ticket 02 of the [deployment effort](../sepolia-arbitrum-deployment/spec.md)

## Outcome

On each public network independently, an external signer deposits exactly `1_000_000` USDC atomic units into an XLN reserve and withdraws exactly `1_000_000` units back to the same wallet. Confirmed receipts and raw balance snapshots prove the intermediate deltas and final restoration of the token and reserve balances. Native ETH costs are accounted for separately.

The owner explicitly separated this task from the immediate contract-deployment scope on 2026-11-11. This record preserves the accepted Q6 financial test; it does not authorize starting it as part of deployment work.

## Implementation and Acceptance

- Build one thin browserless probe using existing production signing/batch, RPC and reserve/token primitives. Verify a genuine local fixture first, then reuse the same behavior on both public networks. No new financial implementation or UI flow.
- Ethereum Sepolia: chain ID `11155111`, existing Circle testnet USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, six decimals.
- Arbitrum Sepolia: chain ID `421614`, existing Circle testnet USDC `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d`, six decimals.
- Before any financial operation, verify the current stack, chain, token and six-decimal identity, signer funding and clean debt-free reserve. Public execution requires verified deployment manifests from the separate deployment effort; implementing the local probe does not require either public deployment to finish first.
- Preserve confirmed approval evidence where applicable, deposit/withdrawal receipts, chain-height balance snapshots, exact USDC/reserve accounting and actual native costs including applicable Arbitrum fees. On failure report the phase and known transactions/balances without automatic financial retries or a success claim.
- The [implementation ticket](issues/01-one-usdc-reserve-roundtrip.md) owns local verification and both public roundtrips. Deployment tickets 03/04 own only deployments and registration; there is no reverse dependency on this task.
- Retain meaningful regressions, existing broader financial coverage, repository checks, stand locking and candidate identity. A local simulator, UI balance or Ethereum-only proof does not establish public withdrawal on both networks.

## Out of Scope

UI, contract deployment infrastructure, shared catalog publication, settlement/dispute expansion, Cross-J transfers/recovery, quotes, MM operation, bridges, new tokens, mainnet and real-funds activation.

The local [CLI probe](../../docs/deployment/usdc-reserve-roundtrip.md) is implemented;
its final owning run passed 15 real-Anvil tests / 65 assertions in 227.39 s on
the dirty candidate based on `2df74f251d3ff3a869738ee1b77787f4be58185b`.
The applicable deployment profile passed all six gates; local implementation
and verification are complete. The owner-selected public Ethereum Sepolia run
then passed: three successful receipts at depth twelve or more, wallet
`9 -> 8 -> 9` USDC, reserve `0 -> 1 -> 0`, debt zero and exact native fees
of `12869822` wei. See the [public result](../../docs/deployment/usdc-reserve-roundtrip.md#public-ethereum-sepolia-result-2026-11-14).
The separately owner-selected public Arbitrum Sepolia run also passed unchanged:
wallet `20 -> 19 -> 20` USDC, reserve `0 -> 1 -> 0`, debt zero, three successful
receipts at depth twelve or more and exact native fees of `7654409540000` wei.
Independent read-only Foundry `cast` verification passed both public runs. See
the [Arbitrum result](../../docs/deployment/usdc-reserve-roundtrip.md#public-arbitrum-sepolia-result-2026-11-14).
The implementation ticket is complete with **12/12** acceptance criteria checked.
The executable probe was subsequently committed as
`c8fcff807e26af4569d9135d08216c1b93efce0a`, with all checked source contents
unchanged. Original public reports retain the actual dirty execution identity;
this is scoped roundtrip acceptance, not Cross-J or whole-product release evidence.
The owner-approved MacBook Pro M5 and existing-branch
exceptions continue to apply; preserve unrelated source and tracker work.
