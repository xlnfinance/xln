# Recovery Map

This folder owns recovery bundle primitives and watchtower authorization helpers.

## What it does

- builds an encrypted runtime checkpoint bundle from canonical runtime state
- derives deterministic lookup keys from `runtimeId + runtimeSeed`
- verifies and decrypts tower payloads locally in the wallet
- computes owner-side tower authorization hashes for delayed counter-disputes
- does **not** hold spend-capable keys

## Main files

- `types.ts`
  Shared bundle, appointment, receipt, and restore response contracts.
- `bundle.ts`
  Runtime checkpoint bundle builder and deterministic hash validation.
- `crypto.ts`
  Lookup-key derivation, AES-GCM encrypt/decrypt for blind tower mode, and
  watchtower authorization hash helpers.

## Called by

- `frontend/src/lib/stores/vaultStore.ts`
  Schedules upload of encrypted runtime backups and restores from tower on a
  fresh device or missing local DB.
- `runtime/watchtower/http.ts`
  Verifies owner-signed appointments and serves blind-backup restore payloads.
- `runtime/watchtower/standalone-server.ts`
  Standalone tower API service backed by LevelDB.
- `runtime.ts`
  Restores an `Env` back from a canonical checkpoint snapshot.

## Scope boundary

This is intentionally the narrow recovery/watchtower cryptography layer:

- yes: encrypted runtime backup and restore
- yes: tower authorization hashing for delayed counter-disputes
- no: tower-side chain watching or tx publication
- no: tower custody
- no: alternate canonical state format

The recovery bundle reuses the same checkpoint snapshot format that storage/WAL
already treats as canonical truth.
