#!/usr/bin/env node

import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import argon2 from 'argon2';
import crypto from 'crypto';
import bip39 from 'bip39';
import os from 'os';

const ALG_ID = 'brainvault/argon2id/v1.0';
const WORDLIST = 'english';
const SHOW_PASSPHRASE = process.argv.includes('--show-passphrase');

function printIntro() {
  console.log(
`--- WHY BRAINVALT EXISTS ---
Regular mnemonic backups (12–24 words) are brittle: lose them—funds gone; write them—anyone can steal.
The "backup" becomes the weakest link.

HISTORY
brainwallet.io gave brain-based wallets a bad name: single MD5 round, no public salt—trivially crackable.
WarpWallet (Keybase) improved it with scrypt + email + password and public bounties (never hacked):
https://keybase.io/warp/warp_1.0.9_SHA256_a2067491ab582bde779f4505055807c2479354633a2216b22cf1e92d1a6e4a87.html
BrainVault takes the lessons and fixes the UX: one master secret -> Argon2id (memory-hard) -> HKDF -> BIP39 + device passphrase.
Weak passwords are slowed automatically (1..5). Factor 1..10 sets time; memory is fixed in GB for reproducible recovery.
No mandatory paper: easy to store in your head, but you can also write it once if you prefer.

COMPAT + RECOVERY
Keep parameters IDENTICAL to recover anywhere: email, MEMORY (GB), FACTOR (1..10).
Changing memory or factor = DIFFERENT wallet. Enter passphrase ON THE DEVICE (e.g., Ledger "Attach to PIN").`
  );
}

// ---------- utils
const toBuf = (x)=>Buffer.isBuffer(x)?x:
  x instanceof Uint8Array?Buffer.from(x.buffer,x.byteOffset,x.byteLength):
  x instanceof ArrayBuffer?Buffer.from(x):
  typeof x==='string'?Buffer.from(x,'utf8'):
  (()=>{throw new TypeError('Unsupported buffer-like')})();

const clamp   = (x,lo,hi)=>Math.max(lo,Math.min(hi,x));
const GiBtoMiB= (g)=>Math.max(1, Math.round(parseFloat(g||'1')*1024));
const fmtMS   = (s)=>`${Math.floor(s/60)}m ${String(Math.floor(s%60)).padStart(2,'0')}s`;
const bar     = (pct,w=28)=>`[${'█'.repeat(Math.round(pct*w)).padEnd(w,' ')}] ${Math.round(pct*100)}%`;
const b64url  = (buf)=>Buffer.from(buf).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromB64url=(s)=>Buffer.from(s.replace(/-/g,'+').replace(/_/g,'/'),'base64');

// format derivation duration as m/s/ms
function fmtDerivDuration(ms){
  if (ms >= 60000) {
    const m = Math.floor(ms / 60000);
    const s = Math.round((ms % 60000) / 1000);
    return `${m}m ${s}s`;
  }
  if (ms >= 1000) return `${(ms/1000).toFixed(2)}s`;
  return `${ms} ms`;
}

// ANSI 2-line TUI helpers
const ESC = '\x1b[';
function clearLine(){ process.stdout.write(ESC + '2K'); }
function cursorUp(n=1){ process.stdout.write(ESC + n + 'A'); }
function cursorDown(n=1){ process.stdout.write(ESC + n + 'B'); }
function carriage(){ process.stdout.write('\r'); }

let peakRssMiB = 0;
function memStatus(requestMiB){
  const rssMiB = Math.round(process.memoryUsage().rss / (1024*1024));
  peakRssMiB = Math.max(peakRssMiB, rssMiB);
  const freeGiB = Math.round(os.freemem() / (1024**3));
  return `req=${requestMiB}MiB rss=${rssMiB}MiB peak=${peakRssMiB}MiB free≈${freeGiB}GiB`;
}

let tuiOpened = false;
function renderTUI(progressLine, resumeLine) {
  if (!tuiOpened) { process.stdout.write('\n\n'); tuiOpened = true; }
  cursorUp(2);
  clearLine(); carriage(); process.stdout.write(progressLine);
  cursorDown(1);
  clearLine(); carriage(); process.stdout.write(resumeLine);
  cursorDown(1);
}

function estimatePwBits(pw){
  const sets={d:/\d/, l:/[a-z]/, u:/[A-Z]/, s:/[^0-9a-zA-Z]/};
  let charset=0; if(sets.d.test(pw))charset+=10; if(sets.l.test(pw))charset+=26;
  if(sets.u.test(pw))charset+=26; if(sets.s.test(pw))charset+=33;
  return charset?Math.log2(charset)*pw.length:0;
}
// slowdown 1..5 (smaller=faster). >=120b→1, <=20b→5.
function bitsToSlowdown(bits){
  const s = 5 - Math.floor((bits - 20) / 20);
  return clamp(isFinite(s)?s:5, 1, 5);
}

// HKDF-SHA256: prefer native; fallback when unavailable (e.g., Bun)
function hkdf(info, key, len=32){
  if (typeof crypto.hkdfSync === 'function') {
    return crypto.hkdfSync('sha256', toBuf(key), Buffer.alloc(0), Buffer.from(info,'utf8'), len);
  }
  const ikm = toBuf(key);
  const salt = Buffer.alloc(0); // empty salt to match current behavior
  const infoBuf = Buffer.from(info, 'utf8');
  const prk = crypto.createHmac('sha256', salt).update(ikm).digest();
  const hashLen = 32;
  const blocks = Math.ceil(len / hashLen);
  let t = Buffer.alloc(0);
  const out = [];
  for (let i = 1; i <= blocks; i++) {
    t = crypto.createHmac('sha256', prk)
      .update(Buffer.concat([t, infoBuf, Buffer.from([i])]))
      .digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, len);
}
function emailHash(email){ return crypto.createHash('sha256').update(toBuf(email)).digest(); }
function makeSalt(emailHashBuf, idx){
  const h = crypto.createHash('sha256');
  h.update(emailHashBuf); h.update('|'); h.update(ALG_ID); h.update('|'); h.update(String(idx));
  return h.digest();
}
async function argon(inputKey, salt, { memoryMiB, timeCost, rawOut=false }){
  return argon2.hash(toBuf(inputKey), {
    type: argon2.argon2id,
    salt: toBuf(salt),
    memoryCost: memoryMiB * 1024,
    timeCost,
    parallelism: 1,
    hashLength: 32,
    raw: rawOut
  });
}
function passphraseFromK(K){ return crypto.createHash('sha256').update(toBuf(K)).digest('hex'); }

// deterministic site passwords (20 chars; includes all classes)
function sitePassword(domain, masterKey, length=20){
  if(!domain || !domain.length) return null;
  const lowers='abcdefghijklmnopqrstuvwxyz';
  const uppers='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const digits='0123456789';
  const specials='!@#$%^&*()-_=+[]{}:,./?';
  const sets=[lowers, uppers, digits, specials];
  const bytes = hkdf(`pw/site:${domain}`, masterKey, length*4);
  let out = sets.map((set,i)=> set[ bytes[i] % set.length ]);
  let idx=sets.length;
  while(out.length<length){
    const set = sets[ bytes[idx] % sets.length ];
    out.push( set[ bytes[idx+1] % set.length ] );
    idx+=2;
  }
  const shuf = hkdf(`pw/site:${domain}/shuffle`, masterKey, length);
  for(let i=length-1;i>0;i--){
    const r = shuf[i] % (i+1);
    [out[i],out[r]]=[out[r],out[i]];
  }
  return out.join('');
}

// resume token: version | memMiB | totalChunks | doneChunks | emailHashB64 | Khex
function makeToken(memMiB, totalChunks, doneChunks, emailHashBuf, Khex){
  return `bv1|${memMiB}|${totalChunks}|${doneChunks}|${b64url(emailHashBuf)}|${Khex}`;
}
function parseToken(tok){
  const p = tok.split('|');
  if(p.length!==6 || p[0]!=='bv1') throw new Error('Bad resume token');
  const memMiB = parseInt(p[1],10);
  const total  = parseInt(p[2],10);
  const done   = parseInt(p[3],10);
  const ehash  = fromB64url(p[4]);
  const Khex   = p[5];
  if(!Number.isFinite(memMiB) || !Number.isFinite(total) || !Number.isFinite(done)) throw new Error('Bad token numbers');
  return { memMiB, total, done, ehash, Khex };
}

// prompts
async function askEmailPwMem(){
  const rl = readline.createInterface({ input, output });
  const totalGiB = Math.max(1, Math.floor(os.totalmem() / (1024**3)));
  const suggestedGiB = Math.max(1, Math.floor(totalGiB * 2 / 3));
  const email = (await rl.question('\nEmail (public salt, >=4 chars): ')).trim();
  if(email.length < 4){ console.error('Email/public salt too short.'); process.exit(1); }
  const password = await rl.question('Password (private pepper, >=6 chars): ');
  if(password.length < 6){ console.error('Password too short.'); process.exit(1); }
  const memAns = (await rl.question(`Memory in GB (fixed forever). ENTER = ~2/3 of your RAM (${suggestedGiB} GB): `)).trim();
  await rl.close();
  const memoryGiB = memAns === '' ? suggestedGiB : parseFloat(memAns);
  if(!isFinite(memoryGiB) || memoryGiB <= 0){ console.error('Invalid memory GB.'); process.exit(1); }
  return { email, password, memoryGiB };
}

async function chooseFactor(){
  while(true){
    const rl = readline.createInterface({ input, output });
    const ans = (await rl.question('\nChoose FACTOR 1–10 (or type "again" to restart): ')).trim();
    await rl.close();
    if(ans.toLowerCase()==='again') return 'again';
    if(/^\d+$/.test(ans)){
      const n=parseInt(ans,10);
      if(n>=1 && n<=10) return n;
    }
    console.log('Invalid — must be integer 1..10. Try again.');
  }
}

// target seconds per factor (f1 demo=instant; f2≈5s; f3≈20s; doubling)
function targetSecondsForFactor(f){
  if(f===1) return 0;
  if(f===2) return 5;
  if(f===3) return 20;
  return 20 * (2 ** (f-3));
}

async function runFresh(){
  printIntro();

  const { email, password, memoryGiB } = await askEmailPwMem();
  const memMiB = GiBtoMiB(memoryGiB);
  const ehash = emailHash(email);
  const pwBits = estimatePwBits(password);
  const slowdown = bitsToSlowdown(pwBits);

  process.stdout.write('\n[BrainVault] Probing chunk time (timeCost=1 @ full memory)... ');
  const t0 = Date.now(); await argon(password, makeSalt(ehash, 0), { memoryMiB: memMiB, timeCost: 1, rawOut: true });
  const chunkSec = Math.max(0.05, (Date.now()-t0)/1000);
  process.stdout.write('done\n');

  console.log(`\nPassword strength ~${pwBits.toFixed(1)} bits -> slowdown x${slowdown}`);
  console.log(`Memory fixed at ${memoryGiB} GB (${memMiB} MiB). Changing this later changes the wallet.\n`);

  console.log('Suggested factors (1..10) — ETA at THIS memory:\n');
  for(let f=1; f<=10; f++){
    const target = targetSecondsForFactor(f);
    const chunks = f===1 ? 1 : Math.max(2, Math.round((target * slowdown) / chunkSec));
    const legend = f===1?'(demo, insecure)' : f===5?'(balanced)' : f===10?'(slow but PARANOID)' : '';
    console.log(` ${String(f).padStart(2)}: ~${fmtMS(chunks * chunkSec)}  chunks=${chunks} ${legend}`);
  }

  const factor = await chooseFactor();
  if(factor==='again'){ console.log('\nRestarting...\n'); return runFresh(); }

  const target = targetSecondsForFactor(factor);
  const total = factor===1 ? 1 : Math.max(2, Math.round((target * slowdown) / chunkSec));

  console.log(`\n[BrainVault] Starting ${total} chunks @ ${memoryGiB} GB (Ctrl+C anytime; resume command printed below)`);

  let Kprev = toBuf(password);
  let done = 0;
  let avg = chunkSec;
  let resumeMsg = '';

  // open TUI area
  renderTUI('Preparing...', ' ');

  const tDeriveStart = Date.now();
  while(done < total){
    const salt = makeSalt(ehash, done);
    const tS = Date.now();
    const K = await argon(Kprev, salt, { memoryMiB: memMiB, timeCost: 1, rawOut: true });
    const sec = (Date.now()-tS)/1000;
    avg = avg*0.5 + sec*0.5;
    done += 1;
    Kprev = K;

    const pct = done/total;
    const remain = (total - done) * avg;
    const progress = `  ${bar(pct)}  chunk ${done}/${total}  ~${fmtMS(remain)} left  | ${memStatus(memMiB)}  `;
    const token = makeToken(memMiB, total, done, ehash, Buffer.from(K).toString('hex'));
    resumeMsg = total>1 ? `  If stopped, resume with: brainvault --resume "${token}"` : '  Demo run (no resume token)';
    renderTUI(progress, resumeMsg);
  }
  if (tuiOpened) { process.stdout.write('\n'); tuiOpened = false; }
  const derivationMs = Date.now() - tDeriveStart;
  console.log(`[BrainVault] m/s/ms time derivation took: ${fmtDerivDuration(derivationMs)}`);

  const K_master = Kprev;
  const entropy   = hkdf('bip39/entropy/v1',    K_master, 32);
  const passbytes = hkdf('bip39/passphrase/v1', K_master, 32);
  const mnemonic  = bip39.entropyToMnemonic(Buffer.from(entropy).toString('hex'));
  const words     = mnemonic.split(' ');

  console.log('\n=== BrainVault ===');
  console.log(`Mnemonic (24 words) — derived in ${fmtDerivDuration(derivationMs)}:\n`);
  console.log(words.slice(0,12).join(' '));
  console.log(words.slice(12).join(' '));

  if (SHOW_PASSPHRASE) {
    console.log('\nPassphrase (enter on device):\n');
    console.log(passphraseFromK(passbytes));
  } else {
    console.log('\nPassphrase: (derived, hidden)');
    console.log('Set it ON DEVICE (Ledger: Settings -> Security -> Passphrase -> "Attach to PIN").');
    console.log('Use --show-passphrase ONCE if you must view it to set the device profile.');
  }

  console.log('\n--- RECOVERY (import) ---');
  console.log('MetaMask:  Import Wallet -> paste mnemonic -> set MetaMask password.');
  console.log('Ledger Live:  Reset device -> Restore from Recovery Phrase -> enter mnemonic.');
  console.log('  On device: Settings -> Security -> Passphrase -> "Attach to PIN" (enter BrainVault passphrase).');
  console.log('Trezor Suite:  Create/Recover -> choose "Hidden wallet" -> enter BrainVault passphrase.');
  console.log('Note: With passphrase enabled, the mnemonic alone opens an empty wallet.');

  const profile = {
    alg_id: ALG_ID,
    wordlist: WORDLIST,
    memory_gib: memoryGiB,
    factor,
    total_chunks: total,
    derivation: { bip39:'mnemonic+passphrase', eth_path: "m/44'/60'/0'/0/0" }
  };
  console.log('\nProfile (metadata only):');
  console.log(JSON.stringify(profile, null, 2));

  const rl3 = readline.createInterface({ input, output });
  console.log('\nDerive site passwords (type domain like "google.com"; blank to finish):');
  while (true) {
    const d = (await rl3.question(' domain: ')).trim();
    if (!d) break;
    const pw = sitePassword(d, K_master, 20);
    if(!pw){ console.log('  invalid domain'); continue; }
    console.log(`  → ${d}: ${pw}`);
  }
  await rl3.close();

  console.log('\nDone. SAME email + SAME memory GB + SAME factor → same wallet.');
}

async function runResume(tokenArg){
  printIntro();

  let tok;
  try { tok = parseToken(tokenArg); }
  catch(e){ console.error('Invalid --resume token:', e.message); process.exit(1); }

  const { memMiB, total, done, ehash, Khex } = tok;
  let Kprev = Buffer.from(Khex, 'hex');

  console.log(`\nResuming at chunk ${done}/${total}  memory=${(memMiB/1024).toFixed(0)} GB (${memMiB} MiB)`);
  let cur = done;

  // open TUI area
  renderTUI('Preparing...', ' ');

  let avg = 1.0, started = false;

  const tDeriveStart = Date.now();
  while(cur < total){
    const salt = makeSalt(ehash, cur);
    const tS = Date.now();
    const K = await argon(Kprev, salt, { memoryMiB: memMiB, timeCost: 1, rawOut: true });
    const sec = (Date.now()-tS)/1000;
    avg = started ? (avg*0.5 + sec*0.5) : sec;
    started = true;

    cur += 1;
    Kprev = K;

    const pct = cur/total;
    const remain = (total - cur) * avg;
    const progress = `  ${bar(pct)}  chunk ${cur}/${total}  ~${fmtMS(remain)} left  | ${memStatus(memMiB)}  `;
    const token = makeToken(memMiB, total, cur, ehash, Buffer.from(K).toString('hex'));
    const resumeMsg = `  If stopped, resume with: brainvault --resume "${token}"`;
    renderTUI(progress, resumeMsg);
  }
  if (tuiOpened) { process.stdout.write('\n'); tuiOpened = false; }
  const derivationMs = Date.now() - tDeriveStart;
  console.log(`[BrainVault] m/s/ms time derivation took: ${fmtDerivDuration(derivationMs)}`);

  const K_master = Kprev;
  const entropy   = hkdf('bip39/entropy/v1',    K_master, 32);
  const passbytes = hkdf('bip39/passphrase/v1', K_master, 32);
  const mnemonic  = bip39.entropyToMnemonic(Buffer.from(entropy).toString('hex'));
  const words     = mnemonic.split(' ');

  console.log('\n=== BrainVault ===');
  console.log(`Mnemonic (24 words) — derived in ${fmtDerivDuration(derivationMs)}:\n`);
  console.log(words.slice(0,12).join(' '));
  console.log(words.slice(12).join(' '));

  if (SHOW_PASSPHRASE) {
    console.log('\nPassphrase (enter on device):\n');
    console.log(passphraseFromK(passbytes));
  } else {
    console.log('\nPassphrase: (derived, hidden)');
    console.log('Set it ON DEVICE (Ledger: Settings -> Security -> Passphrase -> "Attach to PIN").');
    console.log('Use --show-passphrase ONCE if you must view it to set the device profile.');
  }

  console.log('\n--- RECOVERY (import) ---');
  console.log('MetaMask:  Import Wallet -> paste mnemonic -> set MetaMask password.');
  console.log('Ledger Live:  Reset device -> Restore from Recovery Phrase -> enter mnemonic.');
  console.log('  On device: Settings -> Security -> Passphrase -> "Attach to PIN" (enter BrainVault passphrase).');
  console.log('Trezor Suite:  Create/Recover -> choose "Hidden wallet" -> enter BrainVault passphrase.');
  console.log('Note: With passphrase enabled, the mnemonic alone opens an empty wallet.');

  console.log('\nDone. SAME email + SAME memory GB + SAME factor → same wallet.');
}

// ---------- self-tests (1 GiB, derivation=2 chunks)
async function selfTests(){
  printIntro();
  console.log('\n[SelfTest] Running fixed vectors at 1 GiB, 2 chunks (timeCost=1 per chunk)...');

  const memMiB = 1024;
  const email = 'selftest@example.com';
  const password = 'BrainVault_SelfTest_#1';
  const ehash = emailHash(email);

  // expected values computed once; if you change ALG_ID/logic, update these.
  // To compute: run this block once, log K_master_hex and mnemonic, then paste here.
  const salt0 = makeSalt(ehash, 0);
  const tS0 = Date.now();
  const K0 = await argon(password, salt0, { memoryMiB: memMiB, timeCost: 1, rawOut: true });
  const salt1 = makeSalt(ehash, 1);
  const tS1 = Date.now();
  const K1 = await argon(K0, salt1, { memoryMiB: memMiB, timeCost: 1, rawOut: true });
  const derivedMs = Date.now() - tS0;
  const K_master_hex = Buffer.from(K1).toString('hex');
  const entropy = hkdf('bip39/entropy/v1', K1, 32);
  const mnemonic = bip39.entropyToMnemonic(Buffer.from(entropy).toString('hex'));

  console.log('\n[SelfTest] Results:');
  console.log('K_master (hex):', K_master_hex);
  console.log(`Mnemonic (24 words) — derived in ${fmtDerivDuration(derivedMs)}:`);
  const words = mnemonic.split(' ');
  console.log(words.slice(0,12).join(' '));
  console.log(words.slice(12).join(' '));

  console.log('\n[SelfTest] NOTE: These outputs are machine-independent given same code/ALG_ID.');
  console.log('If you bump ALG_ID or change derivation, regenerate and pin new vectors.');
}

// entry
const ri = process.argv.indexOf('--resume');
if (process.argv.includes('--selftest')) {
  selfTests().catch(e=>{ console.error(e); process.exit(1); });
} else if (ri !== -1 && ri + 1 < process.argv.length) {
  runResume(process.argv[ri + 1]).catch(e=>{ console.error(e); process.exit(1); });
} else {
  runFresh().catch(e=>{ console.error(e); process.exit(1); });
}