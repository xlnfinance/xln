<script lang="ts">
  /**
   * Operator UI for probing an EVM RPC and deploying the canonical V1 jurisdiction stack.
   * It exposes deployment authority explicitly and renders only strictly decoded daemon evidence.
   * Importance: 84/100 — wrong signer, chain, or publication labels can mislead an operator.
   */
  import { activeRuntime } from '$lib/stores/vault/vaultStore';
  import {
    getRuntimeControllerConfig,
    runtimeControllerHandle,
  } from '$lib/stores/runtimeControllerStore';
  import {
    STACK_VERSION,
    deployStack,
    fetchStackManagerStatus,
    type StackManagerDeployResult,
    type StackManagerProbe,
    type StackManagerStatus,
    type StackPublicationRequest,
  } from './stack-manager-client';
  type SignerOption = Readonly<{ id: string; label: string }>;
  let rpcUrl = '';
  let networkName = '';
  let jurisdictionKey = '';
  let keyEdited = false;
  let signerId = '';
  let foundationRecipient = '';
  let stablecoinKind: 'existing' | 'test' = 'existing';
  let stablecoinAddress = '';
  let publication: StackPublicationRequest = 'local';
  let confirmations = 12;
  let blockTimeMs = 12_000;
  let currency = 'ETH';
  let explorer = '';
  let description = '';
  let confirmed = false;
  let probing = false;
  let deploying = false;
  let status: StackManagerStatus | null = null;
  let probe: StackManagerProbe | null = null;
  let result: StackManagerDeployResult | null = null;
  let error = '';
  $: signerOptions = ($activeRuntime?.signers ?? [])
    .map((signer): SignerOption | null => {
      const id = String(signer.address || '').trim().toLowerCase();
      return id ? { id, label: String(signer.name || 'Runtime signer').trim() || 'Runtime signer' } : null;
    })
    .filter((signer): signer is SignerOption => signer !== null);
  $: if (signerOptions[0] && !signerOptions.some((signer) => signer.id === signerId)) {
    signerId = signerOptions[0].id;
  }
  $: if (signerId && !foundationRecipient) foundationRecipient = signerId;
  $: balanceWei = probe?.nativeBalanceWei ?? '';
  $: hasGas = balanceWei !== '' && BigInt(balanceWei) > 0n;
  $: runtimeAdminCapability = $runtimeControllerHandle.mode === 'remote'
    ? String(getRuntimeControllerConfig()?.authKey || '')
    : '';
  $: isInBrowserRuntime = $runtimeControllerHandle.mode === 'embedded';
  $: hasRequiredConfig = Boolean(
    networkName.trim()
    && jurisdictionKey.trim()
    && foundationRecipient.trim()
    && Number.isSafeInteger(blockTimeMs)
    && blockTimeMs > 0
    && currency.trim()
    && runtimeAdminCapability
    && (stablecoinKind === 'test' || stablecoinAddress.trim()),
  );
  $: canDeploy = !deploying && !probing && probe !== null && probe.signerId === signerId && hasGas && confirmed && hasRequiredConfig;
  const normalizedKey = (value: string): string => value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const errorMessage = (value: unknown): string => value instanceof Error ? value.message : String(value);
  const formatNativeBalance = (value: string): string => {
    if (!value) return 'Not checked';
    const padded = value.padStart(19, '0');
    const integer = padded.slice(0, -18).replace(/^0+(?=\d)/, '');
    const fraction = padded.slice(-18).replace(/0+$/, '').slice(0, 6);
    return `${integer}${fraction ? `.${fraction}` : ''} native`;
  };
  const onNameInput = (): void => {
    if (!keyEdited) jurisdictionKey = normalizedKey(networkName);
  };
  const onRpcInput = (): void => {
    if (probe && rpcUrl.trim() !== probe.rpcUrl) probe = null;
    result = null;
  };
  const onKeyInput = (): void => {
    keyEdited = true;
  };
  const onSignerChange = (): void => {
    probe = null;
    result = null;
    if (!foundationRecipient || signerOptions.some((signer) => signer.id === foundationRecipient)) {
      foundationRecipient = signerId;
    }
  };
  async function refreshProbe(): Promise<void> {
    probing = true;
    error = '';
    result = null;
    try {
      if (!rpcUrl.trim()) throw new Error('STACK_MANAGER_RPC_URL_REQUIRED');
      if (!signerId) throw new Error('STACK_MANAGER_RUNTIME_SIGNER_REQUIRED');
      if (isInBrowserRuntime) throw new Error('STACK_MANAGER_DAEMON_RUNTIME_REQUIRED');
      const response = await fetchStackManagerStatus(rpcUrl.trim(), signerId, runtimeAdminCapability);
      status = response.status;
      if (!response.probe) throw new Error('STACK_MANAGER_RPC_PROBE_MISSING');
      if (response.probe.rpcUrl !== rpcUrl.trim()) throw new Error('STACK_MANAGER_PROBE_RPC_MISMATCH');
      if (response.probe.signerId !== signerId) throw new Error('STACK_MANAGER_PROBE_SIGNER_MISMATCH');
      probe = response.probe;
      confirmations = probe.chainId === 31_337 || probe.chainId === 1_337 ? 1 : 12;
    } catch (value) {
      probe = null;
      error = errorMessage(value);
    } finally {
      probing = false;
    }
  }
  async function submitDeployment(): Promise<void> {
    deploying = true;
    error = '';
    result = null;
    try {
      if (!probe || probe.signerId !== signerId) throw new Error('STACK_MANAGER_FRESH_PROBE_REQUIRED');
      if (!networkName.trim()) throw new Error('STACK_MANAGER_NAME_REQUIRED');
      if (!jurisdictionKey.trim()) throw new Error('STACK_MANAGER_KEY_REQUIRED');
      if (!foundationRecipient.trim()) throw new Error('STACK_MANAGER_FOUNDATION_RECIPIENT_REQUIRED');
      if (!confirmed) throw new Error('STACK_MANAGER_CONFIRMATION_REQUIRED');
      const stablecoin = stablecoinKind === 'test'
        ? { kind: 'test' as const }
        : { kind: 'existing' as const, address: stablecoinAddress.trim() };
      const response = await deployStack({
        name: networkName.trim(),
        key: jurisdictionKey.trim(),
        rpcUrl: rpcUrl.trim(),
        expectedChainId: probe.chainId,
        blockTimeMs,
        currency: currency.trim(),
        explorer: explorer.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        signerId,
        foundationRecipient: foundationRecipient.trim(),
        stablecoin,
        publication,
        confirmations,
      }, runtimeAdminCapability);
      result = response.result;
      confirmed = false;
    } catch (value) {
      error = errorMessage(value);
    } finally {
      deploying = false;
    }
  }
</script>
<section class="stack-manager" data-testid="stack-manager-v1">
  <header>
    <div>
      <p class="eyebrow">Jurisdiction deployment</p>
      <h4>Stack Manager <span>{STACK_VERSION}</span></h4>
    </div>
    {#if status}<div class:active={status.active} class="phase">{status.phase}</div>{/if}
  </header>
  {#if status?.error}
    <div class="message error" role="alert">{status.error}</div>
  {/if}
  <p class="intro">Probe the exact RPC and Runtime signer before deploying. A stack is saved only after receipt and bytecode verification.</p>
  {#if isInBrowserRuntime}
    <div class="message warning" role="status">In-browser Runtime is active. Stack deployment requires a daemon Runtime because deployment keys and subprocesses must stay outside the browser.</div>
  {/if}
  <div class="form-grid">
    <label>
      RPC URL
      <input data-testid="stack-manager-rpc" bind:value={rpcUrl} on:input={onRpcInput} placeholder="https://your-chain.example/rpc" autocomplete="url" />
    </label>
    <label>
      Network name
      <input data-testid="stack-manager-name" bind:value={networkName} on:input={onNameInput} placeholder="Arbitrum One" />
    </label>
    <label class="wide">
      Runtime signer
      <select data-testid="stack-manager-signer" bind:value={signerId} on:change={onSignerChange} disabled={signerOptions.length === 0}>
        {#if signerOptions.length === 0}
          <option value="">Unlock a Runtime signer first</option>
        {:else}
          {#each signerOptions as signer}
            <option value={signer.id}>{signer.label} · {signer.id}</option>
          {/each}
        {/if}
      </select>
    </label>
  </div>
  <div class="probe-row">
    <div><small>Chain ID</small><strong>{probe?.chainId ?? '—'}</strong></div>
    <div><small>Signer balance</small><strong class:warning={balanceWei === '0'}>{formatNativeBalance(balanceWei)}</strong></div>
    <button data-testid="stack-manager-refresh" class="secondary" on:click={refreshProbe} disabled={probing || deploying || !rpcUrl.trim() || !signerId || !runtimeAdminCapability}>
      {probing ? 'Checking…' : 'Refresh RPC & balance'}
    </button>
  </div>
  {#if probe && !hasGas}
    <div class="guidance" role="status">Fund <code>{signerId}</code> with native gas on chain {probe.chainId}, then refresh.</div>
  {/if}
  <details>
    <summary>Advanced deployment parameters</summary>
    <div class="advanced-grid">
      <label>
        Jurisdiction key
        <input data-testid="stack-manager-key" bind:value={jurisdictionKey} on:input={onKeyInput} placeholder="arbitrum-one" />
      </label>
      <label>
        Foundation recipient / stack admin
        <input data-testid="stack-manager-foundation" bind:value={foundationRecipient} placeholder="0x…" autocomplete="off" />
      </label>
      <label>
        Stablecoin
        <select bind:value={stablecoinKind}>
          <option value="existing">Existing 6-decimal USDT address</option>
          <option value="test">Deploy explicit test token</option>
        </select>
      </label>
      {#if stablecoinKind === 'existing'}
        <label>
          USDT address
          <input data-testid="stack-manager-usdt" bind:value={stablecoinAddress} placeholder="0x…" autocomplete="off" />
        </label>
      {/if}
      <label>
        Publication
        <select data-testid="stack-manager-publication" bind:value={publication}>
          <option value="local">Local discovery only</option>
          <option value="community">Publish to community Gossip</option>
          <option value="official">Publish as official Foundation stack</option>
        </select>
      </label>
      <label>
        Receipt confirmations
        <input type="number" min="1" step="1" bind:value={confirmations} />
      </label>
      <label>
        Block time (ms)
        <input data-testid="stack-manager-block-time" type="number" min="1" step="1" bind:value={blockTimeMs} />
      </label>
      <label>
        Native currency
        <input data-testid="stack-manager-currency" bind:value={currency} placeholder="ETH" />
      </label>
      <label class="wide">
        Block explorer URL
        <input data-testid="stack-manager-explorer" bind:value={explorer} placeholder="https://arbiscan.io" autocomplete="url" />
      </label>
      <label class="wide">
        Description
        <input data-testid="stack-manager-description" bind:value={description} placeholder="Community-operated jurisdiction" />
      </label>
    </div>
    {#if publication !== 'local'}
      <p class="notice">The verified deployment is signed by the Runtime deployer and saved for Gossip. Official publication additionally requires the configured Foundation trust anchor.</p>
    {/if}
  </details>
  <label class="confirm">
    <input data-testid="stack-manager-confirm" type="checkbox" bind:checked={confirmed} />
    <span>I verified the RPC, chain ID, signer, gas balance, recipient, and token configuration.</span>
  </label>
  <button data-testid="stack-manager-deploy" class="deploy" on:click={submitDeployment} disabled={!canDeploy}>
    {deploying ? 'Deploying and verifying…' : `Deploy ${STACK_VERSION} stack`}
  </button>
  {#if error}
    <div class="message error" data-testid="stack-manager-error" role="alert">{error}</div>
  {/if}
  {#if result}
    <div class="result" data-testid="stack-manager-result">
      <h5>{result.localJurisdiction.name} deployed</h5>
      <p>Chain {result.manifest.chainId} · block {result.manifest.entityProviderDeploymentBlock} · {result.publication.scope} {result.publication.status.replace('_', ' ')}</p>
      <dl>
        {#each Object.entries(result.manifest.contracts) as [name, contractAddress]}
          <dt>{name}</dt><dd><code>{contractAddress}</code></dd>
        {/each}
        <dt>USDT</dt><dd><code>{result.manifest.registeredTokens.USDT.address}</code></dd>
      </dl>
    </div>
  {/if}
</section>
<style>
  .stack-manager { max-width: 860px; color: #e7e7e7; }
  header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 8px; }
  h4 { margin: 2px 0 0; font-size: 20px; }
  h4 span { padding: 3px 7px; margin-left: 6px; color: #9fd1ff; background: #12324b; border: 1px solid #275f88; border-radius: 999px; font-size: 11px; vertical-align: middle; }
  .eyebrow { margin: 0; color: #72b7ef; font-size: 10px; font-weight: 700; letter-spacing: .12em; text-transform: uppercase; }
  .intro, .notice { color: #a8a8a8; font-size: 12px; line-height: 1.5; }
  .form-grid, .advanced-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  label { display: flex; flex-direction: column; gap: 6px; color: #c8c8c8; font-size: 12px; }
  .wide { grid-column: 1 / -1; }
  input, select { min-width: 0; padding: 9px 10px; color: #f1f1f1; background: #222; border: 1px solid #444; border-radius: 6px; font: inherit; }
  input:focus, select:focus { border-color: #3d91cf; outline: 2px solid rgba(61,145,207,.2); }
  .probe-row { display: grid; grid-template-columns: 120px minmax(160px, 1fr) auto; align-items: end; gap: 10px; margin: 14px 0; padding: 12px; background: #202020; border: 1px solid #333; border-radius: 8px; }
  .probe-row div { display: flex; flex-direction: column; gap: 3px; }
  small { color: #888; }
  strong.warning { color: #ffb454; }
  button { padding: 9px 13px; border: 1px solid #4b4b4b; border-radius: 6px; cursor: pointer; }
  button:disabled { cursor: not-allowed; opacity: .45; }
  .secondary { color: #ddd; background: #2b2b2b; }
  .deploy { width: 100%; margin-top: 12px; color: #fff; background: #116da6; border-color: #258bcc; font-weight: 700; }
  details { margin: 12px 0; padding: 12px; background: #1e1e1e; border: 1px solid #383838; border-radius: 8px; }
  summary { cursor: pointer; color: #d7d7d7; font-size: 12px; font-weight: 650; }
  .advanced-grid { margin-top: 14px; }
  .confirm { flex-direction: row; align-items: flex-start; margin-top: 14px; line-height: 1.35; }
  .confirm input { margin: 1px 0 0; }
  .guidance, .message, .result { margin-top: 12px; padding: 12px; border-radius: 7px; font-size: 12px; }
  .guidance { color: #ffd18b; background: #352b17; border: 1px solid #6b5525; overflow-wrap: anywhere; }
  .error { color: #ffaaa5; background: #3d2020; border: 1px solid #773333; }
  .warning { color: #ffd18b; background: #352b17; border: 1px solid #6b5525; }
  .result { color: #cdebd5; background: #183225; border: 1px solid #2e6e45; }
  .result h5 { margin: 0 0 4px; font-size: 14px; }
  .result p { margin: 0 0 10px; }
  dl { display: grid; grid-template-columns: minmax(100px, .5fr) minmax(0, 2fr); gap: 5px 10px; margin: 0; }
  dt { color: #92b59b; }
  dd { margin: 0; overflow-wrap: anywhere; }
  code { font-size: 11px; }
  .phase { padding: 5px 8px; color: #aaa; background: #292929; border-radius: 999px; font-size: 10px; text-transform: uppercase; }
  .phase.active { color: #8fd0ff; background: #173247; }
  @media (max-width: 650px) {
    .form-grid, .advanced-grid { grid-template-columns: 1fr; }
    .wide { grid-column: auto; }
    .probe-row { grid-template-columns: 1fr 1fr; }
    .probe-row button { grid-column: 1 / -1; }
  }
</style>
