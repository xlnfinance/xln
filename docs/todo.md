# Working TODO

Live scratchpad for the current work session. Each item records what was
observed, what changed, and what still has to be proved.

## Now: make `bun run dev` reliable

- [x] `contracts-sync` refused to run under Node 26 — the supported-major list
      was pinned to 20/22/24 while the machine ships 25/26. Hardhat 2.29.0
      compiles the jurisdictions contracts under Node 26 (verified by running
      `hardhat compile` directly), so the gate was stale, not protective.
- [x] `bun run dev` now reaches `DEV_READY` in ~44 s from a cold tree.
- [x] The first browser load answered `504 Outdated Optimize Dep` on every
      discovered dependency: Vite's optimizer was still crawling when the page
      asked for its modules. Both dev configs now warm the wallet entries at
      boot, and a cold-cache restart loads the app with an empty error console
      on both `http://localhost:8081/app` and `https://localhost:8080/app`.
- [x] Dependencies moved to the newest semver-compatible releases (Hardhat
      2.29.1, @noble/* 2.3.0, secp256k1 4.0.5, ws 8.21.3, electron 42.9.2,
      knip 6.32.2). Hardhat 3 is a major migration and stays out of this pass.
- [x] Dropped `crypto-js`: nothing imported it; only a bundler chunk rule and a
      knip ignore still named it.

## Now: throughput

The Hub is a single writer and a frame costs about the same whether it carries
one transaction or a hundred (26.1 ms with ~3.4 inputs; a lane daemon with one
Account still spends 36 ms). So frames per second is a hard ceiling and batch
size is the only free multiplier.

- [x] `XLN_RUNTIME_MIN_FRAME_DELAY_MS` sets the frame floor;
      `XLN_HUB_MIN_FRAME_DELAY_MS` forwards it to managed Hub children only.
- [ ] Measure delivered TPS at frame delays 0 / 50 / 100 / 200 ms at 100 users.
- [ ] Raise transactions per frame on the driver side (payments currently submit
      one per sender per round).

## Load runs must be isolated

Editing and committing happen in the main checkout, which a second agent edits
at the same time. A load run must not read that moving tree: the 100-user run at
18:27 consumed a half-applied mempool refactor and died on
`cloneIsolatedRuntimeInput is not defined`.

So runs execute from `/tmp/xln-load`, a detached worktree of this same
repository parked on a known commit. It shares `.git`, holds no work of its own
and is never committed to — after committing in the main checkout, point it at
the new commit and run:

```
git -C /tmp/xln-load checkout -q <commit>
```

## Walls

Measured walls (see memory `hlt-scaling-walls-2026-08-18`):

- [x] Hub gossip Profile crossed the 10 KB entity-context leaf at ~34 accounts.
      Fixed by `publicPinned` + `MAX_PROFILE_ADVERTISED_ACCOUNTS = 100`
      (commit `06e790238`). A 100-user run no longer trips it.
- [x] The payment route barrier judged readiness from the Hub's Profile, which
      a Hub no longer publishes for its users (commit `8da1313dd`).
- [ ] `ACCOUNT_J_CLAIM_NODE_MISSING` halts the Hub at 128 users round 55.
- [ ] ~0.2 core per idle lane daemon caps the stand at 150-250 users.
