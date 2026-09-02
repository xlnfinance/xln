# BrainVault V1 byte specification

Status: frozen. Changing any normative byte or parameter derives a different
wallet. Implementations may optimize scheduling and memory reuse, but they MUST
reproduce the reference vectors in `vectors-v1.json`.

The words MUST, MUST NOT, SHOULD, and MAY are normative.

## 1. Inputs

A derivation has these semantic inputs:

- `name`: non-empty string;
- `passphrase`: non-empty string;
- `shardCount`: integer in `1..4294967295`;
- `factor`: frozen V1 factor committed to the root;
- `multiplier`: positive integer, normally `1`.

Whitespace and case are significant. Implementations MUST NOT trim, case-fold,
or silently repair either string.

For both strings:

1. apply Unicode NFKD normalization;
2. encode the result as UTF-8;
3. replace any unpaired UTF-16 surrogate with U+FFFD before UTF-8 encoding.

The resulting byte strings are `nameBytes` and `passphraseBytes`.

## 2. Frozen constants

```text
canonicalAlgId   = "brainvault/argon2id-sharded/v1.0"
argonType       = Argon2id
argonVersion    = 0x13
baseMemoryKiB   = 262144
timeCost        = 1
parallelism     = 1
shardOutputLen  = 32 bytes
rootOutputLen   = 32 bytes
```

No implementation default is part of V1. Every value above MUST be supplied
explicitly to the KDF.

For multiplier `1`:

```text
algId       = canonicalAlgId
memoryKiB   = baseMemoryKiB
```

For multiplier greater than `1`:

```text
algId       = canonicalAlgId || "|custom"
memoryKiB   = baseMemoryKiB * multiplier
```

The multiplication MUST be exact and MUST fail on integer overflow.

## 3. User levels and frozen factor

Levels are creation UX only. They map to exact shard counts:

```text
level 1 / test     =         1 shard
level 2 / unsafe   =       100 shards
level 3 / quick    =     1,000 shards
level 4 / standard =    10,000 shards (default)
level 5 / hard     =   100,000 shards
level 6 / million  = 1,000,000 shards
```

Levels never enter the derivation. For an exact shard count, derive the frozen
factor as follows:

```text
factor(1) = 1
factor(n) = decimal_digit_count(n - 1) + 1, for n > 1
```

This is exactly `ceil(log10(n)) + 1` without floating-point arithmetic.
Therefore level 4 is 10,000 shards with frozen factor 5.

Legacy factor recovery remains normative:

```text
shardCount = 10^(factor - 1), factor in 1..9
```

Thus legacy factor 2 remains exactly 10 shards even though 10 is not offered as
a new-wallet level.

## 4. Shard salt

`U32BE(x)` is the four-byte unsigned big-endian representation of `x`.

For shard index `i`, where `0 <= i < shardCount`:

```text
saltInput = nameBytes
         || UTF8(algId)
         || U32BE(shardCount)
         || U32BE(i)

salt[i] = BLAKE3-256(saltInput)
```

The name is a public salt input, not secret entropy.

## 5. Shard KDF

For every shard index in `0..shardCount-1`:

```text
shard[i] = Argon2id(
  password      = passphraseBytes,
  salt          = salt[i],
  version       = 0x13,
  memoryKiB     = memoryKiB,
  timeCost      = 1,
  parallelism   = 1,
  outputLength  = 32
)
```

Shards MAY run in any order and with any worker count. Results MUST be restored
to ascending numeric index order before combination.

## 6. Root combination

Concatenate every 32-byte shard result in ascending numeric index order:

```text
shardBytes = shard[0] || shard[1] || ... || shard[shardCount - 1]
```

Construct this exact ASCII/UTF-8 domain string with base-10 integers and no
spaces or newline:

```text
domain = algId
      || "|mem="    || decimal(memoryKiB)
      || "|t=1"
      || "|p=1"
      || "|out=32"
      || "|shards=" || decimal(shardCount)
      || "|factor=" || decimal(factor)
```

The canonical 32-byte root is:

```text
root = BLAKE3-256(shardBytes || UTF8(domain))
```

Worker count, engine name, operating system, timing, and completion order MUST
NOT enter the salt, domain, or root.

## 7. Wallet projections

The following deterministic projections are part of BrainVault V1:

```text
entropy24 = BLAKE3(root || UTF8("bip39/entropy/v1.0"), outputLength=32)
entropy12 = BLAKE3(root || UTF8("bip39/entropy-128/v1.0"), outputLength=16)
deviceKey = BLAKE3(root || UTF8("bip39/passphrase/v1.0"), outputLength=32)
```

Convert `entropy24` and `entropy12` to BIP-39 English mnemonics using the exact
2,048-word list whose newline-terminated SHA-256 is:

```text
2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda
```

Use the standard BIP-39 checksum and an empty BIP-39 mnemonic passphrase.

Ethereum address discovery paths are:

```text
standard[i]   = m/44'/60'/0'/0/i
ledgerLive[i] = m/44'/60'/i'/0/0
```

Both the 24-word primary mnemonic and 12-word secondary mnemonic use these path
families independently.

## 8. Failure behavior

An implementation MUST fail rather than derive when:

- name or passphrase is empty;
- an integer is non-integral, out of range, or overflows;
- a shard is missing, duplicated, malformed, or returned for another spec;
- a native engine returns a non-zero status or an unexpected byte count;
- requested memory or engine constraints cannot be honored exactly.

An implementation MUST NOT silently substitute multiplier `1`, change a shard
count, reorder results, or fall back after an explicitly selected engine fails.
Automatic engine selection MAY fall back only to another engine that has proven
byte parity for the same complete parameter set.

## 9. Security boundary

BrainVault does not create entropy. It makes each password candidate pay the
configured Argon2id memory work for every shard. The name is public. A weak or
reused passphrase remains weak regardless of waiting time.

V1 intentionally defines no recovery receipt, seed file, QR backup, network
service, clock input, or randomness inside derivation. Remembering the exact
inputs and work settings is the recovery mechanism.

CLI implementations SHOULD print only a short root fingerprint and the first
public address after derivation. Mnemonics and private material SHOULD require
exact hidden passphrase rehearsal; empty rehearsal SHOULD exit without reveal.
Passphrases MUST NOT be accepted through command-line arguments because shell
history and process listings commonly retain argv. These are disclosure rules;
they do not alter any V1 derivation byte.
