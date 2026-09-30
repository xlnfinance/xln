# Bilateral finance and local verification

J/E/A models finance through jurisdictions, entities and bilateral accounts.
xln replicates and verifies those account relationships, retaining common
programmable J enforcement when cooperation fails.

## Independent account state

    Entity A ↔ Entity B: account AB
    Entity A ↔ Entity C: account AC
    Entity B ↔ Entity C: account BC

AB and CD can progress independently when they share no execution dependency.
An Entity that owns several accounts still has its own authority and commitment
boundary; accounts on the same Runtime compete for that machine's resources.
Routed operations coordinate the participating accounts and need real capacity.

The scaling property is locality: unrelated participants need not process or
publish each account update. Adding independent machines can add aggregate
capacity. More graph edges alone do not create throughput or liquidity; there is
no claim of infinite capacity, zero coordination or perfect economic isolation.

## Credit enables chosen inbound capacity

A recipient can grant bounded credit to its hub, allowing the hub to owe it
without equal pre-funding. Collateral can secure more of the relationship.
The recipient chooses unsecured exposure; proof, collateral and Delta Transformers
supply distinct protections. See [RCPAN](../core/12_invariant.md).

## Live replica versus financial state

An AccountReplica contains committed AccountState and the live candidate,
proposal, ACK/resend and admission data needed for bilateral agreement.
Historical signed frames belong to dedicated stores and are read on demand;
consensus and ordinary UI refresh do not scan account history.

Both parties verify the exact proposed transition and its signed evidence.
Duplicate delivery is idempotent; conflicting evidence is rejected. Runtime
publishes external effects only after WAL commitment. The implementation contract
is [the canonical cascade](../core/rjea-architecture.md).

## Shared publication and common enforcement

| Ordinary financial updates | xln account model                                          | Global shared-state model                                     |
| -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------- |
| Agreement                  | Participating accounts under Entity authority              | Shared ordering/execution domain                              |
| Evidence retention         | Parties and their delegates retain usable account evidence | State recovery depends on the shared domain's data rules      |
| Parallelism                | Independent relationships across independent machines      | Capacity supplied by the chosen shared execution/DA resources |
| Exceptional enforcement    | Underlying programmable J                                  | Underlying settlement/security system                         |

A rollup can itself serve as an xln J. This does not put every xln account update
through that rollup: the shared layer sees the J operations needed for enforcement.
Failure of a shared hub or J can affect many relationships even though their
account proofs remain separate.

The mission is [provable accounts supporting 51% of world GDP by 2050](../intro.md#mission).
Measure actual adoption, usable recovery and production throughput separately.
