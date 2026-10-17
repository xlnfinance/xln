# Preserve signed profiles when unlocking a hosted wallet

Base: `8210537d983dfd9ea031e871606741b6ea93205a`.

The original BrainVault gate stopped at a retired Svelte heading (exit1,32.468s).
Porting its public flow to the canonical React Gate exposed a real defect:
creation, native/browser seed identity, encrypted storage and three bilateral Hub
Accounts passed, but reload replaced the explicitly published profile name with
the local vault label. The exact browser failed in42.160s; its Settings snapshot
shows the reverted name. `bootHostedVault` submitted `profile-update` on every
ordinary unlock when the saved name differed, also clearing bio and website.

Deleted that duplicate mutation. The canonical `importEntity` input already
initializes a new Entity profile, while checkpoint+ordered WAL restores the
existing committed profile. User publication remains the explicit signed Settings
transaction. No new durable field, recovery reader, crypto path or format change.

The five existing cases now use the current React form, encrypted metadata and
latest typed Runtime diagnostics. Removed retired Svelte selectors, old vault
storage parsing, obsolete post-create/rescue screens and duplicate oracle work.
The three-hub fixture still opens three actual same-J Accounts through the public
UI, checks committed/nonpending Accounts against verified gossip and advertised
hubs, publishes a profile and authenticates a real reload. It now also proves
that bio and website survive. The second-wallet fixture locks the old Runtime,
derives a distinct wallet and preserves both encrypted vaults. No tests skipped.

Evidence/results and exact commands are recorded in the durable job folder:
`/Users/zigota/agent-jobs/xln-mainnet-autonomy-20261017/`.
The original failures remain under `brainvault-standalone-baseline-8210537d9-boundary/`
and `brainvault-react-2-boundary/`. Strict browser health remains enforced; the
original narrowly scoped transient reload recipient allowance is retained.

## Measured verification

- Standalone creation, three actual Hub Accounts, signed name/bio/website and
  password-authenticated checkpoint/WAL reload: 1/1,38.963s, including rebuild.
- Second BrainVault isolation and preservation of both encrypted wallets:
  1/1,23.118s. An intermediate test-only regex incorrectly treated the legitimate
  `kind: "mnemonic"` value as a plaintext key; corrected to match JSON keys.
- Native oracle versus browser worker derivation: 6,7,8 shards each1/1 in
  20.844s,20.716s,21.217s; zero browser errors/warnings/network/HTTP failures.
- Password encryption/identity/tamper rejection, native worker vectors, worker
  pressure and signed gossip recertification: 19/19,72 assertions,2.056s.
- Production fix removes four lines; no Solidity, frozen-core or money formula
  change. Final full check, clean-SHA browser and mandatory pre-push verifier
  are saved as `brainvault-final-check`, `brainvault-clean-head` and
  `brainvault-publish` results before accepting publication.

Reproduce the original complete behavioral regression after `bun run stand:status`:

```sh
bun run stand:run --reason brainvault-profile --timeout-ms 60000 -- \
  bun core/scripts/e2e/runners/run-e2e-parallel-isolated.ts \
  --all --strict-browser-health --shards=1 --workers-per-shard=1 \
  --max-mm-concurrency=1 --video=retain-on-failure --trace=retain-on-failure \
  --screenshot=only-on-failure --max-failures=1 \
  '--pw-files=tests/e2e/recovery/e2e-brainvault-parity.spec.ts::standalone BrainVault creates and starts the XLN wallet with deterministic seed material'
```

Each browser component runs sequentially under its own capacity-one stand and
60-second wall budget. No aggregate release/public-chain/soak/mainnet-readiness
claim follows from these components.
