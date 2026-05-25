# Recovery Map

This folder owns blind-backup recovery primitives.

## What it does

- builds an encrypted runtime checkpoint bundle from canonical runtime state
- derives deterministic lookup keys from `runtimeId + runtimeSeed`
- verifies and decrypts tower payloads locally in the wallet
- does **not** hold spend-capable keys and does **not** publish on-chain actions

## Main files

- `types.ts`
  Shared bundle, appointment, receipt, and restore response contracts.
- `bundle.ts`
  Runtime checkpoint bundle builder and deterministic hash validation.
- `crypto.ts`
  Lookup-key derivation plus AES-GCM encrypt/decrypt for blind tower mode.

## Called by

- `frontend/src/lib/stores/vaultStore.ts`
  Schedules upload of encrypted runtime backups and restores from tower on a
  fresh device or missing local DB.
- `runtime/server/recovery-tower.ts`
  Verifies owner-signed appointments and serves blind-backup restore payloads.
- `runtime.ts`
  Restores an `Env` back from a canonical checkpoint snapshot.

## Scope boundary

This is intentionally the minimal v0 path:

- yes: encrypted runtime backup and restore
- no: active dispute publication
- no: tower custody
- no: alternate canonical state format

The recovery bundle reuses the same checkpoint snapshot format that storage/WAL
already treats as canonical truth.
