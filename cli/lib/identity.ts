import { access, chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { HDNodeWallet, Mnemonic, getIndexedAccountPath } from 'ethers';
import { validateMnemonic, generateMnemonic } from 'bip39';
import { deriveBrainVaultNative } from '../../brainvault/src/native/index.ts';
import type { CliSettings } from './settings';

export type WalletRecord = {
  version: 1;
  runtimeId: string;
  entityId: string | null;
  label: string;
  createdAt: string;
  /** AES-GCM encrypted mnemonic JSON */
  cipher: {
    salt: string;
    iv: string;
    tag: string;
    data: string;
  };
};

export type UnlockedIdentity = {
  mnemonic: string;
  runtimeId: string;
  signerAddress: string;
  privateKeyHex: string;
  privateKeyBytes: Uint8Array;
  label: string;
  entityId: string | null;
};

const walletPath = (settings: CliSettings): string => join(settings.homeDir, 'wallet.json');

const writeWalletRecord = async (
  settings: CliSettings,
  record: WalletRecord,
): Promise<void> => {
  await mkdir(settings.homeDir, { recursive: true, mode: 0o700 });
  await chmod(settings.homeDir, 0o700);
  const path = walletPath(settings);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporaryPath, path);
    await chmod(path, 0o600);
    const directory = await open(settings.homeDir, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
};

export const walletExists = async (settings: CliSettings): Promise<boolean> => {
  try {
    await access(walletPath(settings));
    return true;
  } catch {
    return false;
  }
};

export const deriveHd = (mnemonic: string, index = 0): { address: string; privateKey: string } => {
  const phrase = String(mnemonic || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!validateMnemonic(phrase)) throw new Error('Invalid BIP39 mnemonic');
  const node = HDNodeWallet.fromMnemonic(Mnemonic.fromPhrase(phrase), getIndexedAccountPath(index));
  return { address: node.address.toLowerCase(), privateKey: node.privateKey };
};

const encryptMnemonic = (mnemonic: string, passphrase: string) => {
  const salt = randomBytes(16);
  const key = scryptSync(passphrase, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(mnemonic, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: data.toString('hex'),
  };
};

const decryptMnemonic = (cipher: WalletRecord['cipher'], passphrase: string): string => {
  const key = scryptSync(passphrase, Buffer.from(cipher.salt, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(cipher.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(cipher.tag, 'hex'));
  const plain = Buffer.concat([
    decipher.update(Buffer.from(cipher.data, 'hex')),
    decipher.final(),
  ]);
  return plain.toString('utf8');
};

export const createDemoMnemonic = (): string => generateMnemonic(128);

export const createFromBrainVault = async (input: {
  name: string;
  passphrase: string;
  shardInput?: number;
}): Promise<string> => {
  const result = await deriveBrainVaultNative({
    name: input.name,
    passphrase: input.passphrase,
    shardInput: input.shardInput ?? 1,
    workers: 1,
  });
  return result.mnemonic24;
};

export const saveWallet = async (
  settings: CliSettings,
  input: {
    mnemonic: string;
    passphrase: string;
    label: string;
    entityId?: string | null;
  },
): Promise<WalletRecord> => {
  const { address } = deriveHd(input.mnemonic, 0);
  const record: WalletRecord = {
    version: 1,
    runtimeId: address,
    entityId: input.entityId ?? null,
    label: input.label,
    createdAt: new Date().toISOString(),
    cipher: encryptMnemonic(input.mnemonic.trim().toLowerCase().replace(/\s+/g, ' '), input.passphrase),
  };
  await writeWalletRecord(settings, record);
  return record;
};

export const loadWalletRecord = async (settings: CliSettings): Promise<WalletRecord> => {
  const path = walletPath(settings);
  const [homeStat, walletStat] = await Promise.all([lstat(settings.homeDir), lstat(path)]);
  if (!homeStat.isDirectory() || (homeStat.mode & 0o777) !== 0o700) {
    throw new Error('CLI_WALLET_HOME_PERMISSIONS_INVALID: expected 0700');
  }
  if (!walletStat.isFile() || walletStat.isSymbolicLink() || (walletStat.mode & 0o777) !== 0o600) {
    throw new Error('CLI_WALLET_FILE_PERMISSIONS_INVALID: expected regular 0600 file');
  }
  const expectedUid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (expectedUid !== null && (homeStat.uid !== expectedUid || walletStat.uid !== expectedUid)) {
    throw new Error('CLI_WALLET_OWNER_INVALID');
  }
  const raw = await readFile(path, 'utf8');
  const record = JSON.parse(raw) as WalletRecord;
  if (record.version !== 1 || !record.cipher?.data) throw new Error('Corrupt wallet.json');
  return record;
};

export const unlockWallet = async (settings: CliSettings, passphrase: string): Promise<UnlockedIdentity> => {
  const record = await loadWalletRecord(settings);
  const mnemonic = decryptMnemonic(record.cipher, passphrase);
  const { address, privateKey } = deriveHd(mnemonic, 0);
  if (address !== record.runtimeId) {
    throw new Error('Wallet runtimeId mismatch after decrypt — wrong passphrase or corrupt file');
  }
  const privateKeyBytes = new Uint8Array(
    privateKey
      .slice(2)
      .match(/.{2}/g)!
      .map(byte => parseInt(byte, 16)),
  );
  return {
    mnemonic,
    runtimeId: address,
    signerAddress: address,
    privateKeyHex: privateKey,
    privateKeyBytes,
    label: record.label,
    entityId: record.entityId,
  };
};

export const updateWalletEntityId = async (settings: CliSettings, entityId: string): Promise<void> => {
  const record = await loadWalletRecord(settings);
  record.entityId = entityId;
  await writeWalletRecord(settings, record);
};

export const resolvePassphrase = (): string | null => {
  const fromEnv = process.env['XLN_PASSPHRASE']?.trim();
  if (fromEnv) return fromEnv;
  return null;
};
