<script lang="ts">
  import { get } from 'svelte/store';
  import type { RuntimeReplica, RuntimeInput } from '@xln/runtime/api/public/runtime-module';
  import { xlnFunctions, error } from '../../../../stores/xlnStore';
  import { errorLog } from '../../../../stores/errorLogStore';
  import { recordRuntimeIngressReceipt } from '../../../../stores/commands/runtimeCommandBus';
  import { runtimeControllerHandle } from '../../../../stores/runtimeControllerStore';
  import { requireSignerIdForEntity } from '$lib/utils/identity/entityReplica';
  import BigIntInput from '../../../Common/BigIntInput.svelte';
  import EntitySelect from '../../workspace/shell/EntitySelect.svelte';
  import { requireTokenDecimals } from '../../token-metadata';
  import { optionalBoolean, optionalFiniteNumber, optionalString, readJsonUnknown, rejectExtraKeys, requireUnknownRecord } from '$lib/utils/boundary';

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

  function decodeCreditRequestResponse(value: unknown): CreditRequestResponse {
    const record = requireUnknownRecord(value, 'CREDIT_REQUEST_RESPONSE_INVALID');
    rejectExtraKeys(record, ['success', 'status', 'error', 'approvedAmount', 'requestId', 'statusUrl', 'runtimeId', 'receipt'], 'CREDIT_REQUEST_RESPONSE_EXTRA_FIELD');
    const receiptValue = record['receipt'];
    let receipt: CreditRequestResponse['receipt'];
    if (receiptValue !== undefined) {
      const rawReceipt = requireUnknownRecord(receiptValue, 'CREDIT_REQUEST_RECEIPT_INVALID');
      rejectExtraKeys(rawReceipt, ['id', 'status', 'counts', 'enqueuedHeight', 'observedHeight', 'note'], 'CREDIT_REQUEST_RECEIPT_EXTRA_FIELD');
      let counts: NonNullable<CreditRequestResponse['receipt']>['counts'];
      if (rawReceipt['counts'] !== undefined && rawReceipt['counts'] !== null) {
        const rawCounts = requireUnknownRecord(rawReceipt['counts'], 'CREDIT_REQUEST_RECEIPT_COUNTS_INVALID');
        rejectExtraKeys(rawCounts, ['runtimeTxs', 'entityInputs', 'jInputs'], 'CREDIT_REQUEST_RECEIPT_COUNTS_EXTRA_FIELD');
        const runtimeTxs = optionalFiniteNumber(rawCounts['runtimeTxs'], 'CREDIT_REQUEST_RECEIPT_RUNTIME_TXS_INVALID');
        const entityInputs = optionalFiniteNumber(rawCounts['entityInputs'], 'CREDIT_REQUEST_RECEIPT_ENTITY_INPUTS_INVALID');
        const jInputs = optionalFiniteNumber(rawCounts['jInputs'], 'CREDIT_REQUEST_RECEIPT_J_INPUTS_INVALID');
        counts = {};
        if (runtimeTxs !== undefined) counts.runtimeTxs = runtimeTxs;
        if (entityInputs !== undefined) counts.entityInputs = entityInputs;
        if (jInputs !== undefined) counts.jInputs = jInputs;
      }
      const nullableString = (raw: unknown, code: string): string | null | undefined => raw === null ? null : optionalString(raw, code);
      const nullableNumber = (raw: unknown, code: string): number | null | undefined => raw === null ? null : optionalFiniteNumber(raw, code);
      const id = nullableString(rawReceipt['id'], 'CREDIT_REQUEST_RECEIPT_ID_INVALID');
      const status = optionalString(rawReceipt['status'], 'CREDIT_REQUEST_RECEIPT_STATUS_INVALID');
      const enqueuedHeight = nullableNumber(rawReceipt['enqueuedHeight'], 'CREDIT_REQUEST_RECEIPT_ENQUEUED_HEIGHT_INVALID');
      const observedHeight = nullableNumber(rawReceipt['observedHeight'], 'CREDIT_REQUEST_RECEIPT_OBSERVED_HEIGHT_INVALID');
      const note = nullableString(rawReceipt['note'], 'CREDIT_REQUEST_RECEIPT_NOTE_INVALID');
      receipt = {};
      if (id !== undefined) receipt.id = id;
      if (status !== undefined) receipt.status = status;
      if (counts !== undefined) receipt.counts = counts;
      if (enqueuedHeight !== undefined) receipt.enqueuedHeight = enqueuedHeight;
      if (observedHeight !== undefined) receipt.observedHeight = observedHeight;
      if (note !== undefined) receipt.note = note;
    }
    const nullableString = (raw: unknown, code: string): string | null | undefined => raw === null ? null : optionalString(raw, code);
    const success = optionalBoolean(record['success'], 'CREDIT_REQUEST_SUCCESS_INVALID');
    const status = optionalString(record['status'], 'CREDIT_REQUEST_STATUS_INVALID');
    const error = optionalString(record['error'], 'CREDIT_REQUEST_ERROR_INVALID');
    const approvedAmount = optionalString(record['approvedAmount'], 'CREDIT_REQUEST_AMOUNT_INVALID');
    const requestId = optionalString(record['requestId'], 'CREDIT_REQUEST_ID_INVALID');
    const statusUrl = optionalString(record['statusUrl'], 'CREDIT_REQUEST_STATUS_URL_INVALID');
    const runtimeId = nullableString(record['runtimeId'], 'CREDIT_REQUEST_RUNTIME_ID_INVALID');
    const result: CreditRequestResponse = {};
    if (success !== undefined) result.success = success;
    if (status !== undefined) result.status = status;
    if (error !== undefined) result.error = error;
    if (approvedAmount !== undefined) result.approvedAmount = approvedAmount;
    if (requestId !== undefined) result.requestId = requestId;
    if (statusUrl !== undefined) result.statusUrl = statusUrl;
    if (runtimeId !== undefined) result.runtimeId = runtimeId;
    if (receipt !== undefined) result.receipt = receipt;
    return result;
  }

  async function submitExtendCredit(_successMessage: string) {
    if (!effectiveCounterparty) return;
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
      errorLog.log('Credit action failed', 'Credit Form', { entityId, counterpartyId: effectiveCounterparty, err });
      error.set(`Credit action failed: ${message}`);
    }
  }

  async function extendCredit() {
    if (submitting) throw new Error('CREDIT_SUBMISSION_IN_FLIGHT');
    submitting = true;
    try {
      await submitExtendCredit(`Credit extended: ${activeXlnFunctions?.formatTokenAmount(selectedTokenId, creditAmountBigInt)}`);
    } finally {
      submitting = false;
    }
  }

  async function requestCredit() {
    if (submitting) throw new Error('CREDIT_SUBMISSION_IN_FLIGHT');
    if (!effectiveCounterparty) return;
    submitting = true;
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
      const result = decodeCreditRequestResponse(await readJsonUnknown(response));
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
      errorLog.log('Credit request failed', 'Credit Form', { entityId, counterpartyId: effectiveCounterparty, err });
      error.set(`Credit request failed: ${message}`);
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
        <button class="action-button tertiary" on:click={requestCredit} disabled={submitting || !effectiveCounterparty || creditAmountBigInt <= 0n}>
          {submitting ? 'Submitting…' : 'Request Credit'}
        </button>
      {:else}
        <button class="action-button secondary" on:click={extendCredit} disabled={submitting || !effectiveCounterparty || creditAmountBigInt <= 0n}>
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
