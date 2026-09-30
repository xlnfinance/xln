# Jurisdiction, Entity and Account machines

**Role:** financial model and terminology
**Status:** J/E/A describes existing finance; current xln enforcement uses programmable Js

## Jurisdiction

A J-machine is the authority whose state and rules register financial rights and
enforce settlement. Central-bank ledgers and systems such as Fedwire perform
this role in the existing economy. Securities depositories and other registries
cover related rights. J/E/A gives these functions a common abstraction; it does
not assert that their institutions, access rules or legal mandates are identical.

A programmable public settlement network is another implementation of J.
Replication and verifiability change how its state is maintained and checked,
while the financial role remains jurisdictional registration and enforcement.

Current xln contracts need executable signature verification, reserves,
collateral, signed conditional settlement and disputes. Ethereum, TRON and XLNC
are the initial focus. Compatible EVM jurisdictions, including Base and Arbitrum,
can implement that boundary through the same financial model. Fedwire integration
is future work if a compatible programmable interface becomes available; using
Fedwire to explain J does not claim that Depository is deployed there today.

## Entity

An E-machine represents a person or organization with authority rules, state and
financial relationships. Banks, brokers, companies and individuals all fit this
model. In the implementation, a hub is a Runtime with the hub role, serving
financial relationships through its jurisdiction-specific Entities.

xln makes Entity authority and state verifiable and replicable. Hanko signatures
express authorization; the Entity transition certifies its own state and exact
child Account inputs. The implementation is specified in
[the canonical cascade](rjea-architecture.md).

## Account

An A-machine is the bilateral relationship between two entities: balances,
obligations, credit limits, collateral allocation and agreed programmable terms.
The parties sign state and retain evidence usable for J enforcement when they
stop cooperating. Not every account needs credit or collateral in the same ratio.

The [RCPAN invariant](12_invariant.md) covers both credit-bearing and fully
collateralized policy. Proof, chosen collateral backing and Delta Transformers
protect different parts of that relationship.

## Runtime and the mission

Runtime coordinates the implementation, commits accepted inputs and dispatches
external effects after durability. It does not replace J, E or A authority.

The objective is [MML: accounts supporting 51% of world GDP made provable by
2050](../intro.md#mission). The core change is making existing financial
relationships verifiable and disputable, while ordinary activity remains local
to the parties rather than globally published operation by operation.
