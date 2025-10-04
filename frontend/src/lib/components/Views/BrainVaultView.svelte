<script lang="ts">
  const wordList = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse", "access", "accident", "account", "accuse", "achieve", "acid", "acoustic", "acquire", "across", "act", "action", "actor", "actress", "actual", "adapt", "add", "addict", "address", "adjust", "admit", "adult", "advance", "advice", "aerobic", "affair", "afford", "afraid", "again", "age", "agent", "agree", "ahead", "aim", "air", "airport", "aisle", "alarm", "album", "alcohol", "alert", "alien", "all", "alley", "allow", "almost", "alone", "alpha", "already", "also", "alter", "always", "amateur", "amazing", "among", "amount", "amused", "analyst", "anchor", "ancient", "anger", "angle", "angry", "animal", "ankle", "announce", "annual", "another", "answer", "antenna", "antique", "anxiety", "any", "apart", "apology", "appear", "apple", "approve", "april", "arch", "arctic"];

  const tips = [
    "Channels allow for instant, fee-less transactions off-chain.",
    "Brainwallets use your username as a public salt, enhancing security.",
    "Higher derivation complexity protects against brute-force attacks.",
    "State channels can handle complex logic beyond simple transfers.",
    "Your username in a brainwallet is public, but your password should remain secret.",
    "Channels can be closed cooperatively or through on-chain dispute resolution.",
    "Brainwallets eliminate the need to store a recovery phrase.",
    "State channels can interact with smart contracts off-chain.",
    "The derivation process in brainwallets can be adjusted for better security.",
    "Channels can be used for microtransactions without incurring blockchain fees.",
    "Brainwallets combine something you know (password) with something public (username).",
    "State channels can be used for non-financial applications like gaming.",
    "The security of a brainwallet depends on the strength of your password and derivation complexity.",
    "Channels can be part of a network, enabling multi-hop payments.",
    "Brainwallets can be accessed from any device without needing to sync blockchain data.",
    "State channels can significantly increase blockchain scalability.",
    "The username in a brainwallet helps prevent rainbow table attacks.",
    "Channels can have multiple participants, not just two.",
    "Brainwallets can be a good option for cold storage when used with high security settings.",
    "State channels can reduce congestion on the main blockchain."
  ];

  const times = ['5 seconds', '10 seconds', '30 seconds', '1 minute', '2 minutes', '5 minutes', '10 minutes', '20 minutes', '40 minutes', '1 hour'];
  const colors = ['#ff0000', '#ff5e00', '#ff9a00', '#ffd000', '#dbff00', '#84ff00', '#30ff00', '#00ff33', '#00ff84', '#00ffd5'];

  let activeTab: 'brainwallet' | 'mnemonic' = 'brainwallet';
  let username = '';
  let password = '';
  let mnemonicInput = '';
  let complexity = 5;
  let generating = false;
  let progressFill = 0;
  let matrixText = '';
  let tipText = '';
  let wallets: Array<{ address: string; type: string }> = [];

  $: complexityValue = complexity;
  $: timeEstimate = times[complexity - 1];
  $: sliderGradient = `linear-gradient(to right, ${colors[0]} 0%, ${colors[complexity - 1]} 100%)`;

  function switchTab(tab: 'brainwallet' | 'mnemonic') {
    activeTab = tab;
  }

  function generateMnemonic() {
    const mnemonic = Array(16).fill(0).map(() => wordList[Math.floor(Math.random() * wordList.length)]).join(' ');
    mnemonicInput = mnemonic;
  }

  function generateMatrixAnimation(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%^&*()_+-=[]{}|;:,.<>?';
    const width = 60;
    const height = 5;
    return Array(height).fill(0).map(() =>
      Array(width).fill(0).map(() => Math.random() > 0.7 ? chars[Math.floor(Math.random() * chars.length)] : ' ').join('')
    ).join('\n');
  }

  async function generateWallet() {
    if (activeTab === 'mnemonic') {
      if (!mnemonicInput.trim()) {
        alert('Please enter a mnemonic');
        return;
      }

      const address = '0x' + Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
      wallets = [...wallets, { address, type: 'mnemonic' }];
      mnemonicInput = '';
    } else {
      if (!username.trim() || !password.trim()) {
        alert('Please enter username and password');
        return;
      }

      const totalSteps = complexity * 20;
      let currentStep = 0;

      generating = true;
      progressFill = 0;

      // Start tip rotation
      tipText = tips[Math.floor(Math.random() * tips.length)] || '';
      const tipInterval = setInterval(() => {
        tipText = tips[Math.floor(Math.random() * tips.length)] || '';
      }, 3000);

      // Start matrix animation
      const matrixInterval = setInterval(() => {
        matrixText = generateMatrixAnimation();
      }, 200);

      const generationInterval = setInterval(() => {
        currentStep++;
        progressFill = (currentStep / totalSteps) * 100;

        if (currentStep >= totalSteps) {
          clearInterval(generationInterval);
          clearInterval(tipInterval);
          clearInterval(matrixInterval);

          const address = '0x' + Array(40).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('');
          wallets = [...wallets, { address, type: 'brainwallet' }];

          username = '';
          password = '';

          setTimeout(() => {
            generating = false;
          }, 500);
        }
      }, complexity === 1 ? 50 : 250);
    }
  }

  function loginWallet(index: number) {
    const wallet = wallets[index];
    if (wallet) {
      alert('Login functionality for wallet: ' + wallet.address);
    }
  }
</script>

<div class="brainvault-container">
  <div class="container">
    <h1>XLN Wallet</h1>

    <div class="tabs">
      <button
        class="tab"
        class:active={activeTab === 'brainwallet'}
        on:click={() => switchTab('brainwallet')}
      >
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"/>
        </svg>
        Brainwallet
      </button>
      <button
        class="tab"
        class:active={activeTab === 'mnemonic'}
        on:click={() => switchTab('mnemonic')}
      >
        <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
        </svg>
        Mnemonic
      </button>
    </div>

    {#if activeTab === 'brainwallet'}
      <div class="tab-content active">
        <div class="form-group">
          <label for="username">Username</label>
          <input type="text" id="username" placeholder="Enter username" bind:value={username}>
        </div>

        <div class="form-group">
          <label for="password">Password</label>
          <input type="password" id="password" placeholder="Enter password" bind:value={password}>
        </div>

        <div class="form-group">
          <label>Derivation Complexity: <span>{complexityValue}</span></label>
          <div class="slider-group">
            <input
              type="range"
              id="complexity"
              min="1"
              max="10"
              bind:value={complexity}
              style="background: {sliderGradient}"
            >
            <div class="slider-labels">
              <span>Quick (Demo)</span>
              <span>Balanced</span>
              <span>Secure</span>
            </div>
            <div class="time-estimate">
              <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"/>
              </svg>
              Estimated time: <span>{timeEstimate}</span>
            </div>
          </div>
        </div>
      </div>
    {:else}
      <div class="tab-content active">
        <div class="form-group">
          <label for="mnemonic-input">Mnemonic (16 words)</label>
          <div class="mnemonic-group">
            <textarea id="mnemonic-input" rows="4" placeholder="Enter 16-word mnemonic" bind:value={mnemonicInput}></textarea>
            <button class="icon-btn" on:click={generateMnemonic}>
              <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
              </svg>
            </button>
          </div>
          <p class="info-text">
            <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="vertical-align: middle;">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/>
            </svg>
            Store your mnemonic securely. It's the only way to recover your wallet.
          </p>
        </div>
      </div>
    {/if}

    <button class="generate-btn" on:click={generateWallet} disabled={generating}>
      <svg class="icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"/>
      </svg>
      Generate Wallet
    </button>

    {#if generating}
      <div class="progress-container">
        <div class="progress-bar">
          <div class="progress-fill" style="width: {progressFill}%"></div>
        </div>
        <div class="matrix-box">{matrixText}</div>
        <p class="tip-text">{tipText}</p>
      </div>
    {/if}

    {#if wallets.length > 0}
      <div class="wallets-section">
        <h2>Generated Wallets</h2>
        <div class="wallets-list">
          {#each wallets as wallet, index}
            <div class="wallet-item">
              <span class="wallet-address">{wallet.address} ({wallet.type})</span>
              <button class="login-btn" on:click={() => loginWallet(index)}>Login</button>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .brainvault-container {
    width: 100%;
    min-height: calc(100vh - 60px);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
  }

  .container {
    background: rgba(30, 30, 30, 0.8);
    backdrop-filter: blur(20px);
    -webkit-backdrop-filter: blur(20px);
    border-radius: 12px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    padding: 40px;
    max-width: 520px;
    width: 100%;
  }

  h1 {
    text-align: center;
    margin-bottom: 32px;
    color: #00d9ff;
    font-size: 32px;
    font-weight: 700;
    text-shadow: 0 0 20px rgba(0, 217, 255, 0.3);
  }

  .tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 28px;
    background: rgba(255, 255, 255, 0.03);
    backdrop-filter: blur(20px);
    border-radius: 10px;
    padding: 5px;
    border: 1px solid rgba(255, 255, 255, 0.08);
  }

  .tab {
    flex: 1;
    padding: 12px;
    border: none;
    background: transparent;
    cursor: pointer;
    border-radius: 7px;
    font-size: 14px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    color: rgba(255, 255, 255, 0.5);
  }

  .tab:hover {
    background: rgba(0, 122, 204, 0.15);
    color: rgba(255, 255, 255, 0.8);
  }

  .tab.active {
    background: linear-gradient(135deg, rgba(0, 122, 204, 0.2) 0%, rgba(0, 180, 255, 0.15) 100%);
    color: #00ccff;
    box-shadow: 0 2px 12px rgba(0, 122, 204, 0.3);
  }

  .tab-content {
    display: block;
  }

  .form-group {
    margin-bottom: 20px;
  }

  label {
    display: block;
    margin-bottom: 8px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.7);
    font-size: 14px;
  }

  input[type="text"],
  input[type="password"],
  textarea {
    width: 100%;
    padding: 12px 14px;
    border: 1px solid rgba(255, 255, 255, 0.1);
    background: rgba(0, 0, 0, 0.3);
    border-radius: 6px;
    font-size: 14px;
    transition: all 0.2s;
    color: rgba(255, 255, 255, 0.9);
  }

  input:focus,
  textarea:focus {
    outline: none;
    border-color: rgba(0, 122, 204, 0.5);
    background: rgba(0, 0, 0, 0.4);
    box-shadow: 0 0 0 3px rgba(0, 122, 204, 0.1);
  }

  input::placeholder,
  textarea::placeholder {
    color: rgba(255, 255, 255, 0.3);
  }

  textarea {
    resize: vertical;
    font-family: 'Courier New', monospace;
  }

  .mnemonic-group {
    display: flex;
    gap: 8px;
  }

  .mnemonic-group textarea {
    flex: 1;
  }

  .icon-btn {
    padding: 12px;
    background: rgba(0, 122, 204, 0.3);
    color: #00ccff;
    border: 1px solid rgba(0, 122, 204, 0.5);
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .icon-btn:hover {
    background: rgba(0, 122, 204, 0.5);
    border-color: rgba(0, 180, 255, 0.7);
  }

  .slider-group {
    margin-top: 8px;
  }

  input[type="range"] {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    outline: none;
    -webkit-appearance: none;
  }

  input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #00ccff;
    cursor: pointer;
    box-shadow: 0 0 8px rgba(0, 204, 255, 0.5);
  }

  input[type="range"]::-moz-range-thumb {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: #00ccff;
    cursor: pointer;
    border: none;
    box-shadow: 0 0 8px rgba(0, 204, 255, 0.5);
  }

  .slider-labels {
    display: flex;
    justify-content: space-between;
    margin-top: 8px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }

  .slider-labels span:first-child {
    color: #ef4444;
  }

  .slider-labels span:last-child {
    color: #10b981;
  }

  .time-estimate {
    margin-top: 8px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .info-text {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    line-height: 1.5;
    margin-top: 8px;
    padding: 12px;
    background: rgba(0, 122, 204, 0.1);
    border-left: 3px solid rgba(0, 122, 204, 0.5);
    border-radius: 4px;
  }

  .generate-btn {
    width: 100%;
    padding: 14px;
    background: linear-gradient(135deg, rgba(0, 122, 204, 0.3) 0%, rgba(0, 180, 255, 0.2) 100%);
    border: 1px solid rgba(0, 122, 204, 0.5);
    color: #00ccff;
    border-radius: 8px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    margin-top: 24px;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    box-shadow: 0 4px 16px rgba(0, 122, 204, 0.2);
  }

  .generate-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, rgba(0, 122, 204, 0.4) 0%, rgba(0, 180, 255, 0.3) 100%);
    border-color: rgba(0, 180, 255, 0.7);
    box-shadow: 0 6px 24px rgba(0, 122, 204, 0.4);
    transform: translateY(-2px);
  }

  .generate-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .progress-container {
    margin-top: 20px;
  }

  .progress-bar {
    width: 100%;
    height: 8px;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 4px;
    overflow: hidden;
    border: 1px solid rgba(255, 255, 255, 0.05);
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #00ccff, #00ff88);
    transition: width 0.3s;
    box-shadow: 0 0 10px rgba(0, 204, 255, 0.5);
  }

  .matrix-box {
    margin-top: 12px;
    background: rgba(0, 0, 0, 0.6);
    color: #00ff88;
    padding: 12px;
    border-radius: 6px;
    border: 1px solid rgba(0, 255, 136, 0.2);
    font-family: 'Courier New', monospace;
    font-size: 10px;
    line-height: 1.4;
    overflow: hidden;
    white-space: pre;
  }

  .tip-text {
    margin-top: 12px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.6);
    line-height: 1.5;
    padding: 10px;
    background: rgba(0, 122, 204, 0.08);
    border-radius: 4px;
  }

  .wallets-section {
    margin-top: 32px;
    padding-top: 24px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
  }

  .wallets-section h2 {
    font-size: 20px;
    margin-bottom: 16px;
    color: #00d9ff;
    font-weight: 600;
  }

  .wallet-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 14px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    margin-bottom: 10px;
    transition: all 0.2s ease;
  }

  .wallet-item:hover {
    background: rgba(0, 0, 0, 0.4);
    border-color: rgba(0, 122, 204, 0.4);
  }

  .wallet-address {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.7);
    word-break: break-all;
    font-family: 'Courier New', monospace;
  }

  .login-btn {
    padding: 8px 16px;
    background: rgba(16, 185, 129, 0.3);
    border: 1px solid rgba(16, 185, 129, 0.5);
    color: #00ff88;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .login-btn:hover {
    background: rgba(16, 185, 129, 0.5);
    border-color: rgba(16, 185, 129, 0.7);
    box-shadow: 0 0 12px rgba(16, 185, 129, 0.3);
  }

  .icon {
    width: 16px;
    height: 16px;
    display: inline-block;
  }
</style>
