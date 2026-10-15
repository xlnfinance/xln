# Agent payments: interoperability before another standard

Research and implementation checkpoint: 2026-10-15. This is an experimental
integration, not a mainnet approval or a claim of superior performance.

## Decision

Use MPP and x402 as application interfaces. XLN supplies its own settlement
method through the existing RuntimeAdapter and Paybook. Keep bilateral Accounts,
swaps and dispute evidence native to XLN; do not fork the financial engine or
pretend an XLN Account claim is an EVM token-transfer receipt.

Start with **invoice payments through `mppx`**, whose public Method API accepts
custom client/server implementations. Its existing HTTP/MCP transports should
own transport framing. A separate x402 scheme is a later compatibility adapter,
not a second payment implementation. Mppx supporting both protocols does not
automatically make a custom XLN method compatible with x402 facilitators.
The merchant must explicitly enable XLN. This adapter cannot pay an arbitrary
existing USDC/x402 endpoint with an XLN claim. A gateway that settles on another
rail would need its own liquidity, fee and failure model; that is not implemented.

## What the competitors actually have

| Question | Evidence | Consequence for XLN |
| --- | --- | --- |
| Is x402 used? | Coinbase reported 230M+ transactions and $54M+ volume on 2026-09-22. | It has distribution worth integrating with; these are vendor counters, not verified independent commerce. |
| Does MPP already use channels? | Tempo Sessions uses TIP-1034 unidirectional channels, cumulative signed vouchers, local verification and periodic settlement. | Off-chain micropayments are not a unique XLN feature. |
| Does Yellow have disputes? | Nitrolite v1 uses mutually signed user/Node channel states, ChannelHub challenges and timeout close. | Enforceable state is not unique either. Compare concrete failure/recovery behavior. |
| Is there one objective winner? | No common workload, hardware, custody/risk assumptions or failure experiment was run here. | Do not publish invented latency, TPS, security or overall rankings. |

Primary sources:
[Coinbase adoption report](https://www.coinbase.com/fr/developer-platform/discover/launches/c4a-equities-x402),
[MPP sessions](https://mpp.dev/payment-methods/tempo/session),
[MPP SDK](https://github.com/wevm/mppx),
[Yellow architecture](https://docs.yellow.org/nitrolite/learn/introduction/architecture-at-a-glance/),
[Yellow recovery](https://docs.yellow.org/nitrolite/learn/core-concepts/challenge-response/),
[Yellow v1 SDK surface](https://docs.yellow.org/nitrolite/api-reference/).

The [x402 site](https://x402.org/) displayed 75.41M transactions and $24.24M for
its labelled last-30-days window when checked. That page does not establish a
measurement cutoff or independent buyers. A [July 2026 research preprint](https://arxiv.org/abs/2607.12575)
classifies much of the measured Base activity as fictitious or internal to linked
clusters. Its classification is the authors' result, not an audit performed here.
For MPP and Yellow, comparable verified adoption totals were not established.
Avoid counting proxy integrations as direct provider adoption.

MPP is the best first integration target **for this task** because its published
SDK accepts a custom settlement method and already supplies HTTP payment retry
handling. Yellow is the closer channel-architecture comparison. x402 is the
important compatibility/distribution target. These are different criteria.

For one-way token-by-token inference billing, cumulative MPP vouchers avoid a
bilateral round trip per unit. XLN should not claim that bilateral consensus is
automatically faster. Its useful comparison is recurring two-way commerce with
reusable liquidity, swaps and explicit counterparty risk, measured end to end.

## Implemented surface

`core/api/payments/command.ts` is the shared payment builder for React, the
existing Svelte wallet, CLI and agent code. The duplicate CLI builder is removed.
Routes that disagree with the requested recipient are rejected.

The headless API is:

1. `prepareAgentPayment(adapter, request)` obtains a runtime quote within an
   explicit debit cap and returns a JSON-safe intent. It does not send money.
2. Persist the intent before `sendAgentPayment(adapter, intent)`. Retries reuse
   the exact command ID, sequence, runtime identity, recipient, route and amount.
3. `readAgentPaymentStatus(adapter, intent)` reads committed frame receipts:
   `unresolved`, `in_flight`, `settled` or `failed`. Queue acceptance is not payment.

Amounts are integer base-unit strings. No floating-point money. A missing response,
history gap, or timeout never means “send another payment.” Receipt reads are
explicit and bounded to 10,000 frames; older evidence needs the underlying paged
`frame-receipts` API. The client requires a stable owner command lane, not a
short-lived capability lane whose replay frontier can expire. Serialize commands
on that lane; this release does not allocate parallel per-agent lanes.

Runnable CLI:

```sh
bun cli/agent-payment.ts --help
bun cli/agent-payment.ts prepare request.json intent.json
bun cli/agent-payment.ts send intent.json
bun cli/agent-payment.ts status intent.json
```

The prepare command refuses to overwrite an existing intent. Keep the file on
durable storage. Connection credentials and owner keys belong to the trusted
runner, outside the model context. `maxDebit` is a per-payment bound, **not**
server-enforced delegated authorization or a cumulative spending budget.

## MPP integration

The pinned dependency is `mppx@0.13.5`. The custom method is `xln/charge`, with:

- Request: `amount`, `currency`, `recipient`, `orderId`, `fromHeight`.
- Currency: `xln:eip155:<chainId>/depository:<address>/token:<registryTokenId>`.
  Both ends check the Entity's actual jurisdiction. This is an XLN method-specific
  identifier, not a claim of CAIP registration or automatic ticker conversion.
- Credential: the payment `hashlock`. The merchant independently reads its own
  committed `HtlcReceived` with matching order reference, token and amount.
- Receipt: MPP success plus the hashlock reference. It represents an Account
  payment, not an on-chain transaction hash or guaranteed withdrawal.

Register the existing SDK hooks:

```ts
import { Mppx as Client } from 'mppx/client';
import { Mppx as Server } from 'mppx/server';
import { xlnMppClient } from '../core/api/payments/mpp-client';
import { xlnMppServer } from '../core/api/payments/mpp-server';

// payerOptions includes a connected owner-bound RuntimeAdapter, trusted merchant
// and currency pins, maxDebit, and a durable AtomicStore for saved intents.
const client = Client.create({ methods: [xlnMppClient(payerOptions)], polyfill: false });
const response = await client.fetch(invoiceUrl);

// merchantOptions uses the merchant's own authenticated read-only adapter.
const server = Server.create({
  methods: [xlnMppServer(merchantOptions)], realm, secretKey,
});
const result = await server.charge(order)(request);
if (result.status === 402) return result.challenge;
return result.withReceipt(Response.json(fulfilledOrder));
```

Each merchant order has a durable unique `orderId` and receiver `fromHeight`
recorded when it was created. Reuse both across retries. Never let a caller choose
an already-paid order to obtain a different product. The application authenticates
orders and makes fulfilment idempotent. A payment buys that order; repeated access
does not buy additional work. This is not yet a streaming/metered session method.

The payer stores one immutable intent per merchant/order. A fresh challenge does
not allocate another payment. Saved terms and the trusted host's current debit
cap are checked before retry. Store.memory is suitable only for disposable tests;
production needs durable atomic storage. Losing this store loses application
idempotency, even though the Runtime still retains its command frontier.

## Where XLN can earn an advantage

The hypothesis is one reusable bilateral relationship for payments, atomic swaps,
explicit accepted credit risk, and enforceable signed state. Measure the complete
workflow; do not advertise every part as independently novel.

Agent-facing next capabilities should remain thin adapters:

- Quote and pay with a fixed recipient amount, exact fee/debit limit and resumable
  receipt; runtime performs the canonical financial transition.
- Quote and execute a swap with minimum output and deadline. Payment plus swap is
  not automatically atomic merely because two SDK calls are composed.
- Export evidence, inspect a dispute deadline, and request exit through the
  existing settlement/watchtower paths. A state dispute is not arbitration over
  whether an API answer was useful; unsecured claims are not guaranteed recovery.
- Host-enforced delegated scopes: recipient, asset, operation, expiry and cumulative
  spend. Never expose the Runtime owner's general admin capability directly to a model.

## Verification and remaining release work

Current checks cover canonical command construction, precision above 2^53,
recipient/debit rejection, JSON retry reconstruction, receipt correlation across
pages, ambiguous/failing evidence, and the existing durable command frontier.
Real `mppx` tests cover issuing an XLN challenge, rejecting altered prices,
rejecting an unauthorized merchant and refusing success without receiver evidence.
The server's explicit stable binding also rejects an otherwise valid credential
issued for a different same-priced order or receipt-history boundary. The SDK's
default generic binding does not include these custom invoice fields.

These are boundary and SDK integration tests, **not** a completed live MPP payment
or an interoperability certification. Required next evidence is one funded
same-J payer and merchant completing `402 -> payment -> receipt -> resource`,
then lost-response/restart retry with exactly one economic debit, followed by
wrong asset/domain/recipient, forged receipt and concurrent-order cases. Run that
against the existing stand under its machine lock. No second heavy stand is started.

Only after that flow passes should the same backend be exposed through an x402
scheme and the SDK's MCP transport. Publishing packages, claiming standard
registration, auto-swapping, delegated keys and mainnet enablement remain unimplemented.
