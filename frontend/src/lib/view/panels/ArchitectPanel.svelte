<script lang="ts">
  /**
   * Architect Panel - God-mode controls (extracted from NetworkTopology sidebar)
   * 5 modes: Explore, Build, Economy, Governance, Resolve
   *
   * @license AGPL-3.0
   * Copyright (C) 2025 XLN Finance
   */

  import type { Writable } from 'svelte/store';
  import { panelBridge } from '../utils/panelBridge';
  import { shortAddress } from '$lib/utils/format';

  // Receive isolated env as props (passed from View.svelte) - REQUIRED
  export let isolatedEnv: Writable<any>;
  export let isolatedHistory: Writable<any[]>;
  export let isolatedTimeIndex: Writable<number>;

  type Mode = 'explore' | 'build' | 'economy' | 'governance' | 'resolve';
  let currentMode: Mode = 'economy';
  let loading = false;
  let lastAction = '';

  // Reserve operations state
  let selectedEntityForMint = '';
  let mintAmount = '1000000'; // 1M units
  let r2rFromEntity = '';
  let r2rToEntity = '';
  let r2rAmount = '500000'; // 500K units

  // Entity registration mode
  let numberedEntities = false; // Default: lazy (in-memory only, no blockchain needed)
  let newEntityName = 'alice'; // For manual entity creation in Build mode

  // Topology selector
  let selectedTopology: 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid' = 'hybrid';

  // Xlnomy state
  let showCreateXlnomyModal = false;
  let newXlnomyName = 'xlnomy1';
  let newXlnomyEvmType: 'browservm' | 'reth' | 'erigon' | 'monad' = 'browservm';
  let newXlnomyRpcUrl = 'http://localhost:8545';
  let newXlnomyBlockTime = '1000';
  let newXlnomyAutoGrid = false; // Removed from UI, always manual now

  // Get available Xlnomies from env
  $: xlnomies = $isolatedEnv?.xlnomies ? Array.from($isolatedEnv.xlnomies.keys()) : [];
  $: activeXlnomy = $isolatedEnv?.activeXlnomy || '';

  // Check if env is ready
  $: envReady = $isolatedEnv !== null && $isolatedEnv !== undefined;
  $: if (envReady) {
    console.log('[ArchitectPanel] Env ready with', $isolatedEnv.entities?.length || 0, 'entities');
  }

  // Get entity IDs for dropdowns (extract entityId from replica keys)
  let entityIds: string[] = [];
  $: entityIds = $isolatedEnv?.replicas
    ? Array.from($isolatedEnv.replicas.keys() as Iterable<string>).map((key: string) => key.split(':')[0] || key).filter((id: string, idx: number, arr: string[]) => arr.indexOf(id) === idx)
    : [];

  /** Mint reserves to selected entity */
  async function mintReservesToEntity() {
    if (!selectedEntityForMint || !$isolatedEnv) {
      lastAction = '❌ Select an entity first';
      return;
    }

    loading = true;
    lastAction = `Minting ${mintAmount} to ${shortAddress(selectedEntityForMint)}...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Get the replica to find the signerId
      const replicaKeys = Array.from($isolatedEnv.replicas.keys()) as string[];
      const replicaKey = replicaKeys.find(k => k.startsWith(selectedEntityForMint + ':'));
      const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

      if (!replica) {
        throw new Error(`No replica found for entity ${shortAddress(selectedEntityForMint)}`);
      }

      // Mint via j_event (ReserveUpdated - simulates on-chain deposit)
      await XLN.process($isolatedEnv, [{
        entityId: selectedEntityForMint,
        signerId: replica.signerId,
        entityTxs: [{
          type: 'j_event',
          data: {
            from: replica.signerId,
            event: {
              type: 'ReserveUpdated',
              data: {
                entity: selectedEntityForMint,
                tokenId: 0,
                newBalance: BigInt(mintAmount).toString(),
                name: 'USDC',
                symbol: 'USDC',
                decimals: 6
              }
            },
            observedAt: Date.now(),
            blockNumber: 1,
            transactionHash: '0x' + Array(64).fill('0').join('')
          }
        }]
      }]);

      lastAction = `✅ Minted ${mintAmount} to entity`;

      // Update stores to trigger reactivity
      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);

      // Advance to latest frame
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] Mint complete, new frame created');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Mint error:', err);
    } finally {
      loading = false;
    }
  }

  /** Send R2R (Reserve-to-Reserve) transaction */
  async function sendR2RTransaction() {
    if (!r2rFromEntity || !r2rToEntity || r2rFromEntity === r2rToEntity) {
      lastAction = '❌ Select different FROM and TO entities';
      return;
    }

    if (!$isolatedEnv) {
      lastAction = '❌ Environment not ready';
      return;
    }

    loading = true;
    lastAction = `Sending R2R: ${shortAddress(r2rFromEntity)} → ${shortAddress(r2rToEntity)}...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Get the replica to find the signerId
      const replicaKeys = Array.from($isolatedEnv.replicas.keys()) as string[];
      const replicaKey = replicaKeys.find(k => k.startsWith(r2rFromEntity + ':'));
      const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

      if (!replica) {
        throw new Error(`No replica found for entity ${shortAddress(r2rFromEntity)}`);
      }

      // Check if account exists
      const hasAccount = replica.state?.accounts?.has(r2rToEntity);

      // Step 1: Open account if it doesn't exist
      if (!hasAccount) {
        console.log('[Architect] No account exists, opening account first...');
        lastAction = `Opening account: ${shortAddress(r2rFromEntity)} ↔ ${shortAddress(r2rToEntity)}...`;

        await XLN.process($isolatedEnv, [{
          entityId: r2rFromEntity,
          signerId: replica.signerId,
          entityTxs: [{
            type: 'openAccount',
            data: {
              targetEntityId: r2rToEntity
            }
          }]
        }]);

        console.log('[Architect] Account opened');
      }

      // Step 2: Send payment via directPayment
      lastAction = `Sending payment: ${r2rAmount} units...`;

      await XLN.process($isolatedEnv, [{
        entityId: r2rFromEntity,
        signerId: replica.signerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: r2rToEntity,
            tokenId: 0,
            amount: BigInt(r2rAmount),
            route: [r2rFromEntity, r2rToEntity],
            description: 'Manual R2R payment'
          }
        }]
      }]);

      lastAction = `✅ R2R sent: ${r2rAmount} units`;

      // Update stores to trigger reactivity
      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);

      // Advance to latest frame
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] R2R complete, new frame created');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] R2R error:', err);
    } finally {
      loading = false;
    }
  }

  /** BANKER DEMO STEP 1: Create 3×3 Hub */
  async function createHub() {
    if (!$isolatedEnv?.activeXlnomy) {
      lastAction = '❌ Create xlnomy first';
      return;
    }

    if (entityIds.length > 0) {
      lastAction = '❌ Hub already exists';
      return;
    }

    loading = true;
    lastAction = 'Creating 3×3 hub (9 entities)...';

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      const xlnomy = $isolatedEnv.xlnomies.get($isolatedEnv.activeXlnomy);
      if (!xlnomy) throw new Error('Active xlnomy not found');

      const jPos = xlnomy.jMachine.position;

      // Create 9 entities in 3×3 grid at y=320
      const entities = [];
      for (let i = 0; i < 9; i++) {
        const row = Math.floor(i / 3);
        const col = i % 3;
        const x = jPos.x + (col - 1) * 40;
        const z = jPos.z + (row - 1) * 40;
        const y = jPos.y + 20; // y=320

        const signerId = `${$isolatedEnv.activeXlnomy}_e${i}`;
        const encoder = new TextEncoder();
        const data = encoder.encode(`${$isolatedEnv.activeXlnomy}:e${i}:${Date.now()}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const entityId = '0x' + hashHex;

        entities.push({
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: $isolatedEnv.activeXlnomy
            },
            isProposer: true,
            position: { x, y, z }
          }
        });
      }

      // Import all entities
      await XLN.applyRuntimeInput($isolatedEnv, {
        runtimeTxs: entities,
        entityInputs: []
      });

      lastAction = `✅ Created 3×3 hub (9 entities at y=320)`;

      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] Hub created');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Create hub error:', err);
    } finally {
      loading = false;
    }
  }

  /** BANKER DEMO STEP 2: Fund all entities */
  async function fundAllEntities() {
    if (entityIds.length === 0) {
      lastAction = '❌ Create hub first';
      return;
    }

    loading = true;
    lastAction = `Funding ${entityIds.length} entities...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      for (const entityId of entityIds) {
        const replicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(entityId + ':'));
        const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

        if (replica) {
          await XLN.process($isolatedEnv, [{
            entityId,
            signerId: replica.signerId,
            entityTxs: [{
              type: 'j_event',
              data: {
                from: replica.signerId,
                event: {
                  type: 'ReserveUpdated',
                  data: {
                    entity: entityId,
                    tokenId: 0,
                    newBalance: '1000000',
                    name: 'USDC',
                    symbol: 'USDC',
                    decimals: 6
                  }
                },
                observedAt: Date.now(),
                blockNumber: 1,
                transactionHash: '0x' + Array(64).fill('0').join('')
              }
            }]
          }]);
        }
      }

      lastAction = `✅ Funded all ${entityIds.length} entities with $1M`;

      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] All entities funded');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Fund all error:', err);
    } finally {
      loading = false;
    }
  }

  /** BANKER DEMO STEP 3: Send one random payment */
  async function sendRandomPayment() {
    if (entityIds.length < 2) {
      lastAction = '❌ Need at least 2 entities';
      return;
    }

    loading = true;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Pick 2 random different entities
      const from = entityIds[Math.floor(Math.random() * entityIds.length)];
      let to = entityIds[Math.floor(Math.random() * entityIds.length)];
      while (to === from && entityIds.length > 1) {
        to = entityIds[Math.floor(Math.random() * entityIds.length)];
      }

      const fromReplicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
      const fromReplica = fromReplicaKey ? $isolatedEnv.replicas.get(fromReplicaKey) : null;

      if (!fromReplica || !from || !to) {
        throw new Error('Entity not found');
      }

      lastAction = `Sending payment ${from.slice(0, 8)} → ${to.slice(0, 8)}...`;

      // Check if account exists
      const hasAccount = fromReplica.state?.accounts?.has(to);

      // Open account if needed
      if (!hasAccount) {
        await XLN.process($isolatedEnv, [{
          entityId: from,
          signerId: fromReplica.signerId,
          entityTxs: [{
            type: 'openAccount',
            data: { targetEntityId: to }
          }]
        }]);
      }

      // Send payment
      const amount = Math.floor(Math.random() * 100000) + 10000; // 10K-110K
      await XLN.process($isolatedEnv, [{
        entityId: from,
        signerId: fromReplica.signerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: to,
            tokenId: 0,
            amount: BigInt(amount),
            route: [from, to],
            description: 'Random banker demo payment'
          }
        }]
      }]);

      lastAction = `✅ Payment: ${shortAddress(from)} → ${shortAddress(to)} ($${(amount/1000).toFixed(0)}K)`;

      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] Random payment sent');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Random payment error:', err);
    } finally {
      loading = false;
    }
  }

  /** BANKER DEMO STEP 4: Reset */
  async function resetDemo() {
    stopFedPaymentLoop(); // Stop any running payment loops
    lastAction = 'Reset not implemented yet (reload page for now)';
  }

  /** Get topology preset (inline until we export from runtime.js) */
  function getTopologyPresetInline(type: 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid') {
    if (type === 'hybrid') {
      return {
        type: 'hybrid',
        layers: [
          { name: 'Federal Reserve', yPosition: 220, entityCount: 1, xzSpacing: 0, color: '#FFD700', size: 10.0, emissiveIntensity: 2.0, initialReserves: 100_000_000n, canMintMoney: true },
          { name: 'Big Four Banks', yPosition: 140, entityCount: 4, xzSpacing: 100, color: '#00ff41', size: 1.5, emissiveIntensity: 0.5, initialReserves: 1_000_000n, canMintMoney: false },
          { name: 'Community Banks', yPosition: 80, entityCount: 8, xzSpacing: 120, color: '#FFFF00', size: 0.8, emissiveIntensity: 0.2, initialReserves: 100_000n, canMintMoney: false },
          { name: 'Customers', yPosition: 0, entityCount: 24, xzSpacing: 25, color: '#0088FF', size: 0.5, emissiveIntensity: 0.1, initialReserves: 10_000n, canMintMoney: false }
        ],
        rules: {
          allowedPairs: [
            { from: 'Federal Reserve', to: 'Big Four Banks' }, { from: 'Big Four Banks', to: 'Federal Reserve' },
            { from: 'Big Four Banks', to: 'Big Four Banks' },
            { from: 'Big Four Banks', to: 'Community Banks' }, { from: 'Community Banks', to: 'Big Four Banks' },
            { from: 'Community Banks', to: 'Community Banks' },
            { from: 'Big Four Banks', to: 'Customers' }, { from: 'Community Banks', to: 'Customers' },
            { from: 'Customers', to: 'Big Four Banks' }, { from: 'Customers', to: 'Community Banks' }
          ],
          allowDirectInterbank: true,
          requireHubRouting: false,
          maxHops: 4,
          defaultCreditLimits: new Map()
        },
        crisisThreshold: 0.20,
        crisisMode: 'star'
      };
    } else if (type === 'star') {
      return {
        type: 'star',
        layers: [
          { name: 'Federal Reserve', yPosition: 200, entityCount: 1, xzSpacing: 0, color: '#FFD700', size: 10.0, emissiveIntensity: 2.0, initialReserves: 100_000_000n, canMintMoney: true },
          { name: 'Commercial Banks', yPosition: 100, entityCount: 4, xzSpacing: 100, color: '#00ff41', size: 1.0, emissiveIntensity: 0.3, initialReserves: 1_000_000n, canMintMoney: false },
          { name: 'Customers', yPosition: 0, entityCount: 12, xzSpacing: 25, color: '#0088FF', size: 0.5, emissiveIntensity: 0.1, initialReserves: 10_000n, canMintMoney: false }
        ],
        rules: {
          allowedPairs: [
            { from: 'Federal Reserve', to: 'Commercial Banks' }, { from: 'Commercial Banks', to: 'Federal Reserve' },
            { from: 'Commercial Banks', to: 'Customers' }, { from: 'Customers', to: 'Commercial Banks' }
          ],
          allowDirectInterbank: false,
          requireHubRouting: true,
          maxHops: 3,
          defaultCreditLimits: new Map()
        },
        crisisThreshold: 0.20,
        crisisMode: 'star'
      };
    } else {
      // Default to hybrid for other types (will implement mesh/tiered/correspondent later)
      return getTopologyPresetInline('hybrid');
    }
  }

  /** CREATE ECONOMY WITH TOPOLOGY - Main entry point */
  async function createEconomyWithTopology(topologyType: 'star' | 'mesh' | 'tiered' | 'correspondent' | 'hybrid') {
    console.log('[Architect] createEconomyWithTopology called with type:', topologyType);

    if (!$isolatedEnv?.activeXlnomy) {
      lastAction = '❌ Create xlnomy first';
      console.error('[Architect] No active xlnomy');
      return;
    }

    if (entityIds.length > 0) {
      lastAction = '❌ Economy already exists (reload page to reset)';
      console.error('[Architect] Economy already exists, entityIds:', entityIds.length);
      return;
    }

    loading = true;
    lastAction = `Creating ${topologyType.toUpperCase()} economy...`;
    console.log('[Architect] Starting topology creation, loading=true');

    try {
      // Get topology preset (inline for now)
      console.log('[Architect] Getting topology preset...');
      const topology = getTopologyPresetInline(topologyType);
      console.log('[Architect] Topology preset loaded:', topology.type, 'layers:', topology.layers.length);

      // Create entities based on topology layers
      console.log('[Architect] Calling createEntitiesFromTopology...');
      await createEntitiesFromTopology(topology);
      console.log('[Architect] createEntitiesFromTopology completed');

      // Start payment loop
      console.log('[Architect] Starting payment loop in 2s...');
      setTimeout(() => startSmartPaymentLoop(topology), 2000);

      const totalEntities = topology.layers.reduce((sum: number, layer: any) => sum + layer.entityCount, 0);
      lastAction = `✅ Created ${topologyType.toUpperCase()} economy: ${totalEntities} entities across ${topology.layers.length} layers`;

      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log(`[Architect] ${topologyType.toUpperCase()} economy created successfully`);
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Topology creation error:', err);
      console.error('[Architect] Full error stack:', err.stack);
    } finally {
      loading = false;
      console.log('[Architect] loading=false');
    }
  }

  /** Create entities based on topology configuration */
  async function createEntitiesFromTopology(topology: any) {
    console.log('[createEntities] START');

    const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
    console.log('[createEntities] Loading XLN from:', runtimeUrl);
    const XLN = await import(/* @vite-ignore */ runtimeUrl);
    console.log('[createEntities] XLN loaded');

    const xlnomy = $isolatedEnv.xlnomies.get($isolatedEnv.activeXlnomy);
    if (!xlnomy) {
      console.error('[createEntities] Active xlnomy not found:', $isolatedEnv.activeXlnomy);
      throw new Error('Active xlnomy not found');
    }
    console.log('[createEntities] Xlnomy found:', xlnomy.name);

    const jPos = xlnomy.jMachine.position;
    console.log('[createEntities] J-Machine position:', jPos);

    const entities = [];
    const layerEntityIds: Map<string, string[]> = new Map(); // layerName → entityIds

    // Create entities for each layer
    console.log('[createEntities] Processing', topology.layers.length, 'layers');
    for (const layer of topology.layers) {
      console.log('[createEntities] Layer:', layer.name, 'count:', layer.entityCount, 'y:', layer.yPosition);
      const layerIds: string[] = [];

      for (let i = 0; i < layer.entityCount; i++) {
        // Position calculation
        let x: number, y: number, z: number;
        y = layer.yPosition;

        if (layer.entityCount === 1) {
          // Single entity (Fed, ECB, etc) - center
          x = jPos.x;
          z = jPos.z;
        } else {
          // Multiple entities - spread in circle
          const angle = (i / layer.entityCount) * Math.PI * 2;
          x = jPos.x + Math.cos(angle) * layer.xzSpacing;
          z = jPos.z + Math.sin(angle) * layer.xzSpacing;
        }

        // Generate entity ID
        const signerId = `${$isolatedEnv.activeXlnomy}_${layer.name.toLowerCase().replace(/\s/g, '_')}_${i}`;
        const data = new TextEncoder().encode(`${$isolatedEnv.activeXlnomy}:${layer.name}:${i}:${Date.now()}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const entityId = '0x' + hashHex;

        entities.push({
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: $isolatedEnv.activeXlnomy
            },
            isProposer: true,
            position: { x, y, z }
          }
        });

        layerIds.push(entityId);
      }

      layerEntityIds.set(layer.name, layerIds);
      console.log('[createEntities] Layer', layer.name, 'created', layerIds.length, 'entities');
    }

    // Import all entities
    console.log('[createEntities] Importing', entities.length, 'entities via applyRuntimeInput...');
    await XLN.applyRuntimeInput($isolatedEnv, {
      runtimeTxs: entities,
      entityInputs: []
    });
    console.log('[createEntities] Entities imported');

    // Fund entities according to layer reserves
    console.log('[createEntities] Funding entities...');
    for (const layer of topology.layers) {
      const ids = layerEntityIds.get(layer.name) || [];
      console.log('[createEntities] Funding', ids.length, 'entities in layer:', layer.name);

      for (const entityId of ids) {
        const replicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(entityId + ':'));
        const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

        if (replica) {
          await XLN.process($isolatedEnv, [{
            entityId,
            signerId: replica.signerId,
            entityTxs: [{
              type: 'j_event',
              data: {
                from: replica.signerId,
                event: {
                  type: 'ReserveUpdated',
                  data: {
                    entity: entityId,
                    tokenId: 0,
                    newBalance: layer.initialReserves.toString(),
                    name: 'USD',
                    symbol: 'USD',
                    decimals: 2
                  }
                },
                observedAt: Date.now(),
                blockNumber: 1,
                transactionHash: '0x' + Array(64).fill('0').join('')
              }
            }]
          }]);
        }
      }
    }

    // Create credit lines based on topology rules
    console.log('[createEntities] Creating credit lines for', topology.rules.allowedPairs.length, 'rules...');
    for (const rule of topology.rules.allowedPairs) {
      const fromLayerIds = layerEntityIds.get(rule.from) || [];
      const toLayerIds = layerEntityIds.get(rule.to) || [];
      console.log('[createEntities] Rule:', rule.from, '→', rule.to, `(${fromLayerIds.length}×${toLayerIds.length} pairs)`);

      // Open accounts between all pairs
      for (const fromId of fromLayerIds) {
        for (const toId of toLayerIds) {
          if (fromId === toId) continue; // Skip self

          const fromReplicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(fromId + ':'));
          const fromReplica = fromReplicaKey ? $isolatedEnv.replicas.get(fromReplicaKey) : null;

          if (fromReplica) {
            await XLN.process($isolatedEnv, [{
              entityId: fromId,
              signerId: fromReplica.signerId,
              entityTxs: [{
                type: 'openAccount',
                data: { targetEntityId: toId }
              }]
            }]);
          }
        }
      }
    }

    console.log('[createEntities] COMPLETE - Created economy with', entities.length, 'entities');
  }

  /** OLD: FED RESERVE DEMO (legacy - will be removed) */
  async function createFedReserveDemo() {
    if (!$isolatedEnv?.activeXlnomy) {
      lastAction = '❌ Create xlnomy first';
      return;
    }

    if (entityIds.length > 0) {
      lastAction = '❌ Economy already exists (use Reset first)';
      return;
    }

    loading = true;
    lastAction = 'Creating 4-layer banking system (J-Machine → Fed → Banks → Users)...';

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      const xlnomy = $isolatedEnv.xlnomies.get($isolatedEnv.activeXlnomy);
      if (!xlnomy) throw new Error('Active xlnomy not found');

      const jPos = xlnomy.jMachine.position;

      // 4 LAYERS:
      // Layer 1: J-Machine at y=300 (already exists)
      // Layer 2: Federal Reserve at y=200 (central hub)
      // Layer 3: Big Four Banks at y=100 (commercial hubs)
      // Layer 4: Customers at y=0 (ground level, 2-4 per bank)

      const banks = [
        { name: 'JPMorgan', x: -100, z: -100, customers: 4 },
        { name: 'BofA', x: 100, z: -100, customers: 3 },
        { name: 'Wells', x: -100, z: 100, customers: 2 },
        { name: 'Citi', x: 100, z: 100, customers: 3 }
      ];

      const entities = [];

      // LAYER 2: Federal Reserve (center, y=200)
      const fedSignerId = `${$isolatedEnv.activeXlnomy}_fed`;
      const fedData = new TextEncoder().encode(`${$isolatedEnv.activeXlnomy}:fed:${Date.now()}`);
      const fedHashBuffer = await crypto.subtle.digest('SHA-256', fedData);
      const fedHashArray = Array.from(new Uint8Array(fedHashBuffer));
      const fedHashHex = fedHashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      const fedEntityId = '0x' + fedHashHex;

      entities.push({
        type: 'importReplica',
        entityId: fedEntityId,
        signerId: fedSignerId,
        data: {
          config: {
            mode: 'proposer-based',
            threshold: 1n,
            validators: [fedSignerId],
            shares: { [fedSignerId]: 1n },
            jurisdiction: $isolatedEnv.activeXlnomy
          },
          isProposer: true,
          position: { x: jPos.x, y: 200, z: jPos.z }
        }
      });

      // LAYER 3: Big Four commercial banks (y=100)
      const bankEntityIds = [];
      for (let i = 0; i < banks.length; i++) {
        const bank = banks[i]!;
        const signerId = `${$isolatedEnv.activeXlnomy}_${bank.name.toLowerCase().replace(/\s/g, '_')}`;
        const data = new TextEncoder().encode(`${$isolatedEnv.activeXlnomy}:${bank.name}:${Date.now() + i}`);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const entityId = '0x' + hashHex;

        entities.push({
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: $isolatedEnv.activeXlnomy
            },
            isProposer: true,
            position: { x: jPos.x + bank.x, y: 100, z: jPos.z + bank.z }
          }
        });

        bankEntityIds.push({ entityId, signerId, bank });
      }

      // LAYER 4: Customers (y=0, ground level, clustered around their banks)
      for (let i = 0; i < bankEntityIds.length; i++) {
        const bankData = bankEntityIds[i]!;
        const bankPos = { x: jPos.x + banks[i]!.x, z: jPos.z + banks[i]!.z };
        const customerCount = banks[i]!.customers;

        // Position customers in circle around their bank
        for (let c = 0; c < customerCount; c++) {
          const angle = (c / customerCount) * Math.PI * 2;
          const radius = 25; // Close to bank
          const custX = bankPos.x + Math.cos(angle) * radius;
          const custZ = bankPos.z + Math.sin(angle) * radius;

          const custSignerId = `${$isolatedEnv.activeXlnomy}_${banks[i]!.name.toLowerCase()}_c${c}`;
          const custData = new TextEncoder().encode(`${$isolatedEnv.activeXlnomy}:customer:${banks[i]!.name}:${c}:${Date.now()}`);
          const custHashBuffer = await crypto.subtle.digest('SHA-256', custData);
          const custHashArray = Array.from(new Uint8Array(custHashBuffer));
          const custHashHex = custHashArray.map(b => b.toString(16).padStart(2, '0')).join('');
          const custEntityId = '0x' + custHashHex;

          entities.push({
            type: 'importReplica',
            entityId: custEntityId,
            signerId: custSignerId,
            data: {
              config: {
                mode: 'proposer-based',
                threshold: 1n,
                validators: [custSignerId],
                shares: { [custSignerId]: 1n },
                jurisdiction: $isolatedEnv.activeXlnomy
              },
              isProposer: true,
              position: { x: custX, y: 0, z: custZ }
            }
          });
        }
      }

      // Import all entities
      await XLN.applyRuntimeInput($isolatedEnv, {
        runtimeTxs: entities,
        entityInputs: []
      });

      // FUNDING TIER 1: Fed Reserve with $100M (base money)
      const fedReplicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(fedEntityId + ':'));
      const fedReplica = fedReplicaKey ? $isolatedEnv.replicas.get(fedReplicaKey) : null;

      if (fedReplica) {
        await XLN.process($isolatedEnv, [{
          entityId: fedEntityId,
          signerId: fedReplica.signerId,
          entityTxs: [{
            type: 'j_event',
            data: {
              from: fedReplica.signerId,
              event: {
                type: 'ReserveUpdated',
                data: {
                  entity: fedEntityId,
                  tokenId: 0,
                  newBalance: '100000000', // $100M base money
                  name: 'USD',
                  symbol: 'USD',
                  decimals: 2
                }
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0x' + Array(64).fill('0').join('')
            }
          }]
        }]);
      }

      // FUNDING TIER 2: Banks with $1M each
      for (const bankData of bankEntityIds) {
        const replicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(bankData.entityId + ':'));
        const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

        if (replica) {
          await XLN.process($isolatedEnv, [{
            entityId: bankData.entityId,
            signerId: replica.signerId,
            entityTxs: [{
              type: 'j_event',
              data: {
                from: replica.signerId,
                event: {
                  type: 'ReserveUpdated',
                  data: {
                    entity: bankData.entityId,
                    tokenId: 0,
                    newBalance: '1000000', // $1M
                    name: 'USD',
                    symbol: 'USD',
                    decimals: 2
                  }
                },
                observedAt: Date.now(),
                blockNumber: 1,
                transactionHash: '0x' + Array(64).fill('0').join('')
              }
            }]
          }]);
        }
      }

      // FUNDING TIER 3: Customers with $10K each
      const customerStartIndex = 1 + bankEntityIds.length; // Skip Fed + Banks
      for (let i = customerStartIndex; i < entities.length; i++) {
        const entity = entities[i]!;
        const replicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(entity.entityId + ':'));
        const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

        if (replica) {
          await XLN.process($isolatedEnv, [{
            entityId: entity.entityId,
            signerId: replica.signerId,
            entityTxs: [{
              type: 'j_event',
              data: {
                from: replica.signerId,
                event: {
                  type: 'ReserveUpdated',
                  data: {
                    entity: entity.entityId,
                    tokenId: 0,
                    newBalance: '10000', // $10K
                    name: 'USD',
                    symbol: 'USD',
                    decimals: 2
                  }
                },
                observedAt: Date.now(),
                blockNumber: 1,
                transactionHash: '0x' + Array(64).fill('0').join('')
              }
            }]
          }]);
        }
      }

      // CREDIT LINES TIER 1: Fed → Banks ($10M limit each)
      for (const bankData of bankEntityIds) {
        const replicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(bankData.entityId + ':'));
        const replica = replicaKey ? $isolatedEnv.replicas.get(replicaKey) : null;

        if (replica) {
          await XLN.process($isolatedEnv, [{
            entityId: bankData.entityId,
            signerId: replica.signerId,
            entityTxs: [{
              type: 'openAccount',
              data: { targetEntityId: fedEntityId }
            }]
          }]);
        }
      }

      // CREDIT LINES TIER 2: Banks → Customers ($100K limit each)
      for (let i = customerStartIndex; i < entities.length; i++) {
        const custEntity = entities[i]!;

        // Find which bank this customer belongs to
        const custSignerId = custEntity.signerId;
        const bankName = custSignerId.split('_')[1] || ''; // Extract bank name from signerId
        const parentBank = bankEntityIds.find(b => bankName && b.signerId.includes(bankName));

        if (parentBank) {
          const custReplicaKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(custEntity.entityId + ':'));
          const custReplica = custReplicaKey ? $isolatedEnv.replicas.get(custReplicaKey) : null;

          if (custReplica) {
            await XLN.process($isolatedEnv, [{
              entityId: custEntity.entityId,
              signerId: custReplica.signerId,
              entityTxs: [{
                type: 'openAccount',
                data: { targetEntityId: parentBank.entityId }
              }]
            }]);
          }
        }
      }

      // Count totals
      const totalCustomers = banks.reduce((sum, b) => sum + b.customers, 0);
      const totalEntities = 1 + banks.length + totalCustomers; // Fed + Banks + Customers

      // Start automatic payment flow
      setTimeout(() => startFedPaymentLoop(), 2000);

      lastAction = `✅ Created ${totalEntities} entities: Fed ($100M, y=200) + 4 Banks ($1M, y=100) + ${totalCustomers} Customers ($10K, y=0)`;

      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      console.log('[Architect] Fed Reserve demo created - payment loop starting');
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Fed Reserve demo error:', err);
    } finally {
      loading = false;
    }
  }

  /** Smart Payment Loop: 20% circular payments + Smart QE */
  let fedPaymentInterval: any = null;
  let currentTopology: any = null;

  async function startSmartPaymentLoop(topology: any) {
    currentTopology = topology;
    if (fedPaymentInterval) clearInterval(fedPaymentInterval);

    fedPaymentInterval = setInterval(async () => {
      try {
        const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
        const XLN = await import(/* @vite-ignore */ runtimeUrl);

        // STEP 1: Smart QE (Fed mints if system liquidity low)
        await runSmartQE(XLN, topology);

        // STEP 2: 20% circular payments (all entities trade)
        await run20PercentPayments(XLN);

        // STEP 3: Crisis detection (for HYBRID topology)
        if (topology.type === 'hybrid') {
          await detectAndHandleCrisis(XLN, topology);
        }

        isolatedEnv.set($isolatedEnv);
        isolatedHistory.set($isolatedEnv.history || []);
        isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      } catch (err: any) {
        console.error('[Smart Loop] Error:', err);
      }
    }, 1000); // Every 1 second (not 3)

    console.log(`[Smart Loop] 🔄 Started (${topology.type} topology, 1s interval)`);
  }

  /** Smart QE: Fed mints based on system liquidity */
  async function runSmartQE(XLN: any, topology: any) {
    // Find Fed/Central Bank entity (first layer with canMintMoney)
    const centralBankLayer = topology.layers.find((l: any) => l.canMintMoney);
    if (!centralBankLayer) return;

    const fedId = entityIds.find(id => {
      const key = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.replicas.get(key) : null;
      return replica?.signerId?.includes(centralBankLayer.name.toLowerCase().replace(/\s/g, '_'));
    });

    if (!fedId) return;

    // Calculate system liquidity
    let totalReserves = 0n;
    let totalEntities = 0;

    for (const id of entityIds) {
      const key = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.replicas.get(key) : null;
      if (replica?.state?.reserves) {
        const tokenReserves = replica.state.reserves.get(0) || 0n;
        totalReserves += BigInt(tokenReserves);
        totalEntities++;
      }
    }

    const averageReserves = totalEntities > 0 ? totalReserves / BigInt(totalEntities) : 0n;
    const targetAverage = 100_000n; // Target $100K per entity

    // If average < target, Fed prints
    if (averageReserves < targetAverage) {
      const deficit = (targetAverage - averageReserves) * BigInt(totalEntities);
      const mintAmount = deficit > 1_000_000n ? 1_000_000n : deficit; // Max $1M per tick

      const fedKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(fedId + ':'));
      const fedReplica = fedKey ? $isolatedEnv.replicas.get(fedKey) : null;

      if (fedReplica) {
        const currentReserves = fedReplica.state?.reserves?.get(0) || 0n;
        const newBalance = BigInt(currentReserves) + mintAmount;

        await XLN.process($isolatedEnv, [{
          entityId: fedId,
          signerId: fedReplica.signerId,
          entityTxs: [{
            type: 'j_event',
            data: {
              from: fedReplica.signerId,
              event: {
                type: 'ReserveUpdated',
                data: {
                  entity: fedId,
                  tokenId: 0,
                  newBalance: newBalance.toString(),
                  name: 'USD',
                  symbol: 'USD',
                  decimals: 2
                }
              },
              observedAt: Date.now(),
              blockNumber: 1,
              transactionHash: '0x' + Array(64).fill('0').join('')
            }
          }]
        }]);

        console.log(`[Smart QE] 💵 Fed printed $${(Number(mintAmount)/1000).toFixed(0)}K (avg: $${(Number(averageReserves)/1000).toFixed(0)}K → target: $${(Number(targetAverage)/1000).toFixed(0)}K)`);
      }
    }
  }

  /** 20% Circular Payments: Everyone sends 20% to random peer */
  async function run20PercentPayments(XLN: any) {
    // Get all entities with reserves > 0
    const activeEntities = entityIds.filter(id => {
      const key = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.replicas.get(key) : null;
      const reserves = replica?.state?.reserves?.get(0) || 0n;
      return BigInt(reserves) > 0n;
    });

    // Each entity sends 20% to random peer
    for (const fromId of activeEntities) {
      const fromKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(fromId + ':'));
      const fromReplica = fromKey ? $isolatedEnv.replicas.get(fromKey) : null;
      if (!fromReplica) continue;

      const reserves = BigInt(fromReplica.state?.reserves?.get(0) || 0n);
      if (reserves <= 0n) continue;

      const amount = (reserves * 20n) / 100n; // 20% of balance
      if (amount <= 0n) continue;

      // Pick random target (not self)
      let toId = activeEntities[Math.floor(Math.random() * activeEntities.length)]!;
      let attempts = 0;
      while (toId === fromId && attempts < 10) {
        toId = activeEntities[Math.floor(Math.random() * activeEntities.length)]!;
        attempts++;
      }

      if (toId === fromId) continue; // Skip if couldn't find different entity

      // Check if account exists
      const hasAccount = fromReplica.state?.accounts?.has(toId);

      if (!hasAccount) {
        // Open account first
        await XLN.process($isolatedEnv, [{
          entityId: fromId,
          signerId: fromReplica.signerId,
          entityTxs: [{
            type: 'openAccount',
            data: { targetEntityId: toId }
          }]
        }]);
      }

      // Send 20% payment
      await XLN.process($isolatedEnv, [{
        entityId: fromId,
        signerId: fromReplica.signerId,
        entityTxs: [{
          type: 'directPayment',
          data: {
            targetEntityId: toId,
            tokenId: 0,
            amount: amount,
            route: [fromId, toId],
            description: `20% circular payment`
          }
        }]
      }]);
    }
  }

  /** Crisis Detection: Reserves < 20% threshold */
  async function detectAndHandleCrisis(XLN: any, topology: any) {
    // Check each entity's reserve ratio
    for (const id of entityIds) {
      const key = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.replicas.get(key) : null;
      if (!replica) continue;

      const reserves = BigInt(replica.state?.reserves?.get(0) || 0n);

      // Calculate total deposits (sum of all credit extended to this entity)
      let totalDeposits = 0n;
      if (replica.state?.accounts) {
        for (const [_, account] of replica.state.accounts.entries()) {
          // Sum positive balances (credit extended TO this entity)
          const deltas = account.deltas;
          if (deltas) {
            for (const [_, delta] of deltas.entries()) {
              const offdelta = BigInt(delta.offdelta || 0n);
              if (offdelta > 0n) {
                totalDeposits += offdelta;
              }
            }
          }
        }
      }

      // Crisis if reserves < 20% of deposits
      if (totalDeposits > 0n) {
        const ratio = (reserves * 100n) / totalDeposits;
        if (ratio < 20n) {
          console.log(`[Crisis] 🚨 Entity ${id.slice(0,10)} reserves ${ratio}% < 20% threshold`);
          // TODO: Trigger Fed emergency lending
        }
      }
    }
  }

  /** OLD: Fed Reserve Payment Loop (legacy) */
  async function startFedPaymentLoop() {
    if (fedPaymentInterval) clearInterval(fedPaymentInterval);

    const bankEntityIds = entityIds.filter(id => {
      const key = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.replicas.get(key) : null;
      return replica?.signerId && !replica.signerId.includes('_fed');
    });

    const fedId = entityIds.find(id => {
      const key = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(id + ':'));
      const replica = key ? $isolatedEnv.replicas.get(key) : null;
      return replica?.signerId?.includes('_fed');
    });

    if (!fedId || bankEntityIds.length === 0) {
      console.log('[Fed Loop] No Fed or banks found');
      return;
    }

    let tick = 0;

    fedPaymentInterval = setInterval(async () => {
      try {
        const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
        const XLN = await import(/* @vite-ignore */ runtimeUrl);

        tick++;
        const action = tick % 4; // 4-step cycle

        if (action === 0) {
          // Fed lends to random bank
          const bank = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          const amount = Math.floor(Math.random() * 500000) + 100000; // $100K-$600K

          const fedKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(fedId + ':'));
          const fedReplica = fedKey ? $isolatedEnv.replicas.get(fedKey) : null;

          if (fedReplica) {
            await XLN.process($isolatedEnv, [{
              entityId: fedId,
              signerId: fedReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: bank,
                  tokenId: 0,
                  amount: BigInt(amount),
                  route: [fedId, bank],
                  description: `Fed discount window lending`
                }
              }]
            }]);

            console.log(`[Fed Loop] 🏛️ → 🏦 Fed lent $${(amount/1000).toFixed(0)}K to bank`);
          }
        } else if (action === 1) {
          // Random bank borrows from Fed (reverse direction)
          const bank = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          const amount = Math.floor(Math.random() * 300000) + 50000; // $50K-$350K

          const bankKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(bank + ':'));
          const bankReplica = bankKey ? $isolatedEnv.replicas.get(bankKey) : null;

          if (bankReplica) {
            await XLN.process($isolatedEnv, [{
              entityId: bank,
              signerId: bankReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: fedId,
                  tokenId: 0,
                  amount: BigInt(amount),
                  route: [bank, fedId],
                  description: `Bank repaying Fed loan`
                }
              }]
            }]);

            console.log(`[Fed Loop] 🏦 → 🏛️ Bank repaid $${(amount/1000).toFixed(0)}K to Fed`);
          }
        } else {
          // Interbank payment (Bank → Bank)
          const from = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          let to = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          while (to === from && bankEntityIds.length > 1) {
            to = bankEntityIds[Math.floor(Math.random() * bankEntityIds.length)]!;
          }

          const amount = Math.floor(Math.random() * 200000) + 25000; // $25K-$225K

          const fromKey = (Array.from($isolatedEnv.replicas.keys()) as string[]).find(k => k.startsWith(from + ':'));
          const fromReplica = fromKey ? $isolatedEnv.replicas.get(fromKey) : null;

          if (fromReplica) {
            // Check if account exists
            const hasAccount = fromReplica.state?.accounts?.has(to);

            if (!hasAccount) {
              // Open account first
              await XLN.process($isolatedEnv, [{
                entityId: from,
                signerId: fromReplica.signerId,
                entityTxs: [{
                  type: 'openAccount',
                  data: { targetEntityId: to }
                }]
              }]);
            }

            // Send payment
            await XLN.process($isolatedEnv, [{
              entityId: from,
              signerId: fromReplica.signerId,
              entityTxs: [{
                type: 'directPayment',
                data: {
                  targetEntityId: to,
                  tokenId: 0,
                  amount: BigInt(amount),
                  route: [from, to],
                  description: `Interbank settlement`
                }
              }]
            }]);

            console.log(`[Fed Loop] 🏦 → 🏦 Interbank payment $${(amount/1000).toFixed(0)}K`);
          }
        }

        isolatedEnv.set($isolatedEnv);
        isolatedHistory.set($isolatedEnv.history || []);
        isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);

      } catch (err: any) {
        console.error('[Fed Loop] Payment error:', err);
      }
    }, 3000); // Every 3 seconds

    console.log('[Fed Loop] 🔄 Started auto payment loop (3s interval)');
  }

  function stopFedPaymentLoop() {
    if (fedPaymentInterval) {
      clearInterval(fedPaymentInterval);
      fedPaymentInterval = null;
      console.log('[Fed Loop] ⏹️ Stopped payment loop');
    }
  }

  /** Execute .scenario.txt file (text-based DSL) */
  async function executeScenarioFile(filename: string) {
    loading = true;
    lastAction = `Loading ${filename}...`;

    try {
      // Fetch scenario text
      const response = await fetch(`/scenarios/${filename}`);
      if (!response.ok) {
        throw new Error(`Failed to load: ${response.statusText}`);
      }

      let scenarioText = await response.text();
      console.log(`[Architect] Loaded: ${filename}`);

      // Inject entity registration type (numbered or lazy) into grid commands
      const entityType = numberedEntities ? 'numbered' : 'lazy';
      scenarioText = scenarioText.replace(
        /^(grid\s+\d+(?:\s+\d+)?(?:\s+\d+)?)(\s+.*)?$/gm,
        (match, gridCmd, rest) => {
          // Remove existing type= parameter
          const cleanRest = rest ? rest.replace(/\s+type=\w+/, '') : '';
          return `${gridCmd}${cleanRest} type=${entityType}`;
        }
      );

      console.log(`[Architect] Entity registration mode: ${entityType}`);

      // Import runtime.js
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Parse scenario (text-based DSL)
      const parsed = XLN.parseScenario(scenarioText);

      if (parsed.errors.length > 0) {
        throw new Error(`Parse errors: ${parsed.errors.join(', ')}`);
      }

      console.log(`[Architect] Executing ${parsed.scenario.events.length} events`);

      // Get current env from props
      const currentEnv = $isolatedEnv;
      if (!currentEnv) {
        throw new Error('View environment not initialized');
      }

      // Capture BEFORE state (clean slate) for frame 0
      const emptyFrame = {
        height: 0,
        timestamp: Date.now(),
        replicas: new Map(),
        runtimeInput: { runtimeTxs: [], entityInputs: [] },
        runtimeOutputs: [],
        description: 'Frame 0: Clean slate (before scenario)',
        title: 'Initial State'
      };

      console.log('[Architect] Executing on env:', currentEnv);

      // Execute scenario on isolated env
      const result = await XLN.executeScenario(currentEnv, parsed.scenario);

      if (result.success) {
        lastAction = `✅ Success! ${result.framesGenerated} frames generated.`;
        console.log(`[Architect] ${filename}: ${result.framesGenerated} frames`);

        // Prepend frame 0 (clean slate) to show progression from empty
        const historyWithCleanSlate = [emptyFrame, ...(currentEnv.history || [])];

        // Env is mutated in-place by executeScenario - trigger reactivity
        isolatedEnv.set(currentEnv);
        isolatedHistory.set(historyWithCleanSlate);

        console.log('[Architect] History: Frame 0 (empty) + Frames 1-' + currentEnv.history.length + ' (scenario)');

        // Start at frame 0 to show clean slate
        isolatedTimeIndex.set(0);

        // Notify panels
        panelBridge.emit('entity:created', { entityId: 'scenario', type: 'grid' });
      } else {
        throw new Error(`Execution failed: ${result.errors?.join(', ')}`);
      }
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Error:', err);
    } finally {
      loading = false;
    }
  }

  async function createNewXlnomy() {
    if (!newXlnomyName.trim()) {
      lastAction = '❌ Enter a name for the xlnomy';
      return;
    }

    // Limit to 9 xlnomies (3×3 grid)
    if ($isolatedEnv?.xlnomies && $isolatedEnv.xlnomies.size >= 9) {
      lastAction = '❌ Maximum 9 xlnomies (3×3 grid full)';
      return;
    }

    loading = true;
    lastAction = `Creating xlnomy "${newXlnomyName.toLowerCase()}"...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Step 1: Create Xlnomy (queues grid entity RuntimeTxs)
      await XLN.applyRuntimeInput($isolatedEnv, {
        runtimeTxs: [{
          type: 'createXlnomy',
          data: {
            name: newXlnomyName,
            evmType: newXlnomyEvmType,
            rpcUrl: newXlnomyEvmType !== 'browservm' ? newXlnomyRpcUrl : undefined,
            blockTimeMs: parseInt(newXlnomyBlockTime),
            autoGrid: newXlnomyAutoGrid
          }
        }],
        entityInputs: []
      });

      // Step 2: Process the queued importReplica transactions
      await XLN.applyRuntimeInput($isolatedEnv, {
        runtimeTxs: [],
        entityInputs: []
      });

      console.log('[Architect] Created Xlnomy with', $isolatedEnv.replicas.size, 'total entities');

      // Success message
      const createdName = newXlnomyName.toLowerCase();
      lastAction = `✅ xlnomy "${createdName}" created!`;

      // Close modal and advance to next number
      showCreateXlnomyModal = false;

      // Extract number from xlnomyN format
      const match = newXlnomyName.match(/xlnomy(\d+)/i);
      if (match && match[1]) {
        const num = parseInt(match[1]);
        newXlnomyName = `xlnomy${num + 1}`;
      } else {
        newXlnomyName = 'xlnomy1';
      }

      // Update stores to trigger reactivity
      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Xlnomy creation error:', err);
    } finally {
      loading = false;
    }
  }

  async function switchXlnomy(name: string) {
    if (!$isolatedEnv || name === $isolatedEnv.activeXlnomy) return;

    loading = true;
    lastAction = `Switching to "${name}"...`;

    try {
      $isolatedEnv.activeXlnomy = name;
      const xlnomy = $isolatedEnv.xlnomies?.get(name);

      if (xlnomy) {
        // TODO: Load xlnomy's replicas and history into env
        // For now, just update the active name
        lastAction = `✅ Switched to "${name}"`;
      }

      isolatedEnv.set($isolatedEnv);
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
    } finally {
      loading = false;
    }
  }

  /** Create new entity with custom name */
  async function createEntity() {
    if (!newEntityName.trim()) {
      lastAction = '❌ Enter entity name';
      return;
    }

    if (!$isolatedEnv?.activeXlnomy) {
      lastAction = '❌ Create Xlnomy first';
      return;
    }

    loading = true;
    lastAction = `Creating entity "${newEntityName}"...`;

    try {
      const runtimeUrl = new URL('/runtime.js', window.location.origin).href;
      const XLN = await import(/* @vite-ignore */ runtimeUrl);

      // Generate signerId from xlnomy name + entity name
      const signerId = `${$isolatedEnv.activeXlnomy.toLowerCase()}_${newEntityName.toLowerCase()}`;

      // Generate entityId (hash-based for lazy entities)
      const encoder = new TextEncoder();
      const data = encoder.encode(`${$isolatedEnv.activeXlnomy}:${newEntityName}:${Date.now()}`);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      const entityId = '0x' + hashHex; // 32 bytes = 64 hex chars (bytes32)

      // Random position in 3D space
      const position = {
        x: Math.random() * 400 - 200,
        y: Math.random() * 100,
        z: Math.random() * 400 - 200
      };

      // Create entity via importReplica RuntimeTx
      await XLN.applyRuntimeInput($isolatedEnv, {
        runtimeTxs: [{
          type: 'importReplica',
          entityId,
          signerId,
          data: {
            config: {
              mode: 'proposer-based',
              threshold: 1n,
              validators: [signerId],
              shares: { [signerId]: 1n },
              jurisdiction: $isolatedEnv.activeXlnomy
            },
            isProposer: true,
            position
          }
        }],
        entityInputs: []
      });

      lastAction = `✅ Created "${newEntityName}"`;

      // Auto-advance to next common name for fast creation
      const names = ['alice', 'bob', 'charlie', 'dave', 'eve', 'frank', 'grace', 'heidi'];
      const currentIndex = names.indexOf(newEntityName.toLowerCase());
      newEntityName = currentIndex >= 0 && currentIndex < names.length - 1
        ? (names[currentIndex + 1] || 'entity')
        : 'entity'; // Fallback

      // Update stores
      isolatedEnv.set($isolatedEnv);
      isolatedHistory.set($isolatedEnv.history || []);

      // Advance to latest frame
      isolatedTimeIndex.set(($isolatedEnv.history?.length || 1) - 1);
      panelBridge.emit('entity:created', { entityId, type: 'manual' });
    } catch (err: any) {
      lastAction = `❌ ${err.message}`;
      console.error('[Architect] Create entity error:', err);
    } finally {
      loading = false;
    }
  }

</script>

<div class="architect-panel">
  <div class="header">
    <h3>🎬 Architect</h3>
  </div>

  <div class="mode-selector">
    <button
      class:active={currentMode === 'explore'}
      on:click={() => currentMode = 'explore'}
    >
      🔍 Explore
    </button>
    <button
      class:active={currentMode === 'build'}
      on:click={() => currentMode = 'build'}
    >
      🏗️ Build
    </button>
    <button
      class:active={currentMode === 'economy'}
      on:click={() => currentMode = 'economy'}
    >
      💰 Economy
    </button>
    <button
      class:active={currentMode === 'governance'}
      on:click={() => currentMode = 'governance'}
    >
      ⚖️ Governance
    </button>
    <button
      class:active={currentMode === 'resolve'}
      on:click={() => currentMode = 'resolve'}
    >
      ⚔️ Resolve
    </button>
  </div>

  <div class="mode-content">
    {#if currentMode === 'economy'}
      <h4>Economy Mode</h4>

      {#if !envReady}
        <div class="status loading">
          ⏳ Initializing XLN environment...
        </div>
      {:else}
        <div class="action-section">
          <h5>🌍 Xlnomy (Economy)</h5>

          <!-- Prominent Create Button -->
          <button class="action-btn create-xlnomy-btn" on:click={() => showCreateXlnomyModal = true}>
            ➕ Create Xlnomy Here
          </button>

          <!-- Dropdown for switching (only visible if xlnomies exist) -->
          {#if xlnomies.length > 0}
            <div class="xlnomy-selector">
              <label for="xlnomy-switch">Switch to:</label>
              <select id="xlnomy-switch" bind:value={activeXlnomy} on:change={(e) => switchXlnomy(e.currentTarget.value)}>
                {#each xlnomies as name}
                  <option value={name}>{name}</option>
                {/each}
              </select>
            </div>
          {/if}

          <p class="help-text">Self-contained economies with isolated J-Machine + contracts</p>
        </div>

        <div class="action-section">
          <h5>Entity Registration</h5>
          <label class="checkbox-label">
            <input type="checkbox" bind:checked={numberedEntities} />
            <span>Numbered Entities (on-chain via EntityProvider.sol)</span>
          </label>
          <p class="help-text">
            {#if numberedEntities}
              ⚙️ Numbered: Entities registered on blockchain (slower, sequential numbers)
            {:else}
              ⚡ Lazy: In-browser only entities (faster, hash-based IDs, no gas)
            {/if}
          </p>
        </div>

        <div class="action-section topology-builder">
          <h5>🌐 Economic Topology Builder</h5>
          <p class="topology-intro">XLN = SUPERSET of all financial systems. Choose your model:</p>

          <div class="topology-grid">
            <button
              class="topology-card"
              class:active={selectedTopology === 'hybrid'}
              on:click={() => selectedTopology = 'hybrid'}
              disabled={loading || !activeXlnomy || entityIds.length > 0}
            >
              <div class="badge-new">DEFAULT</div>
              <div class="topology-icon">🔮</div>
              <h6>HYBRID</h6>
              <p class="topology-model">XLN Native</p>
              <ul class="topology-features">
                <li>Adaptive routing</li>
                <li>Crisis → Fed mode</li>
                <li>Best of all worlds</li>
              </ul>
            </button>

            <button
              class="topology-card"
              class:active={selectedTopology === 'star'}
              on:click={() => selectedTopology = 'star'}
              disabled={loading || !activeXlnomy || entityIds.length > 0}
            >
              <div class="topology-icon">⭐</div>
              <h6>STAR</h6>
              <p class="topology-model">USA/Canada</p>
              <ul class="topology-features">
                <li>Fed-centric</li>
                <li>No interbank</li>
                <li>Max control</li>
              </ul>
            </button>

            <button
              class="topology-card"
              class:active={selectedTopology === 'mesh'}
              on:click={() => selectedTopology = 'mesh'}
              disabled={loading || !activeXlnomy || entityIds.length > 0}
            >
              <div class="topology-icon">🕸️</div>
              <h6>MESH</h6>
              <p class="topology-model">Eurozone</p>
              <ul class="topology-features">
                <li>P2P interbank</li>
                <li>ECB emergency</li>
                <li>Decentralized</li>
              </ul>
            </button>

            <button
              class="topology-card"
              class:active={selectedTopology === 'tiered'}
              on:click={() => selectedTopology = 'tiered'}
              disabled={loading || !activeXlnomy || entityIds.length > 0}
            >
              <div class="topology-icon">🏛️</div>
              <h6>TIERED</h6>
              <p class="topology-model">China/Japan</p>
              <ul class="topology-features">
                <li>6 layers strict</li>
                <li>No tier jumping</li>
                <li>Command economy</li>
              </ul>
            </button>

            <button
              class="topology-card"
              class:active={selectedTopology === 'correspondent'}
              on:click={() => selectedTopology = 'correspondent'}
              disabled={loading || !activeXlnomy || entityIds.length > 0}
            >
              <div class="topology-icon">🌍</div>
              <h6>CORRESPONDENT</h6>
              <p class="topology-model">IMF/DevCo</p>
              <ul class="topology-features">
                <li>Chain routing</li>
                <li>Gateway bank</li>
                <li>FX fees</li>
              </ul>
            </button>
          </div>

          <button
            class="demo-btn create-economy-btn"
            on:click={() => createEconomyWithTopology(selectedTopology)}
            disabled={loading || !activeXlnomy || entityIds.length > 0}
          >
            🚀 Create {selectedTopology.toUpperCase()} Economy
          </button>

          {#if fedPaymentInterval}
            <button class="demo-btn stop-btn" on:click={stopFedPaymentLoop}>
              ⏹️ Stop Payment Loop
            </button>
            <p class="step-help live-indicator">🔴 LIVE: {selectedTopology.toUpperCase()} topology running...</p>
          {:else if entityIds.length > 0}
            <button class="demo-btn play-btn" on:click={startFedPaymentLoop}>
              ▶️ Restart Payment Loop
            </button>
          {/if}
        </div>

        <div class="action-section banker-demo">
          <h5>🏦 Banker Demo (Step-by-Step)</h5>

          <button class="demo-btn step-1" on:click={createHub} disabled={loading || !activeXlnomy || entityIds.length > 0}>
            🏗️ Step 1: Create 3×3 Hub
          </button>
          <p class="step-help">9 entities at y=320 (pinnacle hub)</p>

          <button class="demo-btn step-2" on:click={fundAllEntities} disabled={loading || entityIds.length === 0}>
            💰 Step 2: Fund All ($1M each)
          </button>
          <p class="step-help">Mint reserves to all 9 entities</p>

          <button class="demo-btn step-3" on:click={sendRandomPayment} disabled={loading || entityIds.length < 2}>
            🔄 Step 3: Random Payment
          </button>
          <p class="step-help">Send one R2R payment (click multiple times)</p>

          <button class="demo-btn step-4" on:click={resetDemo} disabled={loading}>
            🔄 Reset Demo
          </button>
          <p class="step-help">Clear xlnomy and start over</p>
        </div>

        <div class="action-section">
          <h5>💸 Mint Reserves</h5>
          <div class="form-group">
            <label for="mint-entity">Entity:</label>
            <select id="mint-entity" bind:value={selectedEntityForMint} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="mint-amount">Amount:</label>
            <input id="mint-amount" type="text" bind:value={mintAmount} placeholder="1000000" />
          </div>
          <button class="action-btn" on:click={mintReservesToEntity} disabled={loading || !selectedEntityForMint}>
            💸 Mint to Reserve
          </button>
          <p class="help-text">Deposit tokens to entity reserve (triggers J-Machine)</p>
        </div>

        <div class="action-section">
          <h5>🔄 Reserve-to-Reserve (R2R)</h5>
          <div class="form-group">
            <label for="r2r-from">From Entity:</label>
            <select id="r2r-from" bind:value={r2rFromEntity} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="r2r-to">To Entity:</label>
            <select id="r2r-to" bind:value={r2rToEntity} disabled={entityIds.length === 0}>
              <option value="">-- Select Entity --</option>
              {#each entityIds as entityId}
                <option value={entityId}>{shortAddress(entityId)}</option>
              {/each}
            </select>
          </div>
          <div class="form-group">
            <label for="r2r-amount">Amount:</label>
            <input id="r2r-amount" type="text" bind:value={r2rAmount} placeholder="500000" />
          </div>
          <button class="action-btn" on:click={sendR2RTransaction} disabled={loading || !r2rFromEntity || !r2rToEntity}>
            🔄 Send R2R Transaction
          </button>
          <p class="help-text">Send reserve-to-reserve payment (shows broadcast ripple)</p>
        </div>

        <div class="action-section">
          <h5>VR Mode</h5>
          <button class="action-btn" on:click={() => panelBridge.emit('vr:toggle', {})}>
            🥽 Enter VR
          </button>
          <p class="help-text">Quest 3 / WebXR headsets</p>
        </div>

        <div class="action-section">
          <h5>Broadcast Visualization</h5>
          <label class="checkbox-label">
            <input type="checkbox" checked on:change={(e) => panelBridge.emit('broadcast:toggle', { enabled: e.currentTarget.checked })} />
            Enable J-Machine Broadcast
          </label>
          <p class="help-text">Show O(n) broadcast from J-Machine to all entities</p>

          <h5 style="margin-top: 16px;">Broadcast Style</h5>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="raycast" checked on:change={() => panelBridge.emit('broadcast:style', { style: 'raycast' })} />
            Ray-Cast (shows each individual broadcast)
          </label>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="wave" on:change={() => panelBridge.emit('broadcast:style', { style: 'wave' })} />
            Expanding Wave (organic propagation)
          </label>
          <label class="radio-label">
            <input type="radio" name="broadcast-style" value="particles" on:change={() => panelBridge.emit('broadcast:style', { style: 'particles' })} />
            Particle Swarm (flies to each entity)
          </label>
        </div>

        {#if lastAction}
          <div class="status" class:loading>
            {lastAction}
          </div>
        {/if}
      {/if}

    {:else if currentMode === 'build'}
      <h4>Build Mode</h4>

      {#if !envReady}
        <div class="status loading">
          ⏳ Initializing XLN environment...
        </div>
      {:else if !$isolatedEnv?.activeXlnomy}
        <div class="status">
          ⚠️ Create an Xlnomy first (Economy mode)
        </div>
      {:else}
        <div class="action-section">
          <h5>Create Entity</h5>
          <div class="form-group">
            <label for="entity-name">Entity Name:</label>
            <input
              id="entity-name"
              type="text"
              bind:value={newEntityName}
              placeholder="alice"
              on:keydown={(e) => e.key === 'Enter' && createEntity()}
            />
          </div>
          <button class="action-btn" on:click={createEntity} disabled={loading || !newEntityName.trim()}>
            ➕ Create Entity
          </button>
          <p class="help-text">Entities appear as dots in 3D space</p>
        </div>

        <div class="action-section">
          <h5>Entities in {$isolatedEnv.activeXlnomy}</h5>
          {#if entityIds.length === 0}
            <p class="help-text">No entities yet. Create alice and bob to start!</p>
          {:else}
            <ul class="entity-list">
              {#each entityIds as entityId}
                <li>{shortAddress(entityId)}</li>
              {/each}
            </ul>
          {/if}
        </div>

        {#if lastAction}
          <div class="status" class:loading>
            {lastAction}
          </div>
        {/if}
      {/if}
    {:else}
      <h4>{currentMode.charAt(0).toUpperCase() + currentMode.slice(1)} Mode</h4>
      <p>Coming soon...</p>
    {/if}
  </div>
</div>

{#if showCreateXlnomyModal}
  <div class="modal-overlay" on:click={() => showCreateXlnomyModal = false}>
    <div class="modal" on:click|stopPropagation>
      <h3>Create New Xlnomy</h3>

      <div class="form-group">
        <label for="xlnomy-name">Name:</label>
        <input id="xlnomy-name" type="text" bind:value={newXlnomyName} />
      </div>

      <div class="form-group">
        <label>EVM Type:</label>
        <div class="radio-group">
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="browservm" />
            <span>BrowserVM (Simnet)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="reth" />
            <span>Reth (RPC)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="erigon" />
            <span>Erigon (RPC)</span>
          </label>
          <label class="radio-label">
            <input type="radio" bind:group={newXlnomyEvmType} value="monad" />
            <span>Monad (RPC)</span>
          </label>
        </div>
      </div>

      {#if newXlnomyEvmType !== 'browservm'}
        <div class="form-group">
          <label for="xlnomy-rpc">RPC URL:</label>
          <input id="xlnomy-rpc" type="text" bind:value={newXlnomyRpcUrl} placeholder="http://localhost:8545" />
        </div>
      {/if}

      <div class="form-group">
        <label for="xlnomy-blocktime">Block Time (ms):</label>
        <input id="xlnomy-blocktime" type="text" bind:value={newXlnomyBlockTime} placeholder="1000" />
      </div>

      <div class="modal-actions">
        <button class="action-btn secondary" on:click={() => showCreateXlnomyModal = false}>Cancel</button>
        <button class="action-btn" on:click={createNewXlnomy}>Create</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .architect-panel {
    width: 100%;
    height: 100%;
    background: #1e1e1e;
    color: #ccc;
    display: flex;
    flex-direction: column;
  }

  .header {
    padding: 12px;
    background: #2d2d30;
    border-bottom: 2px solid #007acc;
  }

  .header h3 {
    margin: 0;
    font-size: 14px;
  }

  .mode-selector {
    display: flex;
    gap: 4px;
    padding: 8px;
    background: #252526;
    border-bottom: 1px solid #3e3e3e;
    flex-wrap: wrap;
  }

  .mode-selector button {
    flex: 1;
    min-width: 80px;
    padding: 8px 12px;
    background: #2d2d30;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
  }

  .mode-selector button:hover {
    background: #37373d;
    border-color: #007acc;
  }

  .mode-selector button.active {
    background: #0e639c;
    color: white;
    border-color: #1177bb;
  }

  .mode-content {
    flex: 1;
    padding: 16px;
    overflow-y: auto;
  }

  .mode-content h4 {
    margin: 0 0 12px 0;
    color: #fff;
    font-size: 13px;
  }

  .mode-content p {
    margin: 8px 0;
    font-size: 12px;
    color: #8b949e;
  }

  .action-section {
    margin-bottom: 24px;
    padding: 12px;
    background: #252526;
    border: 1px solid #3e3e3e;
    border-radius: 4px;
  }

  .action-section h5 {
    margin: 0 0 12px 0;
    font-size: 12px;
    color: #fff;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .action-btn {
    width: 100%;
    padding: 12px 16px;
    background: #0e639c;
    border: none;
    color: white;
    border-radius: 4px;
    cursor: pointer;
    font-size: 13px;
    font-weight: 500;
    margin-bottom: 8px;
  }

  .action-btn:hover:not(:disabled) {
    background: #1177bb;
  }

  .action-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .action-btn.secondary {
    background: #2d2d30;
    border: 1px solid #3e3e3e;
  }

  .action-btn.secondary:hover:not(:disabled) {
    background: #37373d;
    border-color: #007acc;
  }

  .help-text {
    margin: 4px 0 0 0;
    font-size: 11px;
    color: #6e7681;
    font-style: italic;
  }

  .status {
    margin-top: 16px;
    padding: 12px;
    background: #1a3a1a;
    border-left: 3px solid #28a745;
    color: #7ee087;
    font-size: 12px;
    border-radius: 4px;
  }

  .status.loading {
    background: #1a2a3a;
    border-left-color: #007acc;
    color: #79c0ff;
  }

  .checkbox-label, .radio-label {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 0;
    font-size: 12px;
    color: #ccc;
    cursor: pointer;
  }

  .checkbox-label:hover, .radio-label:hover {
    color: #fff;
  }

  .checkbox-label input[type="checkbox"],
  .radio-label input[type="radio"] {
    cursor: pointer;
  }

  .form-group {
    margin-bottom: 12px;
  }

  .form-group label {
    display: block;
    margin-bottom: 4px;
    font-size: 11px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .form-group select,
  .form-group input[type="text"] {
    width: 100%;
    padding: 8px 12px;
    background: #1e1e1e;
    border: 1px solid #3e3e3e;
    color: #ccc;
    border-radius: 4px;
    font-size: 12px;
    font-family: monospace;
  }

  .form-group select:focus,
  .form-group input[type="text"]:focus {
    outline: none;
    border-color: #007acc;
  }

  .form-group select:disabled,
  .form-group input[type="text"]:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .checkbox-label span {
    font-weight: 500;
  }

  .create-xlnomy-btn {
    width: 100%;
    padding: 16px !important;
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 16px;
    background: linear-gradient(135deg, #00ff41 0%, #00cc33 100%) !important;
    color: #000 !important;
  }

  .create-xlnomy-btn:hover {
    background: linear-gradient(135deg, #00ff55 0%, #00dd44 100%) !important;
    transform: translateY(-1px);
  }

  .xlnomy-selector {
    display: flex;
    gap: 8px;
    flex-direction: column;
    margin-bottom: 12px;
  }

  .xlnomy-selector label {
    font-size: 11px;
    color: #888;
    margin-bottom: 4px;
  }

  .xlnomy-selector select {
    width: 100%;
    padding: 8px;
    background: #2a2a2a;
    border: 1px solid #444;
    border-radius: 4px;
    color: #fff;
  }

  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
  }

  .modal {
    background: #2d2d30;
    border: 1px solid #007acc;
    border-radius: 8px;
    padding: 24px;
    max-width: 500px;
    width: 90%;
  }

  .modal h3 {
    margin: 0 0 20px 0;
    color: #fff;
    font-size: 16px;
  }

  .radio-group {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .modal-actions {
    display: flex;
    gap: 12px;
    margin-top: 24px;
  }

  .modal-actions .action-btn {
    flex: 1;
  }

  .entity-list {
    list-style: none;
    padding: 0;
    margin: 8px 0;
    max-height: 200px;
    overflow-y: auto;
  }

  .entity-list li {
    padding: 6px 12px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    margin-bottom: 4px;
    font-family: 'Courier New', monospace;
    font-size: 12px;
    color: #8be9fd;
  }

  .topology-builder {
    background: rgba(0, 255, 65, 0.03);
    border: 2px solid rgba(0, 255, 65, 0.3);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 16px;
  }

  .topology-intro {
    font-size: 13px;
    color: #aaa;
    margin: 8px 0 16px 0;
    font-style: italic;
  }

  .topology-grid {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 8px;
    margin-bottom: 16px;
  }

  .topology-card {
    position: relative;
    background: rgba(255, 255, 255, 0.03);
    border: 2px solid rgba(255, 255, 255, 0.1);
    border-radius: 8px;
    padding: 12px 8px;
    cursor: pointer;
    transition: all 0.2s;
    text-align: center;
  }

  .topology-card:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(0, 255, 65, 0.5);
    transform: translateY(-2px);
  }

  .topology-card.active {
    background: rgba(0, 255, 65, 0.15);
    border-color: #00ff41;
    border-width: 3px;
  }

  .topology-card:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .badge-new {
    position: absolute;
    top: 4px;
    right: 4px;
    background: #ff6b6b;
    color: #fff;
    font-size: 9px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 4px;
    animation: pulse 2s ease-in-out infinite;
  }

  .topology-icon {
    font-size: 32px;
    margin-bottom: 8px;
  }

  .topology-card h6 {
    font-size: 13px;
    font-weight: 700;
    color: #fff;
    margin: 4px 0;
  }

  .topology-model {
    font-size: 10px;
    color: #888;
    margin: 4px 0 8px 0;
  }

  .topology-features {
    list-style: none;
    padding: 0;
    margin: 0;
    font-size: 9px;
    color: #aaa;
    text-align: left;
  }

  .topology-features li {
    margin: 2px 0;
    padding-left: 12px;
    position: relative;
  }

  .topology-features li::before {
    content: "▸";
    position: absolute;
    left: 0;
    color: #00ff41;
  }

  .create-economy-btn {
    background: linear-gradient(135deg, #00ff41 0%, #00cc33 100%);
    border: none;
    color: #000;
    font-size: 16px;
    font-weight: 700;
    padding: 16px;
    margin-bottom: 12px;
  }

  .create-economy-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, #00ff55 0%, #00ff41 100%);
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(0, 255, 65, 0.4);
  }

  .banker-demo {
    background: rgba(0, 255, 65, 0.05);
    border: 2px solid rgba(0, 255, 65, 0.3);
    border-radius: 8px;
    padding: 16px;
  }

  .demo-btn {
    width: 100%;
    padding: 14px;
    font-size: 15px;
    font-weight: 700;
    margin-bottom: 8px;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .demo-btn.fed-btn {
    background: linear-gradient(135deg, #8b7fb8 0%, #6a5a8b 100%);
    border: none;
    color: #fff;
    font-size: 16px;
  }

  .demo-btn.fed-btn:hover:not(:disabled) {
    background: linear-gradient(135deg, #9a8ac4 0%, #8b7fb8 100%);
    transform: translateY(-1px);
    box-shadow: 0 4px 12px rgba(139, 127, 184, 0.3);
  }

  .demo-btn.stop-btn {
    background: rgba(255, 70, 70, 0.2);
    border: 1px solid #ff4646;
    color: #ff4646;
    font-size: 14px;
    animation: pulse 2s ease-in-out infinite;
  }

  .demo-btn.stop-btn:hover {
    background: rgba(255, 70, 70, 0.4);
  }

  .demo-btn.play-btn {
    background: rgba(0, 255, 65, 0.2);
    border: 1px solid #00ff41;
    color: #00ff41;
    font-size: 14px;
  }

  .demo-btn.play-btn:hover {
    background: rgba(0, 255, 65, 0.3);
  }

  .live-indicator {
    color: #ff4646;
    font-weight: 700;
    animation: blink 1.5s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 70, 70, 0.4); }
    50% { box-shadow: 0 0 0 8px rgba(255, 70, 70, 0); }
  }

  @keyframes blink {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .demo-btn.step-1 {
    background: linear-gradient(135deg, #007acc 0%, #005a9e 100%);
    border: none;
    color: #fff;
  }

  .demo-btn.step-1:hover:not(:disabled) {
    background: linear-gradient(135deg, #0095ff 0%, #007acc 100%);
    transform: translateY(-1px);
  }

  .demo-btn.step-2 {
    background: linear-gradient(135deg, #00cc33 0%, #009922 100%);
    border: none;
    color: #fff;
  }

  .demo-btn.step-2:hover:not(:disabled) {
    background: linear-gradient(135deg, #00ff41 0%, #00cc33 100%);
    transform: translateY(-1px);
  }

  .demo-btn.step-3 {
    background: linear-gradient(135deg, #ff9500 0%, #cc7700 100%);
    border: none;
    color: #fff;
  }

  .demo-btn.step-3:hover:not(:disabled) {
    background: linear-gradient(135deg, #ffaa00 0%, #ff9500 100%);
    transform: translateY(-1px);
  }

  .demo-btn.step-4 {
    background: rgba(255, 70, 70, 0.2);
    border: 1px solid #ff4646;
    color: #ff4646;
  }

  .demo-btn.step-4:hover:not(:disabled) {
    background: rgba(255, 70, 70, 0.3);
  }

  .demo-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
    transform: none !important;
  }

  .step-help {
    font-size: 11px;
    color: #888;
    margin: 0 0 12px 0;
    font-style: italic;
  }
</style>
