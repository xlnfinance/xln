# Account Tx Map

This folder owns bilateral account transaction application.

## What it does

- validates and applies bilateral account txs
- updates `AccountReplica`
- returns deterministic events used by account consensus and followup logic

## Main files

- `apply.ts`
  Dispatcher from `AccountTx['type']` to handler.
- `handlers/direct-payment.ts`
  Same-j payment execution and forwarding preparation.
- `handlers/htlc-*.ts`
  HTLC lock/reveal/resolve/cancel lifecycle.
- `handlers/pull.ts`
  Cross-j-only `cross_pull_lock` / `cross_pull_close` lifecycle.
- `handlers/swap-offer.ts`, `swap-resolve.ts`, `swap-cancel.ts`
  Same-j order lifecycle at the bilateral layer.
- `handlers/cross-swap-fill-ack.ts`
  Committed cross-j fill acknowledgement at the bilateral layer.

## Called by

- `account-consensus.ts`
- `entity/tx/handlers/account*.ts` followups that inspect committed account tx results

## Calls into

- `cross-jurisdiction.ts`
- `account/state/state-clone.ts`
- `account-consensus-helpers.ts`

## Audit note

If a change affects `pull.ts`, `swap-resolve.ts`, or any HTLC handler, read the
matching entity-layer followups too. Bilateral application and entity followups
are a paired system.
