<!--
  EntityPanelTabs.svelte - Rabby-style tabbed Entity interface

  Single scroll container, no nested scrollbars.
  Clean fintech design with proper form inputs.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import { Wallet as EthersWallet, hexlify, isAddress, ZeroAddress } from 'ethers';
  import type { Env } from '@xln/runtime/xln-api';
  import type { Tab, EntityReplica } from '$lib/types/ui';
  import { history } from '../../stores/xlnStore';
  import { visibleReplicas, currentTimeIndex, isLive, timeOperations } from '../../stores/timeStore';
  import { settings, settingsOperations } from '../../stores/settingsStore';
  import { activeVault } from '$lib/stores/vaultStore';
  import { getEntityEnv, hasEntityEnvContext } from '$lib/view/components/entity/shared/EntityEnvContext';
  import { xlnFunctions, entityPositions, processWithDelay } from '../../stores/xlnStore';
  import { toasts } from '../../stores/toastStore';

  // Icons
  import {
    ArrowUpRight, ArrowDownLeft, Repeat, Landmark, Users, Activity,
    MessageCircle, Settings as SettingsIcon, BookUser,
    ChevronDown, Wallet, AlertTriangle, PlusCircle, Copy, Check, Scale, Globe
  } from 'lucide-svelte';

  // Child components
  import EntityDropdown from './EntityDropdown.svelte';
  import AccountDropdown from './AccountDropdown.svelte';
  import AccountPanel from './AccountPanel.svelte';
  import AccountList from './AccountList.svelte';
  import PaymentPanel from './PaymentPanel.svelte';
  import SwapPanel from './SwapPanel.svelte';
  import SettlementPanel from './SettlementPanel.svelte';
  import ChatMessages from './ChatMessages.svelte';
  import ConsensusState from './ConsensusState.svelte';
  import ProposalsList from './ProposalsList.svelte';
  import JurisdictionDropdown from '$lib/components/Jurisdiction/JurisdictionDropdown.svelte';
  import FormationPanel from './FormationPanel.svelte';
  import QRPanel from './QRPanel.svelte';
  import HubDiscoveryPanel from './HubDiscoveryPanel.svelte';
  import GossipPanel from './GossipPanel.svelte';

  export let tab: Tab;
  export let isLast: boolean = false;
  export let hideHeader: boolean = false;
  export let showJurisdiction: boolean = true;
  export let initialAction: 'r2r' | 'r2c' | undefined = undefined;

  // Tab types
  type ViewTab = 'external' | 'reserves' | 'accounts' | 'send' | 'swap' | 'onj' | 'activity' | 'chat' | 'contacts' | 'receive' | 'create' | 'gossip' | 'governance' | 'settings';

  // Set initial tab based on action
  function getInitialTab(): ViewTab {
    if (initialAction === 'r2r') return 'send';
    if (initialAction === 'r2c') return 'onj'; // On-chain jurisdiction for R2C
    return 'accounts';
  }
  let activeTab: ViewTab = getInitialTab();

  // State
  let replica: EntityReplica | null = null;
  let selectedAccountId: string | null = null;
  let onchainPrefill: { tokenId?: number; id: number } | null = null;
  let selectedJurisdictionName: string | null = null;
  let activityCount = 0;
  let addressCopied = false;
  let openAccountEntityId = '';
  const API_BASE = typeof window !== 'undefined' ? window.location.origin : 'https://xln.finance';
  const REFRESH_OPTIONS = [
    { label: 'Off', value: 0 },
    { label: '1s', value: 1000 },
    { label: '5s', value: 5000 },
    { label: '15s', value: 15000 },
    { label: '30s', value: 30000 },
    { label: '60s', value: 60000 },
  ];

  function updateBalanceRefresh(event: Event) {
    const target = event.target as HTMLSelectElement;
    settingsOperations.setBalanceRefreshMs(Number(target.value));
  }

  function isRuntimeEnv(value: unknown): value is Env {
    if (!value || typeof value !== 'object') return false;
    const obj = value as { eReplicas?: unknown; jReplicas?: unknown };
    return obj.eReplicas instanceof Map && obj.jReplicas instanceof Map;
  }

  async function readJsonResponse(response: Response): Promise<any> {
    const raw = await response.text();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  // Copy address to clipboard
  async function copyAddress() {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    try {
      await navigator.clipboard.writeText(entityId);
      addressCopied = true;
      setTimeout(() => addressCopied = false, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // Get avatar URL
  $: avatarUrl = activeXlnFunctions?.generateEntityAvatar?.(tab.entityId) || '';

  // Format short address for display
  function formatAddress(addr: string): string {
    if (!addr) return '';
    if (addr.length <= 18) return addr;
    return `${addr.slice(0, 10)}...${addr.slice(-6)}`;
  }

  // Context
  const entityEnv = hasEntityEnvContext() ? getEntityEnv() : null;
  const contextReplicas = entityEnv?.eReplicas;
  const contextXlnFunctions = entityEnv?.xlnFunctions;
  const contextHistory = entityEnv?.history;
  const contextTimeIndex = entityEnv?.timeIndex;
  const contextEnv = entityEnv?.env;
  const contextIsLive = entityEnv?.isLive;

  // Reactive stores
  $: activeReplicas = contextReplicas ? $contextReplicas : $visibleReplicas;
  $: activeXlnFunctions = contextXlnFunctions ? $contextXlnFunctions : $xlnFunctions;
  $: activeHistory = contextHistory ? $contextHistory : $history;
  $: activeTimeIndex = contextTimeIndex !== undefined ? $contextTimeIndex : $currentTimeIndex;
  $: activeEnv = contextEnv ? $contextEnv : null;
  $: activeIsLive = contextIsLive !== undefined ? $contextIsLive : $isLive;

  // Get replica
  $: {
    if (tab.entityId && tab.signerId) {
      const replicaKey = `${tab.entityId}:${tab.signerId}`;
      replica = activeReplicas?.get?.(replicaKey) ?? null;
    } else {
      replica = null;
    }
  }

  // Navigation
  $: isAccountFocused = selectedAccountId !== null;
  $: selectedAccount = isAccountFocused && replica?.state?.accounts && selectedAccountId
    ? replica.state.accounts.get(selectedAccountId) : null;

  // Jurisdictions
  $: availableJurisdictions = (() => {
    const env = activeEnv;
    if (!env?.jReplicas) return [];
    if (env.jReplicas instanceof Map) return Array.from(env.jReplicas.values());
    if (Array.isArray(env.jReplicas)) return env.jReplicas;
    return Object.values(env.jReplicas || {});
  })() as Array<{ name?: string }>;

  $: {
    if (showJurisdiction && availableJurisdictions.length > 0 && !selectedJurisdictionName) {
      selectedJurisdictionName = (activeEnv as any)?.activeJurisdiction || availableJurisdictions[0]?.name;
    }
  }

  // Activity count
  $: {
    let activity = 0;
    if (replica?.state?.lockBook) activity += replica.state.lockBook.size;
    activityCount = activity;
  }

  // Contacts (persisted in localStorage)
  let contacts: Array<{ name: string; entityId: string }> = [];
  let newContactName = '';
  let newContactId = '';

  // Governance/Profile settings (REA flow: profile-update entityTx)
  let governanceName = '';
  let governanceBio = '';
  let governanceWebsite = '';
  let governanceSaving = false;
  let governanceLoadedForEntity = '';

  // On-chain reserves (from entityState; no RPC reads)
  let onchainReserves: Map<number, bigint> = new Map();
  let reservesLoading = true;
  let pendingReserveFaucets: Array<{
    tokenId: number;
    amount: bigint;
    expectedBalance: bigint;
    startedAt: number;
    symbol: string;
  }> = [];
  const RESERVE_FAUCET_TIMEOUT_MS = 15000;
  let pendingOffchainFaucets: Array<{
    entityId: string;
    amountLabel: string;
    tokenSymbol: string;
    startedAt: number;
  }> = [];
  const OFFCHAIN_FAUCET_TIMEOUT_MS = 30000;
  const seenPaymentFinalizeEvents = new Set<string>();

  // External tokens (ERC20 balances held by signer EOA)
  interface ExternalToken {
    symbol: string;
    address: string;
    balance: bigint;
    decimals: number;
    tokenId?: number;
  }
  let externalTokens: ExternalToken[] = [];
  let externalTokensLoading = true;
  let depositingToken: string | null = null; // symbol of token being deposited
  let collateralFundingToken: string | null = null; // symbol of token being moved to collateral

  // Faucet: fund entity reserves with test tokens
  function resolveReserveTokenMeta(tokenId: number, symbolHint?: string): { tokenId: number; symbol: string; decimals: number } {
    const byId = externalTokens.find(t => typeof t.tokenId === 'number' && t.tokenId === tokenId);
    if (byId) {
      return { tokenId: byId.tokenId as number, symbol: byId.symbol, decimals: byId.decimals ?? 18 };
    }
    if (symbolHint) {
      const bySymbol = externalTokens.find(t => t.symbol?.toUpperCase?.() === symbolHint.toUpperCase());
      if (bySymbol && typeof bySymbol.tokenId === 'number') {
        return { tokenId: bySymbol.tokenId, symbol: bySymbol.symbol, decimals: bySymbol.decimals ?? 18 };
      }
    }
    const info = getTokenInfo(tokenId);
    return { tokenId, symbol: info.symbol ?? 'UNK', decimals: info.decimals ?? 18 };
  }

  function parseTokenAmount(amount: string, decimals: number): bigint {
    const [wholeRaw, fracRaw = ''] = amount.split('.');
    const whole = wholeRaw && wholeRaw.length > 0 ? BigInt(wholeRaw) : 0n;
    const fracPadded = (fracRaw + '0'.repeat(decimals)).slice(0, decimals);
    const frac = fracPadded.length > 0 ? BigInt(fracPadded) : 0n;
    return whole * 10n ** BigInt(decimals) + frac;
  }

  async function faucetReserves(tokenId: number = 1, symbolHint?: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    try {
      const tokenMeta = resolveReserveTokenMeta(tokenId, symbolHint);
      const amountStr = tokenMeta.symbol === 'WETH' || tokenMeta.symbol === 'ETH' ? '0.1' : '100';
      const amountWei = parseTokenAmount(amountStr, tokenMeta.decimals);
      const currentBalance = onchainReserves.get(tokenMeta.tokenId) ?? 0n;
      const existingForToken = pendingReserveFaucets
        .filter((req) => req.tokenId === tokenMeta.tokenId)
        .sort((a, b) => b.startedAt - a.startedAt)[0];
      const baseExpected = existingForToken ? existingForToken.expectedBalance : currentBalance;
      const expectedBalance = baseExpected + amountWei;
      // Faucet B: Reserve transfer (ALWAYS use prod API, no BrowserVM fake)
      const response = await fetch(`${API_BASE}/api/faucet/reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          tokenId: tokenMeta.tokenId,
          tokenSymbol: tokenMeta.symbol,
          amount: amountStr
        })
      });

      const result = await readJsonResponse(response);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Faucet failed (${response.status})`);
      }

      console.log('[EntityPanel] Reserve faucet request queued:', result);
      pendingReserveFaucets = [...pendingReserveFaucets, {
        tokenId: tokenMeta.tokenId,
        amount: amountWei,
        expectedBalance,
        startedAt: Date.now(),
        symbol: tokenMeta.symbol,
      }];
      toasts.info(`Reserve faucet requested for ${tokenMeta.symbol}. Waiting for on-chain update...`);
    } catch (err) {
      console.error('[EntityPanel] Reserve faucet failed:', err);
      toasts.error(`Reserve faucet failed: ${(err as Error).message}`);
    }
  }

  async function faucetOffchain() {
    const entityId = replica?.state?.entityId || tab.entityId;
    if (!entityId) return;
    try {
      // Faucet C: Offchain payment (requires account with hub)
      const response = await fetch(`${API_BASE}/api/faucet/offchain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userEntityId: entityId,
          tokenId: 1, // USDC
          amount: '100'
        })
      });

      const result = await readJsonResponse(response);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Faucet failed (${response.status})`);
      }

      console.log('[EntityPanel] Offchain faucet success:', result);
      pendingOffchainFaucets = [...pendingOffchainFaucets, {
        entityId,
        amountLabel: '100',
        tokenSymbol: 'USDC',
        startedAt: Date.now(),
      }];
    } catch (err) {
      console.error('[EntityPanel] Offchain faucet failed:', err);
      toasts.error(`Offchain faucet failed: ${(err as Error).message}`);
    }
  }

  const TOKEN_CACHE_TTL_MS = 60_000;
  const tokenCatalogCache = new Map<string, { tokens: ExternalToken[]; expiresAt: number }>();

  function cloneTokenList(tokens: ExternalToken[]): ExternalToken[] {
    return tokens.map(t => ({ ...t, balance: 0n }));
  }

  async function getTokenList(jadapter: any): Promise<ExternalToken[]> {
    const cacheKey = String(jadapter?.chainId ?? 'unknown');
    const cached = tokenCatalogCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cloneTokenList(cached.tokens);
    }

    let tokens: ExternalToken[] = [];
    if (jadapter?.getTokenRegistry) {
      const registry = await jadapter.getTokenRegistry();
      if (registry?.length) {
        tokens = registry.map((t: any) => ({
          symbol: t.symbol,
          address: t.address,
          balance: 0n,
          decimals: typeof t.decimals === 'number' ? t.decimals : 18,
          tokenId: typeof t.tokenId === 'number' ? t.tokenId : undefined,
        }));
      }
    }

    if (tokens.length === 0) {
      const apiTokens = await fetchTokenCatalog();
      tokens = apiTokens.length > 0
        ? apiTokens.map(t => ({ ...t, balance: 0n }))
        : [];
    }

    tokenCatalogCache.set(cacheKey, { tokens: cloneTokenList(tokens), expiresAt: Date.now() + TOKEN_CACHE_TTL_MS });
    return cloneTokenList(tokens);
  }

  async function fetchOnchainReserves() {
    try {
      const newReserves = new Map<number, bigint>();
      const catalogTokenIds = externalTokens
        .map(t => t.tokenId)
        .filter((id): id is number => typeof id === 'number' && id > 0);
      const defaultTokenIds = catalogTokenIds.length > 0 ? catalogTokenIds : [1, 2, 3];
      for (const tokenId of defaultTokenIds) {
        newReserves.set(tokenId, 0n);
      }

      const reserves = replica?.state?.reserves;
      if (reserves) {
        for (const [tokenId, amount] of reserves.entries()) {
          const numericId = Number(tokenId);
          if (!Number.isNaN(numericId)) {
            newReserves.set(numericId, amount);
          }
        }
      }
      if (pendingReserveFaucets.length > 0) {
        console.log(`[EntityPanel] fetchOnchainReserves: replica=${replica?.state?.entityId?.slice(-4) || 'none'}`);
        console.log(`[EntityPanel]   reserves Map size: ${reserves?.size ?? 'null'}`);
        for (const [tid, amt] of reserves?.entries?.() ?? []) {
          console.log(`[EntityPanel]   token ${tid}: ${amt}`);
        }
      }
      onchainReserves = newReserves;
      if (pendingReserveFaucets.length > 0) {
        const now = Date.now();
        const remaining: typeof pendingReserveFaucets = [];
        for (const req of pendingReserveFaucets) {
          const current = newReserves.get(req.tokenId) ?? 0n;
          if (current >= req.expectedBalance) {
            toasts.success(`Received ${formatAmount(req.amount, getTokenInfo(req.tokenId).decimals)} ${req.symbol} in reserves!`);
          } else if (now - req.startedAt > RESERVE_FAUCET_TIMEOUT_MS) {
            toasts.error(`Reserve faucet timed out for ${req.symbol}. Check server logs.`);
          } else {
            remaining.push(req);
          }
        }
        pendingReserveFaucets = remaining;
      }
      reservesLoading = false;
    } catch (err) {
      console.error('[EntityPanel] Failed to fetch reserves:', err);
      reservesLoading = false;
    }
  }

  // Known token addresses for RPC mode (from deploy-tokens.cjs on anvil)
  async function fetchTokenCatalog(): Promise<ExternalToken[]> {
    try {
      const response = await fetch(`${API_BASE}/api/tokens`);
      if (!response.ok) return [];
      const data = await readJsonResponse(response);
      const tokens = Array.isArray(data?.tokens) ? data.tokens : [];
      if (tokens.length === 0) return [];
      return tokens.map((t: any) => ({
        symbol: t.symbol,
        address: t.address,
        balance: 0n,
        decimals: typeof t.decimals === 'number' ? t.decimals : 18,
        tokenId: typeof t.tokenId === 'number' ? t.tokenId : undefined,
      }));
    } catch {
      return [];
    }
  }

  // Fetch external tokens (ERC20 balances for signer) - works for both BrowserVM and RPC modes
  async function fetchExternalTokens() {
    const signerId = tab.signerId;
    if (!signerId) {
      externalTokensLoading = false;
      return;
    }

    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      // CRITICAL: Use activeEnv from context, NOT xln.getEnv() which returns wrong module-level env
      const jadapter = xln.getActiveJAdapter?.(activeEnv as any);

      const tokenList = await getTokenList(jadapter);
      let nativeToken: ExternalToken | null = null;
      // Include native ETH balance (external funds) when possible
      if (jadapter?.provider && isAddress(signerId)) {
        try {
          const nativeBalance = await jadapter.provider.getBalance(signerId);
          nativeToken = {
            symbol: 'ETH',
            address: ZeroAddress,
            balance: nativeBalance,
            decimals: 18,
            tokenId: 0,
          };
        } catch (err) {
          console.warn('[EntityPanel] Failed to fetch native ETH balance:', err);
        }
      }
      if (!jadapter?.getErc20Balance) {
        externalTokens = tokenList;
        externalTokensLoading = false;
        return;
      }

      if (jadapter.getErc20Balances) {
        try {
          const balances = await jadapter.getErc20Balances(tokenList.map(t => t.address), signerId);
          balances.forEach((balance: bigint, idx: number) => {
            if (tokenList[idx]) tokenList[idx].balance = balance;
          });
        } catch (err) {
          console.warn('[EntityPanel] Batch balance fetch failed, falling back to per-token:', err);
          for (const token of tokenList) {
            try {
              token.balance = await jadapter.getErc20Balance(token.address, signerId);
            } catch (innerErr) {
              console.warn(`[EntityPanel] Failed to fetch ${token.symbol} balance:`, innerErr);
            }
          }
        }
      } else {
        for (const token of tokenList) {
          try {
            token.balance = await jadapter.getErc20Balance(token.address, signerId);
          } catch (err) {
            console.warn(`[EntityPanel] Failed to fetch ${token.symbol} balance:`, err);
          }
        }
      }

      externalTokens = nativeToken ? [nativeToken, ...tokenList] : tokenList;
      externalTokensLoading = false;
    } catch (err) {
      console.error('[EntityPanel] Failed to fetch external tokens:', err);
      externalTokensLoading = false;
    }
  }

  // Deposit ERC20 token to entity reserve
  async function depositToReserve(token: ExternalToken) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = tab.signerId;
    if (!entityId || !signerId || token.balance <= 0n) return;
    if (!activeIsLive) {
      toasts.error('Deposit requires LIVE mode');
      return;
    }

    depositingToken = token.symbol;
    try {
      const { getXLN } = await import('$lib/stores/xlnStore');
      const xln = await getXLN();
      // CRITICAL: Use activeEnv from context, NOT xln.getEnv() which returns wrong module-level env
      const jadapter = xln.getActiveJAdapter?.(activeEnv as any);
      if (!jadapter?.externalTokenToReserve) {
        throw new Error('J-adapter deposit not available');
      }

      // Get signer's private key from runtime
      let seed = activeEnv?.runtimeSeed;
      if (!seed) {
        const vault = get(activeVault);
        if (vault?.seed) {
          seed = vault.seed;
        }
      }
      if (!seed) {
        throw new Error('No runtime seed available (unlock vault or load runtime)');
      }

      const privKey = xln.deriveSignerKeySync?.(seed, signerId);
      if (!privKey) {
        throw new Error('Cannot derive signer private key');
      }
      xln.registerSignerKey?.(signerId, privKey);

      // Ensure signer has gas for approve/deposit (RPC mode only)
      if (jadapter?.mode !== 'browservm') {
        let ownerAddress = signerId;
        try {
          ownerAddress = new EthersWallet(hexlify(privKey)).address;
        } catch {
          // Fallback to signerId if wallet derivation fails
        }
        try {
          await fetch(`${API_BASE}/api/faucet/gas`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              userAddress: ownerAddress,
              amount: '0.1',
            }),
          });
        } catch (err) {
          console.warn('[EntityPanel] Gas faucet failed (continuing):', err);
        }
      }

      // Deposit all available balance
      await jadapter.externalTokenToReserve(privKey, entityId, token.address, token.balance);

      console.log(`[EntityPanel] Deposited ${token.symbol} to entity reserves`);

      // Refresh both balances
      await Promise.all([fetchOnchainReserves(), fetchExternalTokens()]);
    } catch (err) {
      console.error('[EntityPanel] Deposit failed:', err);
      toasts.error(`Deposit failed: ${(err as Error).message}`);
    } finally {
      depositingToken = null;
    }
  }

  // Reserve → Collateral (deposit reserves into selected bilateral account)
  async function reserveToCollateral(tokenId: number) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = tab.signerId;
    if (!entityId || !signerId) return;

    if (!selectedAccountId) {
      toasts.error('Select an account to deposit collateral');
      return;
    }

    if (!activeIsLive) {
      toasts.error('Deposit requires LIVE mode');
      return;
    }

    const amount = onchainReserves.get(tokenId) ?? 0n;
    if (amount <= 0n) {
      toasts.error('No reserve balance for this token');
      return;
    }

    const accounts = replica?.state?.accounts;
    if (!accounts || !accounts.has(selectedAccountId)) {
      toasts.error('No account found for selected counterparty');
      return;
    }

    const info = getTokenInfo(tokenId);
    collateralFundingToken = info.symbol;
    try {
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');

      await processWithDelay(env as any, [{
        entityId,
        signerId,
        entityTxs: [
          {
            type: 'deposit_collateral' as const,
            data: {
              counterpartyId: selectedAccountId,
              tokenId,
              amount,
            },
          },
          {
            type: 'j_broadcast',
            data: {},
          },
        ],
      }]);

      toasts.info(`R→C queued for ${info.symbol}. Waiting for on-chain update...`);
    } catch (err) {
      console.error('[EntityPanel] Reserve → Collateral failed:', err);
      toasts.error(`Reserve → Collateral failed: ${(err as Error).message}`);
    } finally {
      collateralFundingToken = null;
    }
  }

  async function openAccountWithFullId(targetEntityId: string) {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = tab.signerId;
    const trimmed = targetEntityId.trim();
    if (!entityId || !signerId) return;
    if (!trimmed.startsWith('0x') || trimmed.length !== 66) {
      toasts.error('Full entity ID required (0x + 64 hex chars)');
      return;
    }
    if (!activeIsLive) {
      toasts.error('Open account requires LIVE mode');
      return;
    }
    try {
      const env = activeEnv;
      if (!env) throw new Error('Environment not ready');
      await processWithDelay(env as any, [{
        entityId,
        signerId,
        entityTxs: [{
          type: 'openAccount' as const,
          data: { targetEntityId: trimmed },
        }],
      }]);
      openAccountEntityId = '';
      toasts.success('Account request sent');
    } catch (err) {
      console.error('[EntityPanel] Open account failed:', err);
      toasts.error(`Open account failed: ${(err as Error).message}`);
    }
  }

  // Faucet external tokens (ERC20 to signer EOA)
  async function faucetExternalTokens(tokenSymbol: string = 'USDC') {
    const signerId = tab.signerId;
    if (!signerId) return;

    try {
      const amount = tokenSymbol === 'ETH' ? '0.1' : '100';
      const isEth = tokenSymbol === 'ETH';
      const endpoint = isEth ? `${API_BASE}/api/faucet/gas` : `${API_BASE}/api/faucet/erc20`;
      const payload = isEth
        ? { userAddress: signerId, amount }
        : { userAddress: signerId, tokenSymbol, amount };
      // Faucet A: ERC20 to wallet (or native ETH gas faucet)
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const result = await readJsonResponse(response);
      if (!response.ok || !result?.success) {
        throw new Error(result?.error || `Faucet failed (${response.status})`);
      }

      console.log('[EntityPanel] External faucet success:', result);
      toasts.success(`Received ${amount} ${tokenSymbol} in wallet!`);

      // Refresh external tokens
      setTimeout(() => fetchExternalTokens(), 1000);
    } catch (err) {
      console.error('[EntityPanel] External faucet failed:', err);
      toasts.error(`External faucet failed: ${(err as Error).message}`);
    }
  }

  function refreshBalances() {
    fetchOnchainReserves();
    fetchExternalTokens();
  }

  let lastEntityId = '';
  let lastSignerId = '';
  $: if (tab.entityId !== lastEntityId || tab.signerId !== lastSignerId) {
    lastEntityId = tab.entityId || '';
    lastSignerId = tab.signerId || '';
    refreshBalances();
  }

  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  $: {
    if (refreshTimer) clearInterval(refreshTimer);
    const refreshMs = $settings.balanceRefreshMs ?? 15000;
    if (refreshMs > 0) {
      refreshTimer = setInterval(() => refreshBalances(), refreshMs);
    }
  }

  onDestroy(() => {
    if (refreshTimer) clearInterval(refreshTimer);
  });

  onMount(() => {
    const saved = localStorage.getItem('xln-contacts');
    if (saved) contacts = JSON.parse(saved);

    // Fetch reserves and external tokens on mount
    refreshBalances();
  });

  function makeEventKey(snapshot: any, log: any, snapshotIndex: number): string {
    const h = snapshot?.height ?? snapshotIndex;
    const id = log?.id ?? -1;
    const ts = log?.timestamp ?? 0;
    return `${h}:${id}:${ts}`;
  }

  function maybeFinalizeOffchainFaucet() {
    if (pendingOffchainFaucets.length === 0 || !Array.isArray(activeHistory) || activeHistory.length === 0) return;

    const pendingByEntity = new Map<string, Array<typeof pendingOffchainFaucets[number]>>();
    for (const req of pendingOffchainFaucets) {
      const key = req.entityId.toLowerCase();
      const arr = pendingByEntity.get(key) ?? [];
      arr.push(req);
      pendingByEntity.set(key, arr);
    }
    for (const arr of pendingByEntity.values()) {
      arr.sort((a, b) => a.startedAt - b.startedAt);
    }

    // Scan recent history only; finalize event should appear shortly after request.
    const startIndex = Math.max(0, activeHistory.length - 120);
    for (let i = startIndex; i < activeHistory.length; i += 1) {
      const snapshot: any = activeHistory[i];
      const logs: any[] = Array.isArray(snapshot?.logs) ? snapshot.logs : [];
      for (const log of logs) {
        if (log?.message !== 'PaymentFinalized') continue;
        if (typeof log?.timestamp === 'number' && log.timestamp < cutoffTs) continue;

        const data = (log?.data || {}) as Record<string, unknown>;
        const rawEntityId = data['entityId'];
        const logEntity = typeof rawEntityId === 'string' ? rawEntityId.toLowerCase() : '';
        const queue = pendingByEntity.get(logEntity);
        if (!queue || queue.length === 0) continue;

        // We only want the final recipient confirmation, not sender-side completion.
        const isFinalRecipient = !data['outboundEntity'];
        if (!isFinalRecipient) continue;

        const eventKey = makeEventKey(snapshot, log, i);
        if (seenPaymentFinalizeEvents.has(eventKey)) continue;
        seenPaymentFinalizeEvents.add(eventKey);
        if (seenPaymentFinalizeEvents.size > 2000) {
          // Prevent unbounded growth on long-lived tabs.
          seenPaymentFinalizeEvents.clear();
          seenPaymentFinalizeEvents.add(eventKey);
        }

        const ts = typeof log?.timestamp === 'number' ? log.timestamp : Date.now();
        const matchIndex = queue.findIndex((req) => req.startedAt <= ts);
        const req = matchIndex >= 0 ? queue.splice(matchIndex, 1)[0] : queue.shift();
        if (req) {
          toasts.success(`Received $${req.amountLabel} ${req.tokenSymbol} via offchain payment!`);
        }
      }
    }

    const now = Date.now();
    for (const [entityKey, queue] of pendingByEntity.entries()) {
      for (const req of queue) {
        if (now - req.startedAt > OFFCHAIN_FAUCET_TIMEOUT_MS) {
          toasts.error(`Offchain faucet timed out for ${entityKey.slice(0, 10)}...`);
        }
      }
      pendingByEntity.set(entityKey, queue.filter((req) => now - req.startedAt <= OFFCHAIN_FAUCET_TIMEOUT_MS));
    }

    pendingOffchainFaucets = Array.from(pendingByEntity.values()).flat();
  }

  $: if (pendingOffchainFaucets.length > 0 && Array.isArray(activeHistory)) {
    maybeFinalizeOffchainFaucet();
  }
  $: if (activeTab === 'governance') {
    loadGovernanceProfileFromGossip();
  }

  function saveContact() {
    if (!newContactName.trim() || !newContactId.trim()) return;
    contacts = [...contacts, { name: newContactName.trim(), entityId: newContactId.trim() }];
    localStorage.setItem('xln-contacts', JSON.stringify(contacts));
    newContactName = '';
    newContactId = '';
  }

  function deleteContact(idx: number) {
    contacts = contacts.filter((_, i) => i !== idx);
    localStorage.setItem('xln-contacts', JSON.stringify(contacts));
  }

  function loadGovernanceProfileFromGossip() {
    const currentEntityId = (replica?.state?.entityId || tab.entityId || '').toLowerCase();
    if (!currentEntityId || governanceLoadedForEntity === currentEntityId) return;
    governanceLoadedForEntity = currentEntityId;
    const profiles = (activeEnv?.gossip?.getProfiles?.() || []) as Array<{
      entityId?: string;
      metadata?: { name?: string; bio?: string; website?: string };
    }>;
    const profile = profiles.find((p) => String(p?.entityId || '').toLowerCase() === currentEntityId);
    const metadata = profile?.metadata;
    governanceName = String(metadata?.name || '');
    governanceBio = String(metadata?.bio || '');
    governanceWebsite = String(metadata?.website || '');
  }

  async function saveGovernanceProfile() {
    const entityId = replica?.state?.entityId || tab.entityId;
    const signerId = tab.signerId;
    const env = activeEnv;
    if (!entityId || !signerId) {
      toasts.error('Entity/signer is required for governance profile update');
      return;
    }
    if (!isRuntimeEnv(env) || !activeIsLive) {
      toasts.error('Governance profile updates require LIVE mode');
      return;
    }

    governanceSaving = true;
    try {
      const profileUpdateInput = {
        entityId,
        signerId,
        entityTxs: [{
          type: 'profile-update' as const,
          data: {
            profile: {
              entityId,
              name: governanceName.trim(),
              bio: governanceBio.trim(),
              website: governanceWebsite.trim(),
              hankoSignature: '',
            },
          },
        }],
      };
      await processWithDelay(env, [profileUpdateInput]);
      toasts.success('Governance profile update submitted');
      governanceLoadedForEntity = '';
      loadGovernanceProfileFromGossip();
    } catch (err) {
      toasts.error(`Governance profile update failed: ${(err as Error).message}`);
    } finally {
      governanceSaving = false;
    }
  }

  // Formatting
  function getTokenInfo(tokenId: number) {
    return activeXlnFunctions?.getTokenInfo(tokenId) ?? { symbol: 'UNK', decimals: 18 };
  }

  function formatAmount(amount: bigint, decimals: number): string {
    const divisor = BigInt(10) ** BigInt(decimals);
    const whole = amount / divisor;
    const frac = amount % divisor;
    if (frac === 0n) return whole.toLocaleString();
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 2);
    return `${whole.toLocaleString()}.${fracStr}`;
  }

  function formatCompact(value: number): string {
    if (!$settings.compactNumbers) {
      return '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (value >= 1_000_000) return '$' + (value / 1_000_000).toFixed(2) + 'M';
    if (value >= 1_000) return '$' + (value / 1_000).toFixed(2) + 'K';
    return '$' + value.toFixed(2);
  }

  const PRICE_BY_SYMBOL: Record<string, number> = {
    USDC: 1,
    USDT: 1,
    WETH: 2500,
    ETH: 2500,
  };

  function getAssetPrice(symbol: string): number {
    return PRICE_BY_SYMBOL[symbol.toUpperCase()] ?? 0;
  }

  function getAssetValue(tokenId: number, amount: bigint, symbolOverride?: string): number {
    const info = getTokenInfo(tokenId);
    const symbol = symbolOverride ?? info.symbol ?? 'UNK';
    const divisor = BigInt(10) ** BigInt(info.decimals);
    const numericAmount = Number(amount) / Number(divisor);
    const price = getAssetPrice(symbol);
    return numericAmount * price;
  }

  function getExternalValue(token: ExternalToken): number {
    const divisor = BigInt(10) ** BigInt(token.decimals ?? 18);
    const numericAmount = Number(token.balance) / Number(divisor);
    const price = getAssetPrice(token.symbol);
    return numericAmount * price;
  }

  function calculatePortfolioValue(reserves: Map<number | string, bigint>): number {
    let total = 0;
    for (const [tokenId, amount] of reserves.entries()) {
      total += getAssetValue(Number(tokenId), amount);
    }
    return total;
  }

  // Calculate totals for the three buckets
  $: externalTotal = (() => {
    let total = 0;
    for (const token of externalTokens) {
      if (token.balance > 0n) {
        total += getExternalValue(token);
      }
    }
    return total;
  })();

  $: reservesTotal = calculatePortfolioValue(onchainReserves);

  $: accountsData = (() => {
    let collateral = 0;
    let credit = 0;
    let count = 0;
    if (replica?.state?.accounts) {
      for (const [_, account] of replica.state.accounts.entries()) {
        count++;
        if (account.deltas) {
          for (const [tokenId, delta] of account.deltas.entries()) {
            const info = getTokenInfo(Number(tokenId));
            const divisor = BigInt(10) ** BigInt(info.decimals);
            const price = getAssetPrice(info.symbol ?? 'UNK');
            // Collateral is what we've put in
            if (delta.collateral > 0n) {
              collateral += (Number(delta.collateral) / Number(divisor)) * price;
            }
            // Credit is positive delta (what counterparty owes us)
            const totalDelta = delta.ondelta + delta.offdelta;
            if (totalDelta > 0n) {
              credit += (Number(totalDelta) / Number(divisor)) * price;
            }
          }
        }
      }
    }
    return { collateral, credit, count, total: collateral + credit };
  })();

  $: netWorth = externalTotal + reservesTotal + accountsData.total;

  // Handlers
  function handleEntitySelect(event: CustomEvent) {
    const { jurisdiction, signerId, entityId } = event.detail;
    selectedAccountId = null;
    tab = { ...tab, jurisdiction, signerId, entityId };
  }

  function handleAccountSelect(event: CustomEvent) {
    selectedAccountId = event.detail.accountId;
  }

  function handleJurisdictionSelect(event: CustomEvent<{ selected: string | null }>) {
    const next = event.detail?.selected;
    if (next) selectedJurisdictionName = next;
  }

  function handleBackToAccounts() {
    selectedAccountId = null;
    activeTab = 'accounts';
  }

  function openOnchainDeposit(tokenId: number) {
    onchainPrefill = { tokenId, id: Date.now() };
    activeTab = 'onj';
  }

  function goToLive() {
    // Jump to live frame
    timeOperations.goToLive();
  }

  // Tab config
  // Pending batch count for On-Chain tab badge
  $: pendingBatchCount = (() => {
    if (!replica?.state) return 0;
    const batch = (replica.state as any)?.jBatchState?.batch;
    if (!batch) return 0;
    return (batch.reserveToCollateral?.length || 0) +
           (batch.collateralToReserve?.length || 0) +
           (batch.settlements?.length || 0) +
           (batch.reserveToReserve?.length || 0);
  })();

  const tabs: Array<{ id: ViewTab; icon: any; label: string; showBadge?: boolean; badgeType?: 'activity' | 'pending' }> = [
    { id: 'external', icon: Wallet, label: 'External' },
    { id: 'reserves', icon: Landmark, label: 'Reserves' },
    { id: 'accounts', icon: Users, label: 'Accounts' },
    { id: 'send', icon: ArrowUpRight, label: 'Send' },
    { id: 'swap', icon: Repeat, label: 'Swap' },
    { id: 'onj', icon: Landmark, label: 'On-Chain', showBadge: true, badgeType: 'pending' },
    { id: 'activity', icon: Activity, label: 'Activity', showBadge: true, badgeType: 'activity' },
    { id: 'chat', icon: MessageCircle, label: 'Chat' },
    { id: 'contacts', icon: BookUser, label: 'Contacts' },
    { id: 'receive', icon: ArrowDownLeft, label: 'Receive' },
    { id: 'create', icon: PlusCircle, label: 'Create' },
    { id: 'gossip', icon: Globe, label: 'Gossip' },
    { id: 'governance', icon: Scale, label: 'Governance' },
    { id: 'settings', icon: SettingsIcon, label: 'Settings' },
  ];
</script>

<div class="entity-panel" data-panel-id={tab.id}>
  <!-- Header -->
  {#if !hideHeader}
    <header class="header">
      {#if showJurisdiction}
        <JurisdictionDropdown
          bind:selected={selectedJurisdictionName}
          on:select={handleJurisdictionSelect}
        />
      {/if}
      <EntityDropdown
        {tab}
        on:entitySelect={handleEntitySelect}
      />
      {#if replica}
        <AccountDropdown
          {replica}
          {selectedAccountId}
          on:accountSelect={handleAccountSelect}
        />
      {/if}
    </header>
  {/if}

  <!-- Historical Mode Warning -->
  {#if !activeIsLive}
    <div class="history-warning" on:click={goToLive}>
      <AlertTriangle size={14} />
      <span>Viewing historical state. Click to go LIVE.</span>
    </div>
  {/if}

  <!-- Main Content - SINGLE SCROLL -->
  <main class="main-scroll">
    {#if !tab.entityId || !tab.signerId}
      <div class="empty-state">
        <Wallet size={40} />
        <h3>Select Entity</h3>
        <p>Choose from the dropdown above</p>
      </div>

    {:else if isAccountFocused && selectedAccount && selectedAccountId}
      <div class="focused-view">
        <button class="back-btn" on:click={handleBackToAccounts}>
          Back to Entity
        </button>
        <div class="focused-title">
          Account with {selectedAccountId}
        </div>
        <AccountPanel
          account={selectedAccount}
          counterpartyId={selectedAccountId}
          entityId={tab.entityId}
          on:back={handleBackToAccounts}
        />
      </div>

    {:else if replica}
      <!-- Hero: Entity + Net Worth -->
      <section class="hero">
        <div class="hero-left">
          {#if avatarUrl}
            <img src={avatarUrl} alt="Entity avatar" class="hero-avatar" />
          {:else}
            <div class="hero-avatar placeholder">
              {activeXlnFunctions?.getEntityShortId?.(tab.entityId)?.slice(0,2) || '??'}
            </div>
          {/if}
          <div class="hero-identity">
            <span class="hero-name">Entity {replica?.state?.entityId || tab.entityId}</span>
            <button class="hero-address" on:click={copyAddress} title="Copy address">
              <span>{formatAddress(replica?.state?.entityId || tab.entityId)}</span>
              {#if addressCopied}
                <Check size={10} />
              {:else}
                <Copy size={10} />
              {/if}
            </button>
          </div>
        </div>
        <div class="hero-right">
          <div class="hero-networth">{formatCompact(netWorth)}</div>
          <div class="hero-label">Net Worth</div>
        </div>
      </section>

      <!-- Breakdown Cards -->
      <section class="breakdown">
        <button class="breakdown-card" class:active={activeTab === 'external'} on:click={() => activeTab = 'external'}>
          <div class="card-value">{formatCompact(externalTotal)}</div>
          <div class="card-label">External</div>
          <div class="card-sub">{externalTokens.filter(t => t.balance > 0n).length} tokens</div>
        </button>
        <button class="breakdown-card" class:active={activeTab === 'reserves'} on:click={() => activeTab = 'reserves'}>
          <div class="card-value">{formatCompact(reservesTotal)}</div>
          <div class="card-label">Reserves</div>
          <div class="card-sub">{Array.from(onchainReserves.values()).filter(v => v > 0n).length} tokens</div>
        </button>
        <button class="breakdown-card wide" class:active={activeTab === 'accounts'} on:click={() => activeTab = 'accounts'}>
          <div class="card-value">{formatCompact(accountsData.total)}</div>
          <div class="card-label">Accounts</div>
          <div class="card-sub">
            {#if accountsData.count > 0}
              {accountsData.count} channel{accountsData.count !== 1 ? 's' : ''}
            {:else}
              No channels
            {/if}
          </div>
        </button>
      </section>

      <!-- Tab Bar -->
      <nav class="tabs">
        {#each tabs as t}
          <button
            class="tab"
            class:active={activeTab === t.id}
            data-testid={`tab-${t.id}`}
            on:click={() => activeTab = t.id}
          >
            <svelte:component this={t.icon} size={15} />
            <span>{t.label}</span>
            {#if t.showBadge && t.badgeType === 'activity' && activityCount > 0}
              <span class="badge">{activityCount}</span>
            {:else if t.showBadge && t.badgeType === 'pending' && pendingBatchCount > 0}
              <span class="badge pending">{pendingBatchCount}</span>
            {/if}
          </button>
        {/each}
      </nav>

      <!-- Tab Content -->
      <section class="content">
        {#if activeTab === 'external'}
          <!-- External Tokens (ERC20 wallet balances) - Horizontal Table -->
          <div class="tab-header-row">
            <h4 class="section-head" style="margin: 0;">External Tokens (ERC20)</h4>
            <div class="header-actions">
              <select class="auto-refresh-select" value={$settings.balanceRefreshMs ?? 15000} on:change={updateBalanceRefresh}>
                {#each REFRESH_OPTIONS as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
              <button class="btn-refresh-small" on:click={() => fetchExternalTokens()} disabled={externalTokensLoading}>
                {externalTokensLoading ? '...' : 'Refresh'}
              </button>
            </div>
          </div>
          <p class="muted wallet-label">Wallet: {tab.signerId?.slice(0, 8)}...{tab.signerId?.slice(-4)}</p>

          {#if externalTokensLoading}
            <div class="loading-row">
              <div class="loading-spinner"></div>
              <span>Loading...</span>
            </div>
          {:else}
            <!-- Table Header -->
            <div class="token-table-header">
              <span class="col-token">Token</span>
              <span class="col-balance">Balance</span>
              <span class="col-value">Value</span>
              <span class="col-actions">Actions</span>
            </div>
            <!-- Table Rows -->
            <div class="token-table">
              {#each externalTokens as token}
                <div class="token-table-row" class:has-balance={token.balance > 0n}>
                  <div class="col-token">
                    <span class="token-icon-small" class:usdc={token.symbol === 'USDC'} class:weth={token.symbol === 'WETH'} class:usdt={token.symbol === 'USDT'}>
                      {token.symbol.slice(0, 1)}
                    </span>
                    <span class="token-name">{token.symbol}</span>
                  </div>
                  <div class="col-balance">
                    <span class="balance-text" class:zero={token.balance === 0n}>
                      {formatAmount(token.balance, token.decimals)}
                    </span>
                  </div>
                  <div class="col-value">
                    <span class="value-text">{formatCompact(getExternalValue(token))}</span>
                  </div>
                  <div class="col-actions">
                    <button
                      class="btn-table-action faucet"
                      on:click={() => faucetExternalTokens(token.symbol)}
                      title="Faucet"
                    >
                      Faucet
                    </button>
                    <button
                      class="btn-table-action deposit"
                      on:click={() => depositToReserve(token)}
                      disabled={depositingToken === token.symbol || token.balance === 0n || token.symbol === 'ETH'}
                      title={token.symbol === 'ETH' ? 'ETH deposit not supported (use WETH)' : 'Deposit to Reserve'}
                    >
                      {depositingToken === token.symbol ? '...' : 'Deposit to Reserve'}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

        {:else if activeTab === 'reserves'}
          <!-- Reserves Detail (Depository.sol balances) - Horizontal Table -->
          <div class="tab-header-row">
            <h4 class="section-head" style="margin: 0;">On-Chain Reserves</h4>
            <div class="header-actions">
              <select class="auto-refresh-select" value={$settings.balanceRefreshMs ?? 15000} on:change={updateBalanceRefresh}>
                {#each REFRESH_OPTIONS as opt}
                  <option value={opt.value}>{opt.label}</option>
                {/each}
              </select>
              <button class="btn-refresh-small" on:click={() => fetchOnchainReserves()} disabled={reservesLoading}>
                {reservesLoading ? '...' : 'Refresh'}
              </button>
            </div>
          </div>
          <p class="muted wallet-label">Entity: {replica?.state?.entityId || tab.entityId}</p>

          {#if reservesLoading}
            <div class="loading-row">
              <div class="loading-spinner"></div>
              <span>Loading...</span>
            </div>
          {:else}
            <!-- Table Header -->
            <div class="token-table-header">
              <span class="col-token">Token</span>
              <span class="col-balance">Balance</span>
              <span class="col-value">Value</span>
              <span class="col-actions">Actions</span>
            </div>
            <!-- Table Rows -->
            <div class="token-table">
              {#each Array.from(onchainReserves.entries()) as [tokenId, amount]}
                {@const info = resolveReserveTokenMeta(Number(tokenId))}
                {@const value = getAssetValue(Number(tokenId), amount)}
                <div class="token-table-row" class:has-balance={amount > 0n} data-testid={`reserve-row-${info.symbol}`}>
                  <div class="col-token">
                    <span class="token-icon-small" class:usdc={info.symbol === 'USDC'} class:weth={info.symbol === 'WETH' || info.symbol === 'ETH'} class:usdt={info.symbol === 'USDT'}>
                      {info.symbol.slice(0, 1)}
                    </span>
                    <span class="token-name">{info.symbol}</span>
                  </div>
                  <div class="col-balance">
                    <span class="balance-text" class:zero={amount === 0n} data-testid={`reserve-balance-${info.symbol}`}>
                      {formatAmount(amount, info.decimals)}
                    </span>
                  </div>
                  <div class="col-value">
                    <span class="value-text">{formatCompact(value)}</span>
                  </div>
                  <div class="col-actions">
                    <button
                      class="btn-table-action faucet"
                      data-testid={`reserve-faucet-${info.symbol}`}
                      on:click={() => faucetReserves(Number(tokenId), info.symbol)}
                    >
                      Faucet
                    </button>
                    <button
                      class="btn-table-action collateral"
                      on:click={() => openOnchainDeposit(Number(tokenId))}
                      disabled={collateralFundingToken === info.symbol}
                      title="Deposit reserve to account"
                    >
                      {collateralFundingToken === info.symbol ? '...' : 'Deposit to Account'}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}

        {:else if activeTab === 'send'}
          <PaymentPanel entityId={replica.state?.entityId || tab.entityId} {contacts} />

        {:else if activeTab === 'swap'}
          <SwapPanel {replica} {tab} />

        {:else if activeTab === 'onj'}
          {#if !activeIsLive}
            <div class="live-required">
              <AlertTriangle size={20} />
              <p>On-chain actions require LIVE mode</p>
              <button class="btn-live" on:click={goToLive}>Go to LIVE</button>
            </div>
          {:else}
            {#if !replica?.state?.accounts || replica.state.accounts.size === 0}
              <div class="live-required" style="margin-bottom: 12px;">
                <AlertTriangle size={20} />
                <p>No accounts yet. Open one in Accounts (hubs or private).</p>
                <button class="btn-live" on:click={() => activeTab = 'accounts'}>Open Accounts</button>
              </div>
            {/if}
            <SettlementPanel entityId={replica.state?.entityId || tab.entityId} {contacts} prefill={onchainPrefill} />
          {/if}

        {:else if activeTab === 'accounts'}
          <button class="btn-faucet" on:click={faucetOffchain}>
            💧 Get Test Funds (Offchain)
            {#if pendingOffchainFaucets.length > 0}
              ({pendingOffchainFaucets.length} pending)
            {/if}
          </button>
          <AccountList {replica} on:select={handleAccountSelect} />
          <div class="account-open-sections">
            <div class="open-section">
              <h4 class="section-head">Open with Public Hub</h4>
              <HubDiscoveryPanel entityId={replica?.state?.entityId || tab.entityId} />
            </div>
            <div class="open-section">
              <h4 class="section-head">Open Private Account</h4>
              <div class="add-contact">
                <input type="text" placeholder="Full Entity ID (0x...)" bind:value={openAccountEntityId} />
                <button class="btn-add" on:click={() => openAccountWithFullId(openAccountEntityId)}>Open</button>
              </div>
              <div class="muted" style="margin-top: 6px;">Only full entity IDs are accepted.</div>
            </div>
          </div>

        {:else if activeTab === 'activity'}
          {#if replica.state?.lockBook && replica.state.lockBook.size > 0}
            <h4 class="section-head">Pending HTLCs</h4>
            {#each Array.from(replica.state.lockBook.entries()) as [lockId, lock]}
              <div class="activity-row">
                <span class="a-icon">lock</span>
                <div class="a-info">
                  <span class="a-title">#{lockId.slice(0, 8)}</span>
                  <span class="a-sub">{lock.direction}</span>
                </div>
                <span class="a-amt">{formatAmount(lock.amount, 6)}</span>
              </div>
            {/each}
          {/if}
          <h4 class="section-head">Consensus</h4>
          <ConsensusState {replica} />
          <h4 class="section-head">Proposals</h4>
          <ProposalsList {replica} {tab} />

        {:else if activeTab === 'chat'}
          <ChatMessages {replica} {tab} currentTimeIndex={activeTimeIndex ?? -1} />

        {:else if activeTab === 'contacts'}
          <h4 class="section-head">Saved Contacts</h4>
          {#if contacts.length === 0}
            <p class="muted">No contacts saved yet</p>
          {:else}
            {#each contacts as contact, idx}
              <div class="contact-row">
                <div class="c-info">
                  <span class="c-name">{contact.name}</span>
                  <span class="c-id">{contact.entityId}</span>
                </div>
                <button class="c-delete" on:click={() => deleteContact(idx)}>x</button>
              </div>
            {/each}
          {/if}

          <h4 class="section-head">Add Contact</h4>
          <div class="add-contact">
            <input type="text" placeholder="Name" bind:value={newContactName} />
            <input type="text" placeholder="Full Entity ID (0x...)" bind:value={newContactId} />
            <button class="btn-add" on:click={saveContact}>Add</button>
          </div>

        {:else if activeTab === 'receive'}
          <QRPanel entityId={replica?.state?.entityId || tab.entityId} />

        {:else if activeTab === 'create'}
          <FormationPanel />

        {:else if activeTab === 'gossip'}
          <GossipPanel entityId={replica?.state?.entityId || tab.entityId} />

        {:else if activeTab === 'governance'}
          <h4 class="section-head">Entity Governance Profile</h4>
          <p class="muted">Updates are submitted through REA as `profile-update` entity transactions.</p>
          <div class="setting-block">
            <label>Display Name</label>
            <input
              type="text"
              bind:value={governanceName}
              placeholder="Entity name"
              maxlength="64"
            />
          </div>
          <div class="setting-block">
            <label>Bio</label>
            <input
              type="text"
              bind:value={governanceBio}
              placeholder="Short description"
              maxlength="180"
            />
          </div>
          <div class="setting-block">
            <label>Website</label>
            <input
              type="url"
              bind:value={governanceWebsite}
              placeholder="https://"
              maxlength="160"
            />
          </div>
          <button class="btn-add" on:click={saveGovernanceProfile} disabled={governanceSaving}>
            {governanceSaving ? 'Submitting...' : 'Save Governance Profile'}
          </button>

        {:else if activeTab === 'settings'}
          <div class="setting-row">
            <span>Compact Numbers</span>
            <button class="toggle" class:on={$settings.compactNumbers}
              on:click={() => settingsOperations.setCompactNumbers(!$settings.compactNumbers)}>
              {$settings.compactNumbers ? 'On' : 'Off'}
            </button>
          </div>
          <div class="setting-row">
            <span>Verbose Logging</span>
            <button class="toggle" class:on={$settings.verboseLogging}
              on:click={() => settingsOperations.setVerboseLogging(!$settings.verboseLogging)}>
              {$settings.verboseLogging ? 'On' : 'Off'}
            </button>
          </div>
          <div class="setting-block">
            <label>Entity ID</label>
            <code>{tab.entityId}</code>
          </div>
          <div class="setting-block">
            <label>Signer ID</label>
            <code>{tab.signerId}</code>
          </div>
          <div class="setting-block">
            <label>Jurisdiction</label>
            <code>{selectedJurisdictionName || 'None'}</code>
          </div>
        {/if}
      </section>
    {/if}
  </main>
</div>

<style>
  .entity-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: #0a0a0a;
    color: #e5e5e5;
    font-family: 'Inter', -apple-system, sans-serif;
    font-size: 13px;
  }

  /* Header */
  .header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    background: #171412;
    border-bottom: 1px solid #292524;
    flex-shrink: 0;
  }

  .header :global(select),
  .header :global(button),
  .header :global(.dropdown-trigger) {
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #a8a29e;
    font-size: 12px;
    padding: 6px 10px;
    cursor: pointer;
  }

  /* History Warning */
  .history-warning {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px;
    background: #422006;
    border-bottom: 1px solid #713f12;
    color: #fbbf24;
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .history-warning:hover {
    background: #4a2408;
  }

  /* Main Scroll - SINGLE SCROLLBAR */
  .main-scroll {
    flex: 1;
    overflow-y: auto;
    overflow-x: hidden;
  }

  .main-scroll::-webkit-scrollbar {
    width: 6px;
  }

  .main-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .main-scroll::-webkit-scrollbar-thumb {
    background: #44403c;
    border-radius: 3px;
  }

  /* Empty State */
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 300px;
    color: #78716c;
    gap: 12px;
  }

  .empty-state h3 {
    margin: 0;
    font-size: 16px;
    color: #a8a29e;
  }

  .empty-state p {
    margin: 0;
    font-size: 12px;
  }

  /* Focused Account View */
  .focused-view {
    padding: 16px;
  }

  .back-btn {
    display: inline-block;
    padding: 6px 12px;
    margin-bottom: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #fbbf24;
    font-size: 12px;
    cursor: pointer;
  }

  .focused-title {
    font-size: 14px;
    color: #78716c;
    margin-bottom: 12px;
  }

  /* Hero Section - Entity + Net Worth */
  .hero {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    background: linear-gradient(180deg, #1c1917 0%, #0c0a09 100%);
    border-bottom: 1px solid #292524;
  }

  .hero-left {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .hero-avatar {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    background: linear-gradient(135deg, #fbbf24 0%, #f59e0b 100%);
    flex-shrink: 0;
  }

  .hero-avatar.placeholder {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 600;
    color: #0c0a09;
  }

  .hero-identity {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .hero-name {
    font-size: 14px;
    font-weight: 600;
    color: #fafaf9;
  }

  .hero-address {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
    background: transparent;
    border: none;
    border-radius: 4px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #78716c;
    cursor: pointer;
    transition: all 0.15s;
  }

  .hero-address:hover {
    background: #292524;
    color: #a8a29e;
  }

  .hero-right {
    text-align: right;
  }

  .hero-networth {
    font-family: 'JetBrains Mono', monospace;
    font-size: 28px;
    font-weight: 600;
    color: #fafaf9;
    letter-spacing: -0.5px;
  }

  .hero-label {
    font-size: 11px;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Breakdown Cards */
  .breakdown {
    display: flex;
    gap: 8px;
    padding: 12px 16px;
    border-bottom: 1px solid #1c1917;
  }

  .breakdown-card {
    flex: 1;
    padding: 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 8px;
    text-align: left;
    cursor: pointer;
    transition: all 0.15s;
  }

  .breakdown-card:hover {
    border-color: #44403c;
    background: #292524;
  }

  .breakdown-card.active {
    border-color: #fbbf24;
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.1) 0%, transparent 100%);
  }

  .breakdown-card.wide {
    flex: 1.2;
  }

  .card-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 16px;
    font-weight: 600;
    color: #fafaf9;
  }

  .card-label {
    font-size: 11px;
    font-weight: 500;
    color: #a8a29e;
    margin-top: 2px;
  }

  .card-sub {
    font-size: 10px;
    color: #57534e;
    margin-top: 4px;
  }

  /* Portfolio - legacy, keep btn-faucet for tab content */
  .portfolio {
    padding: 20px 16px;
    text-align: center;
    border-bottom: 1px solid #1c1917;
  }

  .total-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 32px;
    font-weight: 600;
    color: #fafaf9;
  }

  .total-value.dim {
    color: #57534e;
  }

  .total-label {
    font-size: 11px;
    color: #78716c;
    margin-top: 2px;
    margin-bottom: 16px;
  }

  .btn-faucet {
    margin-top: 8px;
    padding: 12px 24px;
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    border: none;
    border-radius: 8px;
    color: #f0f9ff;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
    transform: translateY(-1px);
  }

  .btn-faucet:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  /* External Tokens */
  .external-tokens {
    padding: 12px 16px;
    border-bottom: 1px solid #1c1917;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }

  .section-header h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 600;
    color: #78716c;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .signer-label {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #57534e;
  }

  .ext-loading {
    font-size: 12px;
    color: #57534e;
    text-align: center;
    padding: 12px;
  }

  .ext-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .ext-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    background: #1c1917;
    border-radius: 6px;
  }

  .ext-symbol {
    font-weight: 600;
    font-size: 12px;
    width: 50px;
  }

  .ext-symbol.eth { color: #627eea; }
  .ext-symbol.usd { color: #2775ca; }

  .ext-amount {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #a8a29e;
  }

  .btn-deposit {
    padding: 4px 10px;
    background: linear-gradient(135deg, #16a34a, #15803d);
    border: none;
    border-radius: 4px;
    color: #f0fdf4;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-deposit:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .ext-empty {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 12px;
    background: #1c1917;
    border-radius: 6px;
    font-size: 12px;
    color: #57534e;
  }

  .btn-faucet-small {
    padding: 4px 10px;
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    border: none;
    border-radius: 4px;
    color: #f0f9ff;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-faucet-small:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-faucet-small:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .token-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-width: 400px;
    margin: 0 auto;
  }

  .token-row {
    display: grid;
    grid-template-columns: 50px 1fr 80px 60px;
    align-items: center;
    gap: 8px;
    font-size: 12px;
  }

  .t-symbol {
    font-weight: 600;
    text-align: left;
  }

  .t-symbol.eth { color: #627eea; }
  .t-symbol.usd { color: #2775ca; }

  .t-amount {
    font-family: 'JetBrains Mono', monospace;
    color: #a8a29e;
    text-align: right;
  }

  .t-bar {
    height: 4px;
    background: #1c1917;
    border-radius: 2px;
    overflow: hidden;
  }

  .t-fill {
    height: 100%;
    background: #fbbf24;
    border-radius: 2px;
  }

  .t-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #57534e;
    text-align: right;
  }

  /* Token List Grid - Beautiful card layout */
  .wallet-address {
    margin-bottom: 16px;
  }

  .token-list-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 40px 20px;
    color: #78716c;
  }

  .loading-spinner {
    width: 20px;
    height: 20px;
    border: 2px solid #292524;
    border-top-color: #fbbf24;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .token-list-grid {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .token-card {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 16px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 12px;
    transition: all 0.15s;
  }

  .token-card:hover {
    border-color: #44403c;
  }

  .token-card.has-balance {
    border-color: #365314;
    background: linear-gradient(135deg, #1c1917 0%, #1a2e05 100%);
  }

  .token-header {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .token-icon {
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: 700;
    font-size: 16px;
    color: white;
    background: #44403c;
  }

  .token-icon.usdc {
    background: linear-gradient(135deg, #2775ca, #1e5aa8);
  }

  .token-icon.weth {
    background: linear-gradient(135deg, #627eea, #4c62c7);
  }

  .token-icon.usdt {
    background: linear-gradient(135deg, #26a17b, #1e8a69);
  }

  .token-symbol {
    font-weight: 600;
    font-size: 15px;
    color: #fafaf9;
  }

  .token-balance {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .balance-amount {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 600;
    color: #fafaf9;
  }

  .balance-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: #78716c;
  }

  .balance-zero {
    font-family: 'JetBrains Mono', monospace;
    font-size: 22px;
    font-weight: 600;
    color: #44403c;
  }

  .token-actions {
    margin-top: 4px;
  }

  .btn-token-action {
    width: 100%;
    padding: 10px 16px;
    border: none;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-token-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-token-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-token-action.faucet {
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    color: #f0f9ff;
  }

  .btn-token-action.faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-token-action:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .token-status {
    font-size: 11px;
    color: #57534e;
    font-style: italic;
  }

  .hint-text {
    text-align: center;
    font-size: 12px;
    color: #57534e;
    margin-top: 16px;
    padding: 12px;
    background: #1c1917;
    border-radius: 8px;
  }

  /* Tabs */
  .tabs {
    display: flex;
    padding: 0 8px;
    background: #0f0d0c;
    border-bottom: 1px solid #1c1917;
    overflow-x: auto;
    flex-shrink: 0;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 10px 10px;
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    color: #78716c;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .tab:hover {
    color: #a8a29e;
  }

  .tab.active {
    color: #fbbf24;
    border-bottom-color: #fbbf24;
  }

  .badge {
    background: #dc2626;
    color: white;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 8px;
  }

  .badge.pending {
    background: #ca8a04;
    color: #fef3c7;
  }

  /* Content */
  .content {
    padding: 16px;
  }

  .section-head {
    font-size: 10px;
    font-weight: 600;
    color: #57534e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin: 16px 0 8px;
  }

  .section-head:first-child {
    margin-top: 0;
  }

  .muted {
    color: #57534e;
    font-size: 12px;
    font-style: italic;
  }

  /* Activity */
  .activity-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 6px;
  }

  .a-icon {
    font-size: 10px;
    padding: 4px 6px;
    background: #292524;
    border-radius: 4px;
    color: #78716c;
  }

  .a-info {
    flex: 1;
    display: flex;
    flex-direction: column;
  }

  .a-title {
    font-size: 12px;
    color: #e7e5e4;
  }

  .a-sub {
    font-size: 10px;
    color: #57534e;
  }

  .a-amt {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
  }

  /* Contacts */
  .contact-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 6px;
  }

  .c-info {
    display: flex;
    flex-direction: column;
  }

  .c-name {
    font-size: 13px;
    color: #e7e5e4;
  }

  .c-id {
    font-family: 'JetBrains Mono', monospace;
    font-size: 10px;
    color: #57534e;
  }

  .c-delete {
    width: 24px;
    height: 24px;
    background: #292524;
    border: none;
    border-radius: 4px;
    color: #78716c;
    cursor: pointer;
  }

  .add-contact {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .add-contact input {
    padding: 10px 12px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 6px;
    color: #e7e5e4;
    font-size: 13px;
  }

  .add-contact input::placeholder {
    color: #57534e;
  }

  .add-contact input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  .btn-add {
    padding: 10px;
    background: linear-gradient(135deg, #92400e, #78350f);
    border: none;
    border-radius: 6px;
    color: #fef3c7;
    font-weight: 500;
    cursor: pointer;
  }

  /* Settings */
  .setting-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .toggle {
    padding: 4px 12px;
    background: #292524;
    border: none;
    border-radius: 4px;
    color: #78716c;
    font-size: 11px;
    cursor: pointer;
  }

  .toggle.on {
    background: #422006;
    color: #fbbf24;
  }

  .setting-block {
    padding: 12px;
    background: #1c1917;
    border-radius: 6px;
    margin-bottom: 8px;
  }

  .setting-block label {
    display: block;
    font-size: 10px;
    color: #57534e;
    margin-bottom: 6px;
  }

  .setting-block code {
    display: block;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #a8a29e;
    background: #0c0a09;
    padding: 8px;
    border-radius: 4px;
    word-break: break-all;
  }

  .setting-block input {
    width: 100%;
    box-sizing: border-box;
    padding: 10px;
    border-radius: 6px;
    border: 1px solid #292524;
    background: #0c0a09;
    color: #e7e5e4;
    font-size: 13px;
  }

  .setting-block input:focus {
    outline: none;
    border-color: #fbbf24;
  }

  /* Live Required */
  .live-required {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 40px 20px;
    text-align: center;
    color: #78716c;
    gap: 12px;
  }

  .live-required p {
    margin: 0;
    font-size: 13px;
  }

  .btn-live {
    padding: 10px 20px;
    background: #422006;
    border: 1px solid #713f12;
    border-radius: 6px;
    color: #fbbf24;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-live:hover {
    background: #4a2408;
  }

  /* Override child component styling */
  .content :global(.payment-panel),
  .content :global(.swap-panel),
  .content :global(.settlement-panel),
  .content :global(.account-list),
  .content :global(.scrollable-component) {
    background: transparent !important;
    border: none !important;
    padding: 0 !important;
    height: auto !important;
    overflow: visible !important;
  }

  .content :global(input),
  .content :global(select) {
    background: #1c1917 !important;
    border: 1px solid #292524 !important;
    border-radius: 6px !important;
    color: #e7e5e4 !important;
    padding: 10px 12px !important;
    font-size: 13px !important;
  }

  .content :global(input:focus),
  .content :global(select:focus) {
    outline: none !important;
    border-color: #fbbf24 !important;
  }

  .content :global(input::placeholder) {
    color: #57534e !important;
  }

  .content :global(button:not(.tab):not(.toggle):not(.back-btn):not(.btn-add):not(.btn-live):not(.c-delete)) {
    background: #1c1917 !important;
    border: 1px solid #292524 !important;
    border-radius: 6px !important;
    color: #a8a29e !important;
    padding: 10px 14px !important;
    font-size: 12px !important;
    cursor: pointer !important;
  }

  .content :global(h3),
  .content :global(h4),
  .content :global(label) {
    color: #a8a29e !important;
  }

  /* ============================================
     HORIZONTAL TABLE LAYOUT (External/Reserves)
     ============================================ */

  .tab-header-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .auto-refresh-select {
    padding: 4px 8px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 4px;
    color: #a8a29e;
    font-size: 11px;
    cursor: pointer;
  }

  .auto-refresh-select:focus {
    outline: none;
    border-color: #44403c;
  }

  .btn-refresh-small {
    padding: 4px 10px;
    background: #1c1917;
    border: 1px solid #292524;
    border-radius: 4px;
    color: #78716c;
    font-size: 11px;
    cursor: pointer;
    transition: all 0.15s;
  }

  .btn-refresh-small:hover:not(:disabled) {
    border-color: #44403c;
    color: #a8a29e;
  }

  .btn-refresh-small:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .wallet-label {
    margin-bottom: 12px;
    font-family: 'JetBrains Mono', monospace;
  }

  .loading-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 20px;
    color: #57534e;
    font-size: 12px;
  }

  /* Table Header */
  .token-table-header {
    display: grid;
    grid-template-columns: 100px 1fr 90px 200px;
    gap: 8px;
    padding: 8px 12px;
    background: #1c1917;
    border-radius: 6px 6px 0 0;
    border-bottom: 1px solid #292524;
    font-size: 10px;
    font-weight: 600;
    color: #57534e;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Table Body */
  .token-table {
    display: flex;
    flex-direction: column;
    background: #1c1917;
    border-radius: 0 0 6px 6px;
  }

  /* Table Row */
  .token-table-row {
    display: grid;
    grid-template-columns: 100px 1fr 90px 200px;
    gap: 8px;
    padding: 10px 12px;
    border-bottom: 1px solid #292524;
    align-items: center;
    transition: background 0.1s;
  }

  .token-table-row:last-child {
    border-bottom: none;
    border-radius: 0 0 6px 6px;
  }

  .token-table-row:hover {
    background: #292524;
  }

  .token-table-row.has-balance {
    background: linear-gradient(90deg, rgba(22, 163, 74, 0.1) 0%, transparent 100%);
  }

  .token-table-row.has-balance:hover {
    background: linear-gradient(90deg, rgba(22, 163, 74, 0.15) 0%, #292524 100%);
  }

  /* Columns */
  .col-token {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .col-balance {
    font-family: 'JetBrains Mono', monospace;
  }

  .col-value {
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    color: #57534e;
  }

  .col-actions {
    display: flex;
    gap: 6px;
    justify-content: flex-end;
  }

  /* Token Icon (small) */
  .token-icon-small {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    font-weight: 600;
    font-size: 11px;
    color: white;
    background: #44403c;
    flex-shrink: 0;
  }

  .token-icon-small.usdc {
    background: linear-gradient(135deg, #2775ca, #1e5aa8);
  }

  .token-icon-small.weth {
    background: linear-gradient(135deg, #627eea, #4c62c7);
  }

  .token-icon-small.usdt {
    background: linear-gradient(135deg, #26a17b, #1e8a69);
  }

  .token-name {
    font-weight: 600;
    font-size: 13px;
    color: #fafaf9;
  }

  .balance-text {
    font-size: 13px;
    color: #e7e5e4;
  }

  .balance-text.zero {
    color: #57534e;
  }

  .value-text {
    font-size: 11px;
    color: #78716c;
  }

  /* Table Action Buttons */
  .btn-table-action {
    padding: 5px 10px;
    border: none;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
    white-space: nowrap;
  }

  .btn-table-action.faucet {
    background: linear-gradient(135deg, #0ea5e9, #0284c7);
    color: #f0f9ff;
  }

  .btn-table-action.faucet:hover:not(:disabled) {
    background: linear-gradient(135deg, #38bdf8, #0ea5e9);
  }

  .btn-table-action.deposit {
    background: linear-gradient(135deg, #16a34a, #15803d);
    color: #f0fdf4;
  }

  .btn-table-action.deposit:hover:not(:disabled) {
    background: linear-gradient(135deg, #22c55e, #16a34a);
  }

  .btn-table-action.collateral {
    background: linear-gradient(135deg, #f59e0b, #d97706);
    color: #fffbeb;
  }

  .btn-table-action.collateral:hover:not(:disabled) {
    background: linear-gradient(135deg, #fbbf24, #f59e0b);
  }

  .btn-table-action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .account-open-sections {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-top: 12px;
  }

  .open-section {
    padding: 10px;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.02);
  }
</style>
