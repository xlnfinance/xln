<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import * as THREE from 'three';
  import { xlnEnvironment, getXLN, xlnFunctions } from '../../stores/xlnStore';
  import { visibleReplicas, visibleGossip, currentTimeIndex, isLive } from '../../stores/timeStore';
  import { timeOperations } from '../../stores/timeStore';
  import { settings } from '../../stores/settingsStore';

  // OrbitControls import (will be loaded dynamically)
  let OrbitControls: any;

  // TypeScript interfaces for type safety
  interface EntityData {
    id: string;
    position: THREE.Vector3;
    mesh: THREE.Mesh;
    profile?: any;
    pulsePhase?: number;
    lastActivity?: number;
  }

  interface ConnectionData {
    from: string;
    to: string;
    line: THREE.Line;
    progressBars?: THREE.Group;
  }

  interface DerivedAccountData {
    delta: number;
    totalCapacity: number;
    ownCreditLimit: number;
    peerCreditLimit: number;
    inCapacity: number;
    outCapacity: number;
    collateral: number;
  }

  interface BirdViewSettings {
    barsMode: 'close' | 'spread';
    selectedTokenId: number;
    viewMode: '2d' | '3d';
    entityMode: 'sphere' | 'identicon';
    dataSource: 'replicas' | 'gossip';
    wasLastOpened: boolean;
  }

  let container: HTMLDivElement;
  let scene: THREE.Scene;
  let camera: THREE.PerspectiveCamera;
  let renderer: THREE.WebGLRenderer;
  let controls: any;
  let raycaster: THREE.Raycaster;
  let mouse: THREE.Vector2;

  // Network data with proper typing
  let entities: EntityData[] = [];
  let connections: ConnectionData[] = [];

  // Transaction particles
  let particles: Array<{
    mesh: THREE.Mesh;
    connectionIndex: number;
    progress: number;
    speed: number;
    type: string;
    amount?: bigint;
  }> = [];

  // Animation frame and hover state
  let animationId: number;
  let hoveredObject: any = null;
  let tooltip = { visible: false, x: 0, y: 0, content: '' };

  // Load saved bird view settings
  function loadBirdViewSettings(): BirdViewSettings {
    try {
      const saved = localStorage.getItem('xln-bird-view-settings');
      return saved ? JSON.parse(saved) : {
        barsMode: 'close',
        selectedTokenId: 0,
        viewMode: '3d',
        entityMode: 'sphere',
        dataSource: 'replicas',
        wasLastOpened: false
      };
    } catch {
      return {
        barsMode: 'close',
        selectedTokenId: 0,
        viewMode: '3d',
        entityMode: 'sphere',
        dataSource: 'replicas',
        wasLastOpened: false
      };
    }
  }

  function saveBirdViewSettings(wasOpened: boolean = true) {
    const settings: BirdViewSettings = {
      barsMode,
      selectedTokenId,
      viewMode,
      entityMode,
      dataSource,
      wasLastOpened: wasOpened
    };
    localStorage.setItem('xln-bird-view-settings', JSON.stringify(settings));
  }

  // Export bird view state for parent component
  export let onBirdViewStateChange: ((isOpen: boolean) => void) | undefined = undefined;

  // Topology control state with persistence
  const savedSettings = loadBirdViewSettings();
  let barsMode: 'close' | 'spread' = savedSettings.barsMode;
  let selectedTokenId = savedSettings.selectedTokenId;
  let viewMode: '2d' | '3d' = savedSettings.viewMode;
  let entityMode: 'sphere' | 'identicon' = savedSettings.entityMode;
  let dataSource: 'replicas' | 'gossip' = savedSettings.dataSource;
  let availableTokens: number[] = [0]; // Will be populated from data

  // Payment route selection state
  let showRouteSelection = false;
  let availableRoutes: Array<{
    from: string;
    to: string;
    path: string[];
    type: 'direct' | 'multihop';
    description: string;
  }> = [];

  onMount(() => {
    const initAndSetup = async () => {
      await initThreeJS();
      updateNetworkData();
      animate();
    };

    initAndSetup().catch(error => {
      throw new Error(`FINTECH-SAFETY: Failed to initialize 3D topology: ${error.message}`);
    });

    // Listen for data changes (both live and time machine)
    const unsubscribe1 = xlnEnvironment.subscribe(updateNetworkData);
    const unsubscribe2 = visibleReplicas.subscribe(updateNetworkData);
    const unsubscribe3 = visibleGossip.subscribe(updateNetworkData);

    return () => {
      unsubscribe1();
      unsubscribe2();
      unsubscribe3();
    };
  });

  onDestroy(() => {
    if (animationId) {
      cancelAnimationFrame(animationId);
    }
    if (renderer) {
      renderer.dispose();
    }
  });

  async function initThreeJS() {
    // Load OrbitControls dynamically
    try {
      const { OrbitControls: OC } = await import('three/examples/jsm/controls/OrbitControls.js');
      OrbitControls = OC;
    } catch (error) {
      console.warn('OrbitControls not available:', error);
    }

    // Scene setup
    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0a0a0a);

    // Camera setup
    camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000
    );
    camera.position.set(0, 0, 25);

    // Renderer setup
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // OrbitControls setup
    if (OrbitControls) {
      controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.05;
      controls.enableZoom = true;
      controls.enableRotate = true;
      controls.enablePan = true;
    }

    // Raycaster for mouse interaction
    raycaster = new THREE.Raycaster();
    mouse = new THREE.Vector2();

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 10, 5);
    scene.add(directionalLight);

    // Mouse events
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseout', onMouseOut);
    renderer.domElement.addEventListener('click', onMouseClick);

    // Handle resize
    window.addEventListener('resize', onWindowResize);
  }

  function updateNetworkData() {
    if (!scene) return;

    const timeIndex = $currentTimeIndex;
    const liveMode = $isLive;

    console.log(`🗺️ Updating topology - ${liveMode ? 'LIVE' : `Frame ${timeIndex}`}`);

    // Clear existing entities and connections
    clearNetwork();

    // Update available tokens
    updateAvailableTokens();

    // Use time-aware data sources
    let entityData: any[] = [];
    let currentReplicas = $visibleReplicas;
    let currentGossip = $visibleGossip;

    // Choose data source based on toggle
    if (dataSource === 'gossip' && currentGossip?.profiles) {
      entityData = Object.values(currentGossip.profiles) as any[];
      console.log(`📡 Using gossip profiles at frame ${timeIndex}:`, entityData.length);
    } else if (currentReplicas.size > 0) {
      // Use replicas (default and more reliable)
      const replicaEntries = Array.from(currentReplicas.entries());
      console.log(`🔄 Using replicas at frame ${timeIndex}:`, replicaEntries.length);

      // Extract unique entity IDs from replica keys with fail-fast validation
      const uniqueEntityIds = new Set<string>();
      for (let i = 0; i < replicaEntries.length; i++) {
        const entry = replicaEntries[i];
        if (!entry || !Array.isArray(entry) || entry.length < 2) {
          throw new Error('FINTECH-SAFETY: Invalid replica entry structure');
        }

        const key = entry[0];
        if (typeof key !== 'string') {
          throw new Error('FINTECH-SAFETY: Replica key must be string');
        }

        const parts = key.split(':');
        const entityId = parts[0];
        if (!entityId) {
          throw new Error('FINTECH-SAFETY: Invalid replica key format - missing entity ID');
        }
        uniqueEntityIds.add(entityId);
      }

      entityData = Array.from(uniqueEntityIds).map(entityId => ({
        entityId,
        capabilities: ['consensus'],
        metadata: { name: entityId.slice(0, 8) + '...' }
      }));
      console.log('🎯 Created entity data from time-aware replicas:', entityData.length);
    }

    // NO DEMO DATA - only show what actually exists
    if (entityData.length === 0) {
      console.warn(`⚠️ No entity data found at frame ${timeIndex} - nothing to display`);
      return; // Don't create fake entities
    }

    console.log(`🗺️ Frame ${timeIndex}: Updating topology with`, entityData.length, 'entities');

    // Create entity nodes
    entityData.forEach((profile, index) => {
      createEntityNode(profile, index, entityData.length);
    });

    // Create connections between entities that have accounts
    createConnections();

    // Create transaction flow particles and trigger activity pulses
    createTransactionParticles();
    updateEntityActivityFromCurrentFrame();
  }

  function clearNetwork() {
    // Remove entity meshes
    entities.forEach(entity => {
      scene.remove(entity.mesh);
    });
    entities = [];

    // Remove connection lines and progress bars
    connections.forEach(connection => {
      scene.remove(connection.line);
      if (connection.progressBars) {
        scene.remove(connection.progressBars);
      }
    });
    connections = [];

    // Remove particles
    particles.forEach(particle => {
      scene.remove(particle.mesh);
    });
    particles = [];
  }

  function createEntityNode(profile: any, index: number, total: number) {
    // Position entities in a circle for now
    const radius = 10;
    const angle = (index / total) * Math.PI * 2;
    const x = Math.cos(angle) * radius;
    const y = Math.sin(angle) * radius;
    const z = 0;

    // Calculate entity size based on selected token reserves
    const entitySize = getEntitySizeForToken(profile.entityId, selectedTokenId);

    // Create entity geometry - size based on token reserves
    const geometry = new THREE.SphereGeometry(entitySize, 32, 32);
    const material = new THREE.MeshLambertMaterial({
      color: 0x00ff88, // Bright green
      emissive: 0x002200, // Slight green glow
      transparent: true,
      opacity: 0.9
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);

    // Add entity label
    const entityId = profile.entityId.slice(0, 8) + '...';
    console.log('🔵 Created entity node:', entityId, 'at', x.toFixed(1), y.toFixed(1));

    scene.add(mesh);

    entities.push({
      id: profile.entityId,
      position: new THREE.Vector3(x, y, z),
      mesh,
      profile,
      pulsePhase: Math.random() * Math.PI * 2, // Random start phase
      lastActivity: 0
    });
  }

  function createConnections() {
    const processedConnections = new Set<string>();
    const currentReplicas = $visibleReplicas;

    console.log(`🔗 Creating connections for frame ${$currentTimeIndex}:`);
    console.log(`🔗 Replicas available:`, currentReplicas.size);

    // Method 1: Real connections from time-aware replicas
    if (currentReplicas.size > 0) {
      for (const [replicaKey, replica] of currentReplicas.entries()) {
        const [entityId] = replicaKey.split(':');
        const entityAccounts = replica.state?.accounts;

        console.log(`🔗 Processing replica ${replicaKey}: accounts=${entityAccounts?.size || 0}`);

        if (!entityAccounts || !entityId) continue;

        for (const accountKey of entityAccounts.keys()) {
          // Account key is just the counterparty ID (not counterpartyId:tokenId)
          const counterpartyId = String(accountKey);

          if (!counterpartyId) continue;

          // Create connection key (sorted to avoid duplicates)
          const connectionKey = [entityId, counterpartyId].sort().join('<->');
          if (processedConnections.has(connectionKey)) continue;
          processedConnections.add(connectionKey);

          // Find entity positions
          const fromEntity = entities.find(e => e.id === entityId);
          const toEntity = entities.find(e => e.id === counterpartyId);

          if (fromEntity && toEntity) {
            console.log(`🔗 Creating connection: ${entityId} ↔ ${counterpartyId}`);
            createConnectionLine(fromEntity, toEntity, entityId, counterpartyId, replica);
          } else {
            console.warn(`🔗 Missing entity for connection: ${entityId} ↔ ${counterpartyId}`);
          }
        }
      }
    }

    // NO DEMO CONNECTIONS - only show real bilateral accounts

    console.log(`🔗 Frame ${$currentTimeIndex}: Created ${connections.length} connections`);
  }

  function createTransactionParticles() {
    // Get current frame's server input for transaction data
    const timeIndex = $currentTimeIndex;

    if (!$isLive && $xlnEnvironment?.history && timeIndex >= 0) {
      const currentFrame = $xlnEnvironment.history[timeIndex];

      if (currentFrame?.serverInput?.entityInputs) {
        console.log(`💫 Analyzing frame ${timeIndex} for transaction particles`);

        currentFrame.serverInput.entityInputs.forEach((entityInput: any) => {
          if (entityInput.entityTxs) {
            entityInput.entityTxs.forEach((tx: any) => {
              if (tx.type === 'account_input') {
                createParticleForTransaction(tx.data, entityInput.entityId);
              }
            });
          }
        });
      }
    } else if ($isLive && $xlnEnvironment?.serverInput?.entityInputs) {
      // Live mode - use current server input
      console.log('💫 Analyzing live frame for transaction particles');

      $xlnEnvironment.serverInput.entityInputs.forEach((entityInput: any) => {
        if (entityInput.entityTxs) {
          entityInput.entityTxs.forEach((tx: any) => {
            if (tx.type === 'account_input') {
              createParticleForTransaction(tx.data, entityInput.entityId);
            }
          });
        }
      });
    }

    console.log(`💫 Created ${particles.length} transaction particles`);
  }

  function createParticleForTransaction(accountTxInput: any, _sourceEntityId: string) {
    const fromId = accountTxInput.fromEntityId;
    const toId = accountTxInput.toEntityId;
    const accountTx = accountTxInput.accountTx;

    // Find connection for this transaction
    const connectionIndex = connections.findIndex(conn =>
      (conn.from === fromId && conn.to === toId) ||
      (conn.from === toId && conn.to === fromId)
    );

    if (connectionIndex === -1) return;

    // Particle color based on transaction type
    let color = 0xffaa00; // Default gold
    let size = 0.1;

    switch (accountTx.type) {
      case 'payment':
        color = 0xffaa00; // Gold for payments
        size = Math.min(0.3, 0.1 + Number(accountTx.amount || 0n) / 10000);
        break;
      case 'credit_limit':
        color = 0x0088ff; // Blue for credit
        size = 0.15;
        break;
      case 'settlement':
        color = 0xff4444; // Red for settlement
        size = 0.2;
        break;
    }

    // Create particle mesh
    const geometry = new THREE.SphereGeometry(size, 8, 8);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8
    });
    const mesh = new THREE.Mesh(geometry, material);

    scene.add(mesh);

    // Add to particles array
    particles.push({
      mesh,
      connectionIndex,
      progress: 0,
      speed: 0.02 + Math.random() * 0.03, // Random speed
      type: accountTx.type,
      amount: accountTx.amount
    });

    // Activity pulses are now handled by updateEntityActivityFromCurrentFrame()
  }

  function createConnectionLine(fromEntity: any, toEntity: any, fromId: string, toId: string, replica: any) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      fromEntity.position,
      toEntity.position
    ]);

    // Create dotted line material
    const material = new THREE.LineDashedMaterial({
      color: 0x00ff44,
      opacity: 0.6,
      transparent: true,
      linewidth: 1,
      dashSize: 0.3,
      gapSize: 0.1
    });

    const line = new THREE.Line(geometry, material);
    line.computeLineDistances(); // Required for dashed lines
    scene.add(line);

    // Create progress bars for credit/collateral
    const progressBars = createProgressBars(fromEntity, toEntity, fromId, toId, replica);

    connections.push({
      from: fromId,
      to: toId,
      line,
      progressBars
    });
  }

  function createProgressBars(fromEntity: any, toEntity: any, fromId: string, toId: string, _replica: any) {
    const group = new THREE.Group();

    // Get current replicas to find the account
    const currentReplicas = $visibleReplicas;

    // Find the replica that actually contains this account
    let accountData: any = null;
    let foundInReplica: string = '';

    // Read accounts THE SAME WAY as EntityPanel - key is just counterpartyId!
    const fromReplica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(fromId + ':'));

    if (fromReplica?.[1]?.state?.accounts) {
      // Account key is just the counterparty ID, not counterpartyId:tokenId
      const accountKey = toId;
      accountData = fromReplica[1].state.accounts.get(accountKey);
      if (accountData) {
        foundInReplica = fromReplica[0];
        console.log(`📊 Found account ${accountKey} in replica ${foundInReplica}`);
        console.log(`📊 Account data:`, accountData);
      }
    }

    // Try reverse direction if not found
    if (!accountData) {
      const toReplica = Array.from(currentReplicas.entries() as [string, any][])
        .find(([key]) => key.startsWith(toId + ':'));

      if (toReplica?.[1]?.state?.accounts) {
        const reverseAccountKey = fromId;
        accountData = toReplica[1].state.accounts.get(reverseAccountKey);
        if (accountData) {
          foundInReplica = toReplica[0];
          console.log(`📊 Found reverse account ${reverseAccountKey} in replica ${foundInReplica}`);
          console.log(`📊 Reverse account data:`, accountData);
        }
      }
    }

    // NO BARS if no real account data
    if (!accountData) {
      console.log(`📊 No real account data for ${fromId} ↔ ${toId} - no bars created`);
      scene.add(group);
      return group;
    }

    // Get token-specific delta data EXACTLY like EntityPanel
    if (!accountData.deltas) {
      console.log(`📊 Account has no deltas map for ${fromId} ↔ ${toId}`);
      scene.add(group);
      return group;
    }

    const tokenDelta = accountData.deltas.get(selectedTokenId);
    if (!tokenDelta) {
      console.log(`📊 No delta data for token ${selectedTokenId} in account ${fromId} ↔ ${toId}`);
      scene.add(group);
      return group;
    }

    console.log(`📊 Token ${selectedTokenId} delta data:`, tokenDelta);

    // Derive channel data using 2019vue logic with REAL token delta
    const derived = deriveEntry(tokenDelta, fromId < toId); // left entity is lexicographically smaller

    // Calculate line geometry
    const direction = new THREE.Vector3().subVectors(toEntity.position, fromEntity.position);
    const lineLength = direction.length();
    const normalizedDirection = direction.clone().normalize();

    // Calculate bar dimensions and positions
    const barHeight = 0.08;

    // Create bars according to 2019vue structure:
    // [our_available_credit][our_secured][our_unsecured] |DELTA| [their_unsecured][their_secured][their_available_credit]

    createChannelBars(group, fromEntity, toEntity, fromId, toId, derived, barHeight, lineLength, normalizedDirection);

    scene.add(group);
    return group;
  }

  function deriveEntry(tokenDelta: any, isLeft: boolean): DerivedAccountData {
    // Use REAL deriveDelta function from xlnFunctions - NO MANUAL CALCULATION!
    if (!$xlnFunctions?.deriveDelta) {
      throw new Error('FINTECH-SAFETY: xlnFunctions.deriveDelta not available');
    }

    if (!tokenDelta) {
      throw new Error('FINTECH-SAFETY: Cannot derive from null token delta');
    }

    console.log(`💰 REAL Token delta before deriveDelta:`, tokenDelta);

    // Use the SAME deriveDelta function as AccountPanel
    const derived = $xlnFunctions.deriveDelta(tokenDelta, isLeft);

    console.log(`💰 REAL Derived data:`, derived);

    // Convert BigInt to numbers for 3D visualization - USE REAL FIELD NAMES!
    const result: DerivedAccountData = {
      delta: Number(derived.delta || 0n),
      totalCapacity: Number(derived.totalCapacity || 0n),
      ownCreditLimit: Number(derived.ownCreditLimit || 0n),
      peerCreditLimit: Number(derived.peerCreditLimit || 0n),
      inCapacity: Number(derived.inCapacity || 0n),
      outCapacity: Number(derived.outCapacity || 0n),
      collateral: Number(derived.collateral || 0n)
    };

    return result;
  }

  function createChannelBars(
    group: THREE.Group,
    fromEntity: EntityData,
    toEntity: EntityData,
    fromId: string,
    toId: string,
    derived: DerivedAccountData,
    barHeight: number,
    lineLength: number,
    direction: THREE.Vector3
  ): void {
    // Use totalCapacity for proportional scaling
    const maxVisualLength = lineLength * 0.6; // Max 60% of line length for bars
    const barScale = derived.totalCapacity > 0 ? maxVisualLength / derived.totalCapacity : 0;

    // Bar colors for REAL deriveDelta fields
    const colors = {
      inCapacity: 0x5cb85c,      // green - can receive
      outCapacity: 0xff9c9c,     // light red - can send
      collateral: 0x0088ff,      // blue - locked collateral
      ownCredit: 0xdc3545,       // red - our credit usage
      peerCredit: 0xffaa00       // orange - their credit usage
    };

    // Calculate segment lengths using REAL deriveDelta fields
    const segments = {
      inCapacity: derived.inCapacity * barScale,
      outCapacity: derived.outCapacity * barScale,
      collateral: derived.collateral * barScale,
      ownCredit: derived.ownCreditLimit * barScale,
      peerCredit: derived.peerCreditLimit * barScale
    };

    // Calculate total bars length
    const totalBarsLength = Object.values(segments).reduce((sum, length) => sum + length, 0);

    // Calculate entity radii to avoid collision
    const fromEntitySize = getEntitySizeForToken(fromId, selectedTokenId);
    const toEntitySize = getEntitySizeForToken(toId, selectedTokenId);

    // Calculate required spacing based on bars length
    const minGap = 0.5; // Minimum visual gap
    const availableSpace = lineLength - fromEntitySize - toEntitySize;

    // Position calculation based on barsMode
    let startPos: THREE.Vector3;
    let barDirection: THREE.Vector3;

    if (barsMode === 'spread') {
      // Spread mode: bars start AFTER entity edge, extend toward center
      const fromEdgePos = fromEntity.position.clone().add(direction.clone().normalize().multiplyScalar(fromEntitySize + minGap));
      startPos = fromEdgePos;
      barDirection = direction.clone().normalize();

      console.log(`🏗️ SPREAD: bars from edge+gap, total length: ${totalBarsLength.toFixed(2)}`);
    } else {
      // Close mode: bars clustered in CENTER, ensuring gaps from entities
      const centerPoint = fromEntity.position.clone().lerp(toEntity.position, 0.5);
      const halfBarsLength = totalBarsLength / 2;

      // Ensure bars don't touch entities
      const safeOffset = Math.max(halfBarsLength, (availableSpace / 2) - minGap);
      startPos = centerPoint.clone().sub(direction.clone().normalize().multiplyScalar(safeOffset));
      barDirection = direction.clone().normalize();

      console.log(`🏗️ CLOSE: centered bars, safe offset: ${safeOffset.toFixed(2)}, available space: ${availableSpace.toFixed(2)}`);
    }

    // Create bars using REAL deriveDelta fields in 2019vue order:
    // [our_available_credit][our_collateral][our_used_credit] |DELTA| [their_used_credit][their_collateral][their_available_credit]
    const barOrder = ['outCapacity', 'collateral', 'ownCredit', 'peerCredit', 'inCapacity'] as const;
    let currentOffset = 0;

    console.log(`📊 Creating bars with segments:`, segments);

    barOrder.forEach((barType, index) => {
      const length = segments[barType as keyof typeof segments];
      if (length === undefined) {
        throw new Error(`FINTECH-SAFETY: Missing segment data for bar type: ${barType}`);
      }
      console.log(`📊 Creating bar ${barType}: length=${length.toFixed(3)}`);

      if (length > 0.01) { // Lower threshold for visibility
        // Create VERY THICK cylindrical bar geometry for visibility
        const radius = barHeight * 3.0; // Much thicker bars
        const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);
        const barColor = colors[barType as keyof typeof colors];
        if (!barColor) {
          throw new Error(`FINTECH-SAFETY: Unknown bar type: ${barType}`);
        }

        const material = new THREE.MeshLambertMaterial({
          color: barColor,
          transparent: true,
          opacity: 0.9,
          emissive: new THREE.Color(barColor).multiplyScalar(0.1) // Slight glow
        });
        const bar = new THREE.Mesh(geometry, material);

        // Position bar along the line
        const barCenter = startPos.clone().add(barDirection.clone().multiplyScalar(currentOffset + length/2));
        bar.position.copy(barCenter);

        // Align bar with line direction - PROPER ROTATION
        const axis = new THREE.Vector3(0, 1, 0); // Cylinder's default axis
        const targetAxis = barDirection.clone().normalize();
        bar.quaternion.setFromUnitVectors(axis, targetAxis);

        group.add(bar);
        console.log(`✅ Created ${barType} bar at offset ${currentOffset.toFixed(2)}`);
      }

      currentOffset += length;

      // Add delta separator after ownCredit (index 2)
      if (index === 2) {
        const separatorPos = startPos.clone().add(barDirection.clone().multiplyScalar(currentOffset));
        createDeltaSeparator(group, separatorPos, barDirection, barHeight);
        currentOffset += 0.15; // Gap for separator
      }
    });
  }

  function createDeltaSeparator(group: THREE.Group, position: THREE.Vector3, direction: THREE.Vector3, barHeight: number) {
    // Flat rectangular separator ===|=== (perpendicular to line)
    const separatorWidth = barHeight * 3; // 3x wider for visibility
    const separatorHeight = 0.05; // Very thin
    const separatorDepth = 0.05;

    const geometry = new THREE.BoxGeometry(separatorDepth, separatorWidth, separatorHeight);
    const material = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0.9
    });
    const separator = new THREE.Mesh(geometry, material);

    separator.position.copy(position);

    // Align perpendicular to line direction (180° rotation)
    separator.lookAt(position.clone().add(direction));
    separator.rotateY(Math.PI / 2); // Make it perpendicular

    group.add(separator);
  }

  function animate() {
    animationId = requestAnimationFrame(animate);

    // Update controls
    if (controls) {
      controls.update();
    } else {
      // Fallback rotation if no controls
      if (scene) {
        scene.rotation.y += 0.002;
      }
    }

    // Animate transaction particles
    animateParticles();

    // Animate entity pulses
    animateEntityPulses();

    if (renderer && camera) {
      renderer.render(scene, camera);
    }
  }

  function animateParticles() {
    particles.forEach((particle, index) => {
      // Update progress
      particle.progress += particle.speed;

      // Remove particle when it reaches the end
      if (particle.progress >= 1) {
        scene.remove(particle.mesh);
        particles.splice(index, 1);
        return;
      }

      // Get connection
      const connection = connections[particle.connectionIndex];
      if (!connection) return;

      // Get start and end points
      const positions = connection.line.geometry.getAttribute('position');
      const start = new THREE.Vector3().fromBufferAttribute(positions, 0);
      const end = new THREE.Vector3().fromBufferAttribute(positions, 1);

      // Interpolate position along the line
      const currentPos = start.lerp(end, particle.progress);
      particle.mesh.position.copy(currentPos);

      // Add some slight pulsing animation
      const pulse = 1 + 0.2 * Math.sin(Date.now() * 0.01 + index);
      particle.mesh.scale.setScalar(pulse);
    });
  }

  function animateEntityPulses() {
    const currentTime = Date.now();

    entities.forEach((entity) => {
      if (!entity.mesh) return;

      // Only pulse if there was recent activity (no constant pulsing!)
      const timeSinceActivity = currentTime - (entity.lastActivity || 0);

      if (timeSinceActivity < 2000) { // 2 second activity window
        // Update pulse phase only when active
        entity.pulsePhase = (entity.pulsePhase || 0) + 0.1;

        // Single transaction pulse (not continuous)
        const pulseIntensity = Math.max(0, 1 - timeSinceActivity / 2000);
        const pulseFactor = 1 + pulseIntensity * 0.4 * Math.sin(entity.pulsePhase);

        entity.mesh.scale.setScalar(pulseFactor);

        // Activity glow with type safety
        const material = entity.mesh.material as THREE.MeshLambertMaterial;
        if (!material?.emissive) {
          throw new Error('FINTECH-SAFETY: Entity material missing emissive property for glow');
        }
        const glowIntensity = pulseIntensity * 0.4;
        material.emissive.setRGB(0, glowIntensity, 0);
      } else {
        // Reset to normal state when no activity
        entity.mesh.scale.setScalar(1);
        const material = entity.mesh.material as THREE.MeshLambertMaterial;
        if (!material?.emissive) {
          throw new Error('FINTECH-SAFETY: Entity material missing emissive property for reset');
        }
        material.emissive.setRGB(0, 0.1, 0); // Base glow
      }
    });
  }

  function triggerEntityActivity(entityId: string) {
    const entity = entities.find(e => e.id === entityId);
    if (entity) {
      entity.lastActivity = Date.now();
      console.log(`💫 Triggered activity pulse for entity: ${entityId.slice(0, 8)}...`);
    }
  }

  function updateEntityActivityFromCurrentFrame() {
    // Reset all activity first
    entities.forEach(entity => {
      entity.lastActivity = 0;
    });

    // Only pulse entities that have transactions in CURRENT frame
    const timeIndex = $currentTimeIndex;

    if (!$isLive && $xlnEnvironment?.history && timeIndex >= 0) {
      const currentFrame = $xlnEnvironment.history[timeIndex];

      if (currentFrame?.serverInput?.entityInputs) {
        console.log(`💫 Checking frame ${timeIndex} for entity activity`);

        currentFrame.serverInput.entityInputs.forEach((entityInput: any) => {
          if (entityInput.entityTxs) {
            entityInput.entityTxs.forEach((tx: any) => {
              if (tx.type === 'account_input') {
                // Pulse entities involved in this transaction
                triggerEntityActivity(tx.data.fromEntityId);
                triggerEntityActivity(tx.data.toEntityId);
                console.log(`💫 Frame ${timeIndex}: Transaction activity ${tx.data.fromEntityId} → ${tx.data.toEntityId}`);
              }
            });
          }
        });
      }
    }
  }

  function onMouseMove(event: MouseEvent) {
    // Calculate mouse position in normalized device coordinates
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update the raycaster with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);

    // Check for intersections with entities
    const entityMeshes = entities.map(e => e.mesh);
    const entityIntersects = raycaster.intersectObjects(entityMeshes);

    // Check for intersections with connection lines
    const connectionLines = connections.map(c => c.line);
    const lineIntersects = raycaster.intersectObjects(connectionLines);

    if (entityIntersects.length > 0) {
      const intersectedObject = entityIntersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object found');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);

      if (!entity) {
        throw new Error('FINTECH-SAFETY: Entity not found for intersected object');
      }

      if (hoveredObject !== intersectedObject) {
        hoveredObject = intersectedObject;

        // Show entity tooltip with balance details
        const balanceInfo = getEntityBalanceInfo(entity.id);
        tooltip = {
          visible: true,
          x: event.clientX,
          y: event.clientY,
          content: `🏛️ Entity: ${entity.id.slice(0, 16)}...\n📊 Capabilities: ${entity.profile?.capabilities?.join(', ') || 'N/A'}\n🔗 Accounts: ${getEntityAccountCount(entity.id)}\n💰 Balances:\n${balanceInfo}`
        };

        // Highlight entity with type safety
        const mesh = intersectedObject as THREE.Mesh;
        const material = mesh.material as THREE.MeshLambertMaterial;
        if (!material?.emissive) {
          throw new Error('FINTECH-SAFETY: Entity material missing emissive property');
        }
        material.emissive.setHex(0x444400);
      }
    } else if (lineIntersects.length > 0) {
      const intersectedLine = lineIntersects[0]?.object;
      if (!intersectedLine) {
        throw new Error('FINTECH-SAFETY: No intersected line found');
      }
      const connection = connections.find(c => c.line === intersectedLine);

      if (!connection) {
        throw new Error('FINTECH-SAFETY: Connection not found for intersected line');
      }

      if (hoveredObject !== intersectedLine) {
        hoveredObject = intersectedLine;

        // Show connection tooltip with account details
        const accountInfo = getConnectionAccountInfo(connection.from, connection.to);
        tooltip = {
          visible: true,
          x: event.clientX,
          y: event.clientY,
          content: `🔗 Account: ${connection.from.slice(0, 8)}...↔${connection.to.slice(0, 8)}...\n${accountInfo}`
        };

        // Highlight connection with type safety
        const lineMesh = intersectedLine as THREE.Line;
        const lineMaterial = lineMesh.material as THREE.LineDashedMaterial;
        if (!lineMaterial?.color) {
          throw new Error('FINTECH-SAFETY: Connection material missing color property');
        }
        lineMaterial.color.setHex(0xffff00);
      }
    } else {
      if (hoveredObject) {
        // Reset highlight safely
        try {
          if (hoveredObject.material?.emissive?.setHex) {
            hoveredObject.material.emissive.setHex(0x002200);
          } else if (hoveredObject.material?.color?.setHex) {
            hoveredObject.material.color.setHex(0x00ff44);
          }
        } catch (e) {
          console.warn('Failed to reset highlight:', e);
        }
        hoveredObject = null;
        tooltip.visible = false;
      }
    }
  }

  function onMouseOut() {
    if (hoveredObject) {
      try {
        if (hoveredObject.material?.emissive?.setHex) {
          hoveredObject.material.emissive.setHex(0x002200);
        }
      } catch (e) {
        console.warn('Failed to reset highlight on mouse out:', e);
      }
      hoveredObject = null;
    }
    tooltip.visible = false;
  }

  function onMouseClick(event: MouseEvent) {
    // Calculate mouse position
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update raycaster
    raycaster.setFromCamera(mouse, camera);

    // Check for entity intersections
    const entityMeshes = entities.map(e => e.mesh);
    const intersects = raycaster.intersectObjects(entityMeshes);

    if (intersects.length > 0) {
      const intersectedObject = intersects[0]?.object;
      if (!intersectedObject) {
        throw new Error('FINTECH-SAFETY: No intersected object in click');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);

      if (!entity) {
        throw new Error('FINTECH-SAFETY: Entity not found for clicked object');
      }

      // Trigger activity animation
      triggerEntityActivity(entity.id);

      // Center camera on entity
      centerCameraOnEntity(entity);

      console.log(`🎯 Clicked entity: ${entity.id.slice(0, 8)}...`);
    }
  }

  function centerCameraOnEntity(entity: EntityData) {
    if (!controls) {
      throw new Error('FINTECH-SAFETY: Camera controls not initialized');
    }

    // Smooth camera movement to entity
    const targetPosition = entity.position.clone();
    targetPosition.z += 5; // Move camera closer

    // Animate camera to target (simple version)
    const startPosition = camera.position.clone();
    const animationDuration = 1000; // 1 second
    const startTime = Date.now();

    function animateCamera() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / animationDuration, 1);

      // Smooth easing
      const eased = 1 - Math.pow(1 - progress, 3);

      camera.position.lerpVectors(startPosition, targetPosition, eased);
      controls.target.lerp(entity.position, eased);

      if (progress < 1) {
        requestAnimationFrame(animateCamera);
      }
    }

    animateCamera();
  }

  function getEntityAccountCount(entityId: string): number {
    const currentReplicas = $visibleReplicas;
    const replica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(entityId + ':'));

    return replica?.[1]?.state?.accounts?.size || 0;
  }

  function update3DMode() {
    if (!camera) return;

    if (viewMode === '2d') {
      // Switch to orthographic 2D view
      camera.position.set(0, 0, 30);
      camera.lookAt(0, 0, 0);
      if (controls) {
        controls.enableRotate = false;
        controls.enablePan = true;
      }
    } else {
      // Switch to 3D perspective view
      camera.position.set(0, 0, 25);
      if (controls) {
        controls.enableRotate = true;
        controls.enablePan = true;
      }
    }
  }

  function updateAvailableTokens() {
    const currentReplicas = $visibleReplicas;
    const tokenSet = new Set<number>();

    // Collect all available token IDs from reserves
    for (const [_, replica] of currentReplicas.entries()) {
      if (!replica?.state?.reserves) continue;

      replica.state.reserves.forEach((_: bigint, tokenId: number) => {
        tokenSet.add(tokenId);
      });
    }

    availableTokens = Array.from(tokenSet).sort((a, b) => a - b);
    if (availableTokens.length === 0) {
      availableTokens = [0]; // Default fallback
    }

    // Reset selected token if it's not available
    if (!availableTokens.includes(selectedTokenId)) {
      const firstToken = availableTokens[0];
      if (firstToken === undefined) {
        throw new Error('FINTECH-SAFETY: No available tokens found');
      }
      selectedTokenId = firstToken;
    }
  }

  function getEntitySizeForToken(entityId: string, tokenId: number): number {
    const currentReplicas = $visibleReplicas;
    const replica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(entityId + ':'));

    if (!replica?.[1]?.state?.reserves) {
      return 0.5; // Default size
    }

    const reserves = replica[1].state.reserves;
    const tokenAmount = reserves.get(tokenId) || 0n;

    // Normalize size between 0.3 and 1.5 based on token amount
    const normalizedAmount = Number(tokenAmount) / 10000; // Adjust scale as needed
    return Math.max(0.3, Math.min(1.5, 0.5 + normalizedAmount * 0.001));
  }

  function showPaymentRoutes() {
    // Auto-switch to LIVE mode before payment
    if (!$isLive) {
      console.log('🔴 Auto-switching to LIVE mode for payment');
      timeOperations.goToLive();
    }

    try {
      // Get available entities from LIVE data
      const liveReplicas = $xlnEnvironment?.replicas || new Map();
      const entityIds = Array.from(new Set(
        Array.from(liveReplicas.keys() as string[]).map((key: string) => {
          const parts = key.split(':');
          if (!parts[0]) {
            throw new Error('FINTECH-SAFETY: Invalid replica key format');
          }
          return parts[0];
        })
      ));

      if (entityIds.length < 2) {
        alert('Need at least 2 entities for payments');
        return;
      }

      // Calculate all possible routes
      availableRoutes = [];

      for (const fromId of entityIds) {
        for (const toId of entityIds) {
          if (fromId === toId) continue;

          // Check for direct connection
          const fromReplica = Array.from(liveReplicas.entries() as [string, any][])
            .find(([key]) => key.startsWith(fromId + ':'));

          if (fromReplica?.[1]?.state?.accounts?.has(toId)) {
            const fromShort = fromId.slice(0, 8);
            const toShort = toId.slice(0, 8);

            availableRoutes.push({
              from: fromId,
              to: toId,
              path: [fromId, toId],
              type: 'direct',
              description: `${fromShort}... → ${toShort}... (Direct)`
            });
          }

          // TODO: Add multi-hop route calculation later
        }
      }

      console.log(`💸 Found ${availableRoutes.length} payment routes`);
      showRouteSelection = true;

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('❌ Route calculation failed:', error);
      throw new Error(`FINTECH-SAFETY: Payment route calculation failed: ${errorMsg}`);
    }
  }

  async function executePaymentRoute(route: typeof availableRoutes[0]) {
    try {
      // Ensure we're in LIVE mode
      if (!$isLive) {
        timeOperations.goToLive();
      }

      await getXLN(); // Validate XLN available

      // Calculate 10% of available capacity
      const liveReplicas = $xlnEnvironment?.replicas || new Map();
      const fromReplica = Array.from(liveReplicas.entries() as [string, any][])
        .find(([key]) => key.startsWith(route.from + ':'));

      let paymentAmount = 100; // Fallback

      if (fromReplica?.[1]?.state?.reserves) {
        const reserves = fromReplica[1].state.reserves;
        const tokenReserve = reserves.get(selectedTokenId) || 0n;
        paymentAmount = Math.max(100, Number(tokenReserve) / 10); // 10% for visibility
      }

      console.log(`💸 Executing payment: ${route.description}, amount: ${paymentAmount}`);

      // Trigger visual activity
      triggerEntityActivity(route.from);
      triggerEntityActivity(route.to);

      // Close route selection
      showRouteSelection = false;

      // TODO: Call actual XLN payment function
      // await xln.makePayment($xlnEnvironment, route.from, route.to, selectedTokenId, paymentAmount);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('❌ Payment execution failed:', error);
      throw new Error(`FINTECH-SAFETY: Payment execution failed: ${errorMsg}`);
    }
  }

  function getEntityBalanceInfo(entityId: string): string {
    const currentReplicas = $visibleReplicas;
    const replica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(entityId + ':'));

    if (!replica?.[1]?.state?.reserves) {
      return "  Reserves loading...";
    }

    const reserves = replica[1].state.reserves;
    const balanceLines: string[] = [];

    if (reserves.size === 0) {
      return "  No token reserves";
    }

    // Show all tokens, highlight selected one
    reserves.forEach((amount: bigint, tokenId: number) => {
      const formattedAmount = (Number(amount) / 1000).toFixed(2);
      const marker = tokenId === selectedTokenId ? '👉' : '  ';
      balanceLines.push(`${marker} Token ${tokenId}: ${formattedAmount}k`);
    });

    return balanceLines.join('\n');
  }

  function getConnectionAccountInfo(fromId: string, toId: string): string {
    const currentReplicas = $visibleReplicas;

    // Find the replica that has this account (try both directions)
    let replica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(fromId + ':'));

    if (!replica) {
      replica = Array.from(currentReplicas.entries() as [string, any][])
        .find(([key]) => key.startsWith(toId + ':'));
    }

    if (!replica?.[1]?.state?.accounts) {
      return "💱 Credit: No replica state\n🔒 Collateral: No data\n⚖️ Balance: No data";
    }

    const accounts = replica[1].state.accounts;

    // Try to find account using counterparty ID as key (not tokenId)
    let accountData = accounts.get(toId);
    if (!accountData) {
      accountData = accounts.get(fromId);
    }

    if (!accountData) {
      return "💱 Credit: No account\n🔒 Collateral: No account\n⚖️ Balance: No account";
    }

    // Get token-specific delta EXACTLY like EntityPanel
    if (!accountData.deltas) {
      return "💱 Credit: No deltas map\n🔒 Collateral: No deltas\n⚖️ Balance: No deltas";
    }

    const tokenDelta = accountData.deltas.get(selectedTokenId);
    if (!tokenDelta) {
      return `💱 Credit: No data for token ${selectedTokenId}\n🔒 Collateral: N/A\n⚖️ Balance: N/A`;
    }

    // Use REAL deriveDelta calculation
    const derived = deriveEntry(tokenDelta, fromId < toId);

    const inCap = (derived.inCapacity / 1000).toFixed(1) + 'k';
    const outCap = (derived.outCapacity / 1000).toFixed(1) + 'k';
    const collateral = (derived.collateral / 1000).toFixed(1) + 'k';
    const balance = (derived.delta / 1000).toFixed(1) + 'k';
    const totalCap = (derived.totalCapacity / 1000).toFixed(1) + 'k';

    return `💚 Can Receive: ${inCap}\n💸 Can Send: ${outCap}\n🔒 Collateral: ${collateral}\n⚖️ Balance: ${balance}\n📊 Total Capacity: ${totalCap}`;
  }


  function onWindowResize() {
    if (!camera || !renderer) return;

    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }
</script>

<div bind:this={container} class="network-topology-container">
  <div class="topology-overlay">
    <div class="topology-info">
      <h3>🗺️ Network Topology</h3>

      <!-- Stats -->
      <p>Entities: {entities.length}</p>
      <p>Connections: {connections.length}</p>
      <p class="frame-info">
        {#if $isLive}
          🔴 LIVE Mode
        {:else}
          📼 Frame {$currentTimeIndex + 1}
        {/if}
      </p>

      <!-- Controls -->
      <div class="topology-controls">
        <!-- Token Filter -->
        <div class="control-group">
          <label>🪙 Token:</label>
          <select bind:value={selectedTokenId} on:change={() => { saveBirdViewSettings(); updateNetworkData(); }}>
            {#each availableTokens as tokenId}
              <option value={tokenId}>Token {tokenId}</option>
            {/each}
          </select>
        </div>

        <!-- Bars Mode -->
        <div class="control-group">
          <label>📊 Bars:</label>
          <button
            class="toggle-btn"
            class:active={barsMode === 'close'}
            on:click={() => { barsMode = 'close'; saveBirdViewSettings(); updateNetworkData(); }}
          >
            Close
          </button>
          <button
            class="toggle-btn"
            class:active={barsMode === 'spread'}
            on:click={() => { barsMode = 'spread'; saveBirdViewSettings(); updateNetworkData(); }}
          >
            Spread
          </button>
        </div>

        <!-- 2D/3D Mode -->
        <div class="control-group">
          <label>👁️ View:</label>
          <button
            class="toggle-btn"
            class:active={viewMode === '2d'}
            on:click={() => { viewMode = '2d'; saveBirdViewSettings(); update3DMode(); }}
          >
            2D
          </button>
          <button
            class="toggle-btn"
            class:active={viewMode === '3d'}
            on:click={() => { viewMode = '3d'; saveBirdViewSettings(); update3DMode(); }}
          >
            3D
          </button>
        </div>

        <!-- Data Source -->
        <div class="control-group">
          <label>📡 Data:</label>
          <button
            class="toggle-btn"
            class:active={dataSource === 'replicas'}
            on:click={() => { dataSource = 'replicas'; saveBirdViewSettings(); updateNetworkData(); }}
          >
            Replicas
          </button>
          <button
            class="toggle-btn"
            class:active={dataSource === 'gossip'}
            on:click={() => { dataSource = 'gossip'; saveBirdViewSettings(); updateNetworkData(); }}
          >
            Gossip
          </button>
        </div>

        <!-- Entity Display Mode -->
        <div class="control-group">
          <label>👤 Entity:</label>
          <button
            class="toggle-btn"
            class:active={entityMode === 'sphere'}
            on:click={() => { entityMode = 'sphere'; saveBirdViewSettings(); updateNetworkData(); }}
          >
            Sphere
          </button>
          <button
            class="toggle-btn"
            class:active={entityMode === 'identicon'}
            on:click={() => { entityMode = 'identicon'; saveBirdViewSettings(); updateNetworkData(); }}
          >
            Avatar
          </button>
        </div>

        <!-- Payment Routes -->
        <div class="control-group">
          <button class="action-btn" on:click={showPaymentRoutes}>
            💸 Payment Routes
          </button>
        </div>
      </div>

      <small>Scroll to zoom, drag to rotate</small>
    </div>
  </div>

  {#if tooltip.visible}
    <div
      class="tooltip"
      style="left: {tooltip.x + 10}px; top: {tooltip.y - 10}px;"
    >
      {#each tooltip.content.split('\n') as line}
        <div>{line}</div>
      {/each}
    </div>
  {/if}

  {#if showRouteSelection}
    <div class="route-modal" on:click={() => showRouteSelection = false}>
      <div class="route-content" on:click|stopPropagation>
        <div class="route-header">
        <h3>💸 Select Payment Route</h3>
        <button class="route-close" on:click={() => showRouteSelection = false}>×</button>
      </div>
      <div class="route-list">
        {#each availableRoutes as route}
          <button
            class="route-option"
            on:click={() => executePaymentRoute(route)}
          >
            <div class="route-type">{route.type === 'direct' ? '🎯' : '🔄'}</div>
            <div class="route-description">{route.description}</div>
          </button>
        {/each}
        {#if availableRoutes.length === 0}
          <div class="no-routes">No payment routes available</div>
        {/if}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .network-topology-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 10;
    background: #0a0a0a;
  }

  .topology-overlay {
    position: absolute;
    top: 80px;
    right: 20px;
    background: rgba(45, 45, 45, 0.9);
    border: 1px solid #007acc;
    border-radius: 8px;
    padding: 16px;
    color: #d4d4d4;
    z-index: 20;
    backdrop-filter: blur(10px);
  }

  .topology-info h3 {
    margin: 0 0 8px 0;
    color: #007acc;
    font-size: 16px;
  }

  .topology-info p {
    margin: 4px 0;
    font-family: monospace;
    font-size: 12px;
  }

  .topology-info small {
    color: #9d9d9d;
    font-size: 10px;
  }

  .frame-info {
    color: #00ff88;
    font-weight: bold;
    font-size: 11px;
    font-family: monospace;
  }

  .tooltip {
    position: fixed;
    background: rgba(0, 0, 0, 0.9);
    color: #00ff88;
    padding: 8px 12px;
    border-radius: 6px;
    border: 1px solid #00ff44;
    font-family: monospace;
    font-size: 12px;
    line-height: 1.4;
    z-index: 30;
    pointer-events: none;
    backdrop-filter: blur(10px);
    box-shadow: 0 4px 12px rgba(0, 255, 68, 0.3);
  }

  .topology-controls {
    margin-top: 12px;
    padding-top: 8px;
    border-top: 1px solid rgba(0, 255, 68, 0.3);
  }

  .control-group {
    display: flex;
    align-items: center;
    margin-bottom: 8px;
    gap: 8px;
  }

  .control-group label {
    font-size: 10px;
    color: #9d9d9d;
    min-width: 45px;
  }

  .control-group select {
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid #00ff44;
    border-radius: 4px;
    color: #00ff88;
    font-size: 10px;
    padding: 2px 4px;
    font-family: monospace;
  }

  .toggle-btn {
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(0, 255, 68, 0.5);
    border-radius: 4px;
    color: #9d9d9d;
    padding: 2px 6px;
    font-size: 9px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: monospace;
  }

  .toggle-btn:hover {
    border-color: #00ff44;
    color: #00ff88;
  }

  .toggle-btn.active {
    background: rgba(0, 255, 68, 0.2);
    border-color: #00ff44;
    color: #00ff88;
    font-weight: bold;
  }

  .action-btn {
    background: rgba(255, 175, 0, 0.2);
    border: 1px solid #ffaf00;
    border-radius: 4px;
    color: #ffaf00;
    padding: 4px 8px;
    font-size: 9px;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: monospace;
    font-weight: bold;
  }

  .action-btn:hover {
    background: rgba(255, 175, 0, 0.4);
    color: #ffd700;
  }

  .route-modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: rgba(0, 0, 0, 0.8);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    backdrop-filter: blur(10px);
  }

  .route-content {
    background: rgba(0, 0, 0, 0.95);
    border: 2px solid #00ff44;
    border-radius: 12px;
    padding: 20px;
    min-width: 400px;
    max-height: 500px;
  }

  .route-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    color: #00ff88;
    border-bottom: 1px solid rgba(0, 255, 68, 0.3);
    padding-bottom: 8px;
  }

  .route-close {
    background: none;
    border: none;
    color: #ff4444;
    font-size: 24px;
    cursor: pointer;
    padding: 0;
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .route-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 400px;
    overflow-y: auto;
  }

  .route-option {
    display: flex;
    align-items: center;
    gap: 12px;
    background: rgba(0, 255, 68, 0.1);
    border: 1px solid rgba(0, 255, 68, 0.3);
    border-radius: 6px;
    padding: 12px;
    color: #d4d4d4;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: monospace;
  }

  .route-option:hover {
    background: rgba(0, 255, 68, 0.2);
    border-color: #00ff44;
    color: #00ff88;
  }

  .route-type {
    font-size: 16px;
  }

  .route-description {
    font-size: 12px;
  }

  .no-routes {
    text-align: center;
    color: #9d9d9d;
    font-style: italic;
    padding: 20px;
  }
</style>