<script lang="ts">
  import { get } from 'svelte/store';
  import type { Env, RuntimeInput } from '@xln/runtime/xln-api';
  import { xlnFunctions, error } from '../../stores/xlnStore';
  import { recordRuntimeIngressReceipt } from '../../stores/runtimeCommandBus';
  import { runtimeControllerHandle } from '../../stores/runtimeControllerStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import EntitySelect from './EntitySelect.svelte';

  export let entityId: string;
  export let actionRuntimeEnv: Env | null = null;
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

  $: effectiveCounterparty = counterpartyId || selectedCounterparty;
  $: tokenList = [1, 2, 3].map(id => {
    const info = activeXlnFunctions?.getTokenInfo?.(id);
    return { id, symbol: info?.symbol || `TKN${id}` };
  });
  $: selectedTokenDecimals = (() => {
    const info = activeXlnFunctions?.getTokenInfo?.(selectedTokenId);
    const decimals = Number(info?.decimals);
    return Number.isFinite(decimals) && decimals >= 0 ? decimals : 18;
  })();

  type CreditEntityInput = {
    entityId: string;
    signerId: string;
    entityTxs: Array<{
      type: 'extendCredit';
      data: {
        counterpartyEntityId: string;
        tokenId: number;
        amount: bigint;
      };
    }>;
  };

  type CreditRequestResponse = {
    success?: boolean;
    status?: 'queued' | 'already_satisfied' | string;
    error?: string;
    approvedAmount?: string;
    requestId?: string;
    statusUrl?: string;
    runtimeId?: string | null;
    receipt?: {
      id?: string | null;
      status?: string;
      counts?: {
        runtimeTxs?: number;
        entityInputs?: number;
        jInputs?: number;
      };
      enqueuedHeight?: number | null;
      observedHeight?: number | null;
      note?: string | null;
    };
  };

  async function submitExtendCredit(successMessage: string) {
    if (!effectiveCounterparty) return;
    try {
      const env = activeEnv;
      const handle = get(runtimeControllerHandle);
      const remoteWritable = handle.mode === 'remote' && handle.authLevel === 'admin';
      if (!env && !remoteWritable) throw new Error('Credit command requires live embedded Env or admin remote runtime');
      if (!activeIsLive) throw new Error('Credit updates are only available in LIVE mode');
      const resolvedSigner = (env && activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'credit-form'))
        || signerId
        || (env ? requireSignerIdForEntity(env, entityId, 'credit-form') : '');
      if (!resolvedSigner) throw new Error('Signer is required for credit command');

      const input: CreditEntityInput = {
        entityId,
        signerId: resolvedSigner,
        entityTxs: [{
          type: 'extendCredit',
          data: {
            counterpartyEntityId: effectiveCounterparty,
            tokenId: selectedTokenId,
            amount: creditAmountBigInt,
          },
        }],
      };

      if (!submitRuntimeInput) throw new Error('Credit command path is not connected');
      await submitRuntimeInput({ runtimeTxs: [], entityInputs: [input], jInputs: [] });
      creditAmountBigInt = 0n;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Credit action failed:', message);
      error.set(`Credit action failed: ${message}`);
    }
  }

  async function extendCredit() {
    await submitExtendCredit(`Credit extended: ${activeXlnFunctions?.formatTokenAmount(selectedTokenId, creditAmountBigInt)}`);
  }

  async function requestCredit() {
    if (!effectiveCounterparty) return;
    try {
      if (!activeIsLive) throw new Error('Credit requests are only available in LIVE mode');
      const apiBase = typeof window === 'undefined' ? '' : window.location.origin;
      const response = await fetch(`${apiBase}/api/credit/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          hubEntityId: effectiveCounterparty,
          tokenId: selectedTokenId,
          amount: creditAmountBigInt.toString(),
        }),
      });
      const result = await response.json() as CreditRequestResponse;
      if (!response.ok || result.success !== true) {
        throw new Error(result.error || `Credit request failed (${response.status})`);
      }
      if (result.receipt) {
        const handle = get(runtimeControllerHandle);
        recordRuntimeIngressReceipt({
          runtimeId: result.runtimeId || handle.runtimeId || handle.id || 'remote',
          mode: 'remote',
          receipt: result.receipt,
          statusUrl: result.statusUrl ?? null,
        });
      }
      creditAmountBigInt = 0n;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error('Credit request failed:', message);
      error.set(`Credit request failed: ${message}`);
    }
  }
</script>

<div class="action-card">
  <h4>{mode === 'request' ? 'Request Credit' : 'Extend Credit'}</h4>
  <div class="action-form">
    {#if counterpartyId === null}
      <EntitySelect bind:value={selectedCounterparty} options={accountIds} {entityNames} placeholder="Select account" />
    {/if}
    <select bind:value={selectedTokenId} class="form-select">
      {#each tokenList as token}
        <option value={token.id}>{token.symbol}</option>
      {/each}
    </select>
    <BigIntInput
      bind:value={creditAmountBigInt}
      decimals={selectedTokenDecimals}
      placeholder="Credit amount"
    />
    <div class="button-row">
      {#if mode === 'request'}
        <button class="action-button tertiary" on:click={requestCredit} disabled={!effectiveCounterparty || creditAmountBigInt <= 0n}>
          Request Credit
        </button>
      {:else}
        <button class="action-button secondary" on:click={extendCredit} disabled={!effectiveCounterparty || creditAmountBigInt <= 0n}>
          Extend Credit
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
