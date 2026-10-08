# Design constraints for provable finance

xln's objective is [MML: accounts supporting 51% of world GDP made provable by
2050](intro.md#mission). J/E/A describes existing finance; RCPAN makes bilateral
credit and collateral coexist with executable account proofs.

This document explains design choices. Implementation evidence and launch status
are recorded separately in [mainnet.md](mainnet.md) and release artifacts.

## Local financial activity

Putting every operation through one mandatory shared execution or data pipeline
creates a common resource limit. xln keeps ordinary account updates local to the
parties and their Entity authority; J handles the enforcement and settlement
operations that need it. Independent relationships can add aggregate capacity.

Locality does not imply unlimited capacity. Each Runtime, Entity, hub and route
has hardware and liquidity limits. J must also absorb collateral activity and
credible dispute load. One billion TPS is a target, not a result established by
the topology or a replay benchmark.

## Credit and collateral

Receiving requires available account capacity. A fully collateralized relationship
can receive using backing already available to it. A credit-bearing relationship
can also receive against a deliberately accepted obligation from its counterparty.
RCPAN supports both through one signed account model:

    −leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit

Credit is a policy choice, not a protocol mandate. The parties select risk and
backing manually or through soft-limit policy. The runtime enforces exact agreed
bounds before signing; the J enforces the resulting signed claims. See
[the invariant](core/12_invariant.md) for orientation and grant direction.

## Organizational authority

People, businesses, banks and other organizations need explicit authority to
approve changes. Entity machines make that authority and state verifiable.
Runtime orchestrates their deterministic transitions and publishes external
effects only after commitment; it does not replace their authority boundaries.

## Proof, backing and conditions

A usable proof identifies the signed obligation. Collateral provides backing for
the secured entitlement. Delta Transformers enforce agreed conditions while
value moves. These protections reduce specific failure exposures; unsecured
claims still depend on repayment and J enforcement remains subject to its actual
availability, inclusion and timing rules.

## Programmable jurisdiction

The current implementation uses EVM-compatible J-machines to verify Entity
signatures, execute dispute conditions and atomically settle collateral/reserves.
Ethereum, TRON and XLNC are the initial focus; compatible additional Js use the
same financial path after their boundary is verified.

These are executable interface requirements, not a theorem that another virtual
machine or institutional settlement system can never implement equivalent rules.
A future central-bank programmable J can fit the model without changing the
meaning of Entity or Account.

## What must be demonstrated

- A user can fund, pay, swap, withdraw and recover using retained evidence.
- Credit consent, collateral backing and conditional execution remain exact under failure.
- Each admitted J has proven observation, deployment, dispute and withdrawal behavior.
- Throughput counts committed economic operations; MML measures provability coverage,
  with no repeated counting of hops, retries or later settlement.

See [the architecture comparison](competitors.md) and
[the launch acceptance journey](wallet-journey-plan.md).
