import { describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDemoMnemonic,
  deriveHd,
  saveWallet,
  unlockWallet,
  walletExists,
} from '../lib/identity';
import type { CliSettings } from '../lib/settings';
import { resolveJurisdictionRpc } from '../lib/api';
import { resolveCliRelayUrl } from '../lib/session';

const tempSettings = async (): Promise<CliSettings> => {
  const homeDir = await mkdtemp(join(tmpdir(), 'xln-cli-id-'));
  return {
    barStyle: 'closed',
    apiBase: 'https://xln.finance',
    dbPath: join(homeDir, 'db'),
    homeDir,
    socketPath: join(homeDir, 'daemon.sock'),
    profileName: 'wallet',
  };
};

describe('cli identity', () => {
  test('encrypts and unlocks mnemonic roundtrip', async () => {
    const settings = await tempSettings();
    try {
      const mnemonic = createDemoMnemonic();
      const { address } = deriveHd(mnemonic, 0);
      expect(await walletExists(settings)).toBe(false);
      await saveWallet(settings, { mnemonic, passphrase: 'secret', label: 't' });
      expect(await walletExists(settings)).toBe(true);
      expect((await stat(join(settings.homeDir, 'wallet.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(settings.homeDir)).mode & 0o777).toBe(0o700);
      const unlocked = await unlockWallet(settings, 'secret');
      expect(unlocked.runtimeId).toBe(address);
      expect(unlocked.signerAddress).toBe(address);
      expect(unlocked.mnemonic.split(' ').length).toBe(12);
    } finally {
      await rm(settings.homeDir, { recursive: true, force: true });
    }
  });

  test('wrong passphrase fails loud', async () => {
    const settings = await tempSettings();
    try {
      await saveWallet(settings, {
        mnemonic: createDemoMnemonic(),
        passphrase: 'right',
        label: 't',
      });
      await expect(unlockWallet(settings, 'wrong')).rejects.toThrow();
    } finally {
      await rm(settings.homeDir, { recursive: true, force: true });
    }
  });

  test('rejects a wallet file that is readable by another user', async () => {
    const settings = await tempSettings();
    try {
      await saveWallet(settings, {
        mnemonic: createDemoMnemonic(),
        passphrase: 'right',
        label: 't',
      });
      await chmod(join(settings.homeDir, 'wallet.json'), 0o644);
      await expect(unlockWallet(settings, 'right')).rejects.toThrow('CLI_WALLET_FILE_PERMISSIONS_INVALID');
    } finally {
      await rm(settings.homeDir, { recursive: true, force: true });
    }
  });
});

describe('resolveJurisdictionRpc', () => {
  test('resolves relative /rpc against api base like frontend', () => {
    expect(resolveJurisdictionRpc({ rpc: '/rpc' }, 'https://xln.finance')).toBe(
      'https://xln.finance/rpc',
    );
    expect(resolveJurisdictionRpc({ rpc: '/rpc2' }, 'http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/rpc2',
    );
  });
});

describe('resolveCliRelayUrl', () => {
  test('binds P2P to the same API origin without carrying credentials', () => {
    expect(resolveCliRelayUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/relay');
    expect(resolveCliRelayUrl('https://user:secret@xln.finance/api?token=x#frag')).toBe(
      'wss://xln.finance/relay',
    );
  });

  test('rejects a non-HTTP API origin', () => {
    expect(() => resolveCliRelayUrl('ftp://xln.finance')).toThrow('CLI_API_PROTOCOL_INVALID:ftp:');
  });
});
