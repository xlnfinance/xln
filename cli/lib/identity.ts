import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { HDNodeWallet, Mnemonic, getIndexedAccountPath } from 'ethers';
import { validateMnemonic, generateMnemonic } from 'bip39';
import { deriveBrainVaultNative } from '../../brainvault/native.ts';
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
  await mkdir(settings.homeDir, { recursive: true });
  await writeFile(walletPath(settings), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  return record;
};

export const loadWalletRecord = async (settings: CliSettings): Promise<WalletRecord> => {
  const raw = await readFile(walletPath(settings), 'utf8');
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
  await writeFile(walletPath(settings), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
};

export const resolvePassphrase = (explicit?: string): string | null => {
  const fromEnv = process.env['XLN_PASSPHRASE']?.trim();
  if (explicit?.trim()) return explicit.trim();
  if (fromEnv) return fromEnv;
  return null;
};
