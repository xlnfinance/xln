import { ethers } from 'ethers';

export const HASHLADDER_MAX_FILL_RATIO = 0xffff;
export const HASHLADDER_NIBBLE_COUNT = 4;
export const HASHLADDER_MAX_NIBBLE = 15;

const HEX_32_RE = /^0x[0-9a-fA-F]{64}$/;

export type HashLadderCommitment = {
  fullHash: string;
  partialRoot: string;
};

export type HashLadderSecrets = {
  fullSecret: string;
  nibbleBases: [string, string, string, string];
};

export type HashLadderProof = HashLadderCommitment & HashLadderSecrets;

export type HashLadderReveal = {
  fillRatio: number;
  binary: string;
  fullSecret?: string;
  reveals?: [string, string, string, string];
};

export type DecodedHashLadderBinary = {
  fillRatio: number;
  fullSecret?: string;
  reveals?: [string, string, string, string];
};

export function hashNode(node: string): string {
  if (!HEX_32_RE.test(node)) throw new Error(`HASHLADDER_INVALID_NODE:${node}`);
  return ethers.keccak256(node);
}

export function hashSteps(node: string, steps: number): string {
  let result = node;
  for (let i = 0; i < Math.max(0, Math.floor(steps)); i += 1) {
    result = hashNode(result);
  }
  return result;
}

export function nibbles(fillRatio: number): [number, number, number, number] {
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(fillRatio) || 0)));
  return [
    (ratio >> 12) & 0x0f,
    (ratio >> 8) & 0x0f,
    (ratio >> 4) & 0x0f,
    ratio & 0x0f,
  ];
}

export function partialRootFromRoots(roots: readonly string[]): string {
  if (roots.length !== HASHLADDER_NIBBLE_COUNT) {
    throw new Error(`HASHLADDER_INVALID_ROOT_COUNT:${roots.length}`);
  }
  return ethers.keccak256(ethers.solidityPacked(['bytes32', 'bytes32', 'bytes32', 'bytes32'], roots));
}

export function buildHashLadderCommitment(secrets: HashLadderSecrets): HashLadderCommitment {
  const roots = secrets.nibbleBases.map(base => hashSteps(base, HASHLADDER_MAX_NIBBLE));
  return {
    fullHash: hashNode(secrets.fullSecret),
    partialRoot: partialRootFromRoots(roots),
  };
}

export function buildHashLadderProof(seed: string): HashLadderProof {
  const secretFor = (suffix: string): string => ethers.keccak256(ethers.toUtf8Bytes(`${seed}:${suffix}`));
  const secrets: HashLadderSecrets = {
    fullSecret: secretFor('full'),
    nibbleBases: [
      secretFor('n0'),
      secretFor('n1'),
      secretFor('n2'),
      secretFor('n3'),
    ],
  };
  return {
    ...secrets,
    ...buildHashLadderCommitment(secrets),
  };
}

export function revealHashLadder(proof: HashLadderProof, fillRatio: number): HashLadderReveal {
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(fillRatio) || 0)));
  if (ratio === 0) {
    return { fillRatio: 0, binary: '0x' };
  }
  if (ratio === HASHLADDER_MAX_FILL_RATIO) {
    return { fillRatio: ratio, binary: proof.fullSecret, fullSecret: proof.fullSecret };
  }
  const digits = nibbles(ratio);
  const reveals = proof.nibbleBases.map((base, index) =>
    hashSteps(base, HASHLADDER_MAX_NIBBLE - digits[index]!),
  ) as [string, string, string, string];
  return {
    fillRatio: ratio,
    binary: encodeHashLadderPartialBinary(ratio, reveals),
    reveals,
  };
}

export function encodeHashLadderPartialBinary(fillRatio: number, reveals: readonly string[]): string {
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(fillRatio) || 0)));
  if (ratio <= 0 || ratio >= HASHLADDER_MAX_FILL_RATIO) {
    throw new Error(`HASHLADDER_PARTIAL_RATIO_INVALID:${ratio}`);
  }
  if (reveals.length !== HASHLADDER_NIBBLE_COUNT || reveals.some(reveal => !HEX_32_RE.test(reveal))) {
    throw new Error('HASHLADDER_PARTIAL_REVEALS_INVALID');
  }
  const ratioHex = ratio.toString(16).padStart(4, '0');
  return `0x${ratioHex}${reveals.map(reveal => reveal.slice(2)).join('')}`;
}

export function encodeHashLadderBinaryFromParts(
  fillRatio: number,
  fullSecret?: string,
  reveals?: readonly string[],
): string {
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(fillRatio) || 0)));
  if (ratio === 0) return '0x';
  if (ratio === HASHLADDER_MAX_FILL_RATIO) {
    if (!fullSecret || !HEX_32_RE.test(fullSecret)) throw new Error('HASHLADDER_FULL_SECRET_INVALID');
    return fullSecret;
  }
  if (!reveals) throw new Error('HASHLADDER_PARTIAL_REVEALS_MISSING');
  return encodeHashLadderPartialBinary(ratio, reveals);
}

export function decodeHashLadderBinary(binary?: string): DecodedHashLadderBinary {
  const value = String(binary || '0x').toLowerCase();
  if (value === '0x') return { fillRatio: 0 };
  if (!value.startsWith('0x') || value.length % 2 !== 0) {
    throw new Error('HASHLADDER_BINARY_INVALID_HEX');
  }
  const byteLength = (value.length - 2) / 2;
  if (byteLength === 32) {
    if (!HEX_32_RE.test(value)) throw new Error('HASHLADDER_FULL_BINARY_INVALID');
    return { fillRatio: HASHLADDER_MAX_FILL_RATIO, fullSecret: value };
  }
  if (byteLength !== 130) {
    throw new Error(`HASHLADDER_BINARY_INVALID_LENGTH:${byteLength}`);
  }
  const fillRatio = Number.parseInt(value.slice(2, 6), 16);
  if (!Number.isInteger(fillRatio) || fillRatio <= 0 || fillRatio >= HASHLADDER_MAX_FILL_RATIO) {
    throw new Error(`HASHLADDER_PARTIAL_BINARY_RATIO_INVALID:${fillRatio}`);
  }
  const reveals = [0, 1, 2, 3].map(index => {
    const start = 6 + index * 64;
    return `0x${value.slice(start, start + 64)}`;
  }) as [string, string, string, string];
  if (reveals.some(reveal => !HEX_32_RE.test(reveal))) {
    throw new Error('HASHLADDER_PARTIAL_BINARY_REVEALS_INVALID');
  }
  return { fillRatio, reveals };
}

export function verifyHashLadderReveal(
  commitment: HashLadderCommitment,
  fillRatio: number,
  fullSecret?: string,
  reveals?: readonly string[],
): boolean {
  const ratio = Math.max(0, Math.min(HASHLADDER_MAX_FILL_RATIO, Math.floor(Number(fillRatio) || 0)));
  if (ratio === 0) return true;
  if (ratio === HASHLADDER_MAX_FILL_RATIO) {
    return !!fullSecret && HEX_32_RE.test(fullSecret) && hashNode(fullSecret).toLowerCase() === commitment.fullHash.toLowerCase();
  }
  if (!reveals || reveals.length !== HASHLADDER_NIBBLE_COUNT) return false;
  const digits = nibbles(ratio);
  const roots = reveals.map((reveal, index) => hashSteps(reveal, digits[index]!));
  return partialRootFromRoots(roots).toLowerCase() === commitment.partialRoot.toLowerCase();
}

export function verifyHashLadderBinary(commitment: HashLadderCommitment, binary?: string): DecodedHashLadderBinary {
  const decoded = decodeHashLadderBinary(binary);
  const ok = verifyHashLadderReveal(commitment, decoded.fillRatio, decoded.fullSecret, decoded.reveals);
  if (!ok) throw new Error('HASHLADDER_BINARY_VERIFY_FAILED');
  return decoded;
}
