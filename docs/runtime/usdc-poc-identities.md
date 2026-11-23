# USDC PoC identities and funding roles

Owner clarification, 2026-11-17: retain the separate test user, Hub and MM
identities for the current PoC. Defer the external-wallet integration discussion
and proceed with ticket 11's operator-funding preparation.

## Existing identities

The public preparation owns three separate vaults and TS Runtimes: `user`, `hub`
and `mm`. Each Runtime has a separate Entity and signer in each jurisdiction.
Addresses below were reproduced from the retained vaults and matched the public
preparation evidence. They are public signer addresses, not Entity IDs.

| Role                                              | Ethereum Sepolia 11155111                    | Arbitrum Sepolia 421614                      |
| ------------------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| User                                              | `0x61ff4c022bcc7d342d0d68a7b85f18e0fd7d9446` | `0xb77348f8f01e060934024fefc319c66653df6fa2` |
| Hub                                               | `0x7fd492c67d1b1bab5ba3487e4246c8044db44598` | `0x0b2fffb8b3e09bb3ea2d5ec2442cf055bdfdcdd2` |
| MM                                                | `0xcc26bfec25957d476e4a116fecb206ab9198d196` | `0x00d44b29953dfa094058eaa31440338c899bef37` |
| Deployer / funder in the existing unsigned packet | `0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b` | `0x42Da3Ba8c586F6fe9eF6ed1d09423eB73E4fe25b` |

The user's two addresses are derived from one user vault. Ethereum uses signer
index 0; Arbitrum uses index 650934, derived from the jurisdiction name. The user
vault was created during public preparation and is independent of the deployer
key. Its seed remains in the protected local preparation directory and is not
included in documentation or evidence.

The current journey deposits from the user's Ethereum signer and withdraws to
the user's Arbitrum signer, address B. Initial USDC/ETH provisioning from an
external funding wallet is a separate operation. Making `0x42Da…fe25b` both the
external deposit payer and withdrawal recipient is deferred; the existing CLI
does not expose that integration.

## Operator funding

A funding EOA supplies token capital and native gas. Hub and MM retain their own
signing authority. One funding EOA may provision both operators; no additional
EOA dedicated solely to funding MM is required by the selected PoC.

The selected capital plan funds Hub reserves: 1 USDC on Ethereum as the retained
discretionary buffer and 5 USDC on Arbitrum for the planned five-run series.
Actual USDC custody is in the selected Depository, credited to the specified Hub
Entity reserve. Native ETH topups go to the specified operator signer wallets.
MM order admission uses signed bilateral credit with Hub; no MM USDC wallet or
reserve deposit is proposed. This does not establish full backing for all MM
credit or advertised orders. Any MM on-chain recovery gas is prepared separately
under ticket 05.

The user's five one-USDC deposits remain separate from operator prefunding.
Ticket 11 funds the operators once, using its own exact call and fee authority.
It does not execute a user deposit, Cross-J swap or payout.

The [six authorized public funding transactions](../evidence/ts-usdc-cross-j-poc/local-evidence.md#operator-funding-publicjson)
have now executed from the existing deployer/funder: 1/5-USDC Hub reserves and
0.001/0.0001-ETH Hub signer topups. User and MM wallets/reserves were not funded.
Ticket 11 is complete for this funding. The original Runtime observation
attempt and the accepted restore of the funded demo are recorded in
[ticket 12](../../.scratch/ts-usdc-cross-j-poc/issues/12-public-rpc-capacity-and-funded-catchup.md).

## Deferred choices and authority

A new independent operator funding EOA was recommended during discussion but
has not been created or selected. The existing unsigned packet names the
deployer as funder. Funding preparation must identify the signer explicitly and
must not silently create or substitute one. Deployment origin remains the
deployer recorded in the sealed deployment manifests.

The owner explicitly approved and executed ticket 11's six operator-funding
transactions with their payer, recipients, USDC amounts and numeric ETH limits.
That campaign is consumed. User funding, a public journey or another operator
funding campaign requires its own concrete authority. The owner chose no new
expenses while the RPC/catch-up blocker remains open.

References: [public preparation evidence](../evidence/ts-usdc-cross-j-poc/local-evidence.md#public-preflightjson),
[identity derivation](../../jurisdictions/scripts/usdc-cross-j-preflight/identities.ts),
[financial CLI](usdc-poc-execution.md), [capital plan](usdc-poc-capital-plan.md),
[operator-funding executor](usdc-poc-operator-funding.md),
[ticket 11](../../.scratch/ts-usdc-cross-j-poc/issues/11-separate-operator-funding.md).
