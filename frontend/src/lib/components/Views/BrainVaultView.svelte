<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { HDNodeWallet } from 'ethers';
  import { locale, translations$, initI18n, loadTranslations } from '$lib/i18n';

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
    MIN_NAME_LENGTH: 4,
    MIN_PASSPHRASE_LENGTH: 6,
    MIN_FACTOR: 1,
    MAX_FACTOR: 9,
  };

  const FACTOR_INFO = [
    { factor: 1, shards: 1, memory: '256MB', time: '~3s', description: 'Demo only' },
    { factor: 2, shards: 4, memory: '1GB', time: '~12s', description: 'Quick test' },
    { factor: 3, shards: 16, memory: '4GB', time: '~50s', description: 'Light use' },
    { factor: 4, shards: 64, memory: '16GB', time: '~3min', description: 'Daily wallet' },
    { factor: 5, shards: 256, memory: '64GB', time: '~13min', description: 'Balanced' },
    { factor: 6, shards: 1024, memory: '256GB', time: '~50min', description: 'Secure' },
    { factor: 7, shards: 4096, memory: '1TB', time: '~3.5hr', description: 'Very secure' },
    { factor: 8, shards: 16384, memory: '4TB', time: '~14hr', description: 'Paranoid' },
    { factor: 9, shards: 65536, memory: '16TB', time: '~55hr', description: 'Ultra paranoid' },
  ];

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
  ];

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

  // Derivation state
  let workers: Worker[] = [];
  let workerCount = 1;
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
    try {
      const ctx = initAudio();
      if (ctx.state === 'suspended') ctx.resume();

      // Create mechanical click sound
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();
      const filter = ctx.createBiquadFilter();

      // Metallic click parameters
      oscillator.type = 'square';
      oscillator.frequency.setValueAtTime(800 + Math.random() * 200, ctx.currentTime);
      oscillator.frequency.exponentialRampToValueAtTime(200, ctx.currentTime + 0.05);

      // Low-pass filter for mechanical sound
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(2000, ctx.currentTime);
      filter.frequency.exponentialRampToValueAtTime(400, ctx.currentTime + 0.03);
      filter.Q.value = 2;

      // Quick decay envelope
      gainNode.gain.setValueAtTime(0.15 * intensity, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);

      oscillator.connect(filter);
      filter.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + 0.08);
    } catch (e) {
      // Audio not available, ignore
    }
  }

  function playVaultOpen() {
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
    if ('vibrate' in navigator) {
      if (pattern === 'tick') {
        navigator.vibrate(5);
      } else if (pattern === 'complete') {
        // Success pattern: short-pause-long
        navigator.vibrate([50, 100, 150]);
      }
    }
  }

  // Track tick activation for sound
  $: if (phase === 'deriving') {
    const currentActiveTick = Math.floor(progress / 2.78);
    if (currentActiveTick > lastActiveTick && currentActiveTick > 0) {
      // Play click for each new tick that activates
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
  $: gridCols = Math.ceil(Math.sqrt(shardCount));
  $: gridRows = Math.ceil(shardCount / gridCols);

  // ============================================================================
  // UTILITY FUNCTIONS
  // ============================================================================

  // Native SHA256 using Web Crypto API (browser built-in)
  async function sha256(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
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

    // Create workers
    workerCount = Math.min(
      navigator.hardwareConcurrency || 4,
      shardCount,
      8 // Cap at 8 workers to avoid memory issues
    );

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

      // Create workers
      workerCount = Math.min(
        navigator.hardwareConcurrency || 4,
        shardCount - shardsCompleted,
        8
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

  // Password manager
  async function deriveSitePassword() {
    if (!siteDomain.trim() || !masterKeyHex) return;

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
  });

  // Check for saved resume on mount + init i18n
  onMount(async () => {
    // Init i18n
    await initI18n();
    i18nReady = true;

    // Watch for locale changes
    const unsubscribe = locale.subscribe(async (loc) => {
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

    return () => unsubscribe();
  });

  // BIP39 wordlist
  function getBIP39Wordlist(): string[] {
    return ["abandon","ability","able","about","above","absent","absorb","abstract","absurd","abuse","access","accident","account","accuse","achieve","acid","acoustic","acquire","across","act","action","actor","actress","actual","adapt","add","addict","address","adjust","admit","adult","advance","advice","aerobic","affair","afford","afraid","again","age","agent","agree","ahead","aim","air","airport","aisle","alarm","album","alcohol","alert","alien","all","alley","allow","almost","alone","alpha","already","also","alter","always","amateur","amazing","among","amount","amused","analyst","anchor","ancient","anger","angle","angry","animal","ankle","announce","annual","another","answer","antenna","antique","anxiety","any","apart","apology","appear","apple","approve","april","arch","arctic","area","arena","argue","arm","armed","armor","army","around","arrange","arrest","arrive","arrow","art","artefact","artist","artwork","ask","aspect","assault","asset","assist","assume","asthma","athlete","atom","attack","attend","attitude","attract","auction","audit","august","aunt","author","auto","autumn","average","avocado","avoid","awake","aware","away","awesome","awful","awkward","axis","baby","bachelor","bacon","badge","bag","balance","balcony","ball","bamboo","banana","banner","bar","barely","bargain","barrel","base","basic","basket","battle","beach","bean","beauty","because","become","beef","before","begin","behave","behind","believe","below","belt","bench","benefit","best","betray","better","between","beyond","bicycle","bid","bike","bind","biology","bird","birth","bitter","black","blade","blame","blanket","blast","bleak","bless","blind","blood","blossom","blouse","blue","blur","blush","board","boat","body","boil","bomb","bone","bonus","book","boost","border","boring","borrow","boss","bottom","bounce","box","boy","bracket","brain","brand","brass","brave","bread","breeze","brick","bridge","brief","bright","bring","brisk","broccoli","broken","bronze","broom","brother","brown","brush","bubble","buddy","budget","buffalo","build","bulb","bulk","bullet","bundle","bunker","burden","burger","burst","bus","business","busy","butter","buyer","buzz","cabbage","cabin","cable","cactus","cage","cake","call","calm","camera","camp","can","canal","cancel","candy","cannon","canoe","canvas","canyon","capable","capital","captain","car","carbon","card","cargo","carpet","carry","cart","case","cash","casino","castle","casual","cat","catalog","catch","category","cattle","caught","cause","caution","cave","ceiling","celery","cement","census","century","cereal","certain","chair","chalk","champion","change","chaos","chapter","charge","chase","chat","cheap","check","cheese","chef","cherry","chest","chicken","chief","child","chimney","choice","choose","chronic","chuckle","chunk","churn","cigar","cinnamon","circle","citizen","city","civil","claim","clap","clarify","claw","clay","clean","clerk","clever","click","client","cliff","climb","clinic","clip","clock","clog","close","cloth","cloud","clown","club","clump","cluster","clutch","coach","coast","coconut","code","coffee","coil","coin","collect","color","column","combine","come","comfort","comic","common","company","concert","conduct","confirm","congress","connect","consider","control","convince","cook","cool","copper","copy","coral","core","corn","correct","cost","cotton","couch","country","couple","course","cousin","cover","coyote","crack","cradle","craft","cram","crane","crash","crater","crawl","crazy","cream","credit","creek","crew","cricket","crime","crisp","critic","crop","cross","crouch","crowd","crucial","cruel","cruise","crumble","crunch","crush","cry","crystal","cube","culture","cup","cupboard","curious","current","curtain","curve","cushion","custom","cute","cycle","dad","damage","damp","dance","danger","daring","dash","daughter","dawn","day","deal","debate","debris","decade","december","decide","decline","decorate","decrease","deer","defense","define","defy","degree","delay","deliver","demand","demise","denial","dentist","deny","depart","depend","deposit","depth","deputy","derive","describe","desert","design","desk","despair","destroy","detail","detect","develop","device","devote","diagram","dial","diamond","diary","dice","diesel","diet","differ","digital","dignity","dilemma","dinner","dinosaur","direct","dirt","disagree","discover","disease","dish","dismiss","disorder","display","distance","divert","divide","divorce","dizzy","doctor","document","dog","doll","dolphin","domain","donate","donkey","donor","door","dose","double","dove","draft","dragon","drama","drastic","draw","dream","dress","drift","drill","drink","drip","drive","drop","drum","dry","duck","dumb","dune","during","dust","dutch","duty","dwarf","dynamic","eager","eagle","early","earn","earth","easily","east","easy","echo","ecology","economy","edge","edit","educate","effort","egg","eight","either","elbow","elder","electric","elegant","element","elephant","elevator","elite","else","embark","embody","embrace","emerge","emotion","employ","empower","empty","enable","enact","end","endless","endorse","enemy","energy","enforce","engage","engine","enhance","enjoy","enlist","enough","enrich","enroll","ensure","enter","entire","entry","envelope","episode","equal","equip","era","erase","erode","erosion","error","erupt","escape","essay","essence","estate","eternal","ethics","evidence","evil","evoke","evolve","exact","example","excess","exchange","excite","exclude","excuse","execute","exercise","exhaust","exhibit","exile","exist","exit","exotic","expand","expect","expire","explain","expose","express","extend","extra","eye","eyebrow","fabric","face","faculty","fade","faint","faith","fall","false","fame","family","famous","fan","fancy","fantasy","farm","fashion","fat","fatal","father","fatigue","fault","favorite","feature","february","federal","fee","feed","feel","female","fence","festival","fetch","fever","few","fiber","fiction","field","figure","file","film","filter","final","find","fine","finger","finish","fire","firm","first","fiscal","fish","fit","fitness","fix","flag","flame","flash","flat","flavor","flee","flight","flip","float","flock","floor","flower","fluid","flush","fly","foam","focus","fog","foil","fold","follow","food","foot","force","forest","forget","fork","fortune","forum","forward","fossil","foster","found","fox","fragile","frame","frequent","fresh","friend","fringe","frog","front","frost","frown","frozen","fruit","fuel","fun","funny","furnace","fury","future","gadget","gain","galaxy","gallery","game","gap","garage","garbage","garden","garlic","garment","gas","gasp","gate","gather","gauge","gaze","general","genius","genre","gentle","genuine","gesture","ghost","giant","gift","giggle","ginger","giraffe","girl","give","glad","glance","glare","glass","glide","glimpse","globe","gloom","glory","glove","glow","glue","goat","goddess","gold","good","goose","gorilla","gospel","gossip","govern","gown","grab","grace","grain","grant","grape","grass","gravity","great","green","grid","grief","grit","grocery","group","grow","grunt","guard","guess","guide","guilt","guitar","gun","gym","habit","hair","half","hammer","hamster","hand","happy","harbor","hard","harsh","harvest","hat","have","hawk","hazard","head","health","heart","heavy","hedgehog","height","hello","helmet","help","hen","hero","hidden","high","hill","hint","hip","hire","history","hobby","hockey","hold","hole","holiday","hollow","home","honey","hood","hope","horn","horror","horse","hospital","host","hotel","hour","hover","hub","huge","human","humble","humor","hundred","hungry","hunt","hurdle","hurry","hurt","husband","hybrid","ice","icon","idea","identify","idle","ignore","ill","illegal","illness","image","imitate","immense","immune","impact","impose","improve","impulse","inch","include","income","increase","index","indicate","indoor","industry","infant","inflict","inform","inhale","inherit","initial","inject","injury","inmate","inner","innocent","input","inquiry","insane","insect","inside","inspire","install","intact","interest","into","invest","invite","involve","iron","island","isolate","issue","item","ivory","jacket","jaguar","jar","jazz","jealous","jeans","jelly","jewel","job","join","joke","journey","joy","judge","juice","jump","jungle","junior","junk","just","kangaroo","keen","keep","ketchup","key","kick","kid","kidney","kind","kingdom","kiss","kit","kitchen","kite","kitten","kiwi","knee","knife","knock","know","lab","label","labor","ladder","lady","lake","lamp","language","laptop","large","later","latin","laugh","laundry","lava","law","lawn","lawsuit","layer","lazy","leader","leaf","learn","leave","lecture","left","leg","legal","legend","leisure","lemon","lend","length","lens","leopard","lesson","letter","level","liar","liberty","library","license","life","lift","light","like","limb","limit","link","lion","liquid","list","little","live","lizard","load","loan","lobster","local","lock","logic","lonely","long","loop","lottery","loud","lounge","love","loyal","lucky","luggage","lumber","lunar","lunch","luxury","lyrics","machine","mad","magic","magnet","maid","mail","main","major","make","mammal","man","manage","mandate","mango","mansion","manual","maple","marble","march","margin","marine","market","marriage","mask","mass","master","match","material","math","matrix","matter","maximum","maze","meadow","mean","measure","meat","mechanic","medal","media","melody","melt","member","memory","mention","menu","mercy","merge","merit","merry","mesh","message","metal","method","middle","midnight","milk","million","mimic","mind","minimum","minor","minute","miracle","mirror","misery","miss","mistake","mix","mixed","mixture","mobile","model","modify","mom","moment","monitor","monkey","monster","month","moon","moral","more","morning","mosquito","mother","motion","motor","mountain","mouse","move","movie","much","muffin","mule","multiply","muscle","museum","mushroom","music","must","mutual","myself","mystery","myth","naive","name","napkin","narrow","nasty","nation","nature","near","neck","need","negative","neglect","neither","nephew","nerve","nest","net","network","neutral","never","news","next","nice","night","noble","noise","nominee","noodle","normal","north","nose","notable","note","nothing","notice","novel","now","nuclear","number","nurse","nut","oak","obey","object","oblige","obscure","observe","obtain","obvious","occur","ocean","october","odor","off","offer","office","often","oil","okay","old","olive","olympic","omit","once","one","onion","online","only","open","opera","opinion","oppose","option","orange","orbit","orchard","order","ordinary","organ","orient","original","orphan","ostrich","other","outdoor","outer","output","outside","oval","oven","over","own","owner","oxygen","oyster","ozone","pact","paddle","page","pair","palace","palm","panda","panel","panic","panther","paper","parade","parent","park","parrot","party","pass","patch","path","patient","patrol","pattern","pause","pave","payment","peace","peanut","pear","peasant","pelican","pen","penalty","pencil","people","pepper","perfect","permit","person","pet","phone","photo","phrase","physical","piano","picnic","picture","piece","pig","pigeon","pill","pilot","pink","pioneer","pipe","pistol","pitch","pizza","place","planet","plastic","plate","play","please","pledge","pluck","plug","plunge","poem","poet","point","polar","pole","police","pond","pony","pool","popular","portion","position","possible","post","potato","pottery","poverty","powder","power","practice","praise","predict","prefer","prepare","present","pretty","prevent","price","pride","primary","print","priority","prison","private","prize","problem","process","produce","profit","program","project","promote","proof","property","prosper","protect","proud","provide","public","pudding","pull","pulp","pulse","pumpkin","punch","pupil","puppy","purchase","purity","purpose","purse","push","put","puzzle","pyramid","quality","quantum","quarter","question","quick","quit","quiz","quote","rabbit","raccoon","race","rack","radar","radio","rail","rain","raise","rally","ramp","ranch","random","range","rapid","rare","rate","rather","raven","raw","razor","ready","real","reason","rebel","rebuild","recall","receive","recipe","record","recycle","reduce","reflect","reform","refuse","region","regret","regular","reject","relax","release","relief","rely","remain","remember","remind","remove","render","renew","rent","reopen","repair","repeat","replace","report","require","rescue","resemble","resist","resource","response","result","retire","retreat","return","reunion","reveal","review","reward","rhythm","rib","ribbon","rice","rich","ride","ridge","rifle","right","rigid","ring","riot","ripple","risk","ritual","rival","river","road","roast","robot","robust","rocket","romance","roof","rookie","room","rose","rotate","rough","round","route","royal","rubber","rude","rug","rule","run","runway","rural","sad","saddle","sadness","safe","sail","salad","salmon","salon","salt","salute","same","sample","sand","satisfy","satoshi","sauce","sausage","save","say","scale","scan","scare","scatter","scene","scheme","school","science","scissors","scorpion","scout","scrap","screen","script","scrub","sea","search","season","seat","second","secret","section","security","seed","seek","segment","select","sell","seminar","senior","sense","sentence","series","service","session","settle","setup","seven","shadow","shaft","shallow","share","shed","shell","sheriff","shield","shift","shine","ship","shiver","shock","shoe","shoot","shop","short","shoulder","shove","shrimp","shrug","shuffle","shy","sibling","sick","side","siege","sight","sign","silent","silk","silly","silver","similar","simple","since","sing","siren","sister","situate","six","size","skate","sketch","ski","skill","skin","skirt","skull","slab","slam","sleep","slender","slice","slide","slight","slim","slogan","slot","slow","slush","small","smart","smile","smoke","smooth","snack","snake","snap","sniff","snow","soap","soccer","social","sock","soda","soft","solar","soldier","solid","solution","solve","someone","song","soon","sorry","sort","soul","sound","soup","source","south","space","spare","spatial","spawn","speak","special","speed","spell","spend","sphere","spice","spider","spike","spin","spirit","split","spoil","sponsor","spoon","sport","spot","spray","spread","spring","spy","square","squeeze","squirrel","stable","stadium","staff","stage","stairs","stamp","stand","start","state","stay","steak","steel","stem","step","stereo","stick","still","sting","stock","stomach","stone","stool","story","stove","strategy","street","strike","strong","struggle","student","stuff","stumble","style","subject","submit","subway","success","such","sudden","suffer","sugar","suggest","suit","summer","sun","sunny","sunset","super","supply","supreme","sure","surface","surge","surprise","surround","survey","suspect","sustain","swallow","swamp","swap","swarm","swear","sweet","swift","swim","swing","switch","sword","symbol","symptom","syrup","system","table","tackle","tag","tail","talent","talk","tank","tape","target","task","taste","tattoo","taxi","teach","team","tell","ten","tenant","tennis","tent","term","test","text","thank","that","theme","then","theory","there","they","thing","this","thought","three","thrive","throw","thumb","thunder","ticket","tide","tiger","tilt","timber","time","tiny","tip","tired","tissue","title","toast","tobacco","today","toddler","toe","together","toilet","token","tomato","tomorrow","tone","tongue","tonight","tool","tooth","top","topic","topple","torch","tornado","tortoise","toss","total","tourist","toward","tower","town","toy","track","trade","traffic","tragic","train","transfer","trap","trash","travel","tray","treat","tree","trend","trial","tribe","trick","trigger","trim","trip","trophy","trouble","truck","true","truly","trumpet","trust","truth","try","tube","tuition","tumble","tuna","tunnel","turkey","turn","turtle","twelve","twenty","twice","twin","twist","two","type","typical","ugly","umbrella","unable","unaware","uncle","uncover","under","undo","unfair","unfold","unhappy","uniform","unique","unit","universe","unknown","unlock","until","unusual","unveil","update","upgrade","uphold","upon","upper","upset","urban","urge","usage","use","used","useful","useless","usual","utility","vacant","vacuum","vague","valid","valley","valve","van","vanish","vapor","various","vast","vault","vehicle","velvet","vendor","venture","venue","verb","verify","version","very","vessel","veteran","viable","vibrant","vicious","victory","video","view","village","vintage","violin","virtual","virus","visa","visit","visual","vital","vivid","vocal","voice","void","volcano","volume","vote","voyage","wage","wagon","wait","walk","wall","walnut","want","warfare","warm","warrior","wash","wasp","waste","water","wave","way","wealth","weapon","wear","weasel","weather","web","wedding","weekend","weird","welcome","west","wet","whale","what","wheat","wheel","when","where","whip","whisper","wide","width","wife","wild","will","win","window","wine","wing","wink","winner","winter","wire","wisdom","wise","wish","witness","wolf","woman","wonder","wood","wool","word","work","world","worry","worth","wrap","wreck","wrestle","wrist","write","wrong","yard","year","yellow","you","young","youth","zebra","zero","zone","zoo"];
  }
</script>

<div class="brainvault-container">
  <!-- Header -->
  <div class="header">
    <h1 class="wordmark">{t('vault.title')}</h1>
    <p class="tagline">{t('vault.tagline')}</p>
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
            <button class="resume-btn" on:click={loadResumeToken}>Resume</button>
            <button class="dismiss-btn" on:click={() => { showResumeInput = false; localStorage.removeItem('brainvault_resume'); }}>Dismiss</button>
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
            />
            <div class="factor-labels">
              <span>1</span>
              <span>9</span>
            </div>
          </div>
          <div class="factor-info">
            <span class="factor-level">{factorInfo.description}</span>
            <span class="factor-stats">{factorInfo.shards} shards · {factorInfo.memory} · ~{factorInfo.time}</span>
          </div>
        </div>

        <!-- Warning -->
        <div class="warning-box">
          <p><strong>This is permanent.</strong> Name + passphrase + security level = your wallet forever. No recovery possible.</p>
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
      <div class="vault-door-container" class:opening={progress >= 100}>
        <!-- Split door panels -->
        <div class="vault-split-left"></div>
        <div class="vault-split-right"></div>

        <!-- Vault Door Animation -->
        <div class="vault-door">
          <div class="vault-ring outer" style="--rotation: {progress * 3.6}deg"></div>
          <div class="vault-ring middle" style="--rotation: {-progress * 2.4}deg"></div>
          <div class="vault-ring inner" style="--rotation: {progress * 1.8}deg"></div>

          <!-- Shard segments - 8 pieces around the door -->
          <div class="shard-segments">
            {#each Array(shardCount) as _, i}
              <div
                class="shard-segment"
                class:pending={shardStatus[i] === 'pending'}
                class:computing={shardStatus[i] === 'computing'}
                class:complete={shardStatus[i] === 'complete'}
                style="--shard-angle: {i * (360 / shardCount)}deg; --shard-index: {i}"
              >
                <div class="shard-inner"></div>
              </div>
            {/each}
          </div>

          <div class="vault-center">
            <div class="vault-logo">◈</div>
          </div>
          <!-- Progress indicator dots around the ring -->
          <div class="vault-progress-ring">
            {#each Array(36) as _, i}
              <div
                class="vault-tick"
                class:active={i < Math.floor(progress / 2.78)}
                style="--angle: {i * 10}deg"
              ></div>
            {/each}
          </div>
        </div>

        <!-- Minimal text info -->
        <div class="vault-info">
          <div class="vault-progress-text">{Math.floor(progress)}%</div>
          <div class="vault-time">{formatDuration(remainingMs)}</div>
          <div class="vault-shards">{shardsCompleted}/{shardCount} shards</div>
        </div>

        <!-- Cancel - subtle -->
        <button class="vault-cancel" on:click={reset}>
          esc
        </button>
      </div>

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
                    <stop offset="0%" stop-color="#a855f7"/>
                    <stop offset="100%" stop-color="#06b6d4"/>
                  </linearGradient>
                </defs>
              </svg>
            </div>
          </div>
          <h2>Wallet Generated</h2>
          <p class="success-stats">{formatDuration(elapsedMs)} <span class="stat-divider">·</span> {shardCount} shards</p>
        </div>

        <!-- Address -->
        <div class="result-section">
          <label>Ethereum Address</label>
          <div class="result-box address">
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

        <!-- Password Manager -->
        <div class="result-section password-manager">
          <label>
            <span class="pm-icon">🔑</span> Password Manager
            <span class="label-hint">(derive unique passwords for any site)</span>
          </label>
          <div class="pm-input-row">
            <input
              type="text"
              placeholder="example.com"
              bind:value={siteDomain}
              on:keydown={(e) => e.key === 'Enter' && deriveSitePassword()}
            />
            <button on:click={deriveSitePassword}>Generate</button>
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
          {/if}
        </div>

        <!-- New Wallet Button -->
        <button class="derive-btn secondary" on:click={reset}>
          <span class="btn-icon">🔄</span>
          Derive Another Wallet
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
    padding: 40px 20px;
    background: linear-gradient(135deg, #0a0a1a 0%, #1a1a3a 50%, #0a0a1a 100%);
  }

  .header {
    text-align: center;
    margin-bottom: 40px;
  }

  .wordmark {
    font-size: 56px;
    font-weight: 200;
    letter-spacing: -0.02em;
    color: rgba(255, 255, 255, 0.95);
    margin: 0 0 8px 0;
  }

  .tagline {
    color: rgba(255, 255, 255, 0.5);
    font-size: 17px;
    font-weight: 400;
    margin: 0;
    letter-spacing: -0.01em;
  }

  .main-content {
    max-width: 600px;
    margin: 0 auto;
  }

  /* Glass Card */
  .glass-card {
    background: rgba(255, 255, 255, 0.05);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 24px;
    padding: 32px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  }

  /* Resume Banner */
  .resume-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    background: rgba(147, 51, 234, 0.2);
    border: 1px solid rgba(147, 51, 234, 0.3);
    border-radius: 12px;
    padding: 12px 16px;
    margin-bottom: 24px;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
  }

  .resume-icon {
    font-size: 20px;
  }

  .resume-btn, .dismiss-btn {
    padding: 6px 12px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .resume-btn {
    background: rgba(147, 51, 234, 0.4);
    border: 1px solid rgba(147, 51, 234, 0.5);
    color: white;
    margin-left: auto;
  }

  .resume-btn:hover {
    background: rgba(147, 51, 234, 0.6);
  }

  .dismiss-btn {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.2);
    color: rgba(255, 255, 255, 0.6);
  }

  .dismiss-btn:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  /* Input Groups */
  .input-group {
    margin-bottom: 28px;
  }

  .input-group label {
    display: block;
    font-size: 13px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
    margin-bottom: 4px;
    letter-spacing: 0.01em;
  }

  .input-hint {
    display: block;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.4);
    margin-bottom: 10px;
  }

  .input-wrapper {
    position: relative;
  }

  .input-wrapper input {
    width: 100%;
    padding: 14px 16px;
    background: rgba(0, 0, 0, 0.4);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    font-size: 16px;
    color: white;
    transition: all 0.2s;
    box-sizing: border-box;
  }

  .input-wrapper input:focus {
    outline: none;
    border-color: rgba(255, 255, 255, 0.2);
    background: rgba(0, 0, 0, 0.5);
  }

  .input-wrapper input::placeholder {
    color: rgba(255, 255, 255, 0.25);
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
    color: rgba(255, 255, 255, 0.4);
    transition: color 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .input-wrapper .toggle-visibility:hover {
    color: rgba(255, 255, 255, 0.7);
  }

  .input-wrapper:has(.toggle-visibility) input {
    padding-right: 48px;
  }

  /* Strength Meter */
  .strength-meter {
    height: 4px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 2px;
    margin-top: 8px;
    overflow: hidden;
  }

  .strength-bar {
    height: 100%;
    transition: all 0.3s;
    border-radius: 2px;
  }

  .strength-text {
    font-size: 12px;
    margin-top: 4px;
    display: block;
  }

  /* Factor Slider */
  .factor-slider-wrapper {
    padding: 8px 0;
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

  .factor-info {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-top: 12px;
  }

  .factor-level {
    font-size: 14px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.9);
  }

  .factor-stats {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.5);
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

  /* Derive Button */
  .derive-btn {
    width: 100%;
    padding: 16px;
    background: rgba(255, 255, 255, 0.9);
    border: none;
    border-radius: 12px;
    font-size: 17px;
    font-weight: 500;
    color: #000;
    cursor: pointer;
    transition: all 0.2s;
  }

  .derive-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 1);
  }

  .derive-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .derive-btn.secondary {
    background: rgba(255, 255, 255, 0.1);
    color: rgba(255, 255, 255, 0.9);
    margin-top: 24px;
  }

  .derive-btn.secondary:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
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
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 1000;
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

  /* Shard segments visualization */
  .shard-segments {
    position: absolute;
    inset: 20px;
    pointer-events: none;
  }

  .shard-segment {
    position: absolute;
    width: 50%;
    height: 50%;
    left: 50%;
    top: 50%;
    transform-origin: 0 0;
    transform: rotate(var(--shard-angle, 0deg));
    opacity: 0.3;
    transition: opacity 0.5s, filter 0.5s;
  }

  .shard-inner {
    position: absolute;
    width: 100%;
    height: 100%;
    background: conic-gradient(
      from 0deg,
      transparent 0deg,
      rgba(255, 255, 255, 0.03) 10deg,
      rgba(255, 255, 255, 0.08) 20deg,
      rgba(255, 255, 255, 0.03) 35deg,
      transparent 45deg
    );
    clip-path: polygon(0 0, 100% 0, 0 100%);
  }

  .shard-segment.pending {
    opacity: 0.1;
  }

  .shard-segment.computing {
    opacity: 0.6;
    animation: shard-compute 0.5s ease-in-out infinite alternate;
  }

  .shard-segment.complete {
    opacity: 1;
  }

  .shard-segment.complete .shard-inner {
    background: conic-gradient(
      from 0deg,
      transparent 0deg,
      rgba(255, 255, 255, 0.1) 10deg,
      rgba(255, 255, 255, 0.25) 20deg,
      rgba(255, 255, 255, 0.1) 35deg,
      transparent 45deg
    );
    filter: drop-shadow(0 0 8px rgba(255, 255, 255, 0.3));
  }

  @keyframes shard-compute {
    0% { opacity: 0.4; }
    100% { opacity: 0.8; }
  }

  .vault-shards {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.3);
    margin-top: 4px;
    letter-spacing: 1px;
  }

  /* Complete Phase - Liquid Glass Apple Style */
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
    background: radial-gradient(circle, rgba(139, 92, 246, 0.4) 0%, rgba(6, 182, 212, 0.2) 50%, transparent 70%);
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
      rgba(255, 255, 255, 0.15) 0%,
      rgba(255, 255, 255, 0.05) 50%,
      rgba(255, 255, 255, 0.1) 100%);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border: 1px solid rgba(255, 255, 255, 0.2);
    box-shadow:
      0 8px 32px rgba(139, 92, 246, 0.3),
      inset 0 1px 1px rgba(255, 255, 255, 0.3),
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
    background: linear-gradient(135deg, #e0e7ff 0%, #a5b4fc 50%, #818cf8 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin: 0 0 8px 0;
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }

  .success-stats {
    color: rgba(255, 255, 255, 0.5);
    margin: 0;
    font-size: 13px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }

  .stat-divider {
    opacity: 0.4;
    margin: 0 4px;
  }

  /* Result Sections */
  .result-section {
    margin-bottom: 24px;
  }

  .result-section > label {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin-bottom: 8px;
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
  }

  .result-box {
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 12px;
    padding: 14px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .result-box code {
    flex: 1;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 14px;
    color: rgba(255, 255, 255, 0.9);
    word-break: break-all;
  }

  .result-box code.blurred {
    filter: blur(4px);
    user-select: none;
  }

  .result-box.address code {
    color: #06b6d4;
  }

  .copy-btn, .toggle-btn {
    background: rgba(255, 255, 255, 0.1);
    border: none;
    border-radius: 8px;
    padding: 8px 12px;
    cursor: pointer;
    font-size: 16px;
    transition: all 0.2s;
    flex-shrink: 0;
  }

  .copy-btn:hover, .toggle-btn:hover {
    background: rgba(255, 255, 255, 0.2);
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
    padding: 12px;
    background: linear-gradient(135deg, rgba(147, 51, 234, 0.3), rgba(6, 182, 212, 0.3));
    border: 1px solid rgba(147, 51, 234, 0.3);
    border-radius: 8px;
    color: white;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .mnemonic-toggle button:hover {
    background: linear-gradient(135deg, rgba(147, 51, 234, 0.4), rgba(6, 182, 212, 0.4));
  }

  .mnemonic-words {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 8px;
    margin-top: 16px;
  }

  .word {
    background: rgba(255, 255, 255, 0.05);
    padding: 8px 10px;
    border-radius: 8px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.9);
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
  }

  .word-num {
    color: rgba(255, 255, 255, 0.4);
    margin-right: 4px;
    font-size: 11px;
  }

  .result-box.compact {
    flex-direction: row;
  }

  .result-box.compact code {
    font-size: 12px;
  }

  /* Password Manager */
  .password-manager {
    background: rgba(147, 51, 234, 0.1);
    border-radius: 16px;
    padding: 20px;
    margin-top: 32px;
  }

  .password-manager label {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .pm-icon {
    font-size: 20px;
  }

  .pm-input-row {
    display: flex;
    gap: 8px;
    margin-top: 12px;
  }

  .pm-input-row input {
    flex: 1;
    padding: 12px 14px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 10px;
    font-size: 14px;
    color: white;
  }

  .pm-input-row input:focus {
    outline: none;
    border-color: rgba(147, 51, 234, 0.5);
  }

  .pm-input-row button {
    padding: 12px 20px;
    background: rgba(147, 51, 234, 0.4);
    border: 1px solid rgba(147, 51, 234, 0.5);
    border-radius: 10px;
    color: white;
    font-size: 14px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .pm-input-row button:hover {
    background: rgba(147, 51, 234, 0.6);
  }

  .result-box.site-password {
    margin-top: 12px;
  }

  /* FAQ Section */
  .faq-section {
    margin-top: 48px;
  }

  .faq-section h3 {
    font-size: 20px;
    color: rgba(255, 255, 255, 0.9);
    margin-bottom: 20px;
  }

  .faq-item {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    margin-bottom: 8px;
    overflow: hidden;
    transition: all 0.2s;
  }

  .faq-item.expanded {
    background: rgba(255, 255, 255, 0.05);
    border-color: rgba(147, 51, 234, 0.3);
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
    color: rgba(255, 255, 255, 0.9);
    font-size: 15px;
    font-weight: 500;
    text-align: left;
  }

  .faq-toggle {
    font-size: 20px;
    color: rgba(255, 255, 255, 0.5);
    width: 24px;
    text-align: center;
  }

  .faq-answer {
    padding: 0 20px 16px;
  }

  .faq-answer p {
    margin: 0;
    font-size: 14px;
    line-height: 1.6;
    color: rgba(255, 255, 255, 0.7);
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
