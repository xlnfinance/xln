# BrainVault V1 release discipline

V1 derivation never changes. A release may repair UX, packaging, portability,
or an implementation defect only when every frozen vector retains the same
root. No release may replace a historical tarball.

Before a release:

From the source checkout, first run `bun test historical.test.ts`. This is a
repository-only archive gate: historical tarballs remain inert and are never
nested inside the npm package.

1. run the per-commit tests, the package/offline sandbox tests, and all twelve
   `workers=1/2/8/32` by `multiplier=1/2/10` matrix cases;
   on accelerator platforms also run every shipped accelerator at multiplier 1
   for 1/2/8/32 shards and the full 1,000-shard parity benchmark;
2. rebuild each native executable twice from the locked source and require
   byte-identical SHA-256 output and equality with every shipped prebuild. Rust
   must build with an empty `CARGO_HOME`, `--offline --locked`, `apple-m1` for
   the portable baseline, and `apple-m3` for a separately named M3-family
   variant. Every Apple executable and Metal library must target the M1-era
   macOS 11.0 deployment baseline, then
   run `bun run manifest` to regenerate `MANIFEST.sha256`; record `clang --version`, `rustc -Vv`, Cargo,
   Bun, macOS, SDK, CPU model, and the exact build flags in signed provenance;
3. pack with lifecycle scripts disabled and record the tarball SHA-256 and npm
   registry integrity without executing the package; require
   `dependency-lock.audit` in the tarball and byte-equal to source `bun.lock`;
4. create a signed Git tag whose message contains both hashes;
5. publish identical bytes to npm, GitHub Releases, Software Heritage, and one
   independent long-term archive, then download and re-hash every copy.

Publishing is deliberately separate from development. Never run these external
steps merely because tests pass; the owner must explicitly authorize a release.
The co-shipped manifest detects accidental drift but does not authenticate its
own origin; trust comes from the signed release tag/tarball plus registry integrity.
