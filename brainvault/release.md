# BrainVault V1 release discipline

V1 derivation never changes. A release may repair UX, packaging, portability,
or an implementation defect only when every frozen vector retains the same
root. No release may replace a historical tarball.

Before a release:

1. run the per-commit tests, the package/offline sandbox tests, and all twelve
   `workers=1/2/8/32` by `multiplier=1/2/10` matrix cases;
2. rebuild each native executable twice from the locked source and require
   byte-identical SHA-256 output and equality with every shipped prebuild, then
   regenerate `MANIFEST.sha256`; record `clang --version`, `rustc -Vv`, Cargo,
   Bun, macOS, SDK, CPU model, and the exact build flags in signed provenance;
3. pack with lifecycle scripts disabled and record the tarball SHA-256 and npm
   registry integrity without executing the package;
4. create a signed Git tag whose message contains both hashes;
5. publish identical bytes to npm, GitHub Releases, Software Heritage, and one
   independent long-term archive, then download and re-hash every copy.

Publishing is deliberately separate from development. Never run these external
steps merely because tests pass; the owner must explicitly authorize a release.
The co-shipped manifest detects accidental drift but does not authenticate its
own origin; trust comes from the signed release tag/tarball plus registry integrity.
