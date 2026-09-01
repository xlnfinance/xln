import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, readdir } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';

export const HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM = 'sha256' as const;

export type HltAuthoritySourceBinding = Readonly<{
  algorithm: typeof HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM;
  runtimeSeedHash: string;
  walTreeHash: string;
}>;

const digestHex = (hash: Hash): string => `0x${hash.digest('hex')}`;

const frameHashInput = (hash: Hash, bytes: Uint8Array): void => {
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(bytes.byteLength));
  hash.update(length);
  hash.update(bytes);
};

const hashRuntimeSeed = (runtimeSeed: string): string => {
  const normalized = runtimeSeed.trim();
  if (!normalized) throw new Error('HLT_AUTHORITY_SOURCE_RUNTIME_SEED_EMPTY');
  const hash = createHash(HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM);
  frameHashInput(hash, Buffer.from(normalized, 'utf8'));
  return digestHex(hash);
};

const listWalFiles = async (root: string, directory = root): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => (
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  ))) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`HLT_AUTHORITY_SOURCE_WAL_SYMLINK:${path}`);
    if (entry.isDirectory()) files.push(...await listWalFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`HLT_AUTHORITY_SOURCE_WAL_ENTRY:${path}`);
  }
  return files;
};

export const hashAuthorityWalTree = async (walPath: string): Promise<string> => {
  const root = resolve(walPath);
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory()) throw new Error(`HLT_AUTHORITY_SOURCE_WAL_NOT_DIRECTORY:${root}`);
  const files = await listWalFiles(root);
  if (files.length === 0) throw new Error(`HLT_AUTHORITY_SOURCE_WAL_EMPTY:${root}`);
  const hash = createHash(HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM);
  for (const path of files) {
    const stat = await lstat(path);
    const relativePath = relative(root, path).split(sep).join('/');
    frameHashInput(hash, Buffer.from(relativePath, 'utf8'));
    frameHashInput(hash, Buffer.from(String(stat.size), 'ascii'));
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  }
  return digestHex(hash);
};

export const buildHltAuthoritySourceBinding = async (
  walPath: string,
  runtimeSeed: string,
): Promise<HltAuthoritySourceBinding> => ({
  algorithm: HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM,
  runtimeSeedHash: hashRuntimeSeed(runtimeSeed),
  walTreeHash: await hashAuthorityWalTree(walPath),
});

export const assertHltAuthoritySourceBinding = async (
  binding: HltAuthoritySourceBinding,
  walPath: string,
  runtimeSeed: string,
): Promise<void> => {
  if (binding.algorithm !== HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM) {
    throw new Error(`HLT_AUTHORITY_SOURCE_BINDING_ALGORITHM:${binding.algorithm}`);
  }
  const actualSeedHash = hashRuntimeSeed(runtimeSeed);
  if (actualSeedHash !== binding.runtimeSeedHash) {
    throw new Error(`HLT_AUTHORITY_SOURCE_RUNTIME_SEED_HASH:${binding.runtimeSeedHash}:${actualSeedHash}`);
  }
  const actualWalTreeHash = await hashAuthorityWalTree(walPath);
  if (actualWalTreeHash !== binding.walTreeHash) {
    throw new Error(`HLT_AUTHORITY_SOURCE_WAL_TREE_HASH:${binding.walTreeHash}:${actualWalTreeHash}`);
  }
};

export const copyBoundAuthorityWal = async (
  source: string,
  target: string,
  binding: HltAuthoritySourceBinding,
  runtimeSeed: string,
): Promise<void> => {
  await cp(source, target, { recursive: true, errorOnExist: true, force: false });
  await assertHltAuthoritySourceBinding(binding, target, runtimeSeed);
};
