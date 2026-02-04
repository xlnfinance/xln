<script lang="ts">
  import { JsonRpcProvider, Wallet, Contract, parseUnits, formatUnits, isAddress, type InterfaceAbi } from 'ethers';
  import { BrowserVMEthersProvider } from '@xln/runtime/jadapter/browservm-ethers-provider';
  import type { XLNModule } from '@xln/runtime/xln-api';
  import type { JAdapter } from '@xln/runtime/jadapter';
  import type { BrowserVMProvider as BrowserVMProviderImpl } from '@xln/runtime/jadapter/browservm-provider';
  import { EVM_NETWORKS, ERC20_ABI, getNetworkByChainId, type EVMNetwork, type TokenInfo } from '$lib/config/evmNetworks';
  import { getAvailableJurisdictions } from '$lib/stores/jurisdictionStore';
  import { onMount } from 'svelte';

  // Props
  export let privateKey: string;
  export let walletAddress: string;
  export let entityId: string; // bytes32 entity ID

  // Jurisdiction/Depository info
  let jurisdictions: any[] = [];
  let selectedJurisdiction: any = null;
  let depositoryAddress = '';

  // Token selection
  let selectedNetwork: EVMNetwork = EVM_NETWORKS.find(n => n.chainId === 31337) || EVM_NETWORKS[0]!; // Default to localhost
  let selectedToken: TokenInfo | null = null;
  let customTokenAddress = '';
  let useCustomToken = false;
  let availableTokens: TokenInfo[] = [];
  let browserVmTokens: TokenInfo[] = [];
  let browserVM: BrowserVMProviderImpl | null = null;
  let browserProvider: BrowserVMEthersProvider | null = null;
  let cachedXLN: XLNModule | null = null;
  let isBrowserVM = false;

  // Form
  let amount = '';
  let isApproving = false;
  let isDepositing = false;
  let error = '';
  let success = '';
  let txHash = '';

  // Steps tracking
  let step: 'approve' | 'deposit' | 'done' = 'approve';
  let allowance = 0n;

  const ERC20_INTERFACE: InterfaceAbi = ERC20_ABI as InterfaceAbi;

  // Depository ABI (minimal)
  const DEPOSITORY_ABI = [
    'function externalTokenToReserve((bytes32 entity, address contractAddress, uint96 externalTokenId, uint8 tokenType, uint256 internalTokenId, uint256 amount) params)',
  ] as const;

  onMount(async () => {
    await loadJurisdictions();
  });

  async function ensureBrowserVM(): Promise<BrowserVMProviderImpl | null> {
    if (browserVM) return browserVM;
    const { getXLN } = await import('$lib/stores/xlnStore');
    const xln = cachedXLN ?? await getXLN();
    cachedXLN = xln;
    const env = xln.getEnv();
    const jadapter: JAdapter | null = xln.getActiveJAdapter?.(env) ?? null;
    browserVM = (jadapter?.getBrowserVM?.() as BrowserVMProviderImpl | null) ?? null;
    if (browserVM && !browserProvider) {
      browserProvider = new BrowserVMEthersProvider(browserVM);
    }
    return browserVM;
  }

  async function loadBrowserVMTokens() {
    const vm = await ensureBrowserVM();
    if (!vm?.getTokenRegistry) {
      browserVmTokens = [];
      return;
    }
    const registry = vm.getTokenRegistry();
    browserVmTokens = registry.map((token: any) => ({
      symbol: token.symbol,
      name: token.name,
      address: token.address,
      decimals: token.decimals ?? 18,
    }));
    if (!selectedToken && browserVmTokens.length > 0) {
      selectedToken = browserVmTokens[0]!;
      useCustomToken = false;
    }
  }

  async function loadJurisdictions() {
    try {
      jurisdictions = await getAvailableJurisdictions();
      // Find localhost/hardhat jurisdiction
      selectedJurisdiction = jurisdictions.find(j =>
        j.name.toLowerCase().includes('hardhat') ||
        j.name.toLowerCase().includes('localhost') ||
        j.chainId === 31337
      ) || jurisdictions[0];

      if (selectedJurisdiction) {
        depositoryAddress = selectedJurisdiction.contracts.depository;
        isBrowserVM = selectedJurisdiction.rpc?.startsWith('browservm://') || selectedJurisdiction.chainId === 1337;
        if (isBrowserVM) {
          await loadBrowserVMTokens();
        } else {
          browserVmTokens = [];
          const network = getNetworkByChainId(selectedJurisdiction.chainId);
          if (network) selectedNetwork = network;
        }
      }
    } catch (e) {
      console.error('Failed to load jurisdictions:', e);
    }
  }

  function getProvider() {
    if (isBrowserVM) {
      return browserProvider;
    }
    return new JsonRpcProvider(selectedNetwork.rpcUrl);
  }

  function getWallet(): Wallet {
    const provider = getProvider();
    if (!provider) {
      throw new Error('Provider not ready');
    }
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    return new Wallet(pk, provider);
  }

  function getTokenAddress(): string {
    if (useCustomToken && customTokenAddress) {
      return customTokenAddress;
    }
    return selectedToken?.address || '';
  }

  function getTokenDecimals(): number {
    if (useCustomToken) return 18; // Default for custom
    return selectedToken?.decimals || 18;
  }

  async function checkAllowance() {
    const tokenAddr = getTokenAddress();
    if (!tokenAddr || !depositoryAddress) return;

    try {
      const provider = getProvider();
      if (!provider) return;
      const contract = new Contract(tokenAddr, ERC20_INTERFACE, provider);
      const allowanceFn = contract.getFunction('allowance');
      allowance = await allowanceFn(walletAddress, depositoryAddress);

      const amountWei = parseUnits(amount || '0', getTokenDecimals());
      if (allowance >= amountWei && amountWei > 0n) {
        step = 'deposit';
      } else {
        step = 'approve';
      }
    } catch (e) {
      console.error('Failed to check allowance:', e);
    }
  }

  async function approve() {
    const tokenAddr = getTokenAddress();
    if (!tokenAddr || !amount || !depositoryAddress) {
      error = 'Missing token, amount, or depository';
      return;
    }

    isApproving = true;
    error = '';
    success = '';

    try {
      const wallet = getWallet();
      const contract = new Contract(tokenAddr, ERC20_INTERFACE, wallet);
      const amountWei = parseUnits(amount, getTokenDecimals());

      const approveFn = contract.getFunction('approve');
      const tx = await approveFn(depositoryAddress, amountWei);

      success = `Approving... TX: ${tx.hash}`;
      await tx.wait();

      success = 'Approved! Now deposit.';
      step = 'deposit';
      allowance = amountWei;
    } catch (e: any) {
      error = e.message || 'Approve failed';
    } finally {
      isApproving = false;
    }
  }

  async function deposit() {
    const tokenAddr = getTokenAddress();
    if (!tokenAddr || !amount || !depositoryAddress || !entityId) {
      error = 'Missing required fields';
      return;
    }

    isDepositing = true;
    error = '';
    success = '';

    try {
      const wallet = getWallet();
      const depository = new Contract(depositoryAddress, DEPOSITORY_ABI as InterfaceAbi, wallet);
      const amountWei = parseUnits(amount, getTokenDecimals());

      // Call externalTokenToReserve
      const depositFn = depository.getFunction('externalTokenToReserve');
      const tx = await depositFn({
        entity: entityId,
        contractAddress: tokenAddr,
        externalTokenId: 0,
        tokenType: 0, // ERC20
        internalTokenId: 0, // Let contract assign
        amount: amountWei
      });

      txHash = tx.hash;
      success = `Depositing... TX: ${tx.hash}`;
      await tx.wait();

      success = `Deposited ${amount} tokens to Entity!`;
      step = 'done';
    } catch (e: any) {
      error = e.message || 'Deposit failed';
    } finally {
      isDepositing = false;
    }
  }

  function selectToken(token: TokenInfo | null) {
    selectedToken = token;
    useCustomToken = token === null;
    checkAllowance();
  }

  async function onJurisdictionChange() {
    if (selectedJurisdiction) {
      depositoryAddress = selectedJurisdiction.contracts.depository;
      isBrowserVM = selectedJurisdiction.rpc?.startsWith('browservm://') || selectedJurisdiction.chainId === 1337;
      if (isBrowserVM) {
        await loadBrowserVMTokens();
      } else {
        browserVmTokens = [];
        const network = getNetworkByChainId(selectedJurisdiction.chainId);
        if (network) selectedNetwork = network;
      }
    }
    checkAllowance();
  }

  $: if (amount && (selectedToken || customTokenAddress)) {
    checkAllowance();
  }

  $: availableTokens = isBrowserVM ? browserVmTokens : selectedNetwork.tokens;
</script>

<div class="deposit-container">
  <div class="section-header">
    <span class="icon">💎</span>
    <span class="title">Deposit to Entity</span>
  </div>

  <div class="info-box">
    <div class="info-row">
      <span class="label">Entity ID</span>
      <code class="value">{entityId}</code>
    </div>
    <div class="info-row">
      <span class="label">Depository</span>
      <code class="value">{depositoryAddress ? `${depositoryAddress.slice(0, 10)}...` : 'Loading...'}</code>
    </div>
  </div>

  <!-- J-Machine Select -->
  <div class="field">
    <label>J-Machine</label>
    <select bind:value={selectedJurisdiction} on:change={onJurisdictionChange}>
      {#each jurisdictions as j}
        <option value={j}>{j.name} ({j.currency})</option>
      {/each}
    </select>
  </div>

  <!-- Token Select -->
  <div class="field">
    <label>Token</label>
    <div class="token-buttons">
      {#each availableTokens as token}
        <button
          class="token-btn"
          class:selected={selectedToken?.address === token.address && !useCustomToken}
          on:click={() => selectToken(token)}
        >
          {token.symbol}
        </button>
      {/each}
      <button
        class="token-btn custom"
        class:selected={useCustomToken}
        on:click={() => selectToken(null)}
      >
        Custom
      </button>
    </div>
    {#if useCustomToken}
      <input
        type="text"
        placeholder="0x... token contract address"
        bind:value={customTokenAddress}
        class="custom-input"
      />
    {/if}
  </div>

  <!-- Amount -->
  <div class="field">
    <label>Amount</label>
    <div class="amount-input">
      <input type="text" placeholder="0.00" bind:value={amount} />
      <span class="suffix">{selectedToken?.symbol || 'TOKEN'}</span>
    </div>
  </div>

  <!-- Steps Progress -->
  <div class="steps">
    <div class="step" class:active={step === 'approve'} class:done={step !== 'approve'}>
      <span class="num">1</span>
      <span>Approve</span>
    </div>
    <div class="step-arrow">→</div>
    <div class="step" class:active={step === 'deposit'} class:done={step === 'done'}>
      <span class="num">2</span>
      <span>Deposit</span>
    </div>
    <div class="step-arrow">→</div>
    <div class="step" class:active={step === 'done'}>
      <span class="num">✓</span>
      <span>Done</span>
    </div>
  </div>

  <!-- Action Buttons -->
  <div class="actions">
    {#if step === 'approve'}
      <button
        class="btn primary"
        on:click={approve}
        disabled={isApproving || !amount || (!selectedToken && !customTokenAddress)}
      >
        {isApproving ? 'Approving...' : 'Approve Token'}
      </button>
    {:else if step === 'deposit'}
      <button
        class="btn primary"
        on:click={deposit}
        disabled={isDepositing}
      >
        {isDepositing ? 'Depositing...' : 'Deposit to Entity'}
      </button>
    {:else}
      <div class="success-msg">
        ✅ Deposit complete! Your entity now has reserve balance.
      </div>
    {/if}
  </div>

  {#if error}
    <div class="error">{error}</div>
  {/if}
  {#if success}
    <div class="success">{success}</div>
  {/if}
</div>

<style>
  .deposit-container {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 12px;
    padding: 20px;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 16px;
    padding-bottom: 12px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .icon {
    font-size: 20px;
  }

  .title {
    font-size: 16px;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.9);
  }

  .info-box {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 8px;
    padding: 12px;
    margin-bottom: 16px;
  }

  .info-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
  }

  .label {
    font-size: 12px;
    color: rgba(255, 255, 255, 0.5);
  }

  .value {
    font-size: 11px;
    color: rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.05);
    padding: 2px 6px;
    border-radius: 4px;
  }

  .field {
    margin-bottom: 16px;
  }

  .field label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: rgba(255, 255, 255, 0.6);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  select, input {
    width: 100%;
    padding: 10px 12px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    color: rgba(255, 255, 255, 0.9);
    font-size: 14px;
  }

  select:focus, input:focus {
    outline: none;
    border-color: rgba(255, 200, 100, 0.4);
  }

  .token-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .token-btn {
    padding: 8px 14px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: rgba(255, 255, 255, 0.7);
    font-size: 13px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .token-btn:hover {
    background: rgba(255, 255, 255, 0.08);
  }

  .token-btn.selected {
    background: rgba(255, 200, 100, 0.15);
    border-color: rgba(255, 200, 100, 0.4);
    color: rgba(255, 200, 100, 0.9);
  }

  .token-btn.custom {
    font-style: italic;
  }

  .custom-input {
    margin-top: 8px;
  }

  .amount-input {
    display: flex;
    align-items: center;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    overflow: hidden;
  }

  .amount-input input {
    flex: 1;
    border: none;
    background: transparent;
  }

  .suffix {
    padding: 0 12px;
    color: rgba(255, 255, 255, 0.4);
    font-size: 13px;
    font-weight: 500;
  }

  .steps {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 20px 0;
    padding: 12px;
    background: rgba(0, 0, 0, 0.15);
    border-radius: 8px;
  }

  .step {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 12px;
    border-radius: 6px;
    font-size: 13px;
    color: rgba(255, 255, 255, 0.4);
    transition: all 0.2s;
  }

  .step.active {
    background: rgba(255, 200, 100, 0.15);
    color: rgba(255, 200, 100, 0.9);
  }

  .step.done {
    color: rgba(100, 255, 150, 0.7);
  }

  .num {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 50%;
    font-size: 11px;
    font-weight: 600;
  }

  .step.active .num {
    background: rgba(255, 200, 100, 0.3);
  }

  .step.done .num {
    background: rgba(100, 255, 150, 0.2);
  }

  .step-arrow {
    color: rgba(255, 255, 255, 0.2);
  }

  .actions {
    margin-top: 16px;
  }

  .btn {
    width: 100%;
    padding: 12px 20px;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn.primary {
    background: linear-gradient(135deg, rgba(255, 200, 100, 0.8), rgba(255, 150, 50, 0.8));
    color: #000;
  }

  .btn.primary:hover:not(:disabled) {
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(255, 200, 100, 0.3);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .success-msg {
    text-align: center;
    padding: 16px;
    background: rgba(100, 255, 150, 0.1);
    border-radius: 8px;
    color: rgba(100, 255, 150, 0.9);
    font-weight: 500;
  }

  .error {
    margin-top: 12px;
    padding: 10px;
    background: rgba(255, 100, 100, 0.1);
    border-radius: 6px;
    color: rgba(255, 100, 100, 0.9);
    font-size: 13px;
  }

  .success {
    margin-top: 12px;
    padding: 10px;
    background: rgba(100, 255, 150, 0.1);
    border-radius: 6px;
    color: rgba(100, 255, 150, 0.9);
    font-size: 13px;
  }
</style>
