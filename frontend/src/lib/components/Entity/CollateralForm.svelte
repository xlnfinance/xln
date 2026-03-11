<script lang="ts">
  import type { Env, Profile as GossipProfile } from '@xln/runtime/xln-api';
  import { enqueueEntityInputs, xlnEnvironment, xlnFunctions, error } from '../../stores/xlnStore';
  import { isLive as globalIsLive } from '../../stores/timeStore';
  import { requireSignerIdForEntity } from '$lib/utils/entityReplica';
  import BigIntInput from '../Common/BigIntInput.svelte';
  import EntitySelect from './EntitySelect.svelte';

  $: activeXlnFunctions = $xlnFunctions;
  $: activeEnv = $xlnEnvironment;
  $: activeIsLive = $globalIsLive;

  export let entityId: string;
  export let signerId: string | null = null;
  export let counterpartyId: string | null;
  export let accountIds: string[] = [];

  type FeePolicyView = {
    policyVersion: number;
    baseFee?: bigint | number | string;
    liquidityFeeBps?: bigint | number | string;
    gasFee?: bigint | number | string;
  };

  type HubConfigView = {
    policyVersion: number;
    rebalanceBaseFee?: bigint | number | string;
    baseFee?: bigint | number | string;
    rebalanceLiquidityFeeBps?: bigint | number | string;
    minFeeBps?: bigint | number | string;
    rebalanceGasFee?: bigint | number | string;
  };

  type AccountView = {
    counterpartyRebalanceFeePolicy?: FeePolicyView;
  };

  type ReplicaView = {
    state?: {
      accounts?: Map<string, AccountView>;
      hubRebalanceConfig?: HubConfigView;
    };
  };

  type RuntimeEnv = Env & {
    eReplicas: Map<string, ReplicaView>;
  };

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
    if (!activeEnv?.eReplicas || !effectiveCounterparty || !activeXlnFunctions) return 0n;
    const selfIdNorm = normalizeEntityId(entityId);
    const cpNorm = normalizeEntityId(effectiveCounterparty);
    if (!selfIdNorm || !cpNorm) return 0n;
    const replicas = activeEnv.eReplicas instanceof Map ? activeEnv.eReplicas : null;
    if (!replicas) return 0n;
    for (const [key, replica] of replicas.entries()) {
      const [replicaEntityId] = String(key).split(':');
      if (normalizeEntityId(replicaEntityId) !== selfIdNorm) continue;
      const account = replica?.state?.accounts?.get?.(effectiveCounterparty);
      const delta = account?.deltas?.get?.(selectedTokenId);
      if (!delta) return 0n;
      const derived = activeXlnFunctions.deriveDelta(delta, entityId < effectiveCounterparty);
      return derived.outPeerCredit > derived.outCollateral
        ? (derived.outPeerCredit - derived.outCollateral)
        : 0n;
    }
    return 0n;
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

  function normalizeEntityId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
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

  function isRuntimeEnv(value: unknown): value is RuntimeEnv {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  function resolveCounterpartyPolicy(env: RuntimeEnv, ownerEntityId: string, cpEntityId: string): {
    policyVersion: number;
    baseFee: bigint;
    liquidityFeeBps: bigint;
    gasFee: bigint;
  } | null {
    const ownerNorm = normalizeEntityId(ownerEntityId);
    const cpNorm = normalizeEntityId(cpEntityId);
    if (!ownerNorm || !cpNorm) return null;

    const replicas = env.eReplicas;
    if (replicas) {
      // 1) Prefer account-learned counterparty policy (most specific).
      for (const [key, replica] of replicas.entries()) {
        const [replicaEntityId] = String(key).split(':');
        if (normalizeEntityId(replicaEntityId) !== ownerNorm) continue;
        const accounts = replica?.state?.accounts;
        if (!(accounts instanceof Map)) break;
        for (const [accountKey, account] of accounts.entries()) {
          if (normalizeEntityId(accountKey) !== cpNorm) continue;
          const policy = account?.counterpartyRebalanceFeePolicy;
          const policyVersion = Number(policy?.policyVersion ?? 0);
          if (Number.isFinite(policyVersion) && policyVersion > 0) {
            return {
              policyVersion,
              baseFee: parseBigIntSafe(policy?.baseFee, 0n),
              liquidityFeeBps: parseBigIntSafe(policy?.liquidityFeeBps, 0n),
              gasFee: parseBigIntSafe(policy?.gasFee, 0n),
            };
          }
        }
      }

      // 2) Fallback to counterparty hub config from replica state.
      for (const [key, replica] of replicas.entries()) {
        const [replicaEntityId] = String(key).split(':');
        if (normalizeEntityId(replicaEntityId) !== cpNorm) continue;
        const cfg = replica?.state?.hubRebalanceConfig;
        const policyVersion = Number(cfg?.policyVersion ?? 0);
        if (!Number.isFinite(policyVersion) || policyVersion <= 0) break;
        return {
          policyVersion,
          baseFee: parseBigIntSafe(cfg?.rebalanceBaseFee ?? cfg?.baseFee, 0n),
          liquidityFeeBps: parseBigIntSafe(cfg?.rebalanceLiquidityFeeBps ?? cfg?.minFeeBps, 0n),
          gasFee: parseBigIntSafe(cfg?.rebalanceGasFee, 0n),
        };
      }
    }

    // 3) Gossip metadata (when bilateral policy not yet learned from account state).
    const profiles: GossipProfile[] = env.gossip?.getProfiles?.() || [];
    const profile = profiles.find((p) => normalizeEntityId(p.entityId) === cpNorm);
    const md = profile?.metadata || {};
    const policyVersion = Number(md?.policyVersion ?? 0);
    if (!Number.isFinite(policyVersion) || policyVersion <= 0) return null;
    return {
      policyVersion,
      baseFee: parseBigIntSafe(md?.rebalanceBaseFee ?? md?.baseFee, 0n),
      liquidityFeeBps: parseBigIntSafe(md?.rebalanceLiquidityFeeBps ?? md?.minFeeBps, 0n),
      gasFee: parseBigIntSafe(md?.rebalanceGasFee, 0n),
    };
  }

  async function requestCollateral() {
    if (!effectiveCounterparty) return;
    try {
      const env = activeEnv;
      if (!env) throw new Error('XLN environment not ready');
      if (!isRuntimeEnv(env)) throw new Error('Runtime environment not available');
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

      const collateralInput = {
        entityId,
        signerId: resolvedSigner,
        entityTxs: [{
          type: 'requestCollateral' as const,
          data: {
            counterpartyEntityId: effectiveCounterparty,
            tokenId: selectedTokenId,
            amount: collateralAmount,
            feeAmount,
            policyVersion: feePolicy.policyVersion
          }
        }]
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
