# BrainVault agent contract

Read this file at task start and again after context compaction. It applies only
inside this package. The parent repository rules still apply.

## Mission

Preserve BrainVault V1 forever. Optimization, portability, UX, and packaging may
change. The same semantic inputs must always produce the same root.

Ask the owner before making a new protocol choice. Never reinterpret a frozen
constant, encoding, normalization rule, salt, domain, factor, or wallet path.

## Work order

1. Reproduce the smallest observable failure or establish a measured baseline.
2. For a bug, add the smallest regression test and observe it fail.
3. Change only the owning layer. Do not refactor unrelated code.
4. Run the focused test, then `bun run check`.
5. Run release-only gates only when a release is explicitly authorized.

## Boundaries

```text
CLI / workers / native schedulers
             |
             v
      public wallet API
             |
             v
  ordered canonical root fold
             |
             v
   V1 encoding / salt / KDF
```

- `src/core/primitives/spec.ts` owns frozen bytes, constants, normalization, and salts.
- `src/core/primitives/kdf.ts` owns one canonical Argon2id shard.
- `src/core/canonical.ts` owns ordered root combination and has no I/O or wallet code.
- `src/core/index.ts` owns wallet projections and the public library API.
- Workers and native engines may schedule work only. They may not define V1.
- `src/cli/index.ts` owns interaction and disclosure policy. It may not reimplement V1.

Keep lower-level mechanics behind their existing module. A new export or wider
visibility is an API change and requires a concrete caller, test, and rationale.

## Code

- Name every protocol value in `primitives/spec.ts`; do not scatter magic values.
- Prefer early return or `continue` over nested branches. Always use braces.
- Keep new functions small and names under 30 characters when clarity permits.
- Prefer a discriminated union or enum to a new boolean mode parameter.
- Comment why a security-sensitive block exists, not what each line says.
- Add no dependency for CLI presentation or convenience.
- Preserve unrelated user changes and minimize changed lines.

Do not perform style-only rewrites while fixing behavior. Existing public APIs
and boolean parameters remain unchanged unless the task explicitly owns them.

## Security

- Fail closed on malformed, missing, duplicate, reordered, or foreign shards.
- Never accept secrets through argv, persist, transmit, or log them. Printing is
  allowed only in explicit interactive disclosure modes with their documented
  terminal warnings and cleanup.
- Wipe owned secret buffers on success and failure where the runtime permits.
- Explicit engine failure is fatal. Automatic fallback requires proven parity.
- Default output remains a fingerprint and first public address. Reveal requires
  exact interactive password confirmation and a reliable alternate screen.
- Derivation must not depend on time, randomness, network, engine, or workers.

## Verification

- Protocol change: stop. V1 is frozen.
- Pure derivation: frozen vectors and domain-separation tests.
- Scheduler/native change: malformed-output tests and cross-engine root parity.
- CLI change: pseudo-TTY user simulation, secret-output, Ctrl+C, and `NO_COLOR`.
- Package change: inert offline install, allowlist, manifest, and launcher smoke.
- Native release: `bun run verify:source` proves byte-reproducible builds and
  bundled-binary hash equality without running during package installation.
- Release: the full `workers=1/2/8/32` by `multiplier=1/2/10` matrix.

Never approve from comments or benchmark output alone. Report the exact command,
pass/fail counts, root where relevant, and remaining unverified boundary.

## Git and releases

Work only on `main` and only inside `brainvault/`. Before a commit run
`git diff --check`; before push run `bun run check`.

Use a concise imperative commit subject. Explain why in the body when the reason
is not obvious from the diff.

Never publish, tag, replace an archive, or update a frozen historical hash unless
the owner explicitly authorizes that release operation.
