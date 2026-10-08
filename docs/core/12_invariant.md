# RCPAN invariant

Accounts are bilateral financial relationships between entities. RCPAN combines
signed obligations with optional credit and escrowed collateral.

## Canonical orientation

Left is the lexicographically lower Entity ID; Right is the other party.
For each asset:

    Δ = ondelta + offdelta
    −leftCreditLimit ≤ Δ ≤ collateral + rightCreditLimit

Δ represents Left's allocation. A payment from Left to Right decreases Δ;
a payment from Right to Left increases it. It is not “our balance minus their
balance” and must not change definition when the viewer changes.

| Region             | Financial meaning at settlement                              |
| ------------------ | ------------------------------------------------------------ |
| Δ < 0              | Right receives the collateral; Left owes Right the shortfall |
| 0 ≤ Δ ≤ collateral | Left receives Δ; Right receives the remaining collateral     |
| Δ > collateral     | Left receives the collateral; Right owes Left the shortfall  |

Credit-field names identify the borrowing side:

- Right grants Left credit by setting **leftCreditLimit**, permitting negative Δ.
- Left grants Right credit by setting **rightCreditLimit**, permitting Δ above collateral.

For user-facing balances and capacity, use the canonical
[deriveDelta](../../core/account/utils.ts). Holds, allowances and already drawn
credit affect current capacity. A reduced limit does not erase a signed debt;
the displayed inequality describes agreed admission bounds, not permission to
rewrite an existing obligation.

## One financial model, different policies

    Credit-only:       −Lₗ ≤ Δ ≤ Lᵣ
    Collateral-only:     0 ≤ Δ ≤ C
    Reserve-credit:    −Lₗ ≤ Δ ≤ C + Lᵣ

Zero credit is valid. Credit is chosen by the grantor; underwriting and default
preferences belong to the parties and operators. To receive without equal
pre-funding, a user may grant bounded credit to its hub. That deliberately accepts
an unsecured receivable rather than silently treating it as collateral.

For example, start with no collateral, Δ = 0 and both limits = 3:
Left pays Right 2, producing Δ = −2; Right then pays Left 3, producing Δ = 1.
The second outcome is a claim on Right, not newly created escrow backing.

With collateral = 3 and no credit, Δ must stay in [0, 3]. Starting at Δ = 0,
Right pays Left 2, producing Δ = 2: Left's secured allocation is 2 and Right's is 1.

## Three protections

1. **Proof:** signed account evidence establishes the obligation for J dispute.
2. **Collateral:** chosen backing protects the secured entitlement; soft/hard
   limits manage additional credit exposure through the canonical financial path.
3. **Delta Transformers:** signed conditional transitions protect value in motion,
   with J enforcement bounded by the agreed allowances and evidence.

The J pays available collateral/reserves according to the signed outcome and
books remaining debt under its enforcement rules. Unsecured repayment is not
guaranteed. Bounds constrain direct account exposure; a common hub failure can
still affect many accounts and routes at once.

## Architecture and mission

Independent account activity does not require global per-payment publication.
Runtime and Entity still own real commitment, authority and capacity constraints.
The goal is [MML: provable accounts supporting 51% of world GDP by 2050](../intro.md#mission),
not a larger count of internal route hops.

See [the canonical cascade](rjea-architecture.md),
[consensus invariants](../consensus-invariants.md), and
[Depository settlement](../../jurisdictions/contracts/Depository.sol).
