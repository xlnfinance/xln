/**
 * C1 differential-encoder corpus generator (single source for TS and Rust).
 *
 * Emits one JSON file per case into the corpus dir. Every file uses the shared
 * tagged wire schema below, so both drivers reconstruct the exact same input:
 *
 *   Value = {t:'null'} | {t:'bool',v} | {t:'num',v:<JS-canonical text>} |
 *           {t:'bign',v:<decimal>} | {t:'str',v} | {t:'arr',v:Value[]} |
 *           {t:'map',v:[[Value,Value],...]} | {t:'set',v:Value[]} |
 *           {t:'obj',v:[[key,Value|{t:'undef'}],...]}
 *   Case  = {id, kind, class, ...payload}
 *     kind: 'value' | 'flat-root' | 'radix-leaf' | 'radix-branch' |
 *           'radix-extension' | 'radix-tree' | 'tx'
 *     class: 'both-encode' | 'both-reject' | 'rust-rejects' | 'ts-only'
 *
 * Deterministic: same --seed + --count => identical corpus (splitmix64 PRNG).
 * Strings are always well-formed Unicode: JS TextEncoder maps lone surrogates
 * to U+FFFD while Rust strings cannot hold them at all, so that domain is out
 * of scope (documented in report.md).
 */
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ── deterministic PRNG (splitmix64 over two 32-bit lanes) ────────────────────
const makePrng = (seed: number) => {
  let hi = seed >>> 0;
  let lo = (seed * 0x9e3779b1) >>> 0;
  let bits = 0;
  const nextU32 = (): number => {
    lo = (lo + 0x9e3779b9) >>> 0;
    hi = (hi ^ (lo >>> 15)) >>> 0;
    hi = (hi * 0x85ebca6b) >>> 0;
    hi = (hi ^ (hi >>> 13)) >>> 0;
    bits = (bits * 0x41c64e6d + 0x3039) >>> 0;
    return (hi ^ bits) >>> 0;
  };
  return {
    nextU32,
    int: (maxExclusive: number): number => nextU32() % maxExclusive,
    bool: (): boolean => (nextU32() & 1) === 1,
    pick: <T>(items: readonly T[]): T => items[nextU32() % items.length]!,
  };
};
type Prng = ReturnType<typeof makePrng>;

// ── random f64 via raw bit patterns (restricted to finite) ───────────────────
const randomFiniteDouble = (rng: Prng): number => {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  for (;;) {
    view.setUint32(0, rng.nextU32());
    view.setUint32(4, rng.nextU32());
    const value = view.getFloat64(0);
    if (Number.isFinite(value)) return value;
  }
};

const hex32 = (rng: Prng): string => {
  let text = '0x';
  for (let index = 0; index < 32; index += 1) text += (rng.nextU32() % 256).toString(16).padStart(2, '0');
  return text;
};
const hex64Id = (rng: Prng): string => '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex');
const randomBytes = (rng: Prng, length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) bytes[index] = rng.nextU32() % 256;
  return bytes;
};
const randomBigint = (rng: Prng, maxHexDigits = 40): bigint => {
  const digits = 1 + rng.int(maxHexDigits);
  let text = '';
  for (let index = 0; index < digits; index += 1) text += '0123456789abcdef'[rng.int(16)];
  const magnitude = BigInt('0x' + text);
  return rng.bool() ? -magnitude : magnitude;
};

// ── string pools (all well-formed; surrogates only as valid pairs) ──────────
const ASCII_POOL = 'abcXYZ019 _-.:/\u0000';
const stringPool = (rng: Prng, length: number): string => {
  const mode = rng.int(8);
  let text = '';
  while (text.length < length) {
    if (mode === 0) text += ASCII_POOL[rng.int(ASCII_POOL.length - 4)];
    else if (mode === 1) text += String.fromCharCode(0x80 + rng.int(0x7f)); // latin-1
    else if (mode === 2) text += String.fromCharCode(0x4e00 + rng.int(2000)); // BMP CJK
    else if (mode === 3) text += String.fromCodePoint(0x10000 + rng.int(0xfffff)); // non-BMP
    else if (mode === 4) text += String.fromCodePoint(rng.bool() ? 0x1f600 : 0x1f9d0); // emoji
    else if (mode === 5) text += '\u200b\u0301\u0301'; // zero-width + combining
    else if (mode === 6) text += String.fromCodePoint(0xfffd + rng.int(2)); // U+FFFD..U+FFFE
    else text += ASCII_POOL[rng.int(ASCII_POOL.length)];
  }
  let sliced = text.slice(0, length);
  // Slicing between a surrogate pair would create a lone surrogate: Rust
  // strings cannot hold one and JS TextEncoder would hash U+FFFD instead.
  while (sliced.length > 0) {
    const last = sliced.codePointAt(sliced.length - 1)!;
    if (last >= 0xd800 && last <= 0xdbff) sliced = sliced.slice(0, -1);
    else break;
  }
  return sliced;
};
/** String whose UTF-8 encoding is exactly `byteLength` bytes (multibyte-safe). */
const byteExactString = (byteLength: number, filler: string): string => {
  const unit = new TextEncoder().encode(filler);
  const whole = Math.floor(byteLength / unit.length);
  const rest = byteLength - whole * unit.length;
  let text = filler.repeat(whole);
  if (rest > 0) text += ' '.repeat(rest);
  return text;
};

// ── CanonicalValue wire builders ─────────────────────────────────────────────
type WireValue = { t: string; v?: unknown };
const wNull: WireValue = { t: 'null' };
const wBool = (v: boolean): WireValue => ({ t: 'bool', v });
const wNum = (v: string): WireValue => ({ t: 'num', v });
const wBig = (v: string): WireValue => ({ t: 'bign', v });
const wStr = (v: string): WireValue => ({ t: 'str', v });
const wArr = (v: WireValue[]): WireValue => ({ t: 'arr', v });
const wMap = (v: [WireValue, WireValue][]): WireValue => ({ t: 'map', v });
const wSet = (v: WireValue[]): WireValue => ({ t: 'set', v });
const wObj = (v: [string, WireValue][]): WireValue => ({ t: 'obj', v });
const wUndef: WireValue = { t: 'undef' };

const NUMBER_BOUNDARIES = [
  '0', '9007199254740991', '-9007199254740991', '1e+21', '1e-7', '0.000001',
  '5e-324', '1.7976931348623157e+308', '-1.7976931348623157e+308', '-3.5', '0.1',
  '123456789012345680', '0.30000000000000004', '100000000000000000000',
];

const randomNumberWire = (rng: Prng): string => {
  const mode = rng.int(4);
  if (mode === 0) return String(rng.int(2000000) - 1000000);
  if (mode === 1) return String(randomFiniteDouble(rng));
  if (mode === 2) return rng.pick(NUMBER_BOUNDARIES);
  return String(rng.int(9007199254740991));
};

const randomStringWire = (rng: Prng): string => {
  const length = rng.int(24);
  if (rng.int(6) === 0) return stringPool(rng, 55 + rng.int(2)); // RLP boundary
  return stringPool(rng, length);
};

const randomBigintWire = (rng: Prng): string => {
  if (rng.int(8) === 0) return rng.pick(['0', '255', '256', '65535', '65536', '-255', '-256']);
  return randomBigint(rng).toString();
};

// Object keys chosen to flip order between UTF-16 (JS `<`) and UTF-8 byte
// comparison — the exact cmp_utf16 trap the readme calls out.
const ORDER_FLIP_KEYS = ['\uFFFB', '\uFFFE', '\uFFFF', '\u{10000}', '\u{1F600}', '\u{FFFD}', 'a', 'z'];

const randomValue = (rng: Prng, depth: number): WireValue => {
  if (depth <= 0) {
    const leaf = rng.int(5);
    if (leaf === 0) return wNull;
    if (leaf === 1) return wBool(rng.bool());
    if (leaf === 2) return wNum(randomNumberWire(rng));
    if (leaf === 3) return wBig(randomBigintWire(rng));
    return wStr(randomStringWire(rng));
  }
  const branch = rng.int(9);
  const breadth = rng.int(4);
  if (branch <= 1) return wArr(Array.from({ length: breadth }, () => randomValue(rng, depth - 1)));
  if (branch <= 3) {
    // Keys are deduped by wire identity: random collisions are never
    // intentional, and both encoders must reject a duplicated key.
    const seen = new Set<string>();
    const pairs: [WireValue, WireValue][] = [];
    for (let index = 0; index < breadth; index += 1) {
      const key = randomValue(rng, 0);
      const fingerprint = JSON.stringify(key);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      pairs.push([key, randomValue(rng, depth - 1)]);
    }
    return wMap(pairs);
  }
  if (branch === 4) {
    const seen = new Set<string>();
    const members: WireValue[] = [];
    for (let index = 0; index < breadth; index += 1) {
      const member = randomValue(rng, 0);
      const fingerprint = JSON.stringify(member);
      if (seen.has(fingerprint)) continue;
      seen.add(fingerprint);
      members.push(member);
    }
    return wSet(members);
  }
  if (branch <= 6) {
    const seen = new Set<string>();
    const entries: [string, WireValue][] = [];
    for (let index = 0; index < breadth; index += 1) {
      const key = rng.int(3) === 0 ? rng.pick(ORDER_FLIP_KEYS) : stringPool(rng, rng.int(8));
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push([key, rng.int(10) === 0 ? wUndef : randomValue(rng, depth - 1)]);
    }
    return wObj(entries);
  }
  const leaf = rng.int(5);
  if (leaf === 0) return wNull;
  if (leaf === 1) return wBool(rng.bool());
  if (leaf === 2) return wNum(randomNumberWire(rng));
  if (leaf === 3) return wBig(randomBigintWire(rng));
  return wStr(randomStringWire(rng));
};

// ── case model ───────────────────────────────────────────────────────────────
type CaseClass = 'both-encode' | 'both-reject' | 'rust-rejects' | 'ts-only';
type Case = { id: string; kind: string; class: CaseClass; [key: string]: unknown };

const writeCase = (dir: string, testCase: Case): void => {
  writeFileSync(resolve(dir, `${testCase.id}.json`), JSON.stringify(testCase));
};

// ── tx wire generators (mirror of core/types/account.ts AccountTx) ──────────
const u16 = (rng: Prng): number => rng.int(65536);
const u32 = (rng: Prng): number => rng.int(4294967296);
const safeU64 = (rng: Prng): number => rng.int(9007199254740991);
const bigW = (rng: Prng): string => randomBigint(rng, 24).toString();
const txRandom = (rng: Prng, kind: string): Record<string, unknown> => {
  const opt = <T>(value: T): [boolean, T] => [rng.bool(), value];
  switch (kind) {
    case 'direct_payment': {
      const [hasDescription, description] = opt(stringPool(rng, rng.int(12)));
      const [hasGateway, gateway] = opt(hex64Id(rng));
      return {
        tokenId: u16(rng), amount: bigW(rng), route: Array.from({ length: rng.int(3) }, () => hex64Id(rng)),
        ...(hasDescription ? { description } : {}), fromEntityId: hex64Id(rng), toEntityId: hex64Id(rng),
        deliveryMode: rng.bool() ? 'direct' : 'trusted',
        ...(hasGateway ? { trustedGatewayEntityId: gateway } : {}),
      };
    }
    case 'add_delta':
      return { tokenId: u16(rng) };
    case 'set_credit_limit':
      return { tokenId: u16(rng), amount: bigW(rng) };
    case 'rebalance_policy':
      return {
        tokenId: u32(rng),
        policyVersion: rng.bool() ? 9007199254740991 : rng.int(9007199254740990) + 1,
        baseFee: bigW(rng), liquidityFeeBps: bigW(rng), gasFee: bigW(rng),
      };
    case 'swap_offer': {
      const [hasTif, tif] = opt(rng.int(3));
      const [hasTicks, ticks] = opt(bigW(rng));
      return {
        offerId: hex64Id(rng), giveTokenId: u32(rng), giveTokenDecimals: u32(rng), giveAmount: bigW(rng),
        wantTokenId: u32(rng), wantTokenDecimals: u32(rng), wantAmount: bigW(rng), maxFee: bigW(rng),
        minNetReceive: bigW(rng), ...(hasTif ? { timeInForce: tif } : {}), ...(hasTicks ? { priceTicks: ticks } : {}),
      };
    }
    case 'swap_resolve': {
      const optionalBig = () => { const [has, value] = opt(bigW(rng)); return has ? value : undefined; };
      const optionalU32 = () => { const [has, value] = opt(u32(rng)); return has ? value : undefined; };
      const [hasNum, num] = opt(bigW(rng));
      const [hasDen, den] = opt(bigW(rng));
      const [hasComment, comment] = opt(stringPool(rng, rng.int(10)));
      const [hasFeeToken, feeToken] = opt(u32(rng));
      const [hasFeeAmount, feeAmount] = opt(bigW(rng));
      const [hasExecGive, execGive] = opt(bigW(rng));
      const [hasExecWant, execWant] = opt(bigW(rng));
      const [hasRestGiveToken, restGiveToken] = opt(u32(rng));
      const [hasRestWantToken, restWantToken] = opt(u32(rng));
      const [hasRestTicks, restTicks] = opt(bigW(rng));
      const [hasRestGive, restGive] = opt(bigW(rng));
      const [hasRestWant, restWant] = opt(bigW(rng));
      const [hasQuantGive, quantGive] = opt(bigW(rng));
      const [hasQuantWant, quantWant] = opt(bigW(rng));
      return {
        offerId: hex64Id(rng), fillRatio: u32(rng),
        ...(hasNum ? { fillNumerator: num } : {}), ...(hasDen ? { fillDenominator: den } : {}),
        cancelRemainder: rng.bool(), ...(hasComment ? { comment } : {}),
        ...(hasFeeToken ? { feeTokenId: feeToken } : {}), ...(hasFeeAmount ? { feeAmount } : {}),
        ...(hasExecGive ? { executionGiveAmount: execGive } : {}), ...(hasExecWant ? { executionWantAmount: execWant } : {}),
        ...(hasRestGiveToken ? { restingGiveTokenId: restGiveToken } : {}), ...(hasRestWantToken ? { restingWantTokenId: restWantToken } : {}),
        ...(hasRestTicks ? { restingPriceTicks: restTicks } : {}), ...(hasRestGive ? { restingGiveAmount: restGive } : {}),
        ...(hasRestWant ? { restingWantAmount: restWant } : {}), ...(hasQuantGive ? { restingQuantizedGive: quantGive } : {}),
        ...(hasQuantWant ? { restingQuantizedWant: quantWant } : {}),
      };
    }
    case 'swap_cancel_request':
      return { offerId: hex64Id(rng) };
    case 'htlc_lock': {
      const [hasMode, mode] = opt(rng.bool() ? 'instant' : 'async');
      const [hasEnvelope, envelope] = opt({
        version: 'xln:htlc-opaque:aes-gcm',
        ciphertext: Buffer.from(randomBytes(rng, 48 + rng.int(113))).toString('base64'),
      });
      return {
        lockId: hex64Id(rng), hashlock: hex32(rng), timelock: bigW(rng), revealBeforeHeight: safeU64(rng),
        amount: bigW(rng), tokenId: u16(rng),
        ...(hasMode ? { deliveryMode: mode } : {}), ...(hasEnvelope ? { envelope } : {}),
      };
    }
    case 'htlc_resolve':
      return rng.bool()
        ? { lockId: hex64Id(rng), outcome: 'secret', secret: hex32(rng) }
        : { lockId: hex64Id(rng), outcome: 'error', ...(rng.bool() ? { reason: stringPool(rng, rng.int(12)) } : {}) };
    case 'j_event_claim': {
      const events = Array.from({ length: 1 + rng.int(3) }, () => {
        const data = {
          leftEntity: hex64Id(rng), rightEntity: hex64Id(rng), tokenId: u16(rng),
          leftReserve: bigW(rng), rightReserve: bigW(rng), collateral: bigW(rng), ondelta: bigW(rng),
          nonce: rng.int(2147483648),
        };
        return {
          type: 'AccountSettled', data,
          ...(rng.bool() ? { blockNumber: rng.int(2147483648) } : {}),
          ...(rng.bool() ? { blockHash: hex32(rng) } : {}),
          ...(rng.bool() ? { transactionHash: hex32(rng) } : {}),
          ...(rng.bool() ? { logIndex: rng.int(1024) } : {}),
          ...(rng.bool() ? { eventIndex: rng.int(1024) } : {}),
        };
      });
      const proof = () => ({
        version: 1,
        nodes: Array.from({ length: rng.int(3) }, () => rng.bool()
          ? { version: 1, type: 'leaf', key: hex32(rng), record: { version: 1, accountKey: hex32(rng), side: rng.bool() ? 'left' : 'right', jHeight: rng.int(2147483648), jBlockHash: hex32(rng), eventsHash: hex32(rng) } }
          : { version: 1, type: 'branch', bit: rng.int(65536), left: hex32(rng), right: hex32(rng) }),
      });
      const [hasLeft, left] = opt(proof());
      const [hasRight, right] = opt(proof());
      return {
        jHeight: safeU64(rng), jBlockHash: hex32(rng), events,
        ...(hasLeft ? { leftProof: left } : {}), ...(hasRight ? { rightProof: right } : {}),
      };
    }
    default:
      throw new Error(`TX_KIND_UNKNOWN:${kind}`);
  }
};

const TX_KINDS = [
  'direct_payment', 'add_delta', 'set_credit_limit', 'rebalance_policy', 'swap_offer',
  'swap_resolve', 'swap_cancel_request', 'htlc_lock', 'htlc_resolve', 'j_event_claim',
] as const;

// ── sharp seeds (readme-mandated edges + boundary probes) ────────────────────
const seeds = (): Case[] => {
  const cases: Case[] = [];
  const push = (id: string, kind: string, klass: CaseClass, payload: Record<string, unknown>) =>
    cases.push({ id: `seed-${id}`, kind, class: klass, ...payload });

  // scalars
  push('scalar-null', 'value', 'both-encode', { value: wNull });
  push('scalar-bool', 'value', 'both-encode', { value: wArr([wBool(true), wBool(false)]) });
  const numberSeeds: [string, CaseClass][] = [
    ['0', 'both-encode'], ['9007199254740991', 'both-encode'], ['-9007199254740991', 'both-encode'],
    ['1e+21', 'both-encode'], ['1e-7', 'both-encode'], ['0.000001', 'both-encode'],
    ['5e-324', 'both-encode'], ['1.7976931348623157e+308', 'both-encode'], ['-1.7976931348623157e+308', 'both-encode'],
    ['123456789012345680', 'both-encode'], // String(Number("123456789012345678"))
    ['123456789012345678', 'rust-rejects'], // not a canonical rendering: binary64 rounds to ...680
    ['0.30000000000000004', 'both-encode'],
    ['NaN', 'both-reject'], ['Infinity', 'both-reject'], ['-Infinity', 'both-reject'],
    ['-0', 'rust-rejects'], // TS String(-0)==="0"; Rust parse_js_canonical rejects "-0" text
    ['1e21', 'rust-rejects'], // non-canonical text: JS renders 1e+21
    ['1.0', 'rust-rejects'], ['01', 'rust-rejects'], ['+1', 'rust-rejects'],
  ];
  for (const [text, klass] of numberSeeds) {
    push(`number-${text.replace(/[^0-9a-zA-Z+-]/g, (c) => '.' + c.codePointAt(0)!)}`, 'value', klass, { value: wNum(text) });
  }
  // bigint: zero magnitude is the [0] byte, not empty
  for (const text of ['0', '255', '256', '65535', '65536', '-255', '-256', '-1',
    '115792089237316195423570985008687907853269984665640564039457584007913129639936']) {
    push(`bigint-${text.replace(/[^0-9-]/g, '')}`, 'value', 'both-encode', { value: wBig(text) });
  }
  // strings: empty, RLP 55/56 boundaries in 1/2/3/4-byte encodings, non-BMP
  const stringSeeds: [string, string][] = [
    ['empty', ''],
    ['ascii-55', byteExactString(55, 'a')], ['ascii-56', byteExactString(56, 'a')],
    ['latin1-55', byteExactString(55, '\u00e9')], ['latin1-56', byteExactString(56, '\u00e9')],
    ['cjk-55', byteExactString(55, '\u4e2d')], ['cjk-56', byteExactString(56, '\u4e2d')],
    ['nonbmp-54', byteExactString(54, '\u{1F600}')], ['nonbmp-56', byteExactString(56, '\u{1F600}')],
    ['surrogate-pair', 'a\u{10000}b'], ['zwj-emoji', '\u{1F469}\u200D\u{1F4BB}'],
    ['combining', 'e\u0301\u0327'], ['zero-width', 'a\u200Bb\u2060c'],
    ['nul-byte', 'a\u0000b'], ['long-1024', byteExactString(1024, 'x')],
    ['replacement', '\uFFFD\uFFFE\uFFFF'], ['max-cp', '\u{10FFFF}'],
  ];
  for (const [id, text] of stringSeeds) push(`string-${id}`, 'value', 'both-encode', { value: wStr(text) });

  // empty containers and nested empties
  push('empty-array', 'value', 'both-encode', { value: wArr([]) });
  push('empty-set', 'value', 'both-encode', { value: wSet([]) });
  push('empty-map', 'value', 'both-encode', { value: wMap([]) });
  push('empty-object', 'value', 'both-encode', { value: wObj([]) });
  push('nested-empty', 'value', 'both-encode', {
    value: wObj([['a', wArr([wSet([]), wMap([]), wObj([['b', wNull]])])]]),
  });

  // duplicates: both sides must reject (TS via driver boundary check, Rust in encoder)
  push('dup-map-key', 'value', 'both-reject', { value: wMap([[wStr('dup'), wNum('1')], [wStr('dup'), wNum('2')]]) });
  push('dup-map-key-nested', 'value', 'both-reject', {
    value: wMap([[wArr([wStr('k')]), wNull], [wArr([wStr('k')]), wBool(true)]]),
  });
  push('dup-set-value', 'value', 'both-reject', { value: wSet([wStr('dup'), wStr('dup')]) });
  push('dup-set-value-bigint', 'value', 'both-reject', { value: wSet([wBig('7'), wBig('7')]) });
  push('dup-object-key', 'value', 'both-reject', { value: wObj([['k', wNull], ['k', wBool(true)]]) });

  // undefined-valued own property: TS skips before hashing; schema models the boundary
  push('object-undefined-entry', 'value', 'both-encode', {
    value: wObj([['a', wUndef], ['b', wNum('1')]]),
  });
  push('object-undefined-only', 'value', 'both-encode', { value: wObj([['a', wUndef]]) });

  // UTF-16 vs UTF-8 key-order flips (cmp_utf16)
  for (const [id, keys] of [
    ['fffb-vs-10000', ['\uFFFB', '\u{10000}']],
    ['ffff-vs-10000', ['\uFFFF', '\u{10000}']],
    ['emoji-vs-fffd', ['\u{1F600}', '\uFFFD']],
    ['trio', ['\uFFFD', '\uFFFE', '\u{10000}', '\u{1F600}', 'a', 'z']],
  ] as [string, string[]][]) {
    push(`object-order-${id}`, 'value', 'both-encode', {
      value: wObj(keys.map((key, index) => [key, wNum(String(index))])),
    });
  }

  // map keys: mixed types, encoded-prefix relations, cross-type near collisions
  push('map-mixed-keys', 'value', 'both-encode', {
    value: wMap([
      [wNum('1'), wNull], [wBig('1'), wNull], [wStr('1'), wNull], [wBool(true), wNull],
      [wArr([wStr('a')]), wNull], [wStr('a'), wNull], [wStr('ab'), wNull], [wStr(''), wNull],
    ]),
  });
  push('map-nested-container-key', 'value', 'both-encode', {
    value: wMap([[wMap([[wStr('k'), wNum('1')]]), wStr('v')]]),
  });

  // depth + width (RLP long-list headers)
  let deep: WireValue = wNull;
  for (let index = 0; index < 12; index += 1) deep = wObj([[`d${index}`, wArr([deep])]]);
  push('deep-12', 'value', 'both-encode', { value: deep });
  push('wide-200', 'value', 'both-encode', {
    value: wArr(Array.from({ length: 200 }, (_, index) => wNum(String(index)))),
  });
  push('set-100-sorted', 'value', 'both-encode', {
    value: wSet(Array.from({ length: 100 }, (_, index) => wStr(`k-${String(index % 37).padStart(3, '0')}-${index}`))),
  });
  push('map-50', 'value', 'both-encode', {
    value: wMap(Array.from({ length: 50 }, (_, index) => [wStr(`key-${index}`), wBig(String(index * 7919 - 3959))])),
  });

  // flat integrity root
  push('flat-empty', 'flat-root', 'both-encode', { namespace: 'account.state', entries: [] });
  push('flat-single', 'flat-root', 'both-encode', {
    namespace: 'account.state',
    entries: [['identity', wObj([['chainId', wNum('31337')], ['seed', wStr('0x' + '11'.repeat(32))]])]],
  });
  push('flat-duplicate-path', 'flat-root', 'both-encode', {
    namespace: 'test',
    entries: [['p', wNum('1')], ['p', wNum('2')]],
  });
  push('flat-nonbmp-path', 'flat-root', 'both-encode', {
    namespace: 'ns\u{1F600}',
    entries: [['\u{10000}\uFFFB', wNull], ['a', wBool(true)]],
  });
  push('flat-55-56-path', 'flat-root', 'both-encode', {
    namespace: 'account.frame',
    entries: [[byteExactString(55, 'p'), wNull], [byteExactString(56, 'p'), wNull]],
  });

  // radix leaf / branch / extension / tree
  push('radix-leaf-empty-key', 'radix-leaf', 'both-encode', { keyHex: '0x', valueHex: '0x' + 'ab'.repeat(32) });
  push('radix-leaf-55-56-key', 'radix-leaf', 'both-encode', {
    keyHex: '0x' + 'cd'.repeat(27) + 'ef56',
    valueHex: '0x' + '01'.repeat(32),
  });
  push('radix-branch-empty', 'radix-branch', 'both-encode', { slots: Array.from({ length: 16 }, () => null) });
  push('radix-branch-slot0', 'radix-branch', 'both-encode', {
    slots: ['0x' + '22'.repeat(32), ...Array.from({ length: 15 }, () => null)],
  });
  push('radix-branch-slot15', 'radix-branch', 'both-encode', {
    slots: [...Array.from({ length: 15 }, () => null), '0x' + '22'.repeat(32)],
  });
  push('radix-branch-full', 'radix-branch', 'both-encode', {
    slots: Array.from({ length: 16 }, (_, slot) => '0x' + (slot + 1).toString(16).padStart(2, '0').repeat(32)),
  });
  push('radix-extension-odd', 'radix-extension', 'both-encode', { path: [2, 10, 11], childHex: '0x' + 'cd'.repeat(32) });
  push('radix-extension-even', 'radix-extension', 'both-encode', { path: [0, 1, 2, 3], childHex: '0x' + 'cd'.repeat(32) });
  push('radix-extension-long', 'radix-extension', 'both-encode', { path: [1, 2, 3, 4, 5, 6, 7], childHex: '0x' + 'cd'.repeat(32) });
  push('radix-extension-invalid-slot', 'radix-extension', 'both-reject', { path: [2, 16], childHex: '0x' + 'cd'.repeat(32) });
  push('radix-tree-single', 'radix-tree', 'both-encode', { leaves: [{ keyHex: '0x' + 'aa'.repeat(4), valueHex: '0x' + '01'.repeat(32) }] });
  push('radix-tree-shared-prefix', 'radix-tree', 'both-encode', {
    leaves: [
      { keyHex: '0xaabbcc', valueHex: '0x' + '01'.repeat(32) },
      { keyHex: '0xaabbdd', valueHex: '0x' + '02'.repeat(32) },
      { keyHex: '0xaabbee', valueHex: '0x' + '03'.repeat(32) },
    ],
  });
  push('radix-tree-fan16', 'radix-tree', 'both-encode', {
    leaves: Array.from({ length: 16 }, (_, slot) => ({
      keyHex: '0x' + slot.toString(16).padStart(2, '0') + 'ab'.repeat(5),
      valueHex: '0x' + (slot + 1).toString(16).padStart(2, '0').repeat(32),
    })),
  });
  push('radix-tree-dup-key', 'radix-tree', 'both-reject', {
    leaves: [
      { keyHex: '0x' + 'aa'.repeat(4), valueHex: '0x' + '01'.repeat(32) },
      { keyHex: '0x' + 'aa'.repeat(4), valueHex: '0x' + '02'.repeat(32) },
    ],
  });
  push('radix-tree-mixed-lengths', 'radix-tree', 'both-reject', {
    leaves: [
      { keyHex: '0x' + 'aa'.repeat(4), valueHex: '0x' + '01'.repeat(32) },
      { keyHex: '0x' + 'bb'.repeat(5), valueHex: '0x' + '02'.repeat(32) },
    ],
  });

  // tx: one minimal + one maximal seed per native kind
  for (const kind of TX_KINDS) {
    const rng = makePrng(1 + kind.length);
    const minimal = txRandom({ ...rng, int: (max: number) => 0, bool: () => false } as Prng, kind);
    const maximal = txRandom({ ...rng, int: (max: number) => Math.max(0, max - 1), bool: () => true } as Prng, kind);
    push(`tx-${kind}-minimal`, 'tx', 'both-encode', { txKind: kind, data: minimal });
    push(`tx-${kind}-maximal`, 'tx', 'both-encode', { txKind: kind, data: maximal });
  }
  // known asymmetric tx domains
  // FX-1/D2 made the protocol bound symmetric: both production engines now
  // reject policyVersion > Number.MAX_SAFE_INTEGER before frame hashing.
  // Keep the generated corpus authoritative; never hand-edit only the seed.
  push('tx-policy-unsafe-version', 'tx', 'both-reject', {
    txKind: 'rebalance_policy',
    data: { tokenId: 7, policyVersion: '9007199254740992', baseFee: '1', liquidityFeeBps: '2', gasFee: '3' },
  });
  push('tx-lending-fund', 'tx', 'ts-only', {
    txKind: 'lending_fund',
    data: { positionId: '0x' + 'aa'.repeat(32), hubEntityId: '0x' + 'bb'.repeat(32), lenderEntityId: '0x' + 'cc'.repeat(32), tokenId: 1, amount: '5', termId: 'one_hour', interestBps: 100 },
  });
  push('tx-reserve-to-collateral', 'tx', 'ts-only', {
    txKind: 'reserve_to_collateral',
    data: { tokenId: 1, collateral: '5', ondelta: '0', side: 'receiving', blockNumber: 1, transactionHash: '0x' + 'ee'.repeat(32) },
  });
  push('tx-request-collateral', 'tx', 'ts-only', {
    txKind: 'request_collateral',
    data: { tokenId: 1, amount: '7', feeTokenId: 2, feeAmount: '1', policyVersion: 3 },
  });
  return cases;
};

// ── random case generators ───────────────────────────────────────────────────
const randomValueCase = (rng: Prng): Case => {
  const roll = rng.int(20);
  let value = randomValue(rng, 1 + rng.int(3));
  let klass: CaseClass = 'both-encode';
  if (roll === 0) {
    // inject a duplicate map key / set value to exercise both-reject
    const key = randomValue(rng, 0);
    value = rng.bool()
      ? wMap([[key, wNull], [randomValue(rng, 0), wBool(true)], [key, wBool(true)]])
      : wSet([key, randomValue(rng, 0), key]);
    klass = 'both-reject';
  } else if (roll === 1) {
    value = wObj([['dup', randomValue(rng, 0)], ['dup', randomValue(rng, 0)]]);
    klass = 'both-reject';
  } else if (roll === 2) {
    value = wNum(rng.pick(['NaN', 'Infinity', '-Infinity']));
    klass = 'both-reject';
  }
  return { id: '', kind: 'value', class: klass, value };
};

const randomFlatCase = (rng: Prng): Case => {
  const namespace = rng.pick(['account.state', 'account.frame', 'entity.account-shadow', 'test', stringPool(rng, 4)]);
  const entries = Array.from({ length: rng.int(7) }, (_, index) => [
    rng.bool() && index > 0 ? 'identity' : stringPool(rng, rng.int(10)),
    randomValue(rng, 1 + rng.int(2)),
  ]);
  return { id: '', kind: 'flat-root', class: 'both-encode', namespace, entries };
};

const randomRadixLeafCase = (rng: Prng): Case => ({
  id: '', kind: 'radix-leaf', class: 'both-encode',
  keyHex: '0x' + Buffer.from(randomBytes(rng, rng.int(12))).toString('hex'),
  valueHex: '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex'),
});

const randomRadixBranchCase = (rng: Prng): Case => ({
  id: '', kind: 'radix-branch', class: 'both-encode',
  slots: Array.from({ length: 16 }, () => (rng.bool() ? '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex') : null)),
});

const randomRadixExtensionCase = (rng: Prng): Case => ({
  id: '', kind: 'radix-extension', class: 'both-encode',
  path: Array.from({ length: 1 + rng.int(6) }, () => rng.int(16)),
  childHex: '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex'),
});

const randomRadixTreeCase = (rng: Prng): Case => {
  const keyLength = 1 + rng.int(5);
  const roll = rng.int(12);
  if (roll === 0) {
    const key = '0x' + Buffer.from(randomBytes(rng, keyLength)).toString('hex');
    return {
      id: '', kind: 'radix-tree', class: 'both-reject',
      leaves: [
        { keyHex: key, valueHex: '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex') },
        { keyHex: key, valueHex: '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex') },
      ],
    };
  }
  if (roll === 1) {
    return {
      id: '', kind: 'radix-tree', class: 'both-reject',
      leaves: [
        { keyHex: '0x' + Buffer.from(randomBytes(rng, keyLength)).toString('hex'), valueHex: '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex') },
        { keyHex: '0x' + Buffer.from(randomBytes(rng, keyLength + 1)).toString('hex'), valueHex: '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex') },
      ],
    };
  }
  // shared-prefix-biased keys: same first bytes, diverging nibble late
  const prefix = randomBytes(rng, Math.max(0, keyLength - 1));
  const count = 1 + rng.int(7);
  const seen = new Set<string>();
  const leaves: { keyHex: string; valueHex: string }[] = [];
  while (leaves.length < count) {
    const key = new Uint8Array(keyLength);
    key.set(prefix.subarray(0, keyLength - 1));
    key[keyLength - 1] = rng.int(256);
    const keyHex = '0x' + Buffer.from(key).toString('hex');
    if (seen.has(keyHex)) continue;
    seen.add(keyHex);
    leaves.push({ keyHex, valueHex: '0x' + Buffer.from(randomBytes(rng, 32)).toString('hex') });
  }
  return { id: '', kind: 'radix-tree', class: 'both-encode', leaves };
};

const randomTxCase = (rng: Prng): Case => {
  const txKind = rng.pick(TX_KINDS);
  const data = txRandom(rng, txKind);
  return { id: '', kind: 'tx', class: 'both-encode', txKind, data };
};

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argValue = (name: string, fallback: string): string => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
};
const count = Number(argValue('count', '10000'));
const seed = Number(argValue('seed', '20260826'));
const numbersOnly = args.includes('--numbers-only');
const outDir = resolve(argValue('out', 'proofs/fuzz/enc-diff/corpus'));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let index = 0;
const emit = (testCase: Case): void => {
  index += 1;
  writeCase(outDir, { ...testCase, id: testCase.id || `case-${String(index).padStart(6, '0')}` });
};
for (const seedCase of seeds()) emit(seedCase);
const rng = makePrng(seed);

if (numbersOnly) {
  // Focused ryu_js-vs-String(number) torture: every case is one random finite
  // binary64 rendered by JavaScript, which Rust must accept byte-identically.
  for (let made = 0; made < count; made += 1) {
    emit({ id: '', kind: 'value', class: 'both-encode', value: wNum(String(randomFiniteDouble(rng))) });
  }
  console.log(JSON.stringify({ out: outDir, cases: index, seed, mode: 'numbers-only' }));
  process.exit(0);
}
const generators: ((rng: Prng) => Case)[] = [
  ...Array.from({ length: 45 }, () => randomValueCase),
  ...Array.from({ length: 10 }, () => randomFlatCase),
  ...Array.from({ length: 5 }, () => randomRadixLeafCase),
  ...Array.from({ length: 5 }, () => randomRadixBranchCase),
  ...Array.from({ length: 5 }, () => randomRadixExtensionCase),
  ...Array.from({ length: 5 }, () => randomRadixTreeCase),
  ...Array.from({ length: 25 }, () => randomTxCase),
];
for (let made = 0; made < count; made += 1) emit(generators[rng.int(generators.length)]!(rng));

console.log(JSON.stringify({ out: outDir, cases: index, seed, note: 'per-class tally printed by run.ts' }));
