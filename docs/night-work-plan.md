# Current xln execution handoff

## Current SHA

- Verification base: `2418d02737f9d44749aa3d1105d750e00f765511`, owner-approved `testnets_deploy` branch. Resolve the delivery commit with `git rev-parse HEAD`.
- `main`: `019d45beb5954e77fe806d643845f6a4dca4fa82`, unchanged.
- This commit contains eleven Stack Manager adapter tests, two test fixtures, removal of one unused production import and this handoff. No production behavior or financial protocol changes. Verification ran before commit on the identical executable source content; no clean release run is claimed.
- The unrelated public-proof diagnostic edit and Svelte task record remain byte-identical. All 185 retained public deployment files are unchanged.
- Owner-approved MacBook M5 execution exception and explicit local commit authority. No public signing, transfer, deployment or push in this slice.

## Last green command

The following complete owning run passed **29 tests across 11 files, 333 assertions**:

```sh
bun run stand:run --reason adapter-owning-final --timeout-ms 600000 -- \
  bun test \
  core/__tests__/orchestrator/stack-manager-confirmations-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-evidence-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-preflight-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-recovery/stack-manager-confirmation-race-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-recovery/stack-manager-resume-binding-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-recovery/stack-manager-resume-ownership-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-recovery/stack-manager-resume-process.test.ts \
  core/__tests__/orchestrator/stack-manager-recovery/stack-manager-resume-publication-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-recovery/stack-manager-resume-review-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-recovery/stack-manager-resume-stages-anvil.test.ts \
  core/__tests__/orchestrator/stack-manager-script-evidence-anvil.test.ts
```

Strict TypeScript for the owning tests/fixtures and their import closure passed.
Owning lint passed 14 files with zero approved debt findings. Read-only review
found no loss of financial, no-send, catalog or community-publication assertions.

Then `bun run check:deployment` passed **6/6 gates**: artifact parity, types,
lint, 274 Hardhat tests, 64 Foundry checks and 110 Bun tests / 3,580 assertions.
The canonical interruption matrix passed all 22 cuts. All 561 covered source
hashes stayed stable during the run; all 181 artifact hashes and the fourteen
owned executable/test file hashes matched the final checked candidate.

## First red command/error

No unresolved failure in this selected test-alignment scope. Owning tests,
strict types/lint and the applicable deployment profile are green. This does
not establish a clean whole-product release or new public financial-flow proof.

## Artifact path

- Runnable adapter tests: `core/__tests__/orchestrator/stack-manager-*.test.ts` and `core/__tests__/orchestrator/stack-manager-recovery/`.
- Test fixtures: `core/__tests__/fixtures/stack-manager-resume-invocation.ts` and `core/__tests__/orchestrator/stack-manager-recovery/stack-manager-resume-support.ts`.
- Existing public records remain under `jurisdictions/ignition/deployments/eth-sepolia-ignition-01/`, `arb-sepolia-ignition-01/` and their sibling read-only reports. Public execution used `49c26224497d5e875c369098f02d515e0fb81134`; verifier source was committed at `cb52df9da1b0e1f0291db08074df122680da4526`.
- Owner retention choice: generated local case data and check reports are removed after verification. The measured summary above and runnable tests remain; deleted raw cases cannot be reconstructed from this summary alone.
- [CLI operator guide](deployment/ignition-stack-design.md).

## Next single command

```sh
git status --short --branch
```

Inspect the remaining public-proof edit and Svelte task separately. They and the
public deployment artifacts are excluded from this commit. The owner explicitly
authorized the local commit; no push is authorized.

## Remaining final gates

- Preserve the checked candidate when preparing a commit. Executable changes need owning checks and the applicable profile again; no clean committed release run is claimed.
- Public USDC funding, approval, reserve roundtrips, Cross-J and interrupted-transfer recovery remain separate unrun financial tasks.
- Further Stack Manager HTTP/Rust/UI integration remains deferred. These tests exercise existing deployment callers and catalog boundaries; they do not deliver that application feature.
- Full repository, browser and whole-product/mainnet release gates were not run for this deployment-only test slice.
