# Testnet end-to-end skeleton

The goal's last item as a script that fails loudly: two users and two hubs on the deployed Sepolia contracts (an anvil fork, nothing sent to a live chain), driven through the rewrite on main (`pure/`), one step per thing money does: deposit, open Accounts, pay, an HTLC across both hubs, an on-chain reveal, a swap, a forced dispute, the Account following the chain, nodes over a transport.

```sh
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.0"      # Bun 1.4.0
bun install --frozen-lockfile && (cd pure && bun install --frozen-lockfile)
bash contracts/scripts/build.sh                                 # for verify.ts, step S0
export PATH=$PATH:/opt/foundry                                  # anvil (see below if it is not installed)
bun testnet-e2e/run.ts --out /mnt/project-files/e2e/skeleton-status.md
bun test testnet-e2e                                            # the harness's own guards
```

Foundry in a cloud box: `curl -sSL -o f.tgz https://github.com/foundry-rs/foundry/releases/download/stable/foundry_stable_linux_amd64.tar.gz`, unpack `anvil` somewhere on `PATH`, or point `ANVIL` at it.

## What a run says

Each step ends in one of five states, and the report lists the missing pieces in the order the steps need them.

| State | Meaning |
| --- | --- |
| done | every layer the step touched is the rewrite on main |
| scaffolded | it ran on the real contracts, with the stand-ins named under "Uses" done by this harness |
| blocked | it could not run: a named piece is not on main, with the PR or thread expected to supply it |
| failed | a check broke, or a tripwire went off (below): a bug until shown otherwise |
| skipped | a step it needs did not finish |

Exit 0 only when every step is done, 1 while any is scaffolded or blocked, 2 when a check failed.

## Where each piece comes from

Real, from main: Account money and the frame round (`pure/account`), every encoding the contracts read and every signed payload (`pure/chain`: Batch, ProofBody, batch and dispute-proof payloads, the lazy Hanko), signatures (`pure/kernel`). Stand-ins in this folder, each a named gap in `lib/gaps.ts`: the J side that sends a Batch (`lib/chain.ts`), the two Account replicas with messages handed across in memory (`lib/pair.ts`), the hop-by-hop HTLC forwarder and the proof body of a ledger with no open clause (`steps.ts`).

## Tripwires

Every gap has a probe that looks at main (a file, a mention). When the piece lands, the step that still lists it as missing or as a stand-in goes red, and the message says to replace it. Nobody has to remember to update the skeleton: it fails until they do. `bun test testnet-e2e` pins that behaviour.

## Safety

The only node this talks to is a loopback one (`lib/anvil.ts` refuses anything else, tested). The fork URL is read by anvil, which keeps every transaction in its own memory. The parties' keys are derived from fixed strings and hold test tokens minted on the fork (the faucet token has an open `mint`). No deployer key is used or looked for. A run against live Sepolia is not something this script can do; that stays Arthur's, from his Mac.

## Outside the one gate

This folder is not in `pure/`, so the register, the style gate and the seeds do not see it, and it never makes main red. When a step turns green end to end, the next move is to bring that step into the gate (a Runtime-driven version of S2 to S8 on a fork), not before.
