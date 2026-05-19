export type FactorInfo = {
  factor: number;
  shards: number;
  time: string;
  tier: string;
};

export const FACTOR_INFO: FactorInfo[] = [
  { factor: 1, shards: 1, time: '3s', tier: 'Test' },
  { factor: 2, shards: 10, time: '30s', tier: 'Basic' },
  { factor: 3, shards: 100, time: '5min', tier: 'Standard' },
  { factor: 4, shards: 1000, time: '50min', tier: 'Strong' },
  { factor: 5, shards: 10000, time: '8hr', tier: 'Maximum' },
];

export const FAQ_ITEMS = [
  {
    q: 'What is BrainVault?',
    a: 'BrainVault generates a cryptocurrency wallet from something you can remember: a name (public) and passphrase (secret). No need to write down 24 random words - your brain IS the backup.',
  },
  {
    q: 'How is this different from old "brainwallets"?',
    a: 'Old brainwallets used fast hashing (MD5/SHA256) and were cracked instantly. BrainVault uses Argon2id - a memory-hard algorithm that requires gigabytes of RAM per attempt, making brute-force attacks impractical.',
  },
  {
    q: 'What does "sharded" mean?',
    a: 'Instead of one giant computation, we split it into many 256MB shards. Your phone computes them sequentially; a powerful computer computes them in parallel. Same wallet, different speeds.',
  },
  {
    q: 'What is the "factor"?',
    a: 'Factor determines security level. Each factor quadruples the work needed. Factor 5 (~64GB equivalent) is good for most users. Factor 9 (~16TB equivalent) would take attackers millions of years.',
  },
  {
    q: 'Can I recover my wallet anywhere?',
    a: 'Yes! Same name + passphrase + factor = same wallet on any device, anywhere, forever. No seed phrase backup needed. But remember: if you forget your inputs, your funds are GONE.',
  },
  {
    q: 'What about the 24-word mnemonic?',
    a: 'BrainVault generates a standard BIP39 mnemonic for compatibility. You can import it into MetaMask, Ledger, or any wallet. The mnemonic IS your wallet - treat it as sensitive as a password.',
  },
  {
    q: 'What is the device passphrase?',
    a: 'An additional layer for hardware wallets. On Ledger/Trezor, set it as a "hidden wallet" passphrase. The mnemonic alone opens a decoy wallet; add the passphrase for your real wallet.',
  },
  {
    q: 'How strong should my passphrase be?',
    a: 'At least 6 characters minimum, but longer is better. A memorable sentence works great: "My cat Felix was born in 2019!" is far stronger than "P@ssw0rd123".',
  },
  {
    q: 'What if I forget my name/passphrase/factor?',
    a: 'Your funds are permanently lost. There is no recovery. This is the tradeoff for not needing a backup. Consider storing a hint somewhere safe, but NEVER the actual passphrase.',
  },
  {
    q: 'Can I use this as a password manager?',
    a: 'Yes! Once derived, enter any domain to generate a unique strong password for that site. The passwords are deterministically derived from your master key.',
  },
  {
    q: 'How can I verify this code is safe?',
    a: 'This is 100% open source. View source: github.com/xlnfinance/xln. Run locally: git clone, cd frontend, bun install, bun run dev. Check Network tab - zero external requests. You can even disconnect from internet and it still works.',
  },
];

export const STRENGTH_COLORS: Record<string, string> = {
  weak: '#ef4444',
  fair: '#f59e0b',
  good: '#84cc16',
  strong: '#22c55e',
  excellent: '#06b6d4',
};

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function generateBase58Secret(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => BASE58[byte % BASE58.length]!).join('');
}

export function formatUSD(value: number): string {
  if (value === 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

export function formatRuntimeDurationRounded(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.max(0, Math.ceil(safeMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

export function formatMemoryLabel(memoryMb: number): string {
  if (memoryMb >= 1024) return `${(memoryMb / 1024).toFixed(1)} GB`;
  return `${Math.floor(memoryMb)} MB`;
}

