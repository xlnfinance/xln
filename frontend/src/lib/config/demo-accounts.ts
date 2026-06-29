/**
 * Demo accounts for quick testing.
 * Throwaway testnet identities — each session generates unique random passwords,
 * so these reset on every reload. Names feed seed derivation + become entity names.
 */

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';

function randomPassword(len = 8): string {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => CHARS[b % CHARS.length]).join('');
}

/** Persona category — drives chip coloring in quick login. */
export type DemoRole = 'user' | 'hub' | 'app';

export interface DemoAccount {
  /** Short label shown on the chip. */
  label: string;
  /** Name used for seed derivation + public entity name. */
  name: string;
  password: string;
  factor: number;
  role: DemoRole;
}

function make(label: string, role: DemoRole): DemoAccount {
  return { label, name: label, password: randomPassword(), factor: 1, role };
}

export const DEMO_ACCOUNTS: DemoAccount[] = [
  // Local sandbox users (throwaway BrainVault seeds). Real hubs/apps connect via the
  // live-runtime dropdown (radapter token system), not throwaway seeds.
  ...['A', 'B', 'C', 'D', 'E'].map((l) => make(l, 'user')),
];

export const DEFAULT_DEMO_ACCOUNT = DEMO_ACCOUNTS[0];
