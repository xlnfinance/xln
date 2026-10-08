<script lang="ts">
  import { get } from 'svelte/store';
  import type { RuntimeReplica, RuntimeInput } from '@xln/core/api/public/runtime-module';
  import { xlnFunctions, error } from '../../../../stores/xlnStore';
  import { errorLog } from '../../../../stores/errorLogStore';
  import { runtimeControllerHandle } from '../../../../stores/runtimeControllerStore';
  import { requireSignerIdForEntity } from '$lib/utils/identity/entityReplica';
  import BigIntInput from '../../../Common/BigIntInput.svelte';
  import EntitySelect from '../../workspace/shell/EntitySelect.svelte';
  import { requireTokenDecimals } from '../../token-metadata';

  export let entityId: string;
  export let actionRuntimeEnv: RuntimeReplica | null = null;
  export let isLive: boolean;
  export let signerId: string | null = null;
  export let counterpartyId: string | null;
  export let accountIds: string[] = [];
  export let entityNames: Map<string, string> = new Map();
  export let mode: 'extend' | 'request' = 'extend';
  export let submitRuntimeInput: ((input: RuntimeInput) => Promise<unknown> | unknown) | null = null;

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = actionRuntimeEnv;
  $: activeIsLive = isLive;

  let selectedCounterparty = counterpartyId || '';
  let selectedTokenId = 1;
  let creditAmountBigInt = 0n;
  let submitting = false;

  $: effectiveCounterparty = counterpartyId || selectedCounterparty;
  $: tokenList = activeXlnFunctions
    ? [1, 2, 3].map((id) => ({ id, symbol: activeXlnFunctions.getTokenInfo(id).symbol }))
    : [];
  $: selectedTokenDecimals = (() => {
    if (!activeXlnFunctions) return 0;
    return requireTokenDecimals(
      activeXlnFunctions.getTokenInfo(selectedTokenId).decimals,
      `token:${selectedTokenId}`,
    );
  })();

  type CreditEntityTx =
    | { type: 'extendCredit'; data: { counterpartyEntityId: string; tokenId: number; amount: bigint } }
    | {
        type: 'requestCredit';
        data: { counterpartyEntityId: string; tokenId: number; amount: bigint; requestId: string };
      };

  /** 'credit-<16 hex>': the Account replay id of one credit request. */
  function newCreditRequestId(): string {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return `credit-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  }

  /**
   * Extend: we set our own credit line to the counterparty. Request: we sign a
   * `credit_request` inside the bilateral account; a hub answers after commit
   * with its own credit line (capped per request, never lowering a larger one).
   */
  function buildCreditTx(counterpartyEntityId: string): CreditEntityTx {
    const data = { counterpartyEntityId, tokenId: selectedTokenId, amount: creditAmountBigInt };
    return mode === 'request'
      ? { type: 'requestCredit', data: { ...data, requestId: newCreditRequestId() } }
      : { type: 'extendCredit', data };
  }

  async function submitCredit(counterpartyEntityId: string) {
    const label = mode === 'request' ? 'Credit request' : 'Credit action';
    try {
      const env = activeEnv;
      const handle = get(runtimeControllerHandle);
      const remoteWritable = handle.mode === 'remote' && handle.authLevel === 'admin';
      if (!env && !remoteWritable) throw new Error('Credit command requires live embedded RuntimeReplica or admin remote runtime');
      if (!activeIsLive) throw new Error('Credit updates are only available in LIVE mode');
      const resolvedSigner = (env && activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'credit-form'))
        || signerId
        || (env ? requireSignerIdForEntity(env, entityId, 'credit-form') : '');
      if (!resolvedSigner) throw new Error('Signer is required for credit command');
      if (!submitRuntimeInput) throw new Error('Credit command path is not connected');
      const entityTxs = [buildCreditTx(counterpartyEntityId)];
      await submitRuntimeInput({ runtimeTxs: [], entityInputs: [{ entityId, signerId: resolvedSigner, entityTxs }], jInputs: [] });
      creditAmountBigInt = 0n;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      errorLog.log(`${label} failed`, 'Credit Form', { entityId, counterpartyId: counterpartyEntityId, err });
      error.set(`${label} failed: ${message}`);
    }
  }

  async function submit() {
    if (submitting) throw new Error('CREDIT_SUBMISSION_IN_FLIGHT');
    if (!effectiveCounterparty) return;
    submitting = true;
    try {
      await submitCredit(effectiveCounterparty);
    } finally {
      submitting = false;
    }
  }
</script>

<div class="action-card">
  <h4>{mode === 'request' ? 'Request Credit' : 'Extend Credit'}</h4>
  <div class="action-form">
    {#if counterpartyId === null}
      <EntitySelect bind:value={selectedCounterparty} options={accountIds} {entityNames} placeholder="Select account" />
    {/if}
    <select bind:value={selectedTokenId} class="form-select" disabled={submitting}>
      {#each tokenList as token}
        <option value={token.id}>{token.symbol}</option>
      {/each}
    </select>
    <BigIntInput
      bind:value={creditAmountBigInt}
      decimals={selectedTokenDecimals}
      placeholder="Credit amount"
      disabled={submitting}
    />
    <div class="button-row">
      {#if mode === 'request'}
        <button class="action-button tertiary" on:click={submit} disabled={submitting || !effectiveCounterparty || creditAmountBigInt <= 0n}>
          {submitting ? 'Submitting…' : 'Request Credit'}
        </button>
      {:else}
        <button class="action-button secondary" on:click={submit} disabled={submitting || !effectiveCounterparty || creditAmountBigInt <= 0n}>
          {submitting ? 'Submitting…' : 'Extend Credit'}
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .action-card {
    background: #18181b;
    border: 1px solid #27272a;
    border-radius: 10px;
    padding: 12px;
    margin-bottom: 8px;
  }

  .action-card h4 {
    margin: 0 0 8px 0;
    color: #e4e4e7;
    font-size: 0.8em;
    font-weight: 600;
  }

  .action-form {
    display: flex;
    gap: 7px;
    align-items: center;
    flex-wrap: wrap;
  }

  .form-select {
    padding: 9px 10px;
    background: #09090b;
    border: 1px solid #27272a;
    border-radius: 8px;
    color: #e4e4e7;
    font-size: 0.88em;
    min-width: 100px;
  }

  .form-select:focus {
    border-color: #fbbf24;
    outline: none;
    box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.1);
  }

  .action-button {
    padding: 8px 14px;
    border: none;
    border-radius: 8px;
    font-weight: 600;
    font-size: 0.78em;
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .action-button.secondary {
    background: linear-gradient(135deg, #1e40af, #1e3a8a);
    color: white;
    box-shadow: 0 1px 3px rgba(30, 64, 175, 0.3);
  }

  .action-button.secondary:hover {
    background: linear-gradient(135deg, #2563eb, #1e40af);
  }

  .action-button.tertiary {
    background: linear-gradient(135deg, #14532d, #166534);
    color: white;
    box-shadow: 0 1px 3px rgba(22, 101, 52, 0.3);
  }

  .action-button.tertiary:hover {
    background: linear-gradient(135deg, #15803d, #166534);
  }

  .action-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .button-row {
    display: flex;
    gap: 7px;
    flex-wrap: wrap;
  }
</style>
