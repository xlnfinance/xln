<script lang="ts">
  import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress, type InterfaceAbi } from 'ethers';
  import { EVM_NETWORKS, ERC20_ABI, type EVMNetwork, type TokenInfo } from '$lib/config/evmNetworks';

  // Cast ABI to proper type for ethers
  const ERC20_INTERFACE: InterfaceAbi = ERC20_ABI as InterfaceAbi;

  // Props from BrainVault - the wallet's private key (masterKeyHex)
  export let privateKey: string;
  export let walletAddress: string;

  // State - EVM_NETWORKS always has Ethereum as first element
  let selectedNetwork: EVMNetwork = EVM_NETWORKS[0]!;
  let selectedToken: TokenInfo | null = null;
  let customTokenAddress = '';
  let recipientAddress = '';
  let amount = '';
  let gasEstimate = '';
  let status: 'idle' | 'estimating' | 'sending' | 'success' | 'error' = 'idle';
  let errorMessage = '';
  let txHash = '';
  let isCustomToken = false;
  let customTokenInfo: TokenInfo | null = null;
  let loadingCustomToken = false;

  // Network dropdown state
  let networkDropdownOpen = false;
  let tokenDropdownOpen = false;

  // Get mainnets only for default display
  $: mainnetNetworks = EVM_NETWORKS.filter(n => !n.isTestnet);
  $: testnetNetworks = EVM_NETWORKS.filter(n => n.isTestnet);

  // Get tokens for selected network
  $: availableTokens = selectedNetwork?.tokens || [];

  // Reset token when network changes
  $: if (selectedNetwork) {
    selectedToken = null;
    customTokenAddress = '';
    customTokenInfo = null;
    isCustomToken = false;
    gasEstimate = '';
  }

  // Validate inputs
  $: canEstimate = selectedNetwork &&
    (selectedToken || (isCustomToken && customTokenInfo)) &&
    recipientAddress &&
    isAddress(recipientAddress) &&
    amount &&
    parseFloat(amount) > 0;

  $: canSend = canEstimate && gasEstimate && status !== 'sending';

  // Create provider for selected network
  function getProvider(): JsonRpcProvider {
    return new JsonRpcProvider(selectedNetwork.rpcUrl);
  }

  // Create wallet signer
  function getWallet(): Wallet {
    const provider = getProvider();
    // Ensure privateKey has 0x prefix
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    return new Wallet(pk, provider);
  }

  // Load custom token info
  async function loadCustomToken() {
    if (!customTokenAddress || !isAddress(customTokenAddress)) {
      customTokenInfo = null;
      return;
    }

    loadingCustomToken = true;
    errorMessage = '';
    try {
      const provider = getProvider();
      const contract = new Contract(customTokenAddress, ERC20_INTERFACE, provider);
      const [symbol, name, decimals] = await Promise.all([
        contract.getFunction('symbol')(),
        contract.getFunction('name')(),
        contract.getFunction('decimals')()
      ]);

      customTokenInfo = {
        symbol,
        name,
        address: customTokenAddress,
        decimals: Number(decimals)
      };
      selectedToken = null;
    } catch (e) {
      customTokenInfo = null;
      errorMessage = e instanceof Error ? e.message : 'Failed to load token';
    } finally {
      loadingCustomToken = false;
    }
  }

  // Estimate gas
  async function estimateGas() {
    if (!canEstimate) return;

    status = 'estimating';
    errorMessage = '';
    gasEstimate = '';

    try {
      const token = isCustomToken ? customTokenInfo : selectedToken;
      if (!token) throw new Error('No token selected');

      const provider = getProvider();
      const contract = new Contract(token.address, ERC20_INTERFACE, provider);
      const amountWei = parseUnits(amount, token.decimals);

      // Estimate gas using getFunction
      const transferFn = contract.getFunction('transfer');
      const gasLimit = await transferFn.estimateGas(recipientAddress, amountWei, {
        from: walletAddress
      });

      // Get gas price
      const feeData = await provider.getFeeData();
      const gasPrice = feeData.gasPrice || 0n;
      const totalGas = gasLimit * gasPrice;

      gasEstimate = `~${formatUnits(totalGas, 18)} ${selectedNetwork.symbol}`;
      status = 'idle';
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Gas estimation failed';
      // Common errors translation
      if (msg.includes('insufficient funds')) {
        errorMessage = 'Insufficient balance for gas fees';
      } else if (msg.includes('execution reverted')) {
        errorMessage = 'Transaction would fail - check token balance';
      } else {
        errorMessage = msg;
      }
      status = 'error';
    }
  }

  // Send transaction
  async function sendTransaction() {
    if (!canSend) return;

    status = 'sending';
    errorMessage = '';
    txHash = '';

    try {
      const token = isCustomToken ? customTokenInfo : selectedToken;
      if (!token) throw new Error('No token selected');

      const wallet = getWallet();
      const contract = new Contract(token.address, ERC20_INTERFACE, wallet);
      const amountWei = parseUnits(amount, token.decimals);

      const transferFn = contract.getFunction('transfer');
      const tx = await transferFn(recipientAddress, amountWei);
      txHash = tx.hash;

      // Wait for confirmation
      await tx.wait();
      status = 'success';
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Transaction failed';
      if (msg.includes('insufficient funds')) {
        errorMessage = 'Insufficient balance for gas fees';
      } else if (msg.includes('nonce')) {
        errorMessage = 'Nonce error - please try again';
      } else {
        errorMessage = msg;
      }
      status = 'error';
    }
  }

  function selectNetwork(network: EVMNetwork) {
    selectedNetwork = network;
    networkDropdownOpen = false;
  }

  function selectToken(token: TokenInfo) {
    selectedToken = token;
    isCustomToken = false;
    customTokenAddress = '';
    customTokenInfo = null;
    tokenDropdownOpen = false;
  }

  function enableCustomToken() {
    isCustomToken = true;
    selectedToken = null;
    tokenDropdownOpen = false;
  }

  function openExplorer() {
    if (txHash && selectedNetwork.explorerUrl) {
      window.open(`${selectedNetwork.explorerUrl}/tx/${txHash}`, '_blank');
    }
  }

  function reset() {
    recipientAddress = '';
    amount = '';
    gasEstimate = '';
    status = 'idle';
    errorMessage = '';
    txHash = '';
  }
</script>

<div class="erc20-send">
  <div class="send-header">
    <span class="send-icon">&#x21E8;</span>
    <span class="send-title">Send Token</span>
  </div>

  <!-- Network Selector -->
  <div class="field-group">
    <label>Network</label>
    <div class="dropdown" class:open={networkDropdownOpen}>
      <button class="dropdown-trigger" on:click={() => networkDropdownOpen = !networkDropdownOpen}>
        <span class="network-name">{selectedNetwork.name}</span>
        <span class="network-chain">({selectedNetwork.symbol})</span>
        <span class="dropdown-arrow">{networkDropdownOpen ? '^' : 'v'}</span>
      </button>
      {#if networkDropdownOpen}
        <div class="dropdown-menu">
          <div class="dropdown-section">
            <span class="section-label">Mainnets</span>
            {#each mainnetNetworks as network}
              <button
                class="dropdown-item"
                class:selected={network.chainId === selectedNetwork.chainId}
                on:click={() => selectNetwork(network)}
              >
                {network.name} <span class="chain-id">({network.symbol})</span>
              </button>
            {/each}
          </div>
          <div class="dropdown-section">
            <span class="section-label">Testnets</span>
            {#each testnetNetworks as network}
              <button
                class="dropdown-item"
                class:selected={network.chainId === selectedNetwork.chainId}
                on:click={() => selectNetwork(network)}
              >
                {network.name} <span class="chain-id">({network.symbol})</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </div>
  </div>

  <!-- Token Selector -->
  <div class="field-group">
    <label>Token</label>
    <div class="dropdown" class:open={tokenDropdownOpen}>
      <button class="dropdown-trigger" on:click={() => tokenDropdownOpen = !tokenDropdownOpen}>
        {#if selectedToken}
          <span class="token-symbol">{selectedToken.symbol}</span>
          <span class="token-name">{selectedToken.name}</span>
        {:else if isCustomToken && customTokenInfo}
          <span class="token-symbol">{customTokenInfo.symbol}</span>
          <span class="token-name">{customTokenInfo.name}</span>
        {:else if isCustomToken}
          <span class="token-placeholder">Enter custom address...</span>
        {:else}
          <span class="token-placeholder">Select token...</span>
        {/if}
        <span class="dropdown-arrow">{tokenDropdownOpen ? '^' : 'v'}</span>
      </button>
      {#if tokenDropdownOpen}
        <div class="dropdown-menu">
          {#if availableTokens.length > 0}
            {#each availableTokens as token}
              <button
                class="dropdown-item"
                class:selected={selectedToken?.address === token.address}
                on:click={() => selectToken(token)}
              >
                <span class="token-symbol">{token.symbol}</span>
                <span class="token-name">{token.name}</span>
              </button>
            {/each}
            <div class="dropdown-divider"></div>
          {/if}
          <button
            class="dropdown-item custom-token-btn"
            class:selected={isCustomToken}
            on:click={enableCustomToken}
          >
            <span class="custom-icon">+</span>
            <span>Custom Token Address</span>
          </button>
        </div>
      {/if}
    </div>

    {#if isCustomToken}
      <div class="custom-token-input">
        <input
          type="text"
          placeholder="0x... (ERC20 contract address)"
          bind:value={customTokenAddress}
          on:blur={loadCustomToken}
        />
        {#if loadingCustomToken}
          <span class="loading-indicator">...</span>
        {:else if customTokenInfo}
          <span class="token-found">{customTokenInfo.symbol}</span>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Recipient Address -->
  <div class="field-group">
    <label>Recipient Address</label>
    <input
      type="text"
      class="address-input"
      placeholder="0x..."
      bind:value={recipientAddress}
      class:invalid={recipientAddress && !isAddress(recipientAddress)}
    />
    {#if recipientAddress && !isAddress(recipientAddress)}
      <span class="field-error">Invalid address</span>
    {/if}
  </div>

  <!-- Amount -->
  <div class="field-group">
    <label>Amount</label>
    <div class="amount-input-wrapper">
      <input
        type="text"
        class="amount-input"
        placeholder="0.00"
        bind:value={amount}
      />
      <span class="amount-symbol">
        {selectedToken?.symbol || customTokenInfo?.symbol || 'TOKEN'}
      </span>
    </div>
  </div>

  <!-- Gas Estimate -->
  {#if gasEstimate}
    <div class="gas-estimate">
      <span class="gas-label">Estimated Gas:</span>
      <span class="gas-value">{gasEstimate}</span>
    </div>
  {/if}

  <!-- Error Message -->
  {#if errorMessage}
    <div class="error-message">{errorMessage}</div>
  {/if}

  <!-- Success Message -->
  {#if status === 'success' && txHash}
    <div class="success-message">
      <span>Transaction sent!</span>
      {#if selectedNetwork.explorerUrl}
        <button class="explorer-link" on:click={openExplorer}>
          View on {selectedNetwork.explorerName} -&gt;
        </button>
      {/if}
    </div>
  {/if}

  <!-- Action Buttons -->
  <div class="action-buttons">
    {#if status === 'success'}
      <button class="action-btn secondary" on:click={reset}>
        Send Another
      </button>
    {:else}
      <button
        class="action-btn estimate"
        on:click={estimateGas}
        disabled={!canEstimate || status === 'estimating'}
      >
        {status === 'estimating' ? 'Estimating...' : 'Estimate Gas'}
      </button>
      <button
        class="action-btn send"
        on:click={sendTransaction}
        disabled={!canSend}
      >
        {status === 'sending' ? 'Sending...' : 'Send'}
      </button>
    {/if}
  </div>

  <!-- Explorer Link -->
  <div class="explorer-footer">
    {#if selectedNetwork.explorerUrl}
      <a href="{selectedNetwork.explorerUrl}/address/{walletAddress}" target="_blank" rel="noopener">
        View balance on {selectedNetwork.explorerName} -&gt;
      </a>
    {:else}
      <span class="no-explorer">Local network - no explorer</span>
    {/if}
  </div>
</div>

<style>
  .erc20-send {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 16px;
    margin-top: 16px;
  }

  .send-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .send-icon {
    font-size: 18px;
    color: rgba(251, 191, 36, 0.8);
  }

  .send-title {
    font-size: 14px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
    letter-spacing: 0.02em;
  }

  .field-group {
    margin-bottom: 14px;
  }

  .field-group label {
    display: block;
    font-size: 11px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.5);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 6px;
  }

  /* Dropdown */
  .dropdown {
    position: relative;
  }

  .dropdown-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .dropdown-trigger:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: rgba(255, 255, 255, 0.12);
  }

  .dropdown.open .dropdown-trigger {
    border-color: rgba(251, 191, 36, 0.4);
  }

  .dropdown-arrow {
    margin-left: auto;
    font-size: 10px;
    color: rgba(255, 255, 255, 0.4);
  }

  .dropdown-menu {
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    margin-top: 4px;
    background: rgba(20, 18, 15, 0.98);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 8px;
    padding: 6px;
    z-index: 100;
    max-height: 240px;
    overflow-y: auto;
    backdrop-filter: blur(20px);
  }

  .dropdown-section {
    padding: 4px 0;
  }

  .section-label {
    display: block;
    font-size: 10px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.35);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 4px 8px;
  }

  .dropdown-item {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    background: transparent;
    border: none;
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.85);
    font-size: 13px;
    cursor: pointer;
    transition: background 0.15s ease;
    text-align: left;
  }

  .dropdown-item:hover {
    background: rgba(255, 255, 255, 0.06);
  }

  .dropdown-item.selected {
    background: rgba(251, 191, 36, 0.15);
    color: rgba(251, 191, 36, 1);
  }

  .chain-id, .network-chain {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
  }

  .token-symbol {
    font-weight: 600;
  }

  .token-name {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }

  .token-placeholder {
    color: rgba(255, 255, 255, 0.4);
  }

  .dropdown-divider {
    height: 1px;
    background: rgba(255, 255, 255, 0.08);
    margin: 6px 0;
  }

  .custom-token-btn .custom-icon {
    font-weight: bold;
    color: rgba(251, 191, 36, 0.8);
  }

  .custom-token-input {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 8px;
  }

  .custom-token-input input {
    flex: 1;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 12px;
    font-family: monospace;
  }

  .custom-token-input input:focus {
    outline: none;
    border-color: rgba(251, 191, 36, 0.4);
  }

  .loading-indicator {
    color: rgba(255, 255, 255, 0.5);
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 0.5; }
    50% { opacity: 1; }
  }

  .token-found {
    font-size: 11px;
    font-weight: 600;
    color: rgba(100, 200, 100, 0.9);
    padding: 4px 8px;
    background: rgba(100, 200, 100, 0.1);
    border-radius: 4px;
  }

  /* Input fields */
  .address-input,
  .amount-input {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 13px;
    font-family: monospace;
    transition: border-color 0.2s ease;
    box-sizing: border-box;
  }

  .address-input:focus,
  .amount-input:focus {
    outline: none;
    border-color: rgba(251, 191, 36, 0.4);
  }

  .address-input.invalid {
    border-color: rgba(255, 100, 100, 0.5);
  }

  .field-error {
    font-size: 11px;
    color: rgba(255, 100, 100, 0.9);
    margin-top: 4px;
  }

  .amount-input-wrapper {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .amount-input-wrapper .amount-input {
    flex: 1;
  }

  .amount-symbol {
    font-size: 12px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.5);
    min-width: 50px;
    text-align: right;
  }

  /* Gas estimate */
  .gas-estimate {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
    margin-bottom: 12px;
  }

  .gas-label {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }

  .gas-value {
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.8);
    font-family: monospace;
  }

  /* Messages */
  .error-message {
    padding: 10px 12px;
    background: rgba(255, 100, 100, 0.1);
    border: 1px solid rgba(255, 100, 100, 0.2);
    border-radius: 6px;
    color: rgba(255, 150, 150, 0.9);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .success-message {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: rgba(100, 200, 100, 0.1);
    border: 1px solid rgba(100, 200, 100, 0.2);
    border-radius: 6px;
    color: rgba(150, 255, 150, 0.9);
    font-size: 12px;
    margin-bottom: 12px;
  }

  .explorer-link {
    background: none;
    border: none;
    color: rgba(251, 191, 36, 0.9);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
  }

  .explorer-link:hover {
    color: rgba(251, 191, 36, 1);
  }

  /* Action buttons */
  .action-buttons {
    display: flex;
    gap: 10px;
    margin-top: 16px;
  }

  .action-btn {
    flex: 1;
    padding: 12px 16px;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    border: none;
  }

  .action-btn.estimate {
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .action-btn.estimate:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.1);
  }

  .action-btn.send {
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.9), rgba(217, 119, 6, 0.9));
    color: #000;
  }

  .action-btn.send:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(251, 191, 36, 0.3);
  }

  .action-btn.secondary {
    background: rgba(255, 255, 255, 0.06);
    color: rgba(255, 255, 255, 0.8);
    border: 1px solid rgba(255, 255, 255, 0.1);
  }

  .action-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none;
  }

  /* Explorer footer */
  .explorer-footer {
    margin-top: 12px;
    text-align: center;
  }

  .explorer-footer a {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.4);
    text-decoration: none;
  }

  .explorer-footer a:hover {
    color: rgba(251, 191, 36, 0.8);
  }

  .no-explorer {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.3);
  }
</style>
