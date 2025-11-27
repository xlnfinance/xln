<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { HDNodeWallet } from 'ethers';
  import { locale, translations$, initI18n, loadTranslations } from '$lib/i18n';
  import ERC20Send from '$lib/components/Wallet/ERC20Send.svelte';
  import DepositToEntity from '$lib/components/Wallet/DepositToEntity.svelte';
  import { keccak256, zeroPadValue } from 'ethers';

  // Initialize i18n
  let i18nReady = false;
  $: t = $translations$;

  // ============================================================================
  // CRYPTO WORKER HELPER
  // We use a dedicated worker for all BLAKE3 operations since hash-wasm
  // doesn't work well in the main thread (Buffer polyfill issues)
  // ============================================================================

  let cryptoWorker: Worker | null = null;
  let cryptoWorkerId = 0;
  const cryptoCallbacks = new Map<number, { resolve: (data: any) => void; reject: (err: Error) => void }>();

  async function initCryptoWorker(): Promise<void> {
    if (cryptoWorker) return;

    cryptoWorker = new Worker('/brainvault-worker.js', { type: 'module' });

    cryptoWorker.onmessage = (e) => {
      const { type, id, data } = e.data;
      const callback = cryptoCallbacks.get(id);
      if (!callback) return;

      if (type === 'error') {
        callback.reject(new Error(data.message));
      } else {
        callback.resolve(data);
      }
      cryptoCallbacks.delete(id);
    };

    // Wait for worker to be ready
    return new Promise((resolve, reject) => {
      const id = ++cryptoWorkerId;
      const timeout = setTimeout(() => reject(new Error('Crypto worker init timeout')), 10000);
      cryptoCallbacks.set(id, {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (err) => { clearTimeout(timeout); reject(err); }
      });
      cryptoWorker!.postMessage({ type: 'init', id });
    });
  }

  async function workerBlake3(inputHex: string): Promise<string> {
    await initCryptoWorker();
    return new Promise((resolve, reject) => {
      const id = ++cryptoWorkerId;
      cryptoCallbacks.set(id, { resolve: (d) => resolve(d.resultHex), reject });
      cryptoWorker!.postMessage({ type: 'blake3', id, data: { inputHex } });
    });
  }

  async function workerHashName(name: string): Promise<string> {
    await initCryptoWorker();
    return new Promise((resolve, reject) => {
      const id = ++cryptoWorkerId;
      cryptoCallbacks.set(id, { resolve: (d) => resolve(d.nameHashHex), reject });
      cryptoWorker!.postMessage({ type: 'hash_name', id, data: { name } });
    });
  }

  // ============================================================================
  // CONSTANTS
  // ============================================================================

  const BRAINVAULT_V2 = {
    ALG_ID: 'brainvault/argon2id-sharded/v2.0',
    SHARD_MEMORY_KB: 256 * 1024,
    MIN_NAME_LENGTH: 1,
    MIN_PASSPHRASE_LENGTH: 6,
    MIN_FACTOR: 1,
    MAX_FACTOR: 9,
  };

  // Attack cost assumes: $0.05/GB-hour on AWS, 1M password guesses
  // Time to crack = shards × 256MB × $0.05/GB-hr × 1M guesses
  const FACTOR_INFO = [
    { factor: 1, shards: 1, memory: '256MB', time: '3s', description: 'Demo only', attackCost: '$13K', attackTime: '1 hour' },
    { factor: 2, shards: 4, memory: '1GB', time: '12s', description: 'Testing', attackCost: '$50K', attackTime: '4 hours' },
    { factor: 3, shards: 16, memory: '4GB', time: '50s', description: 'Coffee money', attackCost: '$200K', attackTime: '1 day' },
    { factor: 4, shards: 64, memory: '16GB', time: '3min', description: 'Pocket change', attackCost: '$800K', attackTime: '5 days' },
    { factor: 5, shards: 256, memory: '64GB', time: '13min', description: 'Savings', attackCost: '$3.2M', attackTime: '3 weeks' },
    { factor: 6, shards: 1024, memory: '256GB', time: '50min', description: 'Serious money', attackCost: '$13M', attackTime: '3 months' },
    { factor: 7, shards: 4096, memory: '1TB', time: '3.5hr', description: 'Life savings', attackCost: '$51M', attackTime: '1 year' },
    { factor: 8, shards: 16384, memory: '4TB', time: '14hr', description: 'Generational', attackCost: '$200M', attackTime: '4 years' },
    { factor: 9, shards: 65536, memory: '16TB', time: '55hr', description: 'Nation-state', attackCost: '$800M', attackTime: '16 years' },
  ];

  // ============================================================================
  // IDENTICON GENERATOR (Ethereum Blockies-style)
  // ============================================================================

  function generateIdenticon(address: string, size = 8): string {
    // Simple hash function for seed
    const seed = address.toLowerCase().replace('0x', '');
    let seedInt = 0;
    for (let i = 0; i < seed.length; i++) {
      seedInt = ((seedInt << 5) - seedInt + seed.charCodeAt(i)) | 0;
    }

    // PRNG based on seed
    const rand = () => {
      const x = Math.sin(seedInt++) * 10000;
      return x - Math.floor(x);
    };

    // Generate colors from seed
    const hue = Math.floor(rand() * 360);
    const sat = 50 + Math.floor(rand() * 30);
    const colors = [
      `hsl(${hue}, ${sat}%, 65%)`,
      `hsl(${(hue + 120) % 360}, ${sat}%, 35%)`,
      `hsl(${(hue + 240) % 360}, ${sat}%, 50%)`
    ];

    // Generate pattern (symmetric)
    const pattern: number[][] = [];
    for (let y = 0; y < size; y++) {
      const row: number[] = [];
      pattern[y] = row;
      for (let x = 0; x < Math.ceil(size / 2); x++) {
        const v = Math.floor(rand() * 3);
        row[x] = v;
        row[size - 1 - x] = v; // Mirror
      }
    }

    // Render to SVG
    const cellSize = 10;
    let svg = `<svg width="${size * cellSize}" height="${size * cellSize}" viewBox="0 0 ${size * cellSize} ${size * cellSize}" xmlns="http://www.w3.org/2000/svg">`;
    svg += `<rect width="100%" height="100%" fill="${colors[0]}"/>`;
    for (let y = 0; y < size; y++) {
      const row = pattern[y];
      if (!row) continue;
      for (let x = 0; x < size; x++) {
        const val = row[x] ?? 0;
        if (val > 0) {
          svg += `<rect x="${x * cellSize}" y="${y * cellSize}" width="${cellSize}" height="${cellSize}" fill="${colors[val]}"/>`;
        }
      }
    }
    svg += '</svg>';
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  // Reactive identicon
  $: identiconSrc = ethereumAddress ? generateIdenticon(ethereumAddress) : '';

  const FAQ_ITEMS = [
    {
      q: 'What is BrainVault?',
      a: 'BrainVault generates a cryptocurrency wallet from something you can remember: a name (public) and passphrase (secret). No need to write down 24 random words - your brain IS the backup.'
    },
    {
      q: 'How is this different from old "brainwallets"?',
      a: 'Old brainwallets used fast hashing (MD5/SHA256) and were cracked instantly. BrainVault uses Argon2id - a memory-hard algorithm that requires gigabytes of RAM per attempt, making brute-force attacks impractical.'
    },
    {
      q: 'What does "sharded" mean?',
      a: 'Instead of one giant computation, we split it into many 256MB shards. Your phone computes them sequentially; a powerful computer computes them in parallel. Same wallet, different speeds.'
    },
    {
      q: 'What is the "factor"?',
      a: 'Factor determines security level. Each factor quadruples the work needed. Factor 5 (~64GB equivalent) is good for most users. Factor 9 (~16TB equivalent) would take attackers millions of years.'
    },
    {
      q: 'Can I recover my wallet anywhere?',
      a: 'Yes! Same name + passphrase + factor = same wallet on any device, anywhere, forever. No seed phrase backup needed. But remember: if you forget your inputs, your funds are GONE.'
    },
    {
      q: 'What about the 24-word mnemonic?',
      a: 'BrainVault generates a standard BIP39 mnemonic for compatibility. You can import it into MetaMask, Ledger, or any wallet. The mnemonic IS your wallet - treat it as sensitive as a password.'
    },
    {
      q: 'What is the device passphrase?',
      a: 'An additional layer for hardware wallets. On Ledger/Trezor, set it as a "hidden wallet" passphrase. The mnemonic alone opens a decoy wallet; add the passphrase for your real wallet.'
    },
    {
      q: 'How strong should my passphrase be?',
      a: 'At least 6 characters minimum, but longer is better. A memorable sentence works great: "My cat Felix was born in 2019!" is far stronger than "P@ssw0rd123".'
    },
    {
      q: 'What if I forget my name/passphrase/factor?',
      a: 'Your funds are permanently lost. There is no recovery. This is the tradeoff for not needing a backup. Consider storing a hint somewhere safe, but NEVER the actual passphrase.'
    },
    {
      q: 'Can I use this as a password manager?',
      a: 'Yes! Once derived, enter any domain to generate a unique strong password for that site. The passwords are deterministically derived from your master key.'
    },
    {
      q: 'How can I verify this code is safe?',
      a: 'This is 100% open source. View source: github.com/xlnfinance/xln. Run locally: git clone, cd frontend, bun install, bun run dev. Check Network tab - zero external requests. You can even disconnect from internet and it still works.'
    },
  ];

  // Short memorable words for passphrase suggestion (3-5 letters each)
  const WORDS = [
    'sun', 'moon', 'star', 'fire', 'wind', 'rain', 'snow', 'leaf', 'tree', 'bird',
    'wolf', 'bear', 'fish', 'frog', 'lion', 'hawk', 'deer', 'swan', 'crow', 'owl',
    'blue', 'red', 'gold', 'jade', 'ruby', 'onyx', 'iron', 'silk', 'oak', 'ash',
    'dawn', 'dusk', 'noon', 'tide', 'wave', 'rock', 'sand', 'peak', 'cave', 'lake',
    'rose', 'lily', 'fern', 'vine', 'seed', 'root', 'bark', 'twig', 'moss', 'herb',
    'king', 'sage', 'bard', 'monk', 'lord', 'duke', 'earl', 'chef', 'smith', 'mage',
  ];

  function suggestPassphrase(): void {
    // Pick 3 random words = ~17.8 bits each × 3 = ~53 bits
    // Combined with factor 5+ this is very strong
    const words: string[] = [];
    const used = new Set<number>();
    while (words.length < 3) {
      const idx = Math.floor(Math.random() * WORDS.length);
      if (!used.has(idx)) {
        used.add(idx);
        words.push(WORDS[idx]!);
      }
    }
    passphrase = words.join('-');
  }

  // ============================================================================
  // STATE
  // ============================================================================

  type Phase = 'input' | 'deriving' | 'complete';

  let phase: Phase = 'input';

  // Input state
  let name = '';
  let passphrase = '';
  let showPassphrase = false;
  let factor = 5;
  let animationStyle: 'vault' | 'shards' = 'vault'; // Toggle between vault door and shard grid
  let soundTheme: 'off' | 'vault' | 'digital' | 'nature' | 'minimal' | 'retro' = 'off';
  $: soundEnabled = soundTheme !== 'off';

  // XLN tips shown during derivation
  const XLN_TIPS = [
    'xln enables instant off-chain payments between any two entities',
    'Every transaction is cryptographically signed and verifiable on-chain',
    'BrainVault uses Argon2id — the same algorithm trusted by password managers',
    'Your wallet exists in your memory. No seed phrase backup needed.',
    'xln supports multi-jurisdictional settlements across different blockchains',
    'Higher security factors = more shards = exponentially harder to brute-force',
    'The same name + passphrase + factor will always produce the same wallet',
    'xln entities can exchange value without trusting a central authority',
    'Device passphrase adds an extra layer — use it for hardware wallet hidden wallets',
    'Each shard requires 256MB of memory, making GPU attacks impractical',
    'xln uses bilateral consensus for instant finality between parties',
    'Your password manager passwords are derived from your master key — no storage needed',
    'Factor 5 requires ~64GB equivalent work — good balance of security and speed',
    'xln separates jurisdiction (law), entity (identity), and account (balance) layers',
    'The 24-word mnemonic is BIP39 standard — works with MetaMask, Ledger, Trezor',
    'xln enables programmable money with smart contract integration',
    'Memory-hard functions prevent specialized ASIC attacks on your passphrase',
    'xln achieves finality in milliseconds vs hours for on-chain transactions',
    'Your wallet address is derived from Ethereum\'s standard HD path m/44\'/60\'/0\'/0/0',
    'xln is open source — audit the code yourself at github.com/xlnfinance/xln',
  ];

  let currentTipIndex = 0;
  let tipInterval: ReturnType<typeof setInterval> | null = null;

  // Derivation state
  let workers: Worker[] = [];
  let workerCount = 1;
  let maxWorkers = typeof navigator !== 'undefined' ? Math.min(navigator.hardwareConcurrency || 4, 8) : 4;
  let targetWorkerCount = Math.ceil(maxWorkers / 2); // Start gentle at 50% CPU

  // Device memory detection (navigator.deviceMemory gives GB, default 8GB if unavailable)
  let deviceMemoryGB = typeof navigator !== 'undefined' ? ((navigator as any).deviceMemory || 8) : 8;
  let deviceMemoryMB = deviceMemoryGB * 1024;

  // Reactive memory calculations - show TARGET for immediate feedback, not actual workerCount
  $: allocatedMemoryMB = targetWorkerCount * 256;
  $: memoryPercent = Math.min(100, (allocatedMemoryMB / deviceMemoryMB) * 100);
  let shardCount = 0;
  let shardsCompleted = 0;
  let shardResults: Map<number, string> = new Map();
  let shardStatus: ('pending' | 'computing' | 'complete')[] = [];
  let estimatedShardTimeMs = 3000;
  let startTime = 0;
  let elapsedMs = 0;
  let elapsedInterval: ReturnType<typeof setInterval> | null = null;

  // Resume state
  let showResumeInput = false;

  // Result state
  let mnemonic24 = '';
  let mnemonic12 = '';
  let devicePassphrase = '';
  let ethereumAddress = '';
  let masterKeyHex = '';
  let entityId = ''; // bytes32 entity ID derived from address
  let showMnemonic = false;
  let showDevicePassphrase = false;
  let copiedField: string | null = null;

  // Password manager state
  let siteDomain = '';
  let sitePassword = '';
  let showSitePassword = false;

  // FAQ state
  let expandedFaq: number | null = null;

  // ============================================================================
  // AUDIO & HAPTICS - Mechanical vault clicks and mobile feedback
  // ============================================================================

  let audioCtx: AudioContext | null = null;
  let lastActiveTick = 0;

  function initAudio(): AudioContext {
    if (!audioCtx) {
      audioCtx = new AudioContext();
    }
    return audioCtx;
  }

  function playVaultClick(intensity: number = 1) {
    if (!soundEnabled) return;
    try {
      const ctx = initAudio();
      if (ctx.state === 'suspended') ctx.resume();

      switch (soundTheme) {
        case 'vault': // Heavy mechanical vault tumbler
          playVaultTumbler(ctx, intensity);
          break;
        case 'digital': // Sci-fi digital blip
          playDigitalBlip(ctx, intensity);
          break;
        case 'nature': // Soft water drop
          playWaterDrop(ctx, intensity);
          break;
        case 'minimal': // Subtle tick
          playMinimalTick(ctx, intensity);
          break;
        case 'retro': // 8-bit coin sound
          playRetroCoin(ctx, intensity);
          break;
      }
    } catch (e) {
      // Audio not available, ignore
    }
  }

  function playVaultTumbler(ctx: AudioContext, intensity: number) {
    // Heavy mechanical vault tumbler click
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(150 + Math.random() * 50, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(40, ctx.currentTime + 0.1);

    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(800, ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(100, ctx.currentTime + 0.08);
    filter.Q.value = 5;

    gain.gain.setValueAtTime(0.2 * intensity, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);

    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.12);
  }

  function playDigitalBlip(ctx: AudioContext, intensity: number) {
    // Sci-fi digital blip
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(800, ctx.currentTime + 0.05);

    gain.gain.setValueAtTime(0.12 * intensity, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.06);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.06);
  }

  function playWaterDrop(ctx: AudioContext, intensity: number) {
    // Soft water drop
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(600 + Math.random() * 200, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.15);

    gain.gain.setValueAtTime(0.08 * intensity, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.2);
  }

  function playMinimalTick(ctx: AudioContext, intensity: number) {
    // Subtle minimal tick
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(2000, ctx.currentTime);

    gain.gain.setValueAtTime(0.06 * intensity, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.02);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.02);
  }

  function playRetroCoin(ctx: AudioContext, intensity: number) {
    // 8-bit coin collect sound
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.setValueAtTime(987, ctx.currentTime);
    osc.frequency.setValueAtTime(1319, ctx.currentTime + 0.05);

    gain.gain.setValueAtTime(0.1 * intensity, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.1);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.1);
  }

  function playVaultOpen() {
    if (!soundEnabled) return;
    try {
      const ctx = initAudio();
      if (ctx.state === 'suspended') ctx.resume();

      // Heavy mechanical vault opening sound
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          const oscillator = ctx.createOscillator();
          const gainNode = ctx.createGain();

          oscillator.type = 'triangle';
          oscillator.frequency.setValueAtTime(100 + i * 30, ctx.currentTime);
          oscillator.frequency.exponentialRampToValueAtTime(50, ctx.currentTime + 0.2);

          gainNode.gain.setValueAtTime(0.2, ctx.currentTime);
          gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);

          oscillator.connect(gainNode);
          gainNode.connect(ctx.destination);

          oscillator.start(ctx.currentTime);
          oscillator.stop(ctx.currentTime + 0.3);
        }, i * 80);
      }
    } catch (e) {
      // Audio not available, ignore
    }
  }

  function hapticFeedback(pattern: 'tick' | 'complete') {
    if (!soundEnabled) return;
    if ('vibrate' in navigator) {
      if (pattern === 'tick') {
        navigator.vibrate(5);
      } else if (pattern === 'complete') {
        // Success pattern: short-pause-long
        navigator.vibrate([50, 100, 150]);
      }
    }
  }

  // Track tick activation for sound - play every ~16 chunks (not every tick)
  // 100% / ~6 sounds = ~16.67% intervals
  $: if (phase === 'deriving') {
    const currentActiveTick = Math.floor(progress / 16.67);
    if (currentActiveTick > lastActiveTick && currentActiveTick > 0) {
      // Play click for approximately every 16 chunks of progress
      playVaultClick(0.8 + Math.random() * 0.4);
      hapticFeedback('tick');
      lastActiveTick = currentActiveTick;
    }
  } else {
    lastActiveTick = 0;
  }

  // ============================================================================
  // COMPUTED
  // ============================================================================

  $: passwordStrength = estimatePasswordStrength(passphrase);
  $: factorInfo = FACTOR_INFO[factor - 1]!;
  $: canDerive = name.length >= BRAINVAULT_V2.MIN_NAME_LENGTH &&
                 passphrase.length >= BRAINVAULT_V2.MIN_PASSPHRASE_LENGTH;
  $: progress = shardCount > 0 ? (shardsCompleted / shardCount) * 100 : 0;
  $: remainingMs = shardCount > 0
    ? Math.max(0, ((shardCount - shardsCompleted) / Math.max(workerCount, 1)) * estimatedShardTimeMs)
    : 0;

  // Shard grid dimensions (for visualization)
  // For very large shard counts, cap visual grid at 64x64 (4096 visible cells)
  // Each visual cell represents a chunk of shards
  $: maxVisualCols = 64;
  $: visualShardCount = Math.min(shardCount, maxVisualCols * maxVisualCols);
  $: gridCols = Math.min(Math.ceil(Math.sqrt(shardCount)), maxVisualCols);
  $: gridRows = Math.ceil(visualShardCount / gridCols);
  $: shardsPerCell = Math.ceil(shardCount / visualShardCount);

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  // Native SHA256 using Web Crypto API (browser built-in)
  async function sha256(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data.buffer as ArrayBuffer);
    const hashArray = new Uint8Array(hashBuffer);
    return bytesToHex(hashArray);
  }

  function hexToBytes(hex: string): Uint8Array {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function estimatePasswordStrength(pw: string): { bits: number; rating: string; color: string } {
    if (!pw) return { bits: 0, rating: 'none', color: '#666' };

    const charsets = {
      lowercase: /[a-z]/.test(pw) ? 26 : 0,
      uppercase: /[A-Z]/.test(pw) ? 26 : 0,
      digits: /\d/.test(pw) ? 10 : 0,
      special: /[^a-zA-Z0-9]/.test(pw) ? 33 : 0,
    };

    const poolSize = Object.values(charsets).reduce((a, b) => a + b, 0);
    const bits = poolSize > 0 ? Math.log2(poolSize) * pw.length : 0;

    if (bits < 40) return { bits: Math.round(bits), rating: 'weak', color: '#ef4444' };
    if (bits < 60) return { bits: Math.round(bits), rating: 'fair', color: '#f59e0b' };
    if (bits < 80) return { bits: Math.round(bits), rating: 'good', color: '#84cc16' };
    if (bits < 100) return { bits: Math.round(bits), rating: 'strong', color: '#22c55e' };
    return { bits: Math.round(bits), rating: 'excellent', color: '#06b6d4' };
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) {
      const mins = Math.floor(ms / 60000);
      const secs = Math.round((ms % 60000) / 1000);
      return `${mins}m ${secs}s`;
    }
    const hours = Math.floor(ms / 3600000);
    const mins = Math.round((ms % 3600000) / 60000);
    return `${hours}h ${mins}m`;
  }

  function getShardCount(f: number): number {
    return Math.pow(4, f - 1);
  }

  async function copyToClipboard(text: string, field: string) {
    await navigator.clipboard.writeText(text);
    copiedField = field;
    setTimeout(() => copiedField = null, 2000);
  }

  // ============================================================================
  // DERIVATION LOGIC
  // ============================================================================

  async function startDerivation() {
    phase = 'deriving';
    shardCount = getShardCount(factor);
    shardsCompleted = 0;
    shardResults = new Map();
    shardStatus = Array(shardCount).fill('pending');
    startTime = Date.now();
    elapsedMs = 0;

    // Start elapsed timer
    elapsedInterval = setInterval(() => {
      elapsedMs = Date.now() - startTime;
    }, 100);

    // Start tip rotation (change every 7 seconds)
    currentTipIndex = Math.floor(Math.random() * XLN_TIPS.length);
    tipInterval = setInterval(() => {
      currentTipIndex = (currentTipIndex + 1) % XLN_TIPS.length;
    }, 7000);

    // Create workers - start at targetWorkerCount (50% of maxWorkers by default)
    const cpuCores = navigator.hardwareConcurrency || 4;
    workerCount = Math.min(targetWorkerCount, shardCount);
    console.log(`[BrainVault] Using ${workerCount} workers (${cpuCores} cores, max ${maxWorkers}, starting at ${targetWorkerCount})`);

    // Hash the name first using the worker
    const nameHashHex = await workerHashName(name);

    // Create workers
    workers = [];
    const workerPromises: Promise<void>[] = [];

    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker('/brainvault-worker.js', { type: 'module' });
      workers.push(worker);

      const initPromise = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 30000);

        worker.onmessage = (e) => {
          const { type, data } = e.data;

          if (type === 'ready') {
            clearTimeout(timeout);
            resolve();
          } else if (type === 'probe_result') {
            estimatedShardTimeMs = data.estimatedShardTimeMs;
          } else if (type === 'shard_complete') {
            handleShardComplete(data.shardIndex, data.resultHex, data.elapsedMs);
          } else if (type === 'error') {
            console.error('Worker error:', data.message);
          }
        };

        worker.onerror = (e) => {
          clearTimeout(timeout);
          reject(e);
        };
      });

      worker.postMessage({ type: 'init', id: i });
      workerPromises.push(initPromise);
    }

    try {
      await Promise.all(workerPromises);

      // Probe first worker for time estimate
      workers[0]?.postMessage({ type: 'probe', id: 0 });

      // Wait a bit for probe result
      await new Promise(r => setTimeout(r, 500));

      // Dispatch initial shards
      dispatchShards(nameHashHex);
    } catch (err) {
      console.error('Failed to initialize workers:', err);
      terminateWorkers();
      phase = 'input';
    }
  }

  let nameHashHexGlobal = '';
  let nextShardToDispatch = 0;

  function dispatchShards(nameHashHex: string) {
    nameHashHexGlobal = nameHashHex;
    nextShardToDispatch = 0;

    // Dispatch one shard to each worker
    for (let i = 0; i < workers.length && nextShardToDispatch < shardCount; i++) {
      dispatchNextShard(workers[i]!);
    }
  }

  function dispatchNextShard(worker: Worker) {
    if (nextShardToDispatch >= shardCount) return;

    const shardIndex = nextShardToDispatch++;
    shardStatus[shardIndex] = 'computing';
    shardStatus = shardStatus; // Trigger reactivity

    worker.postMessage({
      type: 'derive_shard',
      id: shardIndex,
      data: {
        nameHashHex: nameHashHexGlobal,
        passphrase,
        shardIndex,
      }
    });
  }

  async function handleShardComplete(shardIndex: number, resultHex: string, elapsedMs: number) {
    shardResults.set(shardIndex, resultHex);
    shardStatus[shardIndex] = 'complete';
    shardStatus = shardStatus;
    shardsCompleted++;

    // Play sound for completed shard
    const intensity = 0.5 + (shardsCompleted / shardCount) * 0.5; // Gets louder as we progress
    playVaultClick(intensity);

    // Update time estimate (exponential moving average)
    estimatedShardTimeMs = estimatedShardTimeMs * 0.7 + elapsedMs * 0.3;

    // Save resume token to localStorage
    saveResumeToken();

    // Find the worker that completed this shard and give it more work
    const workerIndex = workers.findIndex(w => w !== null);
    if (workerIndex >= 0 && nextShardToDispatch < shardCount) {
      dispatchNextShard(workers[workerIndex]!);
    }

    // Check if all done
    if (shardsCompleted >= shardCount) {
      await finalizeDeriv();
    }
  }

  async function finalizeDeriv() {
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
      elapsedInterval = null;
    }
    if (tipInterval) {
      clearInterval(tipInterval);
      tipInterval = null;
    }
    elapsedMs = Date.now() - startTime;

    terminateWorkers();

    // Collect results in order
    const orderedResults: Uint8Array[] = [];
    for (let i = 0; i < shardCount; i++) {
      const hex = shardResults.get(i);
      if (!hex) throw new Error(`Missing shard ${i}`);
      orderedResults.push(hexToBytes(hex));
    }

    // Combine with BLAKE3
    const totalLength = orderedResults.reduce((sum, s) => sum + s.length, 0);
    const combined = new Uint8Array(totalLength + 1);
    let offset = 0;
    for (const shard of orderedResults) {
      combined.set(shard, offset);
      offset += shard.length;
    }
    combined[totalLength] = factor; // Add factor to prevent collisions

    masterKeyHex = await workerBlake3(bytesToHex(combined));

    // Derive BIP39 entropy
    const masterKey = hexToBytes(masterKeyHex);
    const entropyInput = new Uint8Array(masterKey.length + 20);
    entropyInput.set(masterKey, 0);
    entropyInput.set(new TextEncoder().encode('bip39/entropy/v2.0'), masterKey.length);
    const entropyHex = await workerBlake3(bytesToHex(entropyInput));
    const entropy = hexToBytes(entropyHex);

    // Generate mnemonic
    mnemonic24 = await entropyToMnemonic(entropy);
    mnemonic12 = mnemonic24.split(' ').slice(0, 12).join(' ');

    // Derive device passphrase
    const passInput = new Uint8Array(masterKey.length + 24);
    passInput.set(masterKey, 0);
    passInput.set(new TextEncoder().encode('bip39/passphrase/v2.0'), masterKey.length);
    devicePassphrase = await workerBlake3(bytesToHex(passInput));

    // Derive Ethereum address using ethers directly
    // We use the mnemonic without device passphrase for MetaMask compatibility
    // The device passphrase is only for hardware wallet hidden wallets
    // HDNodeWallet.fromPhrase creates a wallet at the Ethereum default path m/44'/60'/0'/0/0
    const wallet = HDNodeWallet.fromPhrase(mnemonic24);
    ethereumAddress = wallet.address;
    // Entity ID is keccak256(address) - deterministic bytes32 derived from address
    entityId = keccak256(wallet.address);

    // Clear localStorage resume token
    localStorage.removeItem('brainvault_resume');

    // Play vault open sound and haptic
    playVaultOpen();
    hapticFeedback('complete');

    phase = 'complete';
  }

  function terminateWorkers() {
    for (const worker of workers) {
      worker?.terminate();
    }
    workers = [];
  }

  // Dynamic worker scaling based on user slider
  async function adjustWorkers() {
    if (phase !== 'deriving') return;

    const currentCount = workers.length;
    const target = targetWorkerCount;

    if (target < currentCount) {
      // Scale down: terminate excess workers (they'll finish current shard first)
      const excessWorkers = workers.splice(target);
      for (const w of excessWorkers) {
        w?.terminate();
      }
      workerCount = workers.length;
    } else if (target > currentCount && nextShardToDispatch < shardCount) {
      // Scale up: add more workers
      const workersToAdd = target - currentCount;

      for (let i = 0; i < workersToAdd && nextShardToDispatch < shardCount; i++) {
        const worker = new Worker('/brainvault-worker.js', { type: 'module' });
        workers.push(worker);

        // Set up message handler
        worker.onmessage = (e) => {
          const { type, data } = e.data;
          if (type === 'ready') {
            // Dispatch work immediately
            if (nextShardToDispatch < shardCount) {
              dispatchNextShard(worker);
            }
          } else if (type === 'shard_complete') {
            handleShardComplete(data.shardIndex, data.resultHex, data.elapsedMs);
          } else if (type === 'error') {
            console.error('Worker error:', data.message);
          }
        };

        worker.onerror = (e) => {
          console.error('Worker error:', e);
        };

        worker.postMessage({ type: 'init', id: currentCount + i });
      }
      workerCount = workers.length;
    }
  }

  function saveResumeToken() {
    const token = {
      version: 'bv2',
      nameHash: nameHashHexGlobal,
      factor,
      completedShards: Array.from(shardResults.keys()).sort((a, b) => a - b),
      shardResults: Object.fromEntries(
        Array.from(shardResults.entries()).map(([k, v]) => [k.toString(), v])
      ),
      name, // Needed for UI
    };
    localStorage.setItem('brainvault_resume', JSON.stringify(token));
  }

  async function loadResumeToken() {
    const saved = localStorage.getItem('brainvault_resume');
    if (!saved) {
      alert('No resume token found');
      return;
    }

    try {
      const token = JSON.parse(saved);
      if (token.version !== 'bv2') {
        alert('Invalid resume token version');
        return;
      }

      // Restore state
      name = token.name || '';
      factor = token.factor;
      shardCount = getShardCount(factor);
      shardResults = new Map(Object.entries(token.shardResults).map(([k, v]) => [parseInt(k), v as string]));
      shardsCompleted = shardResults.size;
      shardStatus = Array(shardCount).fill('pending');
      for (const idx of shardResults.keys()) {
        shardStatus[idx] = 'complete';
      }
      nameHashHexGlobal = token.nameHash;

      showResumeInput = false;

      // Need passphrase to continue
      if (!passphrase) {
        alert('Enter your passphrase to continue');
        return;
      }

      // Continue derivation
      phase = 'deriving';
      startTime = Date.now();
      elapsedMs = 0;

      elapsedInterval = setInterval(() => {
        elapsedMs = Date.now() - startTime;
      }, 100);

      // Create workers - use targetWorkerCount (user-adjustable)
      workerCount = Math.min(
        targetWorkerCount,
        shardCount - shardsCompleted
      );

      workers = [];
      const workerPromises: Promise<void>[] = [];

      for (let i = 0; i < workerCount; i++) {
        const worker = new Worker('/brainvault-worker.js', { type: 'module' });
        workers.push(worker);

        const initPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 30000);

          worker.onmessage = (e) => {
            const { type, data } = e.data;

            if (type === 'ready') {
              clearTimeout(timeout);
              resolve();
            } else if (type === 'shard_complete') {
              handleShardComplete(data.shardIndex, data.resultHex, data.elapsedMs);
            } else if (type === 'error') {
              console.error('Worker error:', data.message);
            }
          };

          worker.onerror = (e) => {
            clearTimeout(timeout);
            reject(e);
          };
        });

        worker.postMessage({ type: 'init', id: i });
        workerPromises.push(initPromise);
      }

      await Promise.all(workerPromises);

      // Find next shard to dispatch
      nextShardToDispatch = 0;
      while (nextShardToDispatch < shardCount && shardResults.has(nextShardToDispatch)) {
        nextShardToDispatch++;
      }

      // Dispatch remaining shards
      for (let i = 0; i < workers.length && nextShardToDispatch < shardCount; i++) {
        // Find next incomplete shard
        while (nextShardToDispatch < shardCount && shardResults.has(nextShardToDispatch)) {
          nextShardToDispatch++;
        }
        if (nextShardToDispatch < shardCount) {
          dispatchNextShard(workers[i]!);
        }
      }

    } catch (err) {
      console.error('Failed to load resume token:', err);
      alert('Failed to load resume token');
    }
  }

  async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
    const wordlist = getBIP39Wordlist();

    // Checksum
    const checksumHash = await sha256(entropy);
    const checksumBits = hexToBits(checksumHash).slice(0, entropy.length * 8 / 32);

    const entropyBits = bytesToBits(entropy);
    const allBits = entropyBits + checksumBits;

    const words: string[] = [];
    for (let i = 0; i < allBits.length; i += 11) {
      const chunk = allBits.slice(i, i + 11);
      const index = parseInt(chunk, 2);
      words.push(wordlist[index]!);
    }

    return words.join(' ');
  }

  function bytesToBits(bytes: Uint8Array): string {
    return Array.from(bytes).map(b => b.toString(2).padStart(8, '0')).join('');
  }

  function hexToBits(hex: string): string {
    return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
  }

  // Password manager - auto-derive on domain change
  $: if (siteDomain.trim() && masterKeyHex && phase === 'complete') {
    deriveSitePasswordReactive();
  }

  async function deriveSitePasswordReactive() {
    await deriveSitePassword();
  }

  async function deriveSitePassword() {
    if (!siteDomain.trim() || !masterKeyHex) {
      sitePassword = '';
      return;
    }

    const domain = siteDomain.trim().toLowerCase();
    const masterKey = hexToBytes(masterKeyHex);
    const input = new Uint8Array(masterKey.length + domain.length + 14);
    input.set(masterKey, 0);
    input.set(new TextEncoder().encode('site-password:'), masterKey.length);
    input.set(new TextEncoder().encode(domain), masterKey.length + 14);

    const rawHex = await workerBlake3(bytesToHex(input));
    const raw = hexToBytes(rawHex);

    const lowers = 'abcdefghijklmnopqrstuvwxyz';
    const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const digits = '0123456789';
    const specials = '!@#$%^&*()-_=+[]{}:,./?';
    const all = lowers + uppers + digits + specials;

    const passwordChars: string[] = [
      lowers[raw[0]! % lowers.length]!,
      uppers[raw[1]! % uppers.length]!,
      digits[raw[2]! % digits.length]!,
      specials[raw[3]! % specials.length]!,
    ];

    const length = 20;
    for (let i = 4; i < length; i++) {
      passwordChars.push(all[raw[i]! % all.length]!);
    }

    // Shuffle
    for (let i = passwordChars.length - 1; i > 0; i--) {
      const j = raw[length + i]! % (i + 1);
      [passwordChars[i], passwordChars[j]] = [passwordChars[j]!, passwordChars[i]!];
    }

    sitePassword = passwordChars.join('');
  }

  function reset() {
    phase = 'input';
    terminateWorkers();
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
      elapsedInterval = null;
    }
    if (tipInterval) {
      clearInterval(tipInterval);
      tipInterval = null;
    }
    // Keep name and passphrase for convenience
    mnemonic24 = '';
    mnemonic12 = '';
    devicePassphrase = '';
    ethereumAddress = '';
    masterKeyHex = '';
    siteDomain = '';
    sitePassword = '';
    shardsCompleted = 0;
    shardResults = new Map();
    shardStatus = [];
  }

  onDestroy(() => {
    terminateWorkers();
    if (elapsedInterval) {
      clearInterval(elapsedInterval);
    }
    if (tipInterval) {
      clearInterval(tipInterval);
    }
  });

  // Check for saved resume on mount + init i18n
  onMount(() => {
    let unsubscribe: (() => void) | undefined;

    // Run async init
    (async () => {
      // Init i18n
      await initI18n();
      i18nReady = true;

      // Watch for locale changes
      unsubscribe = locale.subscribe(async (loc) => {
        await loadTranslations(loc);
      });

      const saved = localStorage.getItem('brainvault_resume');
      if (saved) {
        try {
          const token = JSON.parse(saved);
          if (token.completedShards?.length > 0) {
            showResumeInput = true;
            name = token.name || '';
            factor = token.factor;
          }
        } catch {}
      }
    })();

    return () => {
      if (unsubscribe) unsubscribe();
    };
  });

  // BIP39 wordlist
  function getBIP39Wordlist(): string[] {
    return ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice","aerobic","affair","afford","afraid","again","age","agent","agree","ahead","aim","air","airport","aisle","alarm","album","alcohol","alert","alien","all","alley","allow","almost","alone","alpha","already","also","alter","always","amateur","amazing","among","amount","amused","analyst","anchor","ancient","anger","angle","angry","animal","ankle","announce","annual","another","answer","antenna","antique","anxiety","any","apart","apology","appear","apple","approve","april","arch","arctic","area","arena","argue","arm","armed","armor","army","around","arrange","arrest","arrive","arrow","art","artefact","artist","artwork","ask","aspect","assault","asset","assist","assume","asthma","athlete","atom","attack","attend","attitude","attract","auction","audit","august","aunt","author","auto","autumn","average","avocado","avoid","awake","aware","away","awesome","awful","awkward","axis","baby","bachelor","bacon","badge","bag","balance","balcony","ball","bamboo","banana","banner","bar","barely","bargain","barrel","base","basic","basket","battle","beach","bean","beauty","because","become","beef","before","begin","behave","behind","believe","below","belt","bench","benefit","best","betray","better","between","beyond","bicycle","bid","bike","bind","biology","bird","birth","bitter","black","blade","blame","blanket","blast","bleak","bless","blind","blood","blossom","blouse","blue","blur","blush","board","boat","body","boil","bomb","bone","bonus","book","boost","border","boring","borrow","boss","bottom","bounce","box","boy","bracket","brain","brand","brass","brave","bread","breeze","brick","bridge","brief","bright","bring","brisk","broccoli","broken","bronze","broom","brother","brown","brush","bubble","buddy","budget","buffalo","build","bulb","bulk","bullet","bundle","bunker","burden","burger","burst","bus","business","busy","butter","buyer","buzz","cabbage","cabin","cable","cactus","cage","cake","call","calm","camera","camp","can","canal","cancel","candy","cannon","canoe","canvas","canyon","capable","capital","captain","car","carbon","card","cargo","carpet","carry","cart","case","cash","casino","castle","casual","cat","catalog","catch","category","cattle","caught","cause","caution","cave","ceiling","celery","cement","census","century","cereal","certain","chair","chalk","champion","change","chaos","chapter","charge","chase","chat","cheap","check","cheese","chef","cherry","chest","chicken","chief","child","chimney","choice","choose","chronic","chuckle","chunk","churn","cigar","cinnamon","circle","citizen","city","civil","claim","clap","clarify","claw","clay","clean","clerk","clever","click","client","cliff","climb","clinic","clip","clock","clog","close","cloth","cloud","clown","club","clump","cluster","clutch","coach","coast","coconut","code","coffee","coil","coin","collect","color","column","combine","come","comfort","comic","common","company","concert","conduct","confirm","congress","connect","consider","control","convince","cook","cool","copper","copy","coral","core","corn","correct","cost","cotton","couch","country","couple","course","cousin","cover","coyote","crack","cradle","craft","cram","crane","crash","crater","crawl","crazy","cream","credit","creek","crew","cricket","crime","crisp","critic","crop","cross","crouch","crowd","crucial","cruel","cruise","crumble","crunch","crush","cry","crystal","cube","culture","cup","cupboard","curious","current","curtain","curve","cushion","custom","cute","cycle","dad","damage","damp","dance","danger","daring","dash","daughter","dawn","day","deal","debate","debris","decade","december","decide","decline","decorate","decrease","deer","defense","define","defy","degree","delay","deliver","demand","demise","denial","dentist","deny","depart","depend","deposit","depth","deputy","derive","describe","desert","design","desk","despair","destroy","detail","detect","develop","device","devote","diagram","dial","diamond","diary","dice","diesel","diet","differ","digital","dignity","dilemma","dinner","dinosaur","direct","dirt","disagree","discover","disease","dish","dismiss","disorder","display","distance","divert","divide","divorce","dizzy","doctor","document","dog","doll","dolphin","domain","donate","donkey","donor","door","dose","double","dove","draft","dragon","drama","drastic","draw","dream","dress","drift","drill","drink","drip","drive","drop","drum","dry","duck","dumb","dune","during","dust","dutch","duty","dwarf","dynamic","eager","eagle","early","earn","earth","easily","east","easy","echo","ecology","economy","edge","edit","educate","effort","egg","eight","either","elbow","elder","electric","elegant","element","elephant","elevator","elite","else","embark","embody","embrace","emerge","emotion","employ","empower","empty","enable","enact","end","endless","endorse","enemy","energy","enforce","engage","engine","enhance","enjoy","enlist","enough","enrich","enroll","ensure","enter","entire","entry","envelope","episode","equal","equip","era","erase","erode","erosion","error","erupt","escape","essay","essence","estate","eternal","ethics","evidence","evil","evoke","evolve","exact","example","excess","exchange","excite","exclude","excuse","execute","exercise","exhaust","exhibit","exile","exist","exit","exotic","expand","expect","expire","explain","expose","express","extend","extra","eye","eyebrow","fabric","face","faculty","fade","faint","faith","fall","false","fame","family","famous","fan","fancy","fantasy","farm","fashion","fat","fatal","father","fatigue","fault","favorite","feature","february","federal","fee","feed","feel","female","fence","festival","fetch","fever","few","fiber","fiction","field","figure","file","film","filter","final","find","fine","finger","finish","fire","firm","first","fiscal","fish","fit","fitness","fix","flag","flame","flash","flat","flavor","flee","flight","flip","float","flock","floor","flower","fluid","flush","fly","foam","focus","fog","foil","fold","follow","food","foot","force","forest","forget","fork","fortune","forum","forward","fossil","foster","found","fox","fragile","frame","frequent","fresh","friend","fringe","frog","front","frost","frown","frozen","fruit","fuel","fun","funny","furnace","fury","future","gadget","gain","galaxy","gallery","game","gap","garage","garbage","garden","garlic","garment","gas","gasp","gate","gather","gauge","gaze","general","genius","genre","gentle","genuine","gesture","ghost","giant","gift","giggle","ginger","giraffe","girl","give","glad","glance","glare","glass","glide","glimpse","globe","gloom","glory","glove","glow","glue","goat","goddess","gold","good","goose","gorilla","gospel","gossip","govern","gown","grab","grace","grain","grant","grape","grass","gravity","great","green","grid","grief","grit","grocery","group","grow","grunt","guard","guess","guide","guilt","guitar","gun","gym","habit","hair","half","hammer","hamster","hand","happy","harbor","hard","harsh","harvest","hat","have","hawk","hazard","head","health","heart","heavy","hedgehog","height","hello","helmet","help","hen","hero","hidden","high","hill","hint","hip","hire","history","hobby","hockey","hold","hole","holiday","hollow","home","honey","hood","hope","horn","horror","horse","hospital","host","hotel","hour","hover","hub","huge","human","humble","humor","hundred","hungry","hunt","hurdle","hurry","hurt","husband","hybrid","ice","icon","idea","identify","idle","ignore","ill","illegal","illness","image","imitate","immense","immune","impact","impose","improve","impulse","inch","include","income","increase","index","indicate","indoor","industry","infant","inflict","inform","inhale","inherit","initial","inject","injury","inmate","inner","innocent","input","inquiry","insane","insect","inside","inspire","install","intact","interest","into","invest","invite","involve","iron","island","isolate","issue","item","ivory","jacket","jaguar","jar","jazz","jealous","jeans","jelly","jewel","job","join","joke","journey","joy","judge","juice","jump","jungle","junior","junk","just","kangaroo","keen","keep","ketchup","key","kick","kid","kidney","kind","kingdom","kiss","kit","kitchen","kite","kitten","kiwi","knee","knife","knock","know","lab","label","labor","ladder","lady","lake","lamp","language","laptop","large","later","latin","laugh","laundry","lava","law","lawn","lawsuit","layer","lazy","leader","leaf","learn","leave","lecture","left","leg","legal","legend","leisure","lemon","lend","length","lens","leopard","lesson","letter","level","liar","liberty","library","license","life","lift","light","like","limb","limit","link","lion","liquid","list","little","live","lizard","load","loan","lobster","local","lock","logic","lonely","long","loop","lottery","loud","lounge","love","loyal","lucky","luggage","lumber","lunar","lunch","luxury","lyrics","machine","mad","magic","magnet","maid","mail","main","major","make","mammal","man","manage","mandate","mango","mansion","manual","maple","marble","march","margin","marine","market","marriage","mask","mass","master","match","material","math","matrix","matter","maximum","maze","meadow","mean","measure","meat","mechanic","medal","media","melody","melt","member","memory","mention","menu","mercy","merge","merit","merry","mesh","message","metal","method","middle","midnight","milk","million","mimic","mind","minimum","minor","minute","miracle","mirror","misery","miss","mistake","mix","mixed","mixture","mobile","model","modify","mom","moment","monitor","monkey","monster","month","moon","moral","more","morning","mosquito","mother","motion","motor","mountain","mouse","move","movie","much","muffin","mule","multiply","muscle","museum","mushroom","music","must","mutual","myself","mystery","myth","naive","name","napkin","narrow","nasty","nation","nature","near","neck","need","negative","neglect","neither","nephew","nerve","nest","net","network","neutral","never","news","next","nice","night","noble","noise","nominee","noodle","normal","north","nose","notable","note","nothing","notice","novel","now","nuclear","number","nurse","nut","oak","obey","object","oblige","obscure","observe","obtain","obvious","occur","ocean","october","odor","off","offer","office","often","oil","okay","old","olive","olympic","omit","once","one","onion","online","only","open","opera","opinion","oppose","option","orange","orbit","orchard","order","ordinary","organ","orient","original","orphan","ostrich","other","outdoor","outer","output","outside","oval","oven","over","own","owner","oxygen","oyster","ozone","pact","paddle","page","pair","palace","palm","panda","panel","panic","panther","paper","parade","parent","park","parrot","party","pass","patch","path","patient","patrol","pattern","pause","pave","payment","peace","peanut","pear","peasant","pelican","pen","penalty","pencil","people","pepper","perfect","permit","person","pet","phone","photo","phrase","physical","piano","picnic","picture","piece","pig","pigeon","pill","pilot","pink","pioneer","pipe","pistol","pitch","pizza","place","planet","plastic","plate","play","please","pledge","pluck","plug","plunge","poem","poet","point","polar","pole","police","pond","pony","pool","popular","portion","position","possible","post","potato","pottery","poverty","powder","power","practice","praise","predict","prefer","prepare","present","pretty","prevent","price","pride","primary","print","priority","prison","private","prize","problem","process","produce","profit","program","project","promote","proof","property","prosper","protect","proud","provide","public","pudding","pull","pulp","pulse","pumpkin","punch","pupil","puppy","purchase","purity","purpose","purse","push","put","puzzle","pyramid","quality","quantum","quarter","question","quick","quit","quiz","quote","rabbit","raccoon","race","rack","radar","radio","rail","rain","raise","rally","ramp","ranch","random","range","rapid","rare","rate","rather","raven","raw","razor","ready","real","reason","rebel","rebuild","recall","receive","recipe","record","recycle","reduce","reflect","reform","refuse","region","regret","regular","reject","relax","release","relief","rely","remain","remember","remind","remove","render","renew","rent","reopen","repair","repeat","replace","report","require","rescue","resemble","resist","resource","response","result","retire","retreat","return","reunion","reveal","review","reward","rhythm","rib","ribbon","rice","rich","ride","ridge","rifle","right","rigid","ring","riot","ripple","risk","ritual","rival","river","road","roast","robot","robust","rocket","romance","roof","rookie","room","rose","rotate","rough","round","route","royal","rubber","rude","rug","rule","run","runway","rural","sad","saddle","sadness","safe","sail","salad","salmon","salon","salt","salute","same","sample","sand","satisfy","satoshi","sauce","sausage","save","say","scale","scan","scare","scatter","scene","scheme","school","science","scissors","scorpion","scout","scrap","screen","script","scrub","sea","search","season","seat","second","secret","section","security","seed","seek","segment","select","sell","seminar","senior","sense","sentence","series","service","session","settle","setup","seven","shadow","shaft","shallow","share","shed","shell","sheriff","shield","shift","shine","ship","shiver","shock","shoe","shoot","shop","short","shoulder","shove","shrimp","shrug","shuffle","shy","sibling","sick","side","siege","sight","sign","silent","silk","silly","silver","similar","simple","since","sing","siren","sister","situate","six","size","skate","sketch","ski","skill","skin","skirt","skull","slab","slam","sleep","slender","slice","slide","slight","slim","slogan","slot","slow","slush","small","smart","smile","smoke","smooth","snack","snake","snap","sniff","snow","soap","soccer","social","sock","soda","soft","solar","soldier","solid","solution","solve","someone","song","soon","sorry","sort","soul","sound","soup","source","south","space","spare","spatial","spawn","speak","special","speed","spell","spend","sphere","spice","spider","spike","spin","spirit","split","spoil","sponsor","spoon","sport","spot","spray","spread","spring","spy","square","squeeze","squirrel","stable","stadium","staff","stage","stairs","stamp","stand","start","state","stay","steak","steel","stem","step","stereo","stick","still","sting","stock","stomach","stone","stool","story","stove","strategy","street","strike","strong","struggle","student","stuff","stumble","style","subject","submit","subway","success","such","sudden","suffer","sugar","suggest","suit","summer","sun","sunny","sunset","super","supply","supreme","sure","surface","surge","surprise","surround","survey","suspect","sustain","swallow","swamp","swap","swarm","swear","sweet","swift","swim","swing","switch","sword","symbol","symptom","syrup","system","table","tackle","tag","tail","talent","talk","tank","tape","target","task","taste","tattoo","taxi","teach","team","tell","ten","tenant","tennis","tent","term","test","text","thank","that","theme","then","theory","there","they","thing","this","thought","three","thrive","throw","thumb","thunder","ticket","tide","tiger","tilt","timber","time","tiny","tip","tired","tissue","title","toast","tobacco","today","toddler","toe","together","toilet","token","tomato","tomorrow","tone","tongue","tonight","tool","tooth","top","topic","topple","torch","tornado","tortoise","toss","total","tourist","toward","tower","town","toy","track","trade","traffic","tragic","train","transfer","trap","trash","travel","tray","treat","tree","trend","trial","tribe","trick","trigger","trim","trip","trophy","trouble","truck","true","truly","trumpet","trust","truth","try","tube","tuition","tumble","tuna","tunnel","turkey","turn","turtle","twelve","twenty","twice","twin","twist","two","type","typical","ugly","umbrella","unable","unaware","uncle","uncover","under","undo","unfair","unfold","unhappy","uniform","unique","unit","universe","unknown","unlock","until","unusual","unveil","update","upgrade","uphold","upon","upper","upset","urban","urge","usage","use","used","useful","useless","usual","utility","vacant","vacuum","vague","valid","valley","valve","van","vanish","vapor","various","vast","vault","vehicle","velvet","vendor","venture","venue","verb","verify","version","very","vessel","veteran","viable","vibrant","vicious","victory","video","view","village","vintage","violin","virtual","virus","visa","visit","visual","vital","vivid","vocal","voice","void","volcano","volume","vote","voyage","wage","wagon","wait","walk","wall","walnut","want","warfare","warm","warrior","wash","wasp","waste","water","wave","way","wealth","weapon","wear","weasel","weather","web","wedding","weekend","weird","welcome","west","wet","whale","what","wheat","wheel","when","where","whip","whisper","wide","width","wife","wild","will","win","window","wine","wing","wink","winner","winter","wire","wisdom","wise","wish","witness","wolf","woman","wonder","wood","wool","word","work","world","worry","worth","wrap","wreck","wrestle","wrist","write","wrong","yard","year","yellow","you","young","youth","zebra","zero","zone","zoo"];
  }
</script>

<div class="brainvault-container" class:deriving={phase === 'deriving'} class:complete={phase === 'complete'}>
  <!-- Ambient particles - intensify during derivation -->
  <div class="dust-particles" class:active={phase === 'deriving'}></div>

  <!-- Light rays from logo - EXPLODE during derivation -->
  <div class="light-rays" class:active={phase === 'deriving'}></div>

  <!-- Golden light flood during derivation -->
  {#if phase === 'deriving'}
    <div class="light-flood" style="--progress: {progress}"></div>
  {/if}

  <!-- Header with Monumental Triangle -->
  <div class="header" class:deriving={phase === 'deriving'}>
    <div class="logo-monument" class:deriving={phase === 'deriving'}>
      <div class="logo-glow" class:active={phase === 'deriving'}></div>
      <img src="/img/l.png" alt="xln" class="triangle-logo" class:deriving={phase === 'deriving'} />
    </div>
    <!-- Trust Badges -->
    {#if phase === 'input'}
      <div class="trust-badges">
        <span class="badge offline">100% OFFLINE</span>
        <span class="badge client">CLIENT-SIDE ONLY</span>
      </div>
    {/if}
  </div>

  <!-- Main Content -->
  <div class="main-content">

    <!-- INPUT PHASE -->
    {#if phase === 'input'}
      <div class="glass-card">
        <!-- Resume Banner -->
        {#if showResumeInput}
          <div class="resume-banner">
            <span class="resume-icon">⏸️</span>
            <span>Incomplete derivation found ({shardsCompleted}/{getShardCount(factor)} shards)</span>
            <div class="resume-actions">
              <button class="resume-btn" on:click={loadResumeToken}>Resume</button>
              <button class="dismiss-btn" on:click={() => { showResumeInput = false; localStorage.removeItem('brainvault_resume'); }}>Dismiss</button>
            </div>
          </div>
        {/if}

        <!-- Name Input -->
        <div class="input-group">
          <label for="name">{t('vault.name.label')}</label>
          <span class="input-hint">{t('vault.name.hint')}</span>
          <div class="input-wrapper">
            <input
              type="text"
              id="name"
              bind:value={name}
              placeholder={t('vault.name.placeholder')}
              autocomplete="off"
              spellcheck="false"
            />
          </div>
        </div>

        <!-- Passphrase Input -->
        <div class="input-group">
          <label for="passphrase">{t('vault.password.label')}</label>
          <span class="input-hint">{t('vault.password.hint')}</span>
          <div class="input-wrapper">
            <input
              type={showPassphrase ? 'text' : 'password'}
              id="passphrase"
              bind:value={passphrase}
              placeholder={t('vault.password.placeholder')}
              autocomplete="off"
              spellcheck="false"
            />
            <button
              class="toggle-visibility"
              on:click={() => showPassphrase = !showPassphrase}
              type="button"
              aria-label="Toggle passphrase visibility"
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                {#if showPassphrase}
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                {:else}
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                {/if}
              </svg>
            </button>
            <button
              class="suggest-btn"
              on:click={suggestPassphrase}
              type="button"
              title="Suggest random passphrase"
              aria-label="Suggest random passphrase"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M20 7h-9m9 10h-9M4 7h.01M4 17h.01M7 4l-3 3 3 3M7 17l-3 3 3 3"/>
              </svg>
            </button>
          </div>
          {#if passphrase}
            <div class="strength-meter">
              <div
                class="strength-bar"
                style="width: {Math.min(100, passwordStrength.bits)}%; background: {passwordStrength.color}"
              ></div>
            </div>
            <span class="strength-text" style="color: {passwordStrength.color}">
              {passwordStrength.bits} bits - {passwordStrength.rating}
            </span>
          {/if}
        </div>

        <!-- Factor Slider -->
        <div class="input-group">
          <label for="factor">{t('vault.factor.label')}</label>
          <span class="input-hint">{t('vault.factor.memory')} · {t('vault.factor.time')} · {t('vault.factor.threads')}</span>
          <div class="factor-slider-wrapper">
            <input
              type="range"
              id="factor"
              min="1"
              max="9"
              bind:value={factor}
              aria-label="Security Factor"
            />
            <div class="factor-labels">
              <span class="factor-label-min">1</span>
              <span class="factor-label-max">9</span>
            </div>
            <!-- Current factor value prominently displayed -->
            <div class="factor-current-value">{factor}</div>
          </div>
          <div class="factor-info-row">
            <div class="factor-info">
              <span class="factor-level">{factorInfo.description}</span>
              <span class="factor-stats">{factorInfo.shards} shards · {factorInfo.memory} · {factorInfo.time}</span>
            </div>
          </div>
          <div class="attack-cost">
            <span class="attack-label">Attacker cost (1M guesses):</span>
            <span class="attack-value">{factorInfo.attackCost}</span>
            <span class="attack-time">· {factorInfo.attackTime}</span>
          </div>
        </div>

        <!-- Warning -->
        <div class="warning-box">
          <p><strong>This is permanent.</strong> Name + passphrase + factor = your vault forever. No recovery possible.</p>
        </div>

        <!-- Derive Button -->
        <button
          class="derive-btn"
          disabled={!canDerive}
          on:click={startDerivation}
        >
          {t('vault.derive')}
        </button>
      </div>

    <!-- DERIVING PHASE -->
    {:else if phase === 'deriving'}
      {#if animationStyle === 'vault'}
        <!-- Vault Door Animation - PHARAOH GOLD SHOW -->
        <div class="vault-door-container" class:opening={progress >= 100} style="--progress: {progress}">
          <!-- Golden dust particles floating -->
          <div class="pharaoh-dust"></div>
          <!-- Golden light rays emanating from pyramid -->
          <div class="pharaoh-rays"></div>
          <!-- Golden light flood that intensifies with progress -->
          <div class="pharaoh-flood"></div>

          <div class="vault-split-left"></div>
          <div class="vault-split-right"></div>

          <!-- Monumental Pyramid Visualization -->
          <div class="pyramid-visualization">
            <div class="pyramid-logo" style="--progress: {progress}%">
              <img src="/img/l.png" alt="xln" class="pyramid-triangle pharaoh-blazing" />
              <div class="pyramid-glow pharaoh-glow"></div>
              <!-- Light escaping from pyramid cracks -->
              <div class="pharaoh-crack left"></div>
              <div class="pharaoh-crack right"></div>
            </div>
            <div class="pyramid-progress-text">{Math.floor(progress)}%</div>

            <div class="pyramid-stats">
              <div class="stat-row">
                <span class="stat-label">SHARDS</span>
                <span class="stat-value">{shardsCompleted}/{shardCount}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">THREADS</span>
                <span class="stat-value">{workerCount}/{maxWorkers}</span>
              </div>
              <div class="stat-row">
                <span class="stat-label">MEMORY</span>
                <span class="stat-value">{allocatedMemoryMB}MB</span>
              </div>
            </div>

            <!-- Progress bar -->
            <div class="pyramid-progress-bar">
              <div class="pyramid-progress-fill" style="width: {progress}%"></div>
            </div>

            <!-- Memory allocation slider - Argon2id is MEMORY-HARD -->
            <div class="memory-control">
              <span class="memory-label">MEMORY</span>
              <div class="memory-slider-wrapper">
                <input
                  type="range"
                  min="1"
                  max={maxWorkers}
                  bind:value={targetWorkerCount}
                  on:input={adjustWorkers}
                  class="memory-slider"
                />
                <span class="memory-value">{allocatedMemoryMB}MB / {deviceMemoryMB}MB</span>
              </div>
            </div>

            <!-- Sound selector -->
            <div class="sound-control">
              <span class="sound-label">SOUND</span>
              <select class="sound-select" bind:value={soundTheme}>
                <option value="off">Off</option>
                <option value="vault">Vault</option>
                <option value="digital">Digital</option>
                <option value="nature">Water</option>
                <option value="minimal">Minimal</option>
                <option value="retro">Retro</option>
              </select>
            </div>
          </div>

          <!-- Shard grid under pyramid -->
          <div class="mini-shard-grid" style="--cols: {Math.ceil(Math.sqrt(visualShardCount))}">
            {#each Array(visualShardCount) as _, cellIdx}
              {@const startShard = cellIdx * shardsPerCell}
              {@const endShard = Math.min(startShard + shardsPerCell, shardCount)}
              {@const cellShards = shardStatus.slice(startShard, endShard)}
              {@const completedInCell = cellShards.filter(s => s === 'complete').length}
              {@const computingInCell = cellShards.filter(s => s === 'computing').length}
              {@const cellProgress = completedInCell / cellShards.length}
              <div
                class="mini-shard"
                class:pending={cellProgress === 0 && computingInCell === 0}
                class:computing={computingInCell > 0}
                class:complete={cellProgress === 1}
              ></div>
            {/each}
          </div>

          <div class="vault-info">
            <div class="vault-time">{formatDuration(remainingMs)} remaining</div>
            <div class="vault-tip">{XLN_TIPS[currentTipIndex]}</div>
          </div>

          <!-- Controls bar -->
          <div class="anim-controls">
            <button class="control-btn" on:click={() => animationStyle = 'shards'} title="Switch to shards view">
              ▦
            </button>

            <!-- Sound dropdown -->
            <select class="sound-select-mini" bind:value={soundTheme} title="Sound theme">
              <option value="off">Off</option>
              <option value="vault">Vault</option>
              <option value="digital">Digital</option>
              <option value="nature">Water</option>
              <option value="minimal">Minimal</option>
              <option value="retro">Retro</option>
            </select>

            <button class="control-btn cancel" on:click={reset}>esc</button>
          </div>
        </div>
      {:else}
        <!-- Shards Grid Animation -->
        <div class="shards-container">
          <div class="shards-header">
            <div class="shards-progress-text">{Math.floor(progress)}%</div>
            <div class="shards-time">{formatDuration(remainingMs)}</div>
          </div>

          <div class="shard-grid" style="--cols: {gridCols}">
            {#each Array(visualShardCount) as _, cellIdx}
              {@const startShard = cellIdx * shardsPerCell}
              {@const endShard = Math.min(startShard + shardsPerCell, shardCount)}
              {@const cellShards = shardStatus.slice(startShard, endShard)}
              {@const completedInCell = cellShards.filter(s => s === 'complete').length}
              {@const computingInCell = cellShards.filter(s => s === 'computing').length}
              {@const cellProgress = completedInCell / cellShards.length}
              <div
                class="shard"
                class:pending={cellProgress === 0 && computingInCell === 0}
                class:computing={computingInCell > 0}
                class:complete={cellProgress === 1}
                class:partial={cellProgress > 0 && cellProgress < 1}
                style={cellProgress > 0 && cellProgress < 1 ? `--progress: ${cellProgress}` : ''}
              ></div>
            {/each}
          </div>

          <div class="shards-footer">
            <span class="shards-count">{shardsCompleted}/{shardCount} shards</span>
            <span class="shards-stats">
              {workerCount} workers · {workerCount * 256}MB allocated · {(shardsCompleted / (elapsedMs / 1000) || 0).toFixed(2)} sh/s
            </span>
          </div>

          <div class="shards-tip">{XLN_TIPS[currentTipIndex]}</div>

          <!-- Controls bar -->
          <div class="anim-controls">
            <button class="control-btn" on:click={() => animationStyle = 'vault'} title="Switch to vault view">
              ◎
            </button>

            <!-- Parallelism slider -->
            <div class="parallelism-control">
              <input
                type="range"
                min="1"
                max={maxWorkers}
                bind:value={targetWorkerCount}
                on:input={adjustWorkers}
                class="parallelism-slider"
                title="Adjust CPU usage: {targetWorkerCount}/{maxWorkers} threads"
              />
              <span class="parallelism-label">{targetWorkerCount}</span>
            </div>

            <!-- Sound dropdown -->
            <select class="sound-select-mini" bind:value={soundTheme} title="Sound theme">
              <option value="off">Off</option>
              <option value="vault">Vault</option>
              <option value="digital">Digital</option>
              <option value="nature">Water</option>
              <option value="minimal">Minimal</option>
              <option value="retro">Retro</option>
            </select>

            <button class="control-btn cancel" on:click={reset}>esc</button>
          </div>
        </div>
      {/if}

    <!-- COMPLETE PHASE -->
    {:else if phase === 'complete'}
      <div class="glass-card complete">
        <div class="success-header">
          <!-- Liquid glass checkmark icon -->
          <div class="success-icon-container">
            <div class="success-glow"></div>
            <div class="success-ring">
              <svg viewBox="0 0 24 24" fill="none" class="success-check">
                <path d="M5 13l4 4L19 7" stroke="url(#checkGradient)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
                <defs>
                  <linearGradient id="checkGradient" x1="5" y1="7" x2="19" y2="17">
                    <stop offset="0%" stop-color="#fbbf24"/>
                    <stop offset="100%" stop-color="#d97706"/>
                  </linearGradient>
                </defs>
              </svg>
            </div>
          </div>
          <h2>Vault Opened</h2>
          <p class="success-stats">{formatDuration(elapsedMs)} <span class="stat-divider">·</span> {shardCount} shards</p>
        </div>

        <!-- Address with Identicon -->
        <div class="result-section">
          <label>Ethereum Address</label>
          <div class="result-box address with-identicon">
            <img src={identiconSrc} alt="Address identicon" class="identicon" />
            <code>{ethereumAddress}</code>
            <button class="copy-btn" on:click={() => copyToClipboard(ethereumAddress, 'address')}>
              {copiedField === 'address' ? '✓' : '📋'}
            </button>
          </div>
        </div>

        <!-- 24-word Mnemonic -->
        <div class="result-section">
          <label>
            24-Word Mnemonic
            <span class="label-hint">(for MetaMask, Ledger, Trezor)</span>
          </label>
          <div class="result-box mnemonic">
            <div class="mnemonic-toggle">
              <button on:click={() => showMnemonic = !showMnemonic}>
                {showMnemonic ? 'Hide' : 'Show'} Mnemonic
              </button>
            </div>
            {#if showMnemonic}
              <div class="mnemonic-words">
                {#each mnemonic24.split(' ') as word, i}
                  <span class="word"><span class="word-num">{i + 1}.</span> {word}</span>
                {/each}
              </div>
              <button class="copy-btn full" on:click={() => copyToClipboard(mnemonic24, 'mnemonic24')}>
                {copiedField === 'mnemonic24' ? '✓ Copied!' : '📋 Copy all 24 words'}
              </button>
            {/if}
          </div>
        </div>

        <!-- 12-word Mnemonic -->
        <div class="result-section">
          <label>
            12-Word Mnemonic
            <span class="label-hint">(for wallets that only support 12 words)</span>
          </label>
          <div class="result-box mnemonic compact">
            <code class:blurred={!showMnemonic}>{showMnemonic ? mnemonic12 : '••• ••• ••• ••• ••• ••• ••• ••• ••• ••• ••• •••'}</code>
            {#if showMnemonic}
              <button class="copy-btn" on:click={() => copyToClipboard(mnemonic12, 'mnemonic12')}>
                {copiedField === 'mnemonic12' ? '✓' : '📋'}
              </button>
            {/if}
          </div>
        </div>

        <!-- Device Passphrase -->
        <div class="result-section">
          <label>
            Device Passphrase
            <span class="label-hint">(for Ledger/Trezor hidden wallet)</span>
          </label>
          <div class="result-box passphrase">
            <code class:blurred={!showDevicePassphrase}>
              {showDevicePassphrase ? devicePassphrase : '••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••'}
            </code>
            <button class="toggle-btn" on:click={() => showDevicePassphrase = !showDevicePassphrase}>
              {showDevicePassphrase ? '🙈' : '👁️'}
            </button>
            {#if showDevicePassphrase}
              <button class="copy-btn" on:click={() => copyToClipboard(devicePassphrase, 'devicePass')}>
                {copiedField === 'devicePass' ? '✓' : '📋'}
              </button>
            {/if}
          </div>
        </div>

        <!-- Password Manager - simplified -->
        <div class="result-section password-manager">
          <div class="pm-header">
            <label>Password Manager</label>
            <span class="pm-hint">Derive unique passwords for any site</span>
          </div>
          <div class="pm-input-row">
            <input
              type="text"
              class="pm-domain-input"
              placeholder="github.com, twitter.com..."
              bind:value={siteDomain}
            />
          </div>
          {#if sitePassword}
            <div class="result-box site-password">
              <code class:blurred={!showSitePassword}>
                {showSitePassword ? sitePassword : '••••••••••••••••••••'}
              </code>
              <button class="toggle-btn" on:click={() => showSitePassword = !showSitePassword}>
                {showSitePassword ? '🙈' : '👁️'}
              </button>
              <button class="copy-btn" on:click={() => copyToClipboard(sitePassword, 'sitePass')}>
                {copiedField === 'sitePass' ? '✓' : '📋'}
              </button>
            </div>
          {:else if !siteDomain}
            <div class="pm-empty-state">
              <span class="pm-empty-icon">🔐</span>
              <span class="pm-empty-text">Enter a domain to generate a unique password</span>
            </div>
          {/if}
        </div>

        <!-- ERC20 Send Section -->
        <ERC20Send privateKey={masterKeyHex} walletAddress={ethereumAddress} />

        <!-- Deposit to XLN Entity Section -->
        <DepositToEntity privateKey={masterKeyHex} walletAddress={ethereumAddress} {entityId} />

        <!-- Network Actions -->
        <div class="network-actions">
          <div class="network-cta">
            <div class="network-cta-header">
              <span class="network-icon">◈</span>
              <span class="network-title">Join xln Network</span>
            </div>
            <p class="network-desc">Use this vault as your identity on the xln network. Create an entity, open accounts, send instant payments.</p>
            <a href="/" class="derive-btn network-btn">
              <span class="btn-icon">⚡</span>
              Enter Network
            </a>
          </div>
        </div>

        <!-- New Vault Button -->
        <button class="derive-btn secondary" on:click={reset}>
          <span class="btn-icon">🔄</span>
          Derive Another Vault
        </button>
      </div>
    {/if}

    <!-- FAQ Section -->
    <div class="faq-section">
      <h3>Frequently Asked Questions</h3>
      {#each FAQ_ITEMS as item, i}
        <div class="faq-item" class:expanded={expandedFaq === i}>
          <button class="faq-question" on:click={() => expandedFaq = expandedFaq === i ? null : i}>
            <span>{item.q}</span>
            <span class="faq-toggle">{expandedFaq === i ? '−' : '+'}</span>
          </button>
          {#if expandedFaq === i}
            <div class="faq-answer">
              <p>{item.a}</p>
            </div>
          {/if}
        </div>
      {/each}
    </div>

  </div>
</div>

<style>
  .brainvault-container {
    width: 100%;
    min-height: 100vh;
    padding: 20px;
    background: #000;
    background-image:
      radial-gradient(ellipse at 50% 0%, rgba(180, 140, 80, 0.08) 0%, transparent 50%),
      radial-gradient(ellipse at 50% 20%, rgba(120, 90, 50, 0.05) 0%, transparent 40%),
      linear-gradient(180deg, #0a0806 0%, #000 100%);
    position: relative;
    overflow-y: auto;
    overflow-x: hidden;
    display: flex;
    flex-direction: column;
    box-sizing: border-box;
  }

  /* Dune-style dust particles */
  .dust-particles {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    background-image:
      radial-gradient(1px 1px at 10% 20%, rgba(180, 140, 80, 0.3) 0%, transparent 100%),
      radial-gradient(1px 1px at 30% 40%, rgba(180, 140, 80, 0.2) 0%, transparent 100%),
      radial-gradient(1px 1px at 50% 10%, rgba(180, 140, 80, 0.25) 0%, transparent 100%),
      radial-gradient(1px 1px at 70% 30%, rgba(180, 140, 80, 0.2) 0%, transparent 100%),
      radial-gradient(1px 1px at 90% 50%, rgba(180, 140, 80, 0.3) 0%, transparent 100%),
      radial-gradient(1px 1px at 20% 60%, rgba(180, 140, 80, 0.2) 0%, transparent 100%),
      radial-gradient(1px 1px at 40% 80%, rgba(180, 140, 80, 0.25) 0%, transparent 100%),
      radial-gradient(1px 1px at 60% 70%, rgba(180, 140, 80, 0.2) 0%, transparent 100%),
      radial-gradient(1px 1px at 80% 90%, rgba(180, 140, 80, 0.3) 0%, transparent 100%);
    animation: dust-drift 20s linear infinite;
    opacity: 0.6;
  }

  @keyframes dust-drift {
    0% { transform: translateY(0) translateX(0); }
    50% { transform: translateY(-20px) translateX(10px); }
    100% { transform: translateY(0) translateX(0); }
  }

  /* PHARAOH GOLD SHOW - Particles intensify during derivation */
  .dust-particles.active {
    opacity: 1;
    animation: dust-drift 8s linear infinite, dust-glow 2s ease-in-out infinite;
    background-image:
      radial-gradient(2px 2px at 10% 20%, rgba(255, 200, 100, 0.6) 0%, transparent 100%),
      radial-gradient(2px 2px at 30% 40%, rgba(255, 180, 80, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 50% 10%, rgba(255, 220, 120, 0.55) 0%, transparent 100%),
      radial-gradient(2px 2px at 70% 30%, rgba(255, 180, 80, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 90% 50%, rgba(255, 200, 100, 0.6) 0%, transparent 100%),
      radial-gradient(2px 2px at 20% 60%, rgba(255, 180, 80, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 40% 80%, rgba(255, 220, 120, 0.55) 0%, transparent 100%),
      radial-gradient(2px 2px at 60% 70%, rgba(255, 180, 80, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 80% 90%, rgba(255, 200, 100, 0.6) 0%, transparent 100%),
      radial-gradient(3px 3px at 15% 45%, rgba(255, 200, 100, 0.4) 0%, transparent 100%),
      radial-gradient(3px 3px at 85% 35%, rgba(255, 200, 100, 0.4) 0%, transparent 100%);
  }

  @keyframes dust-glow {
    0%, 100% { filter: brightness(1); }
    50% { filter: brightness(1.5); }
  }

  /* Golden light flood during derivation */
  .light-flood {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    background: radial-gradient(ellipse at 50% 0%,
      rgba(255, 200, 100, calc(0.1 * var(--progress) / 100)) 0%,
      rgba(255, 180, 80, calc(0.05 * var(--progress) / 100)) 30%,
      transparent 70%);
    z-index: 0;
    animation: flood-pulse 3s ease-in-out infinite;
  }

  @keyframes flood-pulse {
    0%, 100% { opacity: 0.8; }
    50% { opacity: 1; }
  }

  /* Light rays emanating from logo */
  .light-rays {
    position: fixed;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 100%;
    height: 60vh;
    background:
      conic-gradient(from 250deg at 50% 0%,
        transparent 0deg,
        rgba(180, 140, 80, 0.03) 10deg,
        transparent 20deg,
        rgba(180, 140, 80, 0.02) 30deg,
        transparent 40deg,
        rgba(180, 140, 80, 0.04) 50deg,
        transparent 60deg,
        rgba(180, 140, 80, 0.02) 70deg,
        transparent 80deg,
        rgba(180, 140, 80, 0.03) 90deg,
        transparent 100deg,
        transparent 260deg,
        rgba(180, 140, 80, 0.03) 270deg,
        transparent 280deg,
        rgba(180, 140, 80, 0.02) 290deg,
        transparent 300deg
      );
    pointer-events: none;
    opacity: 0.8;
    transition: all 0.8s ease;
  }

  /* LIGHT RAYS EXPLODE during derivation */
  .light-rays.active {
    opacity: 1;
    height: 100vh;
    background:
      conic-gradient(from 250deg at 50% 0%,
        transparent 0deg,
        rgba(255, 200, 100, 0.15) 10deg,
        transparent 20deg,
        rgba(255, 180, 80, 0.12) 30deg,
        transparent 40deg,
        rgba(255, 220, 120, 0.18) 50deg,
        transparent 60deg,
        rgba(255, 180, 80, 0.12) 70deg,
        transparent 80deg,
        rgba(255, 200, 100, 0.15) 90deg,
        transparent 100deg,
        transparent 260deg,
        rgba(255, 200, 100, 0.15) 270deg,
        transparent 280deg,
        rgba(255, 180, 80, 0.12) 290deg,
        transparent 300deg
      );
    animation: rays-rotate 30s linear infinite;
  }

  @keyframes rays-rotate {
    0% { transform: translateX(-50%) rotate(0deg); }
    100% { transform: translateX(-50%) rotate(360deg); }
  }

  .header {
    text-align: center;
    margin-bottom: 24px;
    position: relative;
    z-index: 1;
    flex-shrink: 0;
    transition: all 0.8s ease;
  }

  /* Header shrinks during derivation to give space to the show */
  .header.deriving {
    margin-bottom: 12px;
  }

  /* Trust Badges - HN crowd loves these */
  .trust-badges {
    display: flex;
    justify-content: center;
    gap: 12px;
    margin-top: 16px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .badge.offline {
    background: rgba(34, 197, 94, 0.15);
    color: #22c55e;
    border: 1px solid rgba(34, 197, 94, 0.3);
  }

  .badge.offline::before {
    content: '';
    width: 6px;
    height: 6px;
    background: #22c55e;
    border-radius: 50%;
    box-shadow: 0 0 8px #22c55e;
  }

  .badge.client {
    background: rgba(180, 140, 80, 0.15);
    color: #fbbf24;
    border: 1px solid rgba(180, 140, 80, 0.3);
  }

  .logo-monument {
    position: relative;
    margin-bottom: 0;
    display: inline-block;
    transition: all 0.8s ease;
  }

  /* Logo monument GROWS and GLOWS during derivation */
  .logo-monument.deriving {
    transform: scale(1.3);
  }

  .logo-glow {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 200px;
    height: 200px;
    background: radial-gradient(ellipse at center, rgba(180, 140, 80, 0.15) 0%, transparent 70%);
    pointer-events: none;
    animation: glow-pulse 4s ease-in-out infinite;
    transition: all 0.8s ease;
  }

  /* LOGO GLOW EXPLODES during derivation */
  .logo-glow.active {
    width: 400px;
    height: 400px;
    background: radial-gradient(ellipse at center,
      rgba(255, 200, 100, 0.5) 0%,
      rgba(255, 180, 80, 0.3) 30%,
      rgba(255, 150, 50, 0.1) 60%,
      transparent 80%);
    animation: glow-pulse-intense 1.5s ease-in-out infinite;
  }

  @keyframes glow-pulse {
    0%, 100% { opacity: 0.6; transform: translate(-50%, -50%) scale(1); }
    50% { opacity: 1; transform: translate(-50%, -50%) scale(1.1); }
  }

  @keyframes glow-pulse-intense {
    0%, 100% { opacity: 0.8; transform: translate(-50%, -50%) scale(1); }
    50% { opacity: 1; transform: translate(-50%, -50%) scale(1.2); }
  }

  .triangle-logo {
    width: 100px;
    height: auto;
    opacity: 0.95;
    filter:
      drop-shadow(0 0 40px rgba(180, 140, 80, 0.3))
      drop-shadow(0 0 80px rgba(180, 140, 80, 0.15));
    transition: all 0.8s ease;
    position: relative;
    z-index: 1;
    animation: logo-breathe 6s ease-in-out infinite;
  }

  /* Triangle logo BLAZES during derivation */
  .triangle-logo.deriving {
    filter:
      drop-shadow(0 0 60px rgba(255, 200, 100, 0.7))
      drop-shadow(0 0 120px rgba(255, 180, 80, 0.5))
      drop-shadow(0 0 200px rgba(255, 150, 50, 0.3));
    animation: logo-blaze 1.5s ease-in-out infinite;
  }

  @keyframes logo-breathe {
    0%, 100% { transform: scale(1); filter: drop-shadow(0 0 60px rgba(180, 140, 80, 0.3)) drop-shadow(0 0 120px rgba(180, 140, 80, 0.15)); }
    50% { transform: scale(1.02); filter: drop-shadow(0 0 80px rgba(180, 140, 80, 0.4)) drop-shadow(0 0 150px rgba(180, 140, 80, 0.2)); }
  }

  @keyframes logo-blaze {
    0%, 100% {
      transform: scale(1);
      filter: drop-shadow(0 0 60px rgba(255, 200, 100, 0.7)) drop-shadow(0 0 120px rgba(255, 180, 80, 0.5)) drop-shadow(0 0 200px rgba(255, 150, 50, 0.3));
    }
    50% {
      transform: scale(1.05);
      filter: drop-shadow(0 0 80px rgba(255, 220, 120, 0.9)) drop-shadow(0 0 150px rgba(255, 200, 100, 0.7)) drop-shadow(0 0 250px rgba(255, 180, 80, 0.5));
    }
  }

  .triangle-logo:hover {
    opacity: 1;
    filter:
      drop-shadow(0 0 80px rgba(180, 140, 80, 0.5))
      drop-shadow(0 0 150px rgba(180, 140, 80, 0.25));
    transform: scale(1.05);
  }

  .wordmark {
    font-size: 72px;
    font-weight: 100;
    letter-spacing: 0.3em;
    text-transform: lowercase;
    color: rgba(255, 255, 255, 0.9);
    margin: 0 0 12px 0;
    text-shadow: 0 0 60px rgba(180, 140, 80, 0.3);
  }

  .tagline {
    color: rgba(180, 140, 80, 0.6);
    font-size: 14px;
    font-weight: 300;
    margin: 0;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }

  .badges {
    display: flex;
    justify-content: center;
    gap: 12px;
    margin-top: 24px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 14px;
    border-radius: 2px;
    font-size: 10px;
    font-weight: 400;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    cursor: help;
    transition: all 0.3s ease;
  }

  .offline-badge {
    background: transparent;
    border: 1px solid rgba(180, 140, 80, 0.3);
    color: rgba(180, 140, 80, 0.8);
  }

  .offline-badge::before {
    content: '';
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: rgba(180, 140, 80, 0.9);
    box-shadow: 0 0 8px rgba(180, 140, 80, 0.6);
  }

  .client-badge {
    background: transparent;
    border: 1px solid rgba(180, 140, 80, 0.2);
    color: rgba(180, 140, 80, 0.6);
  }

  .badge:hover {
    border-color: rgba(180, 140, 80, 0.5);
    color: rgba(180, 140, 80, 1);
  }

  .main-content {
    max-width: 520px;
    margin: 0 auto;
    position: relative;
    z-index: 1;
    flex: 1;
    display: flex;
    flex-direction: column;
    min-height: 0;
  }

  /* Glass Card - Sacred Chamber */
  .glass-card {
    background: rgba(10, 8, 6, 0.9);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(180, 140, 80, 0.15);
    border-radius: 2px;
    padding: 24px;
    box-shadow:
      0 0 80px rgba(180, 140, 80, 0.05),
      inset 0 1px 0 rgba(180, 140, 80, 0.1);
    position: relative;
  }

  .glass-card::before {
    content: '';
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 60%;
    height: 1px;
    background: linear-gradient(90deg, transparent, rgba(180, 140, 80, 0.4), transparent);
  }

  /* Complete phase - no visible box, seamless with vault background */
  .glass-card.complete {
    background: transparent;
    border: none;
    box-shadow: none;
    backdrop-filter: none;
    -webkit-backdrop-filter: none;
    padding: 0;
  }

  .glass-card.complete::before {
    display: none;
  }

  /* Resume Banner - Pharaoh Gold Monumental Style */
  .resume-banner {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
    background:
      linear-gradient(135deg, rgba(180, 140, 80, 0.15) 0%, rgba(120, 90, 50, 0.1) 100%),
      radial-gradient(ellipse at 50% 0%, rgba(255, 200, 100, 0.1) 0%, transparent 60%);
    border: 1px solid rgba(180, 140, 80, 0.3);
    border-radius: 16px;
    padding: 24px 32px;
    margin-bottom: 32px;
    position: relative;
    overflow: hidden;
  }

  .resume-banner::before {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255, 200, 100, 0.05) 0%, transparent 100%);
    pointer-events: none;
  }

  .resume-icon {
    font-size: 40px;
    filter: drop-shadow(0 0 20px rgba(255, 200, 100, 0.4));
  }

  .resume-banner > span:nth-child(2) {
    font-size: 18px;
    font-weight: 600;
    color: #fbbf24;
    text-shadow: 0 0 10px rgba(251, 191, 36, 0.3);
    letter-spacing: 0.02em;
    text-align: center;
  }

  .resume-actions {
    display: flex;
    gap: 12px;
    margin-top: 8px;
  }

  .resume-btn, .dismiss-btn {
    padding: 12px 24px;
    border-radius: 12px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease-out;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .resume-btn {
    background: linear-gradient(135deg, rgba(255, 200, 100, 0.3) 0%, rgba(180, 140, 80, 0.2) 100%);
    border: 1px solid rgba(255, 200, 100, 0.4);
    color: #fbbf24;
    box-shadow: 0 4px 20px rgba(255, 200, 100, 0.2);
  }

  .resume-btn:hover {
    background: linear-gradient(135deg, rgba(255, 200, 100, 0.5) 0%, rgba(180, 140, 80, 0.4) 100%);
    box-shadow: 0 6px 30px rgba(255, 200, 100, 0.3);
    transform: translateY(-2px);
  }

  .dismiss-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    color: rgba(255, 255, 255, 0.5);
  }

  .dismiss-btn:hover {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(255, 255, 255, 0.25);
  }

  /* Input Groups - Sacred inscriptions */
  .input-group {
    margin-bottom: 16px;
  }

  .input-group label {
    display: block;
    font-size: 11px;
    font-weight: 400;
    color: rgba(180, 140, 80, 0.8);
    margin-bottom: 6px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
  }

  .input-hint {
    display: block;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.35);
    margin-bottom: 12px;
    font-style: italic;
  }

  .input-wrapper {
    position: relative;
  }

  .input-wrapper input {
    width: 100%;
    padding: 16px 18px;
    background: rgba(0, 0, 0, 0.6);
    border: 1px solid rgba(180, 140, 80, 0.2);
    border-radius: 2px;
    font-size: 16px;
    color: rgba(255, 255, 255, 0.9);
    transition: all 0.3s;
    box-sizing: border-box;
    letter-spacing: 0.02em;
  }

  .input-wrapper input:focus {
    outline: none;
    border-color: rgba(180, 140, 80, 0.5);
    background: rgba(0, 0, 0, 0.7);
    box-shadow: 0 0 30px rgba(180, 140, 80, 0.1);
  }

  .input-wrapper input::placeholder {
    color: rgba(255, 255, 255, 0.2);
    font-style: italic;
  }

  /* Password toggle */
  .input-wrapper .toggle-visibility {
    position: absolute;
    right: 14px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: rgba(180, 140, 80, 0.4);
    transition: color 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .input-wrapper .toggle-visibility:hover {
    color: rgba(180, 140, 80, 0.9);
  }

  .input-wrapper .suggest-btn {
    position: absolute;
    right: 48px;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    padding: 4px;
    cursor: pointer;
    color: rgba(180, 140, 80, 0.4);
    transition: color 0.3s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .input-wrapper .suggest-btn:hover {
    color: rgba(180, 140, 80, 0.9);
  }

  .input-wrapper:has(.toggle-visibility) input {
    padding-right: 80px;
  }

  /* Strength Meter */
  .strength-meter {
    height: 2px;
    background: rgba(180, 140, 80, 0.1);
    border-radius: 0;
    margin-top: 10px;
    overflow: hidden;
  }

  .strength-bar {
    height: 100%;
    transition: all 0.3s;
    border-radius: 0;
  }

  .strength-text {
    font-size: 11px;
    margin-top: 6px;
    display: block;
    letter-spacing: 0.05em;
  }

  /* Factor Slider */
  .factor-slider-wrapper {
    position: relative;
    padding: 8px 0;
    padding-top: 56px; /* Make room for the big factor number */
  }

  .factor-slider-wrapper input[type="range"] {
    width: 100%;
    height: 8px;
    background: linear-gradient(90deg, #22c55e 0%, #eab308 50%, #ef4444 100%);
    border-radius: 4px;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .factor-slider-wrapper input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 24px;
    height: 24px;
    background: white;
    border-radius: 50%;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }

  .factor-labels {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.4);
  }

  .factor-current-value {
    position: absolute;
    top: -48px;
    left: 50%;
    transform: translateX(-50%);
    font-size: 48px;
    font-weight: 700;
    color: #fbbf24;
    text-shadow: 0 0 20px rgba(251, 191, 36, 0.5), 0 0 40px rgba(251, 191, 36, 0.3);
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    letter-spacing: -0.02em;
    pointer-events: none;
    transition: all 0.15s ease-out;
  }

  .factor-info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 12px;
    gap: 16px;
  }

  .factor-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .factor-level {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.95);
    letter-spacing: 0.02em;
  }

  .factor-stats {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    letter-spacing: 0.01em;
  }

  .toggle-buttons {
    display: flex;
    gap: 6px;
  }

  .toggle-option {
    flex: 1;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.4);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .toggle-option:hover {
    background: rgba(255, 255, 255, 0.05);
    color: rgba(255, 255, 255, 0.6);
  }

  .toggle-option.active {
    background: rgba(255, 255, 255, 0.1);
    border-color: rgba(255, 255, 255, 0.2);
    color: white;
  }

  /* Sound select dropdown */
  .sound-select {
    width: 100%;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: white;
    font-size: 13px;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.5)' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
  }

  .sound-select:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.2);
  }

  .sound-select option {
    background: #1a1a2e;
    color: white;
  }

  /* Attack Cost Display */
  .attack-cost {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 14px;
    margin-top: 12px;
    background: linear-gradient(135deg, rgba(239, 68, 68, 0.08) 0%, rgba(220, 38, 38, 0.04) 100%);
    border: 1px solid rgba(239, 68, 68, 0.15);
    border-radius: 8px;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
  }

  .attack-label {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.5);
    letter-spacing: 0.02em;
  }

  .attack-value {
    font-size: 13px;
    font-weight: 600;
    color: rgba(239, 68, 68, 0.9);
    letter-spacing: 0.03em;
  }

  .attack-time {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
  }

  /* Warning Box */
  .warning-box {
    background: rgba(255, 255, 255, 0.03);
    border-radius: 12px;
    padding: 16px;
    margin-bottom: 28px;
  }

  .warning-box p {
    margin: 0;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.6);
    line-height: 1.5;
  }

  .warning-box strong {
    color: rgba(255, 255, 255, 0.9);
  }

  /* Derive Button - Sacred Gate */
  .derive-btn {
    width: 100%;
    padding: 18px;
    background: transparent;
    border: 1px solid rgba(180, 140, 80, 0.4);
    border-radius: 2px;
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0.2em;
    text-transform: uppercase;
    color: rgba(180, 140, 80, 0.9);
    cursor: pointer;
    transition: all 0.4s ease;
    position: relative;
    overflow: hidden;
  }

  .derive-btn::before {
    content: '';
    position: absolute;
    top: 0;
    left: -100%;
    width: 100%;
    height: 100%;
    background: linear-gradient(90deg, transparent, rgba(180, 140, 80, 0.1), transparent);
    transition: left 0.5s ease;
  }

  .derive-btn:hover:not(:disabled)::before {
    left: 100%;
  }

  .derive-btn:hover:not(:disabled) {
    background: rgba(180, 140, 80, 0.1);
    border-color: rgba(180, 140, 80, 0.6);
    box-shadow: 0 0 40px rgba(180, 140, 80, 0.15);
    color: rgba(180, 140, 80, 1);
  }

  .derive-btn:disabled {
    opacity: 0.25;
    cursor: not-allowed;
  }

  .derive-btn.secondary {
    background: transparent;
    border: 1px solid rgba(180, 140, 80, 0.2);
    color: rgba(180, 140, 80, 0.6);
    margin-top: 24px;
  }

  .derive-btn.secondary:hover:not(:disabled) {
    background: rgba(180, 140, 80, 0.05);
    border-color: rgba(180, 140, 80, 0.4);
    color: rgba(180, 140, 80, 0.9);
  }

  /* Network CTA Section - Join the Spice Guild */
  .network-actions {
    margin-top: 40px;
    padding-top: 40px;
    border-top: 1px solid rgba(180, 140, 80, 0.1);
  }

  .network-cta {
    background: rgba(180, 140, 80, 0.03);
    border: 1px solid rgba(180, 140, 80, 0.15);
    border-radius: 2px;
    padding: 28px;
    text-align: center;
  }

  .network-cta-header {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    margin-bottom: 14px;
  }

  .network-icon {
    font-size: 20px;
    color: rgba(180, 140, 80, 0.8);
  }

  .network-title {
    font-size: 14px;
    font-weight: 400;
    color: rgba(180, 140, 80, 0.9);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .network-desc {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.4);
    line-height: 1.6;
    margin: 0 0 24px 0;
    font-style: italic;
  }

  .derive-btn.network-btn {
    display: inline-flex;
    background: rgba(180, 140, 80, 0.15);
    border-color: rgba(180, 140, 80, 0.5);
    box-shadow: 0 0 30px rgba(180, 140, 80, 0.1);
    text-decoration: none;
  }

  .derive-btn.network-btn:hover:not(:disabled) {
    background: rgba(180, 140, 80, 0.25);
    border-color: rgba(180, 140, 80, 0.7);
    box-shadow: 0 0 50px rgba(180, 140, 80, 0.2);
    transform: translateY(-1px);
  }

  /* Deriving Phase */
  .glass-card.deriving h2 {
    text-align: center;
    color: rgba(255, 255, 255, 0.9);
    margin-bottom: 24px;
  }

  .progress-info {
    margin-bottom: 24px;
  }

  .progress-stats {
    display: flex;
    justify-content: space-between;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.7);
    margin-bottom: 8px;
  }

  .progress-bar-container {
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    overflow: hidden;
  }

  .progress-bar {
    height: 100%;
    background: linear-gradient(90deg, #7c3aed, #06b6d4);
    transition: width 0.3s;
  }

  .time-info {
    display: flex;
    justify-content: space-between;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    margin-top: 8px;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     VAULT DOOR - Bank vault opening animation (black & white, minimal)
     ═══════════════════════════════════════════════════════════════════════════ */

  .vault-door-container {
    position: fixed;
    inset: 0;
    background: #000;
    background-image:
      radial-gradient(ellipse at 50% 30%, rgba(180, 140, 80, 0.15) 0%, transparent 50%),
      radial-gradient(ellipse at 50% 50%, rgba(120, 90, 50, 0.08) 0%, transparent 40%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    overflow: hidden;
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     PHARAOH GOLD SHOW - You just found pharaoh gold!
     ═══════════════════════════════════════════════════════════════════════════ */

  /* Golden dust particles floating in the air */
  .pharaoh-dust {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: 0.8;
    background-image:
      radial-gradient(2px 2px at 10% 20%, rgba(255, 200, 100, 0.7) 0%, transparent 100%),
      radial-gradient(2px 2px at 20% 50%, rgba(255, 180, 80, 0.6) 0%, transparent 100%),
      radial-gradient(1px 1px at 30% 10%, rgba(255, 220, 120, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 40% 70%, rgba(255, 200, 100, 0.7) 0%, transparent 100%),
      radial-gradient(1px 1px at 50% 30%, rgba(255, 180, 80, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 60% 60%, rgba(255, 220, 120, 0.6) 0%, transparent 100%),
      radial-gradient(1px 1px at 70% 15%, rgba(255, 200, 100, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 80% 45%, rgba(255, 180, 80, 0.7) 0%, transparent 100%),
      radial-gradient(1px 1px at 90% 80%, rgba(255, 220, 120, 0.6) 0%, transparent 100%),
      radial-gradient(2px 2px at 15% 85%, rgba(255, 200, 100, 0.7) 0%, transparent 100%),
      radial-gradient(1px 1px at 25% 35%, rgba(255, 180, 80, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 35% 95%, rgba(255, 220, 120, 0.6) 0%, transparent 100%),
      radial-gradient(1px 1px at 45% 5%, rgba(255, 200, 100, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 55% 75%, rgba(255, 180, 80, 0.7) 0%, transparent 100%),
      radial-gradient(1px 1px at 65% 25%, rgba(255, 220, 120, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 75% 55%, rgba(255, 200, 100, 0.6) 0%, transparent 100%),
      radial-gradient(1px 1px at 85% 15%, rgba(255, 180, 80, 0.5) 0%, transparent 100%),
      radial-gradient(2px 2px at 95% 65%, rgba(255, 220, 120, 0.7) 0%, transparent 100%);
    background-size: 100% 100%;
    animation: pharaoh-dust-drift 15s linear infinite;
  }

  @keyframes pharaoh-dust-drift {
    0% { transform: translateY(0) translateX(0); }
    25% { transform: translateY(-15px) translateX(10px); }
    50% { transform: translateY(0) translateX(-5px); }
    75% { transform: translateY(15px) translateX(5px); }
    100% { transform: translateY(0) translateX(0); }
  }

  /* Golden light rays emanating from the pyramid */
  .pharaoh-rays {
    position: absolute;
    inset: 0;
    pointer-events: none;
    opacity: calc(0.3 + var(--progress, 0) * 0.007);
    background: conic-gradient(
      from 250deg at 50% 35%,
      transparent 0deg,
      rgba(255, 200, 100, 0.2) 10deg,
      transparent 20deg,
      rgba(255, 180, 80, 0.15) 40deg,
      transparent 50deg,
      rgba(255, 220, 120, 0.18) 70deg,
      transparent 80deg,
      rgba(255, 200, 100, 0.2) 100deg,
      transparent 110deg,
      rgba(255, 180, 80, 0.15) 130deg,
      transparent 140deg,
      rgba(255, 220, 120, 0.18) 160deg,
      transparent 170deg,
      rgba(255, 200, 100, 0.2) 190deg,
      transparent 200deg,
      rgba(255, 180, 80, 0.15) 220deg,
      transparent 230deg,
      rgba(255, 220, 120, 0.18) 250deg,
      transparent 260deg,
      rgba(255, 200, 100, 0.2) 280deg,
      transparent 290deg,
      rgba(255, 180, 80, 0.15) 310deg,
      transparent 320deg,
      rgba(255, 220, 120, 0.18) 340deg,
      transparent 360deg
    );
    animation: pharaoh-rays-rotate 60s linear infinite;
  }

  @keyframes pharaoh-rays-rotate {
    0% { transform: rotate(0deg); }
    100% { transform: rotate(360deg); }
  }

  /* Golden light flood that intensifies with progress */
  .pharaoh-flood {
    position: absolute;
    inset: 0;
    pointer-events: none;
    background: radial-gradient(
      ellipse at 50% 35%,
      rgba(255, 200, 100, calc(0.05 + var(--progress, 0) * 0.003)) 0%,
      rgba(255, 180, 80, calc(0.03 + var(--progress, 0) * 0.002)) 30%,
      transparent 70%
    );
    animation: pharaoh-flood-pulse 3s ease-in-out infinite;
  }

  @keyframes pharaoh-flood-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.7; }
  }

  /* Pyramid blazing with golden light */
  .pharaoh-blazing {
    filter:
      drop-shadow(0 0 30px rgba(255, 200, 100, 0.6))
      drop-shadow(0 0 60px rgba(255, 180, 80, 0.4))
      drop-shadow(0 0 100px rgba(255, 160, 60, 0.3));
    animation: pharaoh-blaze 2s ease-in-out infinite;
  }

  @keyframes pharaoh-blaze {
    0%, 100% {
      filter:
        drop-shadow(0 0 30px rgba(255, 200, 100, 0.6))
        drop-shadow(0 0 60px rgba(255, 180, 80, 0.4))
        drop-shadow(0 0 100px rgba(255, 160, 60, 0.3));
    }
    50% {
      filter:
        drop-shadow(0 0 40px rgba(255, 200, 100, 0.8))
        drop-shadow(0 0 80px rgba(255, 180, 80, 0.5))
        drop-shadow(0 0 120px rgba(255, 160, 60, 0.4));
    }
  }

  /* Pharaoh glow - massive golden aura */
  .pharaoh-glow {
    position: absolute;
    inset: -100px;
    background: radial-gradient(
      ellipse at center,
      rgba(255, 200, 100, 0.5) 0%,
      rgba(255, 180, 80, 0.3) 30%,
      rgba(255, 160, 60, 0.15) 50%,
      transparent 80%
    );
    opacity: calc(0.5 + var(--progress, 0%) * 0.005);
    animation: pharaoh-glow-pulse 2s ease-in-out infinite;
    pointer-events: none;
  }

  @keyframes pharaoh-glow-pulse {
    0%, 100% { transform: scale(1); opacity: calc(0.5 + var(--progress, 0%) * 0.005); }
    50% { transform: scale(1.1); opacity: calc(0.7 + var(--progress, 0%) * 0.003); }
  }

  /* Light escaping from pyramid cracks */
  .pharaoh-crack {
    position: absolute;
    width: 3px;
    height: 50px;
    background: linear-gradient(
      180deg,
      transparent 0%,
      rgba(255, 200, 100, 0.9) 30%,
      rgba(255, 220, 120, 1) 50%,
      rgba(255, 200, 100, 0.9) 70%,
      transparent 100%
    );
    box-shadow:
      0 0 15px rgba(255, 200, 100, 0.8),
      0 0 30px rgba(255, 180, 80, 0.5),
      0 0 50px rgba(255, 160, 60, 0.3);
    animation: pharaoh-crack-flicker 1.5s ease-in-out infinite;
  }

  .pharaoh-crack.left {
    top: 60%;
    left: 25%;
    transform: rotate(-25deg);
  }

  .pharaoh-crack.right {
    top: 60%;
    right: 25%;
    transform: rotate(25deg);
  }

  @keyframes pharaoh-crack-flicker {
    0%, 100% { opacity: 0.8; height: 50px; }
    25% { opacity: 1; height: 55px; }
    50% { opacity: 0.6; height: 48px; }
    75% { opacity: 1; height: 52px; }
  }

  .vault-door {
    position: relative;
    width: 280px;
    height: 280px;
  }

  .vault-ring {
    position: absolute;
    inset: 0;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 50%;
    transition: transform 0.5s ease-out;
  }

  .vault-ring.outer {
    inset: 0;
    transform: rotate(var(--rotation, 0deg));
    border-width: 2px;
    border-color: rgba(255, 255, 255, 0.3);
  }

  .vault-ring.middle {
    inset: 30px;
    transform: rotate(var(--rotation, 0deg));
    border-style: dashed;
    border-color: rgba(255, 255, 255, 0.2);
  }

  .vault-ring.inner {
    inset: 60px;
    transform: rotate(var(--rotation, 0deg));
    border-color: rgba(255, 255, 255, 0.1);
  }

  .vault-center {
    position: absolute;
    inset: 90px;
    background: #000;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .vault-logo {
    font-size: 32px;
    color: #fff;
    opacity: 0.8;
    animation: vault-pulse 2s ease-in-out infinite;
  }

  @keyframes vault-pulse {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.05); }
  }

  .vault-progress-ring {
    position: absolute;
    inset: -10px;
  }

  .vault-tick {
    position: absolute;
    width: 2px;
    height: 8px;
    background: rgba(255, 255, 255, 0.1);
    left: 50%;
    top: 0;
    transform-origin: 50% 150px;
    transform: translateX(-50%) rotate(var(--angle, 0deg));
    transition: background 0.3s, box-shadow 0.3s;
  }

  .vault-tick.active {
    background: #fff;
    box-shadow: 0 0 6px rgba(255, 255, 255, 0.8);
  }

  /* Pyramid Visualization - Monumental */
  .pyramid-visualization {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 24px;
    padding: 40px;
    width: 100%;
    max-width: 400px;
  }

  .pyramid-logo {
    position: relative;
    width: 120px;
    height: 120px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .pyramid-triangle {
    width: 100%;
    height: auto;
    opacity: calc(0.4 + var(--progress, 0%) * 0.006);
    filter: drop-shadow(0 0 40px rgba(255, 255, 255, calc(0.1 + var(--progress, 0%) * 0.004)));
    animation: pyramid-breathe 3s ease-in-out infinite;
    transition: opacity 0.3s, filter 0.3s;
  }

  .pyramid-glow {
    position: absolute;
    inset: -20px;
    background: radial-gradient(circle at center, rgba(255, 255, 255, 0.1) 0%, transparent 70%);
    opacity: calc(var(--progress, 0%) * 0.01);
    animation: pyramid-glow-pulse 2s ease-in-out infinite;
    pointer-events: none;
  }

  @keyframes pyramid-breathe {
    0%, 100% { transform: scale(1); }
    50% { transform: scale(1.02); }
  }

  @keyframes pyramid-glow-pulse {
    0%, 100% { opacity: calc(var(--progress, 0%) * 0.008); }
    50% { opacity: calc(var(--progress, 0%) * 0.012); }
  }

  .pyramid-progress-text {
    font-size: 64px;
    font-weight: 200;
    color: rgb(255, 220, 140);
    letter-spacing: 4px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    text-shadow:
      0 0 20px rgba(255, 200, 100, 0.6),
      0 0 40px rgba(255, 180, 80, 0.4);
  }

  .pyramid-stats {
    display: flex;
    gap: 32px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .stat-row {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .stat-label {
    font-size: 10px;
    letter-spacing: 2px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
  }

  .stat-value {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
  }

  .pyramid-progress-bar {
    width: 100%;
    height: 3px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .pyramid-progress-fill {
    height: 100%;
    background: linear-gradient(90deg, rgba(255, 255, 255, 0.5) 0%, #fff 100%);
    transition: width 0.2s ease-out;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
  }

  .memory-control, .sound-control {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .memory-label, .sound-label {
    font-size: 10px;
    letter-spacing: 2px;
    color: rgba(255, 200, 100, 0.6);
    text-transform: uppercase;
    width: 70px;
    flex-shrink: 0;
  }

  .memory-slider-wrapper {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .memory-slider {
    width: 100%;
    height: 24px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 200, 100, 0.15);
    border-radius: 4px;
    cursor: pointer;
  }

  .memory-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 24px;
    background: rgb(255, 200, 100);
    border-radius: 3px;
    cursor: pointer;
    box-shadow: 0 0 10px rgba(255, 200, 100, 0.5);
  }

  .memory-slider::-moz-range-thumb {
    width: 16px;
    height: 24px;
    background: rgb(255, 200, 100);
    border-radius: 3px;
    cursor: pointer;
    box-shadow: 0 0 10px rgba(255, 200, 100, 0.5);
    border: none;
  }

  .memory-value {
    font-size: 11px;
    color: rgba(255, 200, 100, 0.8);
    text-align: right;
  }

  /* Mini shard grid under pyramid */
  .mini-shard-grid {
    display: grid;
    grid-template-columns: repeat(var(--cols, 16), 1fr);
    gap: 2px;
    width: 100%;
    max-width: 320px;
    margin: 16px auto 0;
    padding: 8px;
    background: rgba(0, 0, 0, 0.3);
    border-radius: 8px;
  }

  .mini-shard {
    aspect-ratio: 1;
    border-radius: 2px;
    transition: all 0.2s ease-out;
  }

  .mini-shard.pending {
    background: rgba(80, 60, 30, 0.4);
    border: 1px solid rgba(180, 140, 80, 0.1);
  }

  .mini-shard.computing {
    background: radial-gradient(circle at center,
      rgba(255, 200, 100, 0.9) 0%,
      rgba(255, 180, 80, 0.7) 50%,
      rgba(180, 140, 80, 0.4) 100%);
    box-shadow: 0 0 8px rgba(255, 200, 100, 0.6);
    animation: mini-shard-pulse 0.6s ease-in-out infinite;
  }

  .mini-shard.complete {
    background: linear-gradient(135deg, rgba(255, 220, 120, 0.9) 0%, rgba(230, 180, 80, 0.8) 100%);
    border: 1px solid rgba(255, 220, 120, 0.8);
    box-shadow: 0 0 4px rgba(255, 200, 100, 0.3);
  }

  @keyframes mini-shard-pulse {
    0%, 100% { transform: scale(1); opacity: 1; }
    50% { transform: scale(1.1); opacity: 0.8; }
  }

  .thread-control {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .thread-label {
    font-size: 10px;
    letter-spacing: 2px;
    color: rgba(255, 255, 255, 0.4);
    text-transform: uppercase;
    width: 70px;
    flex-shrink: 0;
  }

  .thread-slider {
    flex: 1;
    height: 24px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 4px;
    cursor: pointer;
  }

  .thread-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 16px;
    height: 24px;
    background: #fff;
    border-radius: 3px;
    cursor: pointer;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
  }

  .thread-slider::-moz-range-thumb {
    width: 16px;
    height: 24px;
    background: #fff;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    box-shadow: 0 0 10px rgba(255, 255, 255, 0.5);
  }

  .sound-select {
    flex: 1;
    padding: 8px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: #fff;
    font-size: 12px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    cursor: pointer;
  }

  .sound-select:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.3);
  }

  .sound-select option {
    background: #0a0a0a;
    color: #fff;
  }

  .derivation-progress {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 16px;
  }

  .progress-bar-track {
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #fff 0%, rgba(255,255,255,0.8) 100%);
    transition: width 0.2s ease-out;
  }

  .progress-label {
    text-align: center;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .sound-selector {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 20px;
    padding: 12px 16px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
  }

  .sound-label {
    font-size: 11px;
    letter-spacing: 2px;
    color: rgba(255, 255, 255, 0.5);
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .sound-select {
    flex: 1;
    padding: 8px 12px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    color: #fff;
    font-size: 13px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    cursor: pointer;
    transition: all 0.2s;
  }

  .sound-select:hover {
    border-color: rgba(255, 255, 255, 0.4);
    background: rgba(0, 0, 0, 0.4);
  }

  .sound-select:focus {
    outline: none;
    border-color: rgba(100, 200, 255, 0.6);
    box-shadow: 0 0 0 2px rgba(100, 200, 255, 0.2);
  }

  .sound-select option {
    background: #1a1a1a;
    color: #fff;
  }

  .vault-info {
    margin-top: 48px;
    text-align: center;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .vault-progress-text {
    font-size: 48px;
    font-weight: 200;
    color: #fff;
    letter-spacing: 4px;
  }

  .vault-time {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 8px;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .vault-cancel {
    position: absolute;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    padding: 8px 24px;
    color: rgba(255, 255, 255, 0.4);
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    font-size: 12px;
    letter-spacing: 2px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .vault-cancel:hover {
    border-color: rgba(255, 255, 255, 0.5);
    color: rgba(255, 255, 255, 0.7);
  }

  /* Controls bar - shared between both animation styles */
  .anim-controls {
    position: absolute;
    bottom: 40px;
    left: 50%;
    transform: translateX(-50%);
    display: flex;
    gap: 12px;
    align-items: center;
  }

  .control-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.15);
    padding: 8px 16px;
    color: rgba(255, 255, 255, 0.5);
    font-size: 14px;
    cursor: pointer;
    transition: all 0.2s;
    border-radius: 6px;
  }

  .control-btn:hover {
    border-color: rgba(255, 255, 255, 0.35);
    color: rgba(255, 255, 255, 0.8);
  }

  .control-btn.cancel {
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    font-size: 12px;
    letter-spacing: 1px;
  }

  /* Parallelism control */
  .parallelism-control {
    display: flex;
    align-items: center;
    gap: 8px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    padding: 4px 12px;
  }

  .parallelism-slider {
    width: 60px;
    height: 4px;
    -webkit-appearance: none;
    appearance: none;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 2px;
    cursor: pointer;
  }

  .parallelism-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px;
    height: 14px;
    background: linear-gradient(135deg, #a855f7, #06b6d4);
    border-radius: 50%;
    cursor: pointer;
    box-shadow: 0 0 8px rgba(168, 85, 247, 0.5);
  }

  .parallelism-slider::-moz-range-thumb {
    width: 14px;
    height: 14px;
    background: linear-gradient(135deg, #a855f7, #06b6d4);
    border-radius: 50%;
    cursor: pointer;
    border: none;
    box-shadow: 0 0 8px rgba(168, 85, 247, 0.5);
  }

  .parallelism-label {
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.6);
    min-width: 12px;
    text-align: center;
  }

  /* Mini sound dropdown for controls bar */
  .sound-select-mini {
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 6px;
    padding: 6px 10px;
    color: rgba(255, 255, 255, 0.5);
    font-size: 11px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .sound-select-mini:hover {
    border-color: rgba(255, 255, 255, 0.35);
    color: rgba(255, 255, 255, 0.8);
  }

  .sound-select-mini option {
    background: #1a1a2e;
    color: #fff;
  }

  /* Split door panels for dramatic opening */
  .vault-split-left,
  .vault-split-right {
    position: absolute;
    top: 0;
    width: 50%;
    height: 100%;
    background: #000;
    z-index: -1;
    opacity: 0;
    transition: transform 0.8s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.1s;
  }

  .vault-split-left {
    left: 0;
    border-right: 1px solid rgba(255, 255, 255, 0.2);
  }

  .vault-split-right {
    right: 0;
    border-left: 1px solid rgba(255, 255, 255, 0.2);
  }

  .vault-door-container.opening .vault-split-left,
  .vault-door-container.opening .vault-split-right {
    z-index: 10;
    opacity: 1;
  }

  .vault-door-container.opening .vault-split-left {
    transform: translateX(-100%);
  }

  .vault-door-container.opening .vault-split-right {
    transform: translateX(100%);
  }

  .vault-door-container.opening .vault-door,
  .vault-door-container.opening .vault-info,
  .vault-door-container.opening .vault-cancel {
    opacity: 0;
    transition: opacity 0.3s;
  }
  .vault-shards {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.3);
    margin-top: 4px;
    letter-spacing: 1px;
  }

  /* Tips display */
  .vault-tip,
  .shards-tip {
    max-width: 400px;
    margin-top: 24px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    text-align: center;
    line-height: 1.5;
    padding: 0 20px;
    animation: tip-fade 7s ease-in-out infinite;
  }

  @keyframes tip-fade {
    0%, 100% { opacity: 0.4; }
    10%, 90% { opacity: 1; }
  }

  /* ═══════════════════════════════════════════════════════════════════════════
     SHARDS GRID - Alternative shard visualization
     ═══════════════════════════════════════════════════════════════════════════ */

  .shards-container {
    position: fixed;
    inset: 0;
    background: #000;
    background-image:
      radial-gradient(ellipse at 50% 30%, rgba(180, 140, 80, 0.08) 0%, transparent 60%),
      radial-gradient(ellipse at 50% 50%, rgba(120, 90, 50, 0.05) 0%, transparent 50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px;
    z-index: 1000;
  }

  .shards-header {
    text-align: center;
    margin-bottom: 32px;
  }

  .shards-progress-text {
    font-size: 56px;
    font-weight: 200;
    color: #fff;
    letter-spacing: 4px;
    font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  }

  .shards-time {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.4);
    margin-top: 8px;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  .shard-grid {
    display: grid;
    grid-template-columns: repeat(var(--cols, 8), 1fr);
    gap: 3px;
    max-width: 400px;
    max-height: 400px;
    width: 100%;
    aspect-ratio: 1;
  }

  /* ANCIENT SEAL - Each shard is a golden seal being unlocked */
  .shard {
    aspect-ratio: 1;
    border-radius: 1px;
    transition: all 0.3s ease;
    position: relative;
  }

  /* Pending - dark dormant seal */
  .shard.pending {
    background: rgba(30, 25, 15, 0.8);
    border: 1px solid rgba(180, 140, 80, 0.15);
    box-shadow: inset 0 0 10px rgba(0, 0, 0, 0.5);
  }

  /* Computing - seal being UNLOCKED, golden fire */
  .shard.computing {
    background: radial-gradient(circle at center,
      rgba(255, 200, 100, 0.8) 0%,
      rgba(255, 180, 80, 0.6) 40%,
      rgba(200, 150, 50, 0.4) 70%,
      rgba(180, 140, 80, 0.3) 100%);
    border: 1px solid rgba(255, 200, 100, 0.8);
    animation: seal-unlock 0.8s ease-in-out infinite;
    box-shadow:
      0 0 15px rgba(255, 200, 100, 0.6),
      0 0 30px rgba(255, 180, 80, 0.3),
      inset 0 0 10px rgba(255, 220, 120, 0.4);
  }

  /* Complete - GOLDEN seal, fully lit */
  .shard.complete {
    background: linear-gradient(135deg,
      rgba(255, 220, 120, 0.95) 0%,
      rgba(255, 200, 100, 0.9) 50%,
      rgba(230, 180, 80, 0.85) 100%);
    border: 1px solid rgba(255, 220, 120, 1);
    box-shadow:
      0 0 8px rgba(255, 200, 100, 0.5),
      0 0 20px rgba(255, 180, 80, 0.2),
      inset 0 1px 0 rgba(255, 255, 255, 0.3);
  }

  /* Partial completion for chunked cells (shows gradient progress) */
  .shard.partial {
    background: linear-gradient(
      to top,
      rgba(255, 200, 100, 0.9) 0%,
      rgba(255, 200, 100, 0.9) calc(var(--progress, 0) * 100%),
      rgba(180, 140, 80, 0.3) calc(var(--progress, 0) * 100%),
      rgba(180, 140, 80, 0.3) 100%
    );
    border: 1px solid rgba(255, 200, 100, 0.6);
    box-shadow: 0 0 10px rgba(255, 200, 100, 0.3);
  }

  @keyframes seal-unlock {
    0%, 100% {
      opacity: 0.7;
      transform: scale(1);
      box-shadow: 0 0 15px rgba(255, 200, 100, 0.6), 0 0 30px rgba(255, 180, 80, 0.3);
    }
    50% {
      opacity: 1;
      transform: scale(1.05);
      box-shadow: 0 0 25px rgba(255, 200, 100, 0.9), 0 0 50px rgba(255, 180, 80, 0.5);
    }
  }

  .shards-footer {
    margin-top: 32px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
  }

  .shards-count {
    font-size: 14px;
    color: rgba(255, 255, 255, 0.6);
    letter-spacing: 1px;
  }

  .shards-stats {
    font-size: 11px;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    color: rgba(139, 92, 246, 0.6);
    letter-spacing: 0.5px;
  }

  /* Complete Phase - Pharaoh Gold Theme */
  .success-header {
    text-align: center;
    margin-bottom: 36px;
  }

  .success-icon-container {
    position: relative;
    width: 80px;
    height: 80px;
    margin: 0 auto 20px;
  }

  .success-glow {
    position: absolute;
    inset: -20px;
    background: radial-gradient(circle, rgba(251, 191, 36, 0.4) 0%, rgba(180, 140, 80, 0.2) 50%, transparent 70%);
    filter: blur(20px);
    animation: pulse-glow 2s ease-in-out infinite;
  }

  @keyframes pulse-glow {
    0%, 100% { opacity: 0.6; transform: scale(1); }
    50% { opacity: 1; transform: scale(1.1); }
  }

  .success-ring {
    position: relative;
    width: 100%;
    height: 100%;
    border-radius: 50%;
    background: linear-gradient(135deg,
      rgba(180, 140, 80, 0.2) 0%,
      rgba(120, 90, 50, 0.1) 50%,
      rgba(180, 140, 80, 0.15) 100%);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(180, 140, 80, 0.3);
    box-shadow:
      0 8px 32px rgba(180, 140, 80, 0.3),
      inset 0 1px 1px rgba(255, 200, 100, 0.3),
      inset 0 -1px 1px rgba(0, 0, 0, 0.1);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .success-check {
    width: 40px;
    height: 40px;
    animation: draw-check 0.6s ease-out forwards;
  }

  .success-check path {
    stroke-dasharray: 30;
    stroke-dashoffset: 30;
    animation: draw-check-path 0.6s ease-out 0.2s forwards;
  }

  @keyframes draw-check-path {
    to { stroke-dashoffset: 0; }
  }

  .success-header h2 {
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 50%, #d97706 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin: 0 0 8px 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.02em;
    text-shadow: 0 0 40px rgba(251, 191, 36, 0.3);
  }

  .success-stats {
    color: rgba(180, 140, 80, 0.7);
    margin: 0;
    font-size: 14px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .stat-divider {
    opacity: 0.4;
    margin: 0 4px;
  }

  /* Result Sections */
  .result-section {
    margin-bottom: 28px;
  }

  .result-section > label {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 10px;
    font-size: 13px;
    font-weight: 600;
    color: rgba(180, 140, 80, 0.8);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  .result-box {
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(180, 140, 80, 0.2);
    border-radius: 10px;
    padding: 16px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .result-box code {
    flex: 1;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
    word-break: break-all;
  }

  .result-box code.blurred {
    filter: blur(4px);
    user-select: none;
  }

  .result-box.address code {
    color: #fbbf24;
    font-size: 13px;
  }

  .result-box.address.with-identicon {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .identicon {
    width: 48px;
    height: 48px;
    border-radius: 8px;
    flex-shrink: 0;
    border: 2px solid rgba(180, 140, 80, 0.3);
    box-shadow: 0 0 12px rgba(180, 140, 80, 0.2);
  }

  .copy-btn, .toggle-btn {
    background: rgba(180, 140, 80, 0.15);
    border: 1px solid rgba(180, 140, 80, 0.2);
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 16px;
    transition: all 0.2s;
    flex-shrink: 0;
    color: rgba(180, 140, 80, 0.8);
  }

  .copy-btn:hover, .toggle-btn:hover {
    background: rgba(180, 140, 80, 0.25);
    border-color: rgba(180, 140, 80, 0.4);
  }

  .copy-btn.full {
    width: 100%;
    margin-top: 12px;
    padding: 12px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
  }

  /* Mnemonic Display */
  .result-box.mnemonic {
    flex-direction: column;
    align-items: stretch;
  }

  .mnemonic-toggle button {
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, rgba(180, 140, 80, 0.2), rgba(120, 90, 50, 0.15));
    border: 1px solid rgba(180, 140, 80, 0.3);
    border-radius: 8px;
    color: #fbbf24;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .mnemonic-toggle button:hover {
    background: linear-gradient(135deg, rgba(180, 140, 80, 0.3), rgba(120, 90, 50, 0.25));
    border-color: rgba(180, 140, 80, 0.5);
  }

  .mnemonic-words {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 10px;
    margin-top: 20px;
    padding: 16px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 12px;
    border: 1px solid rgba(180, 140, 80, 0.2);
  }

  .word {
    display: flex;
    align-items: baseline;
    background: rgba(180, 140, 80, 0.08);
    padding: 12px 14px;
    border-radius: 6px;
    font-size: 15px;
    color: #fbbf24;
    font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Mono', monospace;
    font-weight: 500;
    letter-spacing: 0.02em;
    border: 1px solid rgba(180, 140, 80, 0.15);
    text-shadow: 0 0 8px rgba(251, 191, 36, 0.2);
    min-height: 44px;
    box-sizing: border-box;
  }

  .word-num {
    color: rgba(180, 140, 80, 0.5);
    margin-right: 8px;
    font-size: 12px;
    font-weight: 400;
    min-width: 24px;
    flex-shrink: 0;
  }

  .result-box.compact {
    flex-direction: row;
  }

  .result-box.compact code {
    font-size: 12px;
  }

  /* Password Manager - simplified */
  .password-manager {
    margin-top: 32px;
    border-top: 1px solid rgba(255, 255, 255, 0.08);
    padding-top: 24px;
  }

  .password-manager > label {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
    margin-bottom: 8px;
    display: block;
  }

  .pm-domain-input {
    width: 100%;
    padding: 12px 14px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    font-size: 14px;
    color: white;
    box-sizing: border-box;
  }

  .pm-domain-input:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.25);
  }

  .pm-domain-input::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  .result-box.site-password {
    margin-top: 10px;
  }

  .pm-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 10px;
  }

  .pm-hint {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.35);
  }

  .pm-input-row {
    margin-bottom: 10px;
  }

  .pm-empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 24px 16px;
    background: rgba(255, 255, 255, 0.02);
    border: 1px dashed rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    margin-top: 10px;
  }

  .pm-empty-icon {
    font-size: 24px;
    opacity: 0.5;
  }

  .pm-empty-text {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.35);
    text-align: center;
  }

  /* FAQ Section */
  .faq-section {
    margin-top: 60px;
  }

  .faq-section h3 {
    font-size: 12px;
    color: rgba(180, 140, 80, 0.7);
    margin-bottom: 24px;
    letter-spacing: 0.15em;
    text-transform: uppercase;
    font-weight: 400;
  }

  .faq-item {
    background: transparent;
    border: 1px solid rgba(180, 140, 80, 0.1);
    border-radius: 0;
    margin-bottom: 4px;
    overflow: hidden;
    transition: all 0.3s;
  }

  .faq-item.expanded {
    background: rgba(180, 140, 80, 0.03);
    border-color: rgba(180, 140, 80, 0.25);
  }

  .faq-question {
    width: 100%;
    padding: 16px 20px;
    background: none;
    border: none;
    display: flex;
    justify-content: space-between;
    align-items: center;
    cursor: pointer;
    color: rgba(255, 255, 255, 0.8);
    font-size: 14px;
    font-weight: 400;
    text-align: left;
    transition: color 0.3s;
  }

  .faq-question:hover {
    color: rgba(180, 140, 80, 0.9);
  }

  .faq-toggle {
    font-size: 16px;
    color: rgba(180, 140, 80, 0.4);
    width: 24px;
    text-align: center;
    transition: color 0.3s;
  }

  .faq-item.expanded .faq-toggle {
    color: rgba(180, 140, 80, 0.8);
  }

  .faq-answer {
    padding: 0 20px 18px;
  }

  .faq-answer p {
    margin: 0;
    font-size: 13px;
    line-height: 1.7;
    color: rgba(255, 255, 255, 0.5);
    font-style: italic;
  }

  /* Responsive */
  @media (max-width: 600px) {
    .glass-card {
      padding: 20px;
    }

    .mnemonic-words {
      grid-template-columns: repeat(3, 1fr);
    }

    .factor-stats {
      flex-direction: column;
      gap: 4px;
    }

    .logo h1 {
      font-size: 32px;
    }
  }
</style>
