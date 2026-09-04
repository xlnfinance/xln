# Ten-year BrainVault recovery kit

The domain, npm, GitHub, Cloudflare, Bun, and today's Apple binaries are delivery
conveniences. None is part of the wallet recipe. A decade-long plan must survive
any one of them disappearing.

Preserve several authenticated **public** copies of:

- the exact release tarball and its SHA-256;
- `spec-v1.md`, `tests/data/vectors-v1.json`, and `manifest.sha256`;
- the complete source tree, dependency lock, vendored native source, and licenses;
- the release verification instructions and a known first public address.

These files do not contain the password, mnemonic, root, or private key. They
describe how to reconstruct the algorithm. Store copies on different media and
with different trusted people or archives. A public mirror is acceptable.

The private recovery boundary remains the exact Username, Password, Shard count,
and Multiplier. The intended BrainVault design keeps those in memory. Writing
them down is allowed, but it converts that copy into a secret backup with its
own theft and discovery risk.

Once a year, on a private offline machine:

1. authenticate one preserved release;
2. run the frozen vectors;
3. perform a fresh derivation from memory;
4. compare the complete known first receiving address;
5. reveal no mnemonic unless recovery is actually needed.

Keeping an old Bun executable is useful but insufficient: future operating
systems may stop running it. The normative spec, vectors, portable TypeScript,
complete dependency source, and native source are the real portability layers.
An independent future implementation can be accepted only when it reproduces
every frozen vector byte-for-byte.

No honest project can guarantee that future hardware, compilers, archives, or a
human memory will work for 10 or 100 years. BrainVault's defensible claim is
narrower: recovery does not require a server or private seed artifact, and the
frozen public recipe contains enough evidence for independent reimplementation.
