/**
 * BrainVault v1.0 - Memory-Hard Brain Wallet
 *
 * Problem: Traditional mnemonics require secure storage (paper/hardware wallet).
 * Solution: Derive wallet from memorable (name + passphrase + shard count).
 *
 * Algorithm: Argon2id (memory-hard) + BLAKE3 (fast hash)
 * - Each shard: 256MB argon2id (forces attacker to use RAM, not just CPU)
 * - Parallelizable: phone sequential, workstation parallel
 * - Deterministic: same inputs = same wallet on any device
 *
 * Security: Attacker must compute shards one-by-one (256MB RAM minimum).
 * User with powerful hardware can parallelize (time advantage, not RAM advantage).
 *
 * FROZEN SPEC - DO NOT CHANGE PARAMETERS (breaks all existing wallets)
 */

import { blake3 } from '@noble/hashes/blake3.js';
import { sha256 } from '@noble/hashes/sha2.js';

// Constants - NEVER CHANGE THESE (changing = different wallet)
export const BRAINVAULT_V1 = {
  ALG_ID: 'brainvault/argon2id-sharded/v1.0',
  SHARD_MEMORY_KB: 256 * 1024,    // 256MB per shard
  ARGON_TIME_COST: 1,              // Single iteration per shard
  ARGON_PARALLELISM: 1,            // No internal parallelism (shards provide it)
  SHARD_OUTPUT_BYTES: 32,          // 256 bits per shard
  MIN_NAME_LENGTH: 1,
  MIN_PASSPHRASE_LENGTH: 6,
  MIN_FACTOR: 1,
  MAX_FACTOR: 9,
} as const;

/**
 * Calculate number of shards for a given factor
 * Formula: 10^(factor-1)
 *
 * Factor 1: 1 shard (256MB)
 * Factor 2: 10 shards (2.5GB)
 * Factor 3: 100 shards (25GB)
 * Factor 4: 1000 shards (256GB)
 * Factor 5: 10000 shards (2.5TB)
 */
export function getShardCount(factor: number): number {
  if (factor < BRAINVAULT_V1.MIN_FACTOR || factor > BRAINVAULT_V1.MAX_FACTOR) {
    throw new Error(`Factor must be ${BRAINVAULT_V1.MIN_FACTOR}-${BRAINVAULT_V1.MAX_FACTOR}`);
  }
  return Math.pow(10, factor - 1);
}

/**
 * Get total memory equivalent for display
 */
export function getTotalMemoryGB(factor: number): number {
  const shards = getShardCount(factor);
  return (shards * BRAINVAULT_V1.SHARD_MEMORY_KB) / (1024 * 1024); // KB to GB
}

/**
 * Estimate derivation time based on device capability
 */
export function estimateTime(factor: number, workersAvailable: number, msPerShard: number): {
  optimistic: number;  // With full parallelism
  sequential: number;  // Single worker
} {
  const shards = getShardCount(factor);
  const sequential = shards * msPerShard;
  const optimistic = Math.ceil(shards / workersAvailable) * msPerShard;
  return { optimistic, sequential };
}

/**
 * Format milliseconds to human readable
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
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

/**
 * Estimate password entropy in bits
 */
export function estimatePasswordStrength(password: string): {
  bits: number;
  rating: 'weak' | 'fair' | 'good' | 'strong' | 'excellent';
  message: string;
} {
  const charsets = {
    lowercase: /[a-z]/.test(password) ? 26 : 0,
    uppercase: /[A-Z]/.test(password) ? 26 : 0,
    digits: /\d/.test(password) ? 10 : 0,
    special: /[^a-zA-Z0-9]/.test(password) ? 33 : 0,
  };

  const poolSize = Object.values(charsets).reduce((a, b) => a + b, 0);
  const bits = poolSize > 0 ? Math.log2(poolSize) * password.length : 0;

  let rating: 'weak' | 'fair' | 'good' | 'strong' | 'excellent';
  let message: string;

  if (bits < 40) {
    rating = 'weak';
    message = 'Add more characters and variety';
  } else if (bits < 60) {
    rating = 'fair';
    message = 'Consider a longer passphrase';
  } else if (bits < 80) {
    rating = 'good';
    message = 'Decent for factor 3-5';
  } else if (bits < 100) {
    rating = 'strong';
    message = 'Good for factor 6-7';
  } else {
    rating = 'excellent';
    message = 'Excellent for any factor';
  }

  return { bits: Math.round(bits), rating, message };
}

/**
 * Validate inputs before derivation
 */
export function validateInputs(name: string, passphrase: string, factor: number): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (name.length < BRAINVAULT_V1.MIN_NAME_LENGTH) {
    errors.push(`Name must be at least ${BRAINVAULT_V1.MIN_NAME_LENGTH} characters`);
  }

  if (passphrase.length < BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH) {
    errors.push(`Passphrase must be at least ${BRAINVAULT_V1.MIN_PASSPHRASE_LENGTH} characters`);
  }

  if (factor < BRAINVAULT_V1.MIN_FACTOR || factor > BRAINVAULT_V1.MAX_FACTOR) {
    errors.push(`Factor must be between ${BRAINVAULT_V1.MIN_FACTOR} and ${BRAINVAULT_V1.MAX_FACTOR}`);
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// BROWSER IMPLEMENTATION (using hash-wasm)
// ============================================================================

/**
 * Browser-compatible derivation using hash-wasm
 * This is the main entry point for the frontend
 */
export interface DerivationProgress {
  phase: 'probing' | 'deriving' | 'finalizing' | 'complete';
  shardsCompleted: number;
  shardsTotal: number;
  currentWorkers: number;
  estimatedRemainingMs: number;
  shardResults: Map<number, Uint8Array>;
}

export interface DerivationResult {
  mnemonic24: string;        // Full 24 words (256-bit)
  mnemonic12: string;        // First 12 words (128-bit, for basic wallets)
  devicePassphrase: string;  // For hardware wallet hidden wallet
  ethereumAddress: string;   // Derived ETH address
  masterKeyHex: string;      // For password manager derivation
}


/**
 * Create salt for a specific shard
 * salt = BLAKE3(name_NFKD || ALG_ID || shardCount || shardIndex)
 */
export async function createShardSalt(
  name: string,
  shardIndex: number,
  shardCount: number
): Promise<Uint8Array> {
  const normalized = name.normalize('NFKD');
  const nameBytes = new TextEncoder().encode(normalized);
  const algIdBytes = new TextEncoder().encode(BRAINVAULT_V1.ALG_ID);
  const countBytes = new Uint8Array(4);
  new DataView(countBytes.buffer).setUint32(0, shardCount, false);
  const indexBytes = new Uint8Array(4);
  new DataView(indexBytes.buffer).setUint32(0, shardIndex, false);

  const combined = new Uint8Array(nameBytes.length + algIdBytes.length + 4 + 4);
  combined.set(nameBytes, 0);
  combined.set(algIdBytes, nameBytes.length);
  combined.set(countBytes, nameBytes.length + algIdBytes.length);
  combined.set(indexBytes, nameBytes.length + algIdBytes.length + 4);

  return blake3(combined);
}

/**
 * Derive a single shard (can be called from main thread or worker)
 */
export async function deriveShard(
  passphrase: string,
  shardSalt: Uint8Array
): Promise<Uint8Array> {
  const { argon2id } = await import('hash-wasm');
  const normalized = passphrase.normalize('NFKD');

  const result = await argon2id({
    password: normalized,
    salt: shardSalt,
    parallelism: BRAINVAULT_V1.ARGON_PARALLELISM,
    iterations: BRAINVAULT_V1.ARGON_TIME_COST,
    memorySize: BRAINVAULT_V1.SHARD_MEMORY_KB,
    hashLength: BRAINVAULT_V1.SHARD_OUTPUT_BYTES,
    outputType: 'binary',
  });

  return new Uint8Array(result);
}

/**
 * Combine all shards into master key using BLAKE3
 */
export async function combineShards(
  shardResults: Uint8Array[],
  factor: number
): Promise<Uint8Array> {
  // Concatenate all shards in order
  const totalLength = shardResults.reduce((sum, s) => sum + s.length, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const shard of shardResults) {
    combined.set(shard, offset);
    offset += shard.length;
  }

  // Domain-separated final hash (binds factor and KDF params)
  const shardCount = shardResults.length;
  const domainTag = `${BRAINVAULT_V1.ALG_ID}|mem=${BRAINVAULT_V1.SHARD_MEMORY_KB}|t=${BRAINVAULT_V1.ARGON_TIME_COST}|p=${BRAINVAULT_V1.ARGON_PARALLELISM}|out=${BRAINVAULT_V1.SHARD_OUTPUT_BYTES}|shards=${shardCount}|factor=${factor}`;
  const domainBytes = new TextEncoder().encode(domainTag);
  const withDomain = new Uint8Array(combined.length + domainBytes.length);
  withDomain.set(combined, 0);
  withDomain.set(domainBytes, combined.length);

  return blake3(withDomain);
}

/**
 * HKDF-like key derivation using BLAKE3
 */
export async function deriveKey(
  masterKey: Uint8Array,
  context: string,
  length: number = 32
): Promise<Uint8Array> {
  const contextBytes = new TextEncoder().encode(context);
  const input = new Uint8Array(masterKey.length + contextBytes.length);
  input.set(masterKey, 0);
  input.set(contextBytes, masterKey.length);

  // BLAKE3 can output variable length
  return blake3(input, { dkLen: length });
}

/**
 * Convert entropy to BIP39 mnemonic
 */
export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  // BIP39 wordlist (English)
  const wordlist = await getBIP39Wordlist();

  // Add checksum: SHA256 of entropy, take first entropy.length/32 bits
  const checksumHash = sha256(entropy);
  const checksumBits = bytesToBits(checksumHash).slice(0, entropy.length * 8 / 32);

  // Combine entropy bits + checksum bits
  const entropyBits = bytesToBits(entropy);
  const allBits = entropyBits + checksumBits;

  // Split into 11-bit chunks, each maps to a word
  const words: string[] = [];
  for (let i = 0; i < allBits.length; i += 11) {
    const chunk = allBits.slice(i, i + 11);
    const index = parseInt(chunk, 2);
    words.push(wordlist[index]!);
  }

  return words.join(' ');
}

/**
 * Derive Ethereum address from mnemonic + optional passphrase
 */
export async function deriveEthereumAddress(
  mnemonic: string,
  passphrase: string = ''
): Promise<string> {
  const { HDNodeWallet } = await import('ethers');
  const wallet = HDNodeWallet.fromPhrase(mnemonic, passphrase, "m/44'/60'/0'/0/0");
  return wallet.address;
}

/**
 * Derive site-specific password for password manager
 */
export async function deriveSitePassword(
  masterKeyHex: string,
  domain: string,
  length: number = 20
): Promise<string> {
  const masterKey = hexToBytes(masterKeyHex);
  const raw = await deriveKey(masterKey, `site-password:${domain}`, length * 2);

  // Convert to password with all character classes
  const lowers = 'abcdefghijklmnopqrstuvwxyz';
  const uppers = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits = '0123456789';
  const specials = '!@#$%^&*()-_=+[]{}:,./?';
  const all = lowers + uppers + digits + specials;

  // Ensure at least one of each class
  const password: string[] = [
    lowers[raw[0]! % lowers.length]!,
    uppers[raw[1]! % uppers.length]!,
    digits[raw[2]! % digits.length]!,
    specials[raw[3]! % specials.length]!,
  ];

  // Fill rest
  for (let i = 4; i < length; i++) {
    password.push(all[raw[i]! % all.length]!);
  }

  // Shuffle deterministically using remaining bytes
  for (let i = password.length - 1; i > 0; i--) {
    const j = raw[length + i]! % (i + 1);
    [password[i], password[j]] = [password[j]!, password[i]!];
  }

  return password.join('');
}


// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBits(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(2).padStart(8, '0')).join('');
}

function hexToBits(hex: string): string {
  return hex.split('').map(c => parseInt(c, 16).toString(2).padStart(4, '0')).join('');
}

// BIP39 English wordlist (lazy loaded)
let _wordlist: string[] | null = null;

async function getBIP39Wordlist(): Promise<string[]> {
  if (_wordlist) return _wordlist;

  // Standard BIP39 English wordlist
  _wordlist = [
    "abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse",
    "access", "accident", "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act",
    "action", "actor", "actress", "actual", "adapt", "add", "addict", "address", "adjust", "admit",
    "adult", "advance", "advice", "aerobic", "affair", "afford", "afraid", "again", "age", "agent",
    "agree", "ahead", "aim", "air", "airport", "aisle", "alarm", "album", "alcohol", "alert",
    "alien", "all", "alley", "allow", "almost", "alone", "alpha", "already", "also", "alter",
    "always", "amateur", "amazing", "among", "amount", "amused", "analyst", "anchor", "ancient", "anger",
    "angle", "angry", "animal", "ankle", "announce", "annual", "another", "answer", "antenna", "antique",
    "anxiety", "any", "apart", "apology", "appear", "apple", "approve", "april", "arch", "arctic",
    "area", "arena", "argue", "arm", "armed", "armor", "army", "around", "arrange", "arrest",
    "arrive", "arrow", "art", "artefact", "artist", "artwork", "ask", "aspect", "assault", "asset",
    "assist", "assume", "asthma", "athlete", "atom", "attack", "attend", "attitude", "attract", "auction",
    "audit", "august", "aunt", "author", "auto", "autumn", "average", "avocado", "avoid", "awake",
    "aware", "away", "awesome", "awful", "awkward", "axis", "baby", "bachelor", "bacon", "badge",
    "bag", "balance", "balcony", "ball", "bamboo", "banana", "banner", "bar", "barely", "bargain",
    "barrel", "base", "basic", "basket", "battle", "beach", "bean", "beauty", "because", "become",
    "beef", "before", "begin", "behave", "behind", "believe", "below", "belt", "bench", "benefit",
    "best", "betray", "better", "between", "beyond", "bicycle", "bid", "bike", "bind", "biology",
    "bird", "birth", "bitter", "black", "blade", "blame", "blanket", "blast", "bleak", "bless",
    "blind", "blood", "blossom", "blouse", "blue", "blur", "blush", "board", "boat", "body",
    "boil", "bomb", "bone", "bonus", "book", "boost", "border", "boring", "borrow", "boss",
    "bottom", "bounce", "box", "boy", "bracket", "brain", "brand", "brass", "brave", "bread",
    "breeze", "brick", "bridge", "brief", "bright", "bring", "brisk", "broccoli", "broken", "bronze",
    "broom", "brother", "brown", "brush", "bubble", "buddy", "budget", "buffalo", "build", "bulb",
    "bulk", "bullet", "bundle", "bunker", "burden", "burger", "burst", "bus", "business", "busy",
    "butter", "buyer", "buzz", "cabbage", "cabin", "cable", "cactus", "cage", "cake", "call",
    "calm", "camera", "camp", "can", "canal", "cancel", "candy", "cannon", "canoe", "canvas",
    "canyon", "capable", "capital", "captain", "car", "carbon", "card", "cargo", "carpet", "carry",
    "cart", "case", "cash", "casino", "castle", "casual", "cat", "catalog", "catch", "category",
    "cattle", "caught", "cause", "caution", "cave", "ceiling", "celery", "cement", "census", "century",
    "cereal", "certain", "chair", "chalk", "champion", "change", "chaos", "chapter", "charge", "chase",
    "chat", "cheap", "check", "cheese", "chef", "cherry", "chest", "chicken", "chief", "child",
    "chimney", "choice", "choose", "chronic", "chuckle", "chunk", "churn", "cigar", "cinnamon", "circle",
    "citizen", "city", "civil", "claim", "clap", "clarify", "claw", "clay", "clean", "clerk",
    "clever", "click", "client", "cliff", "climb", "clinic", "clip", "clock", "clog", "close",
    "cloth", "cloud", "clown", "club", "clump", "cluster", "clutch", "coach", "coast", "coconut",
    "code", "coffee", "coil", "coin", "collect", "color", "column", "combine", "come", "comfort",
    "comic", "common", "company", "concert", "conduct", "confirm", "congress", "connect", "consider", "control",
    "convince", "cook", "cool", "copper", "copy", "coral", "core", "corn", "correct", "cost",
    "cotton", "couch", "country", "couple", "course", "cousin", "cover", "coyote", "crack", "cradle",
    "craft", "cram", "crane", "crash", "crater", "crawl", "crazy", "cream", "credit", "creek",
    "crew", "cricket", "crime", "crisp", "critic", "crop", "cross", "crouch", "crowd", "crucial",
    "cruel", "cruise", "crumble", "crunch", "crush", "cry", "crystal", "cube", "culture", "cup",
    "cupboard", "curious", "current", "curtain", "curve", "cushion", "custom", "cute", "cycle", "dad",
    "damage", "damp", "dance", "danger", "daring", "dash", "daughter", "dawn", "day", "deal",
    "debate", "debris", "decade", "december", "decide", "decline", "decorate", "decrease", "deer", "defense",
    "define", "defy", "degree", "delay", "deliver", "demand", "demise", "denial", "dentist", "deny",
    "depart", "depend", "deposit", "depth", "deputy", "derive", "describe", "desert", "design", "desk",
    "despair", "destroy", "detail", "detect", "develop", "device", "devote", "diagram", "dial", "diamond",
    "diary", "dice", "diesel", "diet", "differ", "digital", "dignity", "dilemma", "dinner", "dinosaur",
    "direct", "dirt", "disagree", "discover", "disease", "dish", "dismiss", "disorder", "display", "distance",
    "divert", "divide", "divorce", "dizzy", "doctor", "document", "dog", "doll", "dolphin", "domain",
    "donate", "donkey", "donor", "door", "dose", "double", "dove", "draft", "dragon", "drama",
    "drastic", "draw", "dream", "dress", "drift", "drill", "drink", "drip", "drive", "drop",
    "drum", "dry", "duck", "dumb", "dune", "during", "dust", "dutch", "duty", "dwarf",
    "dynamic", "eager", "eagle", "early", "earn", "earth", "easily", "east", "easy", "echo",
    "ecology", "economy", "edge", "edit", "educate", "effort", "egg", "eight", "either", "elbow",
    "elder", "electric", "elegant", "element", "elephant", "elevator", "elite", "else", "embark", "embody",
    "embrace", "emerge", "emotion", "employ", "empower", "empty", "enable", "enact", "end", "endless",
    "endorse", "enemy", "energy", "enforce", "engage", "engine", "enhance", "enjoy", "enlist", "enough",
    "enrich", "enroll", "ensure", "enter", "entire", "entry", "envelope", "episode", "equal", "equip",
    "era", "erase", "erode", "erosion", "error", "erupt", "escape", "essay", "essence", "estate",
    "eternal", "ethics", "evidence", "evil", "evoke", "evolve", "exact", "example", "excess", "exchange",
    "excite", "exclude", "excuse", "execute", "exercise", "exhaust", "exhibit", "exile", "exist", "exit",
    "exotic", "expand", "expect", "expire", "explain", "expose", "express", "extend", "extra", "eye",
    "eyebrow", "fabric", "face", "faculty", "fade", "faint", "faith", "fall", "false", "fame",
    "family", "famous", "fan", "fancy", "fantasy", "farm", "fashion", "fat", "fatal", "father",
    "fatigue", "fault", "favorite", "feature", "february", "federal", "fee", "feed", "feel", "female",
    "fence", "festival", "fetch", "fever", "few", "fiber", "fiction", "field", "figure", "file",
    "film", "filter", "final", "find", "fine", "finger", "finish", "fire", "firm", "first",
    "fiscal", "fish", "fit", "fitness", "fix", "flag", "flame", "flash", "flat", "flavor",
    "flee", "flight", "flip", "float", "flock", "floor", "flower", "fluid", "flush", "fly",
    "foam", "focus", "fog", "foil", "fold", "follow", "food", "foot", "force", "forest",
    "forget", "fork", "fortune", "forum", "forward", "fossil", "foster", "found", "fox", "fragile",
    "frame", "frequent", "fresh", "friend", "fringe", "frog", "front", "frost", "frown", "frozen",
    "fruit", "fuel", "fun", "funny", "furnace", "fury", "future", "gadget", "gain", "galaxy",
    "gallery", "game", "gap", "garage", "garbage", "garden", "garlic", "garment", "gas", "gasp",
    "gate", "gather", "gauge", "gaze", "general", "genius", "genre", "gentle", "genuine", "gesture",
    "ghost", "giant", "gift", "giggle", "ginger", "giraffe", "girl", "give", "glad", "glance",
    "glare", "glass", "glide", "glimpse", "globe", "gloom", "glory", "glove", "glow", "glue",
    "goat", "goddess", "gold", "good", "goose", "gorilla", "gospel", "gossip", "govern", "gown",
    "grab", "grace", "grain", "grant", "grape", "grass", "gravity", "great", "green", "grid",
    "grief", "grit", "grocery", "group", "grow", "grunt", "guard", "guess", "guide", "guilt",
    "guitar", "gun", "gym", "habit", "hair", "half", "hammer", "hamster", "hand", "happy",
    "harbor", "hard", "harsh", "harvest", "hat", "have", "hawk", "hazard", "head", "health",
    "heart", "heavy", "hedgehog", "height", "hello", "helmet", "help", "hen", "hero", "hidden",
    "high", "hill", "hint", "hip", "hire", "history", "hobby", "hockey", "hold", "hole",
    "holiday", "hollow", "home", "honey", "hood", "hope", "horn", "horror", "horse", "hospital",
    "host", "hotel", "hour", "hover", "hub", "huge", "human", "humble", "humor", "hundred",
    "hungry", "hunt", "hurdle", "hurry", "hurt", "husband", "hybrid", "ice", "icon", "idea",
    "identify", "idle", "ignore", "ill", "illegal", "illness", "image", "imitate", "immense", "immune",
    "impact", "impose", "improve", "impulse", "inch", "include", "income", "increase", "index", "indicate",
    "indoor", "industry", "infant", "inflict", "inform", "inhale", "inherit", "initial", "inject", "injury",
    "inmate", "inner", "innocent", "input", "inquiry", "insane", "insect", "inside", "inspire", "install",
    "intact", "interest", "into", "invest", "invite", "involve", "iron", "island", "isolate", "issue",
    "item", "ivory", "jacket", "jaguar", "jar", "jazz", "jealous", "jeans", "jelly", "jewel",
    "job", "join", "joke", "journey", "joy", "judge", "juice", "jump", "jungle", "junior",
    "junk", "just", "kangaroo", "keen", "keep", "ketchup", "key", "kick", "kid", "kidney",
    "kind", "kingdom", "kiss", "kit", "kitchen", "kite", "kitten", "kiwi", "knee", "knife",
    "knock", "know", "lab", "label", "labor", "ladder", "lady", "lake", "lamp", "language",
    "laptop", "large", "later", "latin", "laugh", "laundry", "lava", "law", "lawn", "lawsuit",
    "layer", "lazy", "leader", "leaf", "learn", "leave", "lecture", "left", "leg", "legal",
    "legend", "leisure", "lemon", "lend", "length", "lens", "leopard", "lesson", "letter", "level",
    "liar", "liberty", "library", "license", "life", "lift", "light", "like", "limb", "limit",
    "link", "lion", "liquid", "list", "little", "live", "lizard", "load", "loan", "lobster",
    "local", "lock", "logic", "lonely", "long", "loop", "lottery", "loud", "lounge", "love",
    "loyal", "lucky", "luggage", "lumber", "lunar", "lunch", "luxury", "lyrics", "machine", "mad",
    "magic", "magnet", "maid", "mail", "main", "major", "make", "mammal", "man", "manage",
    "mandate", "mango", "mansion", "manual", "maple", "marble", "march", "margin", "marine", "market",
    "marriage", "mask", "mass", "master", "match", "material", "math", "matrix", "matter", "maximum",
    "maze", "meadow", "mean", "measure", "meat", "mechanic", "medal", "media", "melody", "melt",
    "member", "memory", "mention", "menu", "mercy", "merge", "merit", "merry", "mesh", "message",
    "metal", "method", "middle", "midnight", "milk", "million", "mimic", "mind", "minimum", "minor",
    "minute", "miracle", "mirror", "misery", "miss", "mistake", "mix", "mixed", "mixture", "mobile",
    "model", "modify", "mom", "moment", "monitor", "monkey", "monster", "month", "moon", "moral",
    "more", "morning", "mosquito", "mother", "motion", "motor", "mountain", "mouse", "move", "movie",
    "much", "muffin", "mule", "multiply", "muscle", "museum", "mushroom", "music", "must", "mutual",
    "myself", "mystery", "myth", "naive", "name", "napkin", "narrow", "nasty", "nation", "nature",
    "near", "neck", "need", "negative", "neglect", "neither", "nephew", "nerve", "nest", "net",
    "network", "neutral", "never", "news", "next", "nice", "night", "noble", "noise", "nominee",
    "noodle", "normal", "north", "nose", "notable", "note", "nothing", "notice", "novel", "now",
    "nuclear", "number", "nurse", "nut", "oak", "obey", "object", "oblige", "obscure", "observe",
    "obtain", "obvious", "occur", "ocean", "october", "odor", "off", "offer", "office", "often",
    "oil", "okay", "old", "olive", "olympic", "omit", "once", "one", "onion", "online",
    "only", "open", "opera", "opinion", "oppose", "option", "orange", "orbit", "orchard", "order",
    "ordinary", "organ", "orient", "original", "orphan", "ostrich", "other", "outdoor", "outer", "output",
    "outside", "oval", "oven", "over", "own", "owner", "oxygen", "oyster", "ozone", "pact",
    "paddle", "page", "pair", "palace", "palm", "panda", "panel", "panic", "panther", "paper",
    "parade", "parent", "park", "parrot", "party", "pass", "patch", "path", "patient", "patrol",
    "pattern", "pause", "pave", "payment", "peace", "peanut", "pear", "peasant", "pelican", "pen",
    "penalty", "pencil", "people", "pepper", "perfect", "permit", "person", "pet", "phone", "photo",
    "phrase", "physical", "piano", "picnic", "picture", "piece", "pig", "pigeon", "pill", "pilot",
    "pink", "pioneer", "pipe", "pistol", "pitch", "pizza", "place", "planet", "plastic", "plate",
    "play", "please", "pledge", "pluck", "plug", "plunge", "poem", "poet", "point", "polar",
    "pole", "police", "pond", "pony", "pool", "popular", "portion", "position", "possible", "post",
    "potato", "pottery", "poverty", "powder", "power", "practice", "praise", "predict", "prefer", "prepare",
    "present", "pretty", "prevent", "price", "pride", "primary", "print", "priority", "prison", "private",
    "prize", "problem", "process", "produce", "profit", "program", "project", "promote", "proof", "property",
    "prosper", "protect", "proud", "provide", "public", "pudding", "pull", "pulp", "pulse", "pumpkin",
    "punch", "pupil", "puppy", "purchase", "purity", "purpose", "purse", "push", "put", "puzzle",
    "pyramid", "quality", "quantum", "quarter", "question", "quick", "quit", "quiz", "quote", "rabbit",
    "raccoon", "race", "rack", "radar", "radio", "rail", "rain", "raise", "rally", "ramp",
    "ranch", "random", "range", "rapid", "rare", "rate", "rather", "raven", "raw", "razor",
    "ready", "real", "reason", "rebel", "rebuild", "recall", "receive", "recipe", "record", "recycle",
    "reduce", "reflect", "reform", "refuse", "region", "regret", "regular", "reject", "relax", "release",
    "relief", "rely", "remain", "remember", "remind", "remove", "render", "renew", "rent", "reopen",
    "repair", "repeat", "replace", "report", "require", "rescue", "resemble", "resist", "resource", "response",
    "result", "retire", "retreat", "return", "reunion", "reveal", "review", "reward", "rhythm", "rib",
    "ribbon", "rice", "rich", "ride", "ridge", "rifle", "right", "rigid", "ring", "riot",
    "ripple", "risk", "ritual", "rival", "river", "road", "roast", "robot", "robust", "rocket",
    "romance", "roof", "rookie", "room", "rose", "rotate", "rough", "round", "route", "royal",
    "rubber", "rude", "rug", "rule", "run", "runway", "rural", "sad", "saddle", "sadness",
    "safe", "sail", "salad", "salmon", "salon", "salt", "salute", "same", "sample", "sand",
    "satisfy", "satoshi", "sauce", "sausage", "save", "say", "scale", "scan", "scare", "scatter",
    "scene", "scheme", "school", "science", "scissors", "scorpion", "scout", "scrap", "screen", "script",
    "scrub", "sea", "search", "season", "seat", "second", "secret", "section", "security", "seed",
    "seek", "segment", "select", "sell", "seminar", "senior", "sense", "sentence", "series", "service",
    "session", "settle", "setup", "seven", "shadow", "shaft", "shallow", "share", "shed", "shell",
    "sheriff", "shield", "shift", "shine", "ship", "shiver", "shock", "shoe", "shoot", "shop",
    "short", "shoulder", "shove", "shrimp", "shrug", "shuffle", "shy", "sibling", "sick", "side",
    "siege", "sight", "sign", "silent", "silk", "silly", "silver", "similar", "simple", "since",
    "sing", "siren", "sister", "situate", "six", "size", "skate", "sketch", "ski", "skill",
    "skin", "skirt", "skull", "slab", "slam", "sleep", "slender", "slice", "slide", "slight",
    "slim", "slogan", "slot", "slow", "slush", "small", "smart", "smile", "smoke", "smooth",
    "snack", "snake", "snap", "sniff", "snow", "soap", "soccer", "social", "sock", "soda",
    "soft", "solar", "soldier", "solid", "solution", "solve", "someone", "song", "soon", "sorry",
    "sort", "soul", "sound", "soup", "source", "south", "space", "spare", "spatial", "spawn",
    "speak", "special", "speed", "spell", "spend", "sphere", "spice", "spider", "spike", "spin",
    "spirit", "split", "spoil", "sponsor", "spoon", "sport", "spot", "spray", "spread", "spring",
    "spy", "square", "squeeze", "squirrel", "stable", "stadium", "staff", "stage", "stairs", "stamp",
    "stand", "start", "state", "stay", "steak", "steel", "stem", "step", "stereo", "stick",
    "still", "sting", "stock", "stomach", "stone", "stool", "story", "stove", "strategy", "street",
    "strike", "strong", "struggle", "student", "stuff", "stumble", "style", "subject", "submit", "subway",
    "success", "such", "sudden", "suffer", "sugar", "suggest", "suit", "summer", "sun", "sunny",
    "sunset", "super", "supply", "supreme", "sure", "surface", "surge", "surprise", "surround", "survey",
    "suspect", "sustain", "swallow", "swamp", "swap", "swarm", "swear", "sweet", "swift", "swim",
    "swing", "switch", "sword", "symbol", "symptom", "syrup", "system", "table", "tackle", "tag",
    "tail", "talent", "talk", "tank", "tape", "target", "task", "taste", "tattoo", "taxi",
    "teach", "team", "tell", "ten", "tenant", "tennis", "tent", "term", "test", "text",
    "thank", "that", "theme", "then", "theory", "there", "they", "thing", "this", "thought",
    "three", "thrive", "throw", "thumb", "thunder", "ticket", "tide", "tiger", "tilt", "timber",
    "time", "tiny", "tip", "tired", "tissue", "title", "toast", "tobacco", "today", "toddler",
    "toe", "together", "toilet", "token", "tomato", "tomorrow", "tone", "tongue", "tonight", "tool",
    "tooth", "top", "topic", "topple", "torch", "tornado", "tortoise", "toss", "total", "tourist",
    "toward", "tower", "town", "toy", "track", "trade", "traffic", "tragic", "train", "transfer",
    "trap", "trash", "travel", "tray", "treat", "tree", "trend", "trial", "tribe", "trick",
    "trigger", "trim", "trip", "trophy", "trouble", "truck", "true", "truly", "trumpet", "trust",
    "truth", "try", "tube", "tuition", "tumble", "tuna", "tunnel", "turkey", "turn", "turtle",
    "twelve", "twenty", "twice", "twin", "twist", "two", "type", "typical", "ugly", "umbrella",
    "unable", "unaware", "uncle", "uncover", "under", "undo", "unfair", "unfold", "unhappy", "uniform",
    "unique", "unit", "universe", "unknown", "unlock", "until", "unusual", "unveil", "update", "upgrade",
    "uphold", "upon", "upper", "upset", "urban", "urge", "usage", "use", "used", "useful",
    "useless", "usual", "utility", "vacant", "vacuum", "vague", "valid", "valley", "valve", "van",
    "vanish", "vapor", "various", "vast", "vault", "vehicle", "velvet", "vendor", "venture", "venue",
    "verb", "verify", "version", "very", "vessel", "veteran", "viable", "vibrant", "vicious", "victory",
    "video", "view", "village", "vintage", "violin", "virtual", "virus", "visa", "visit", "visual",
    "vital", "vivid", "vocal", "voice", "void", "volcano", "volume", "vote", "voyage", "wage",
    "wagon", "wait", "walk", "wall", "walnut", "want", "warfare", "warm", "warrior", "wash",
    "wasp", "waste", "water", "wave", "way", "wealth", "weapon", "wear", "weasel", "weather",
    "web", "wedding", "weekend", "weird", "welcome", "west", "wet", "whale", "what", "wheat",
    "wheel", "when", "where", "whip", "whisper", "wide", "width", "wife", "wild", "will",
    "win", "window", "wine", "wing", "wink", "winner", "winter", "wire", "wisdom", "wise",
    "wish", "witness", "wolf", "woman", "wonder", "wood", "wool", "word", "work", "world",
    "worry", "worth", "wrap", "wreck", "wrestle", "wrist", "write", "wrong", "yard", "year",
    "yellow", "you", "young", "youth", "zebra", "zero", "zone", "zoo"
  ];

  return _wordlist;
}
