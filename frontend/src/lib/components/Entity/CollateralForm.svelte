<script lang="ts">
  import type { Env, Profile as GossipProfile } from '@xln/runtime/xln-api';
  import { enqueueEntityInputs, xlnEnvironment, xlnFunctions, error } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import {
    getCounterpartyAccount,
    getReplicaForEntity,
    normalizeEntityId,
    requireSignerIdForEntity,
  } from '$lib/utils/entityReplica';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import EntitySelect from './EntitySelect.svelte';

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;
  $: activeIsLive = $globalIsLive;

  export let entityId: string;
  export let signerId: string | null = null;
  export let counterpartyId: string | null;
  export let accountIds: string[] = [];

  let selectedCounterparty = counterpartyId || '';
  let selectedTokenId = 1;
  let collateralAmount = 0n;
  let lastPrefillKey = '';
  let lastAutoMax = 0n;

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
  $: maxCollateralNeeded = (() => {
    if (!activeEnv || !effectiveCounterparty || !activeXlnFunctions) return 0n;
    const accountEntry = getCounterpartyAccount(activeEnv, entityId, effectiveCounterparty);
    const delta = accountEntry?.account.deltas?.get?.(selectedTokenId);
    if (!delta) return 0n;
    const derived = activeXlnFunctions.deriveDelta(delta, entityId < effectiveCounterparty);
    return derived.outPeerCredit > derived.outCollateral
      ? (derived.outPeerCredit - derived.outCollateral)
      : 0n;
  })();
  $: {
    const key = `${normalizeEntityId(effectiveCounterparty)}:${selectedTokenId}`;
    if (key !== lastPrefillKey) {
      collateralAmount = maxCollateralNeeded;
      lastAutoMax = maxCollateralNeeded;
      lastPrefillKey = key;
    } else if (collateralAmount === lastAutoMax && maxCollateralNeeded !== lastAutoMax) {
      collateralAmount = maxCollateralNeeded;
      lastAutoMax = maxCollateralNeeded;
    }
  }

  function parseBigIntSafe(value: unknown, defaultValue = 0n): bigint {
    try {
      if (typeof value === 'bigint') return value;
      if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.floor(value));
      if (typeof value === 'string' && value.trim()) return BigInt(value.trim());
      return defaultValue;
    } catch {
      return defaultValue;
    }
  }

  type CounterpartyFeePolicy = {
    policyVersion: number;
    baseFee: bigint;
    liquidityFeeBps: bigint;
    gasFee: bigint;
  };

  function resolveCounterpartyPolicy(env: Env, ownerEntityId: string, cpEntityId: string): CounterpartyFeePolicy | null {
    const ownerNorm = normalizeEntityId(ownerEntityId);
    const cpNorm = normalizeEntityId(cpEntityId);
    if (!ownerNorm || !cpNorm) return null;

    const accountPolicy = getCounterpartyAccount(env, ownerEntityId, cpEntityId)?.account.counterpartyRebalanceFeePolicy;
    const accountPolicyVersion = Number(accountPolicy?.policyVersion ?? 0);
    if (Number.isFinite(accountPolicyVersion) && accountPolicyVersion > 0) {
      return {
        policyVersion: accountPolicyVersion,
        baseFee: parseBigIntSafe(accountPolicy?.baseFee, 0n),
        liquidityFeeBps: parseBigIntSafe(accountPolicy?.liquidityFeeBps, 0n),
        gasFee: parseBigIntSafe(accountPolicy?.gasFee, 0n),
      };
    }

    const hubConfig = getReplicaForEntity(env, cpEntityId)?.state?.hubRebalanceConfig;
    const hubPolicyVersion = Number(hubConfig?.policyVersion ?? 0);
    if (Number.isFinite(hubPolicyVersion) && hubPolicyVersion > 0) {
      return {
        policyVersion: hubPolicyVersion,
        baseFee: parseBigIntSafe(hubConfig?.rebalanceBaseFee ?? hubConfig?.baseFee, 0n),
        liquidityFeeBps: parseBigIntSafe(hubConfig?.rebalanceLiquidityFeeBps ?? hubConfig?.minFeeBps, 0n),
        gasFee: parseBigIntSafe(hubConfig?.rebalanceGasFee, 0n),
      };
    }

    const profile = env.gossip.getProfiles().find((candidate: GossipProfile) => normalizeEntityId(candidate.entityId) === cpNorm);
    const md = profile?.metadata;
    const policyVersion = Number(md?.policyVersion ?? 0);
    if (!Number.isFinite(policyVersion) || policyVersion <= 0) return null;
    return {
      policyVersion,
      baseFee: parseBigIntSafe(md.rebalanceBaseFee ?? md.baseFee, 0n),
      liquidityFeeBps: parseBigIntSafe(md.rebalanceLiquidityFeeBps, 0n),
      gasFee: parseBigIntSafe(md.rebalanceGasFee, 0n),
    };
  }

  type CollateralEntityInput = {
    entityId: string;
    signerId: string;
    entityTxs: Array<{
      type: 'requestCollateral';
      data: {
        counterpartyEntityId: string;
        tokenId: number;
        amount: bigint;
        feeTokenId: number;
        feeAmount: bigint;
        policyVersion: number;
      };
    }>;
  };

  async function requestCollateral() {
    if (!effectiveCounterparty) return;
    try {
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!activeIsLive) throw new Error('Collateral request is only available in LIVE mode');
      const resolvedSigner = activeXlnFunctions?.resolveEntityProposerId?.(env, entityId, 'collateral-form')
        || signerId
        || requireSignerIdForEntity(env, entityId, 'collateral-form');
      const feePolicy = resolveCounterpartyPolicy(env, entityId, effectiveCounterparty);
      if (!feePolicy) {
        throw new Error('Missing counterparty rebalance fee policy. Sync gossip/profile first.');
      }
      if (feePolicy.baseFee < 0n || feePolicy.gasFee < 0n || feePolicy.liquidityFeeBps < 0n) {
        throw new Error('Counterparty rebalance fee policy contains negative values.');
      }
      const feeAmount =
        feePolicy.baseFee +
        feePolicy.gasFee +
        ((collateralAmount * feePolicy.liquidityFeeBps) / 10000n);
      if (feeAmount < 0n) {
        throw new Error('Computed rebalance fee is negative. Counterparty policy is invalid.');
      }

      const collateralInput: CollateralEntityInput = {
        entityId,
        signerId: resolvedSigner,
        entityTxs: [{
          type: 'requestCollateral',
          data: {
            counterpartyEntityId: effectiveCounterparty,
            tokenId: selectedTokenId,
            amount: collateralAmount,
            feeTokenId: selectedTokenId,
            feeAmount,
            policyVersion: feePolicy.policyVersion,
          },
        }],
      };

      await enqueueEntityInputs(env, [collateralInput]);
      console.log(`Collateral requested: ${activeXlnFunctions?.formatTokenAmount(selectedTokenId, collateralAmount)}`);

      collateralAmount = 0n;
    } catch (err) {
      console.error('Failed to request collateral:', err);
      const message = err instanceof Error ? err.message : 'Unknown error';
      error.set(`Collateral request failed: ${message}`);
    }
  }

  function useMaxCollateral() {
    collateralAmount = maxCollateralNeeded;
    lastAutoMax = maxCollateralNeeded;
  }
</script>

<div class="action-card">
  <h4>Request Collateral</h4>
  <div class="action-form">
    {#if counterpartyId === null}
      <EntitySelect bind:value={selectedCounterparty} options={accountIds} placeholder="Select account" />
    {/if}
    <select bind:value={selectedTokenId} class="form-select">
      {#each tokenList as token}
        <option value={token.id}>{token.symbol}</option>
      {/each}
    </select>
    <BigIntInput
      bind:value={collateralAmount}
      decimals={selectedTokenDecimals}
      placeholder="Collateral amount"
    />
    <button
      class="action-button max"
      type="button"
      on:click={useMaxCollateral}
      disabled={!effectiveCounterparty || maxCollateralNeeded <= 0n}
      title="Use max suggested amount"
    >
      Max
    </button>
    <button class="action-button collateral" on:click={requestCollateral} disabled={!effectiveCounterparty || collateralAmount <= 0n}>
      Request Collateral
    </button>
  </div>
  <div class="max-hint">
    Suggested max: {activeXlnFunctions?.formatTokenAmount(selectedTokenId, maxCollateralNeeded) || '0'}
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

  .action-button.max {
    background: #111216;
    border: 1px solid #2f3138;
    color: #d1d5db;
  }

  .action-button.max:hover {
    border-color: #4b5563;
    color: #f3f4f6;
  }

  .action-button.collateral {
    background: linear-gradient(135deg, #0d9488, #0f766e);
    color: white;
    box-shadow: 0 1px 3px rgba(13, 148, 136, 0.3);
  }

  .action-button.collateral:hover {
    background: linear-gradient(135deg, #14b8a6, #0d9488);
  }

  .action-button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .max-hint {
    margin-top: 7px;
    color: #9ca3af;
    font-size: 11px;
    font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
    font-variant-numeric: tabular-nums;
  }
</style>
