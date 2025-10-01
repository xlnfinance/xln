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
    label?: THREE.Sprite; // Label sprite that follows entity
    profile?: any;
    pulsePhase?: number;
    lastActivity?: number;
    isPinned?: boolean;  // User has manually positioned this entity
    isHovered?: boolean; // Mouse is over this entity
    isDragging?: boolean; // Currently being dragged
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
    wasLastOpened: boolean;
    rotationSpeed: number; // 0-100 (0 = stopped, 100 = fast rotation)
    camera?: {
      position: {x: number, y: number, z: number};
      target: {x: number, y: number, z: number};
      zoom: number;
    } | undefined;
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

  // Dual tooltip for connections (showing both perspectives)
  let dualTooltip = {
    visible: false,
    x: 0,
    y: 0,
    leftContent: '',
    rightContent: '',
    leftEntity: '',
    rightEntity: ''
  };

  // Drag state
  let draggedEntity: EntityData | null = null;
  let dragPlane: THREE.Plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0); // Plane for 3D dragging
  let dragOffset: THREE.Vector3 = new THREE.Vector3();
  let isDragging: boolean = false;
  let justDragged: boolean = false; // Flag to prevent click after drag

  // Load saved bird view settings (including camera state)
  function loadBirdViewSettings(): BirdViewSettings {
    try {
      const saved = localStorage.getItem('xln-bird-view-settings');
      const parsed = saved ? JSON.parse(saved) : {
        barsMode: 'close',
        selectedTokenId: 0,
        viewMode: '3d',
        entityMode: 'sphere',
        wasLastOpened: false,
        rotationSpeed: 0,
        camera: undefined
      };
      // FINTECH-SAFETY: Ensure selectedTokenId is number, not string
      if (typeof parsed.selectedTokenId === 'string') {
        parsed.selectedTokenId = Number(parsed.selectedTokenId);
      }
      // Backward compatibility: convert old autoRotate boolean to rotationSpeed
      if (parsed.autoRotate !== undefined && parsed.rotationSpeed === undefined) {
        parsed.rotationSpeed = parsed.autoRotate ? 3000 : 0; // Default to 3000 (Earth-like) if was ON
        delete parsed.autoRotate;
      }
      // Migrate old 0-100000 range to 0-10000 range (divide by 10)
      if (parsed.rotationSpeed !== undefined && parsed.rotationSpeed > 10000) {
        parsed.rotationSpeed = Math.floor(parsed.rotationSpeed / 10);
      }
      // Provide defaults for new fields if missing
      if (parsed.rotationSpeed === undefined) parsed.rotationSpeed = 0;
      return parsed;
    } catch {
      return {
        barsMode: 'close',
        selectedTokenId: 0,
        viewMode: '3d',
        entityMode: 'sphere',
        wasLastOpened: false,
        rotationSpeed: 0,
        camera: undefined
      };
    }
  }

  function saveBirdViewSettings(wasOpened: boolean = true) {
    const settings: BirdViewSettings = {
      barsMode,
      selectedTokenId,
      viewMode,
      entityMode,
      wasLastOpened: wasOpened,
      rotationSpeed,
      camera: camera && controls ? {
        position: {x: camera.position.x, y: camera.position.y, z: camera.position.z},
        target: {x: controls.target.x, y: controls.target.y, z: controls.target.z},
        zoom: camera.zoom
      } : undefined
    };
    localStorage.setItem('xln-bird-view-settings', JSON.stringify(settings));
  }

  // Entity position persistence (CRITICAL: prevents re-intersecting on reload)
  function loadEntityPositions(): Map<string, THREE.Vector3> | null {
    try {
      const saved = localStorage.getItem('xln-entity-positions');
      if (!saved) return null;

      const data = JSON.parse(saved);
      const positions = new Map<string, THREE.Vector3>();

      for (const [entityId, pos] of Object.entries(data)) {
        const posData = pos as {x: number, y: number, z: number};
        positions.set(entityId, new THREE.Vector3(posData.x, posData.y, posData.z));
      }

      console.log(`💾 Loaded ${positions.size} saved entity positions`);
      return positions;
    } catch (err) {
      console.warn('Failed to load entity positions:', err);
      return null;
    }
  }

  function saveEntityPositions() {
    try {
      const data: Record<string, {x: number, y: number, z: number}> = {};

      entities.forEach(entity => {
        data[entity.id] = {
          x: entity.position.x,
          y: entity.position.y,
          z: entity.position.z
        };
      });

      localStorage.setItem('xln-entity-positions', JSON.stringify(data));
      console.log(`💾 Saved ${entities.length} entity positions`);
    } catch (err) {
      console.warn('Failed to save entity positions:', err);
    }
  }

  // Export bird view state for parent component
  export let onBirdViewStateChange: ((isOpen: boolean) => void) | undefined = undefined;

  // Topology control state with persistence
  const savedSettings = loadBirdViewSettings();
  let barsMode: 'close' | 'spread' = savedSettings.barsMode;
  let selectedTokenId = savedSettings.selectedTokenId;
  let viewMode: '2d' | '3d' = savedSettings.viewMode;
  let entityMode: 'sphere' | 'identicon' = savedSettings.entityMode;
  let rotationSpeed: number = savedSettings.rotationSpeed; // 0-10000 (0 = stopped, 10000 = fast)
  let availableTokens: number[] = []; // Will be populated from actual token data

  // Quick payment form state
  let paymentFrom: string = '';
  let paymentTo: string = '';
  let paymentAmount: string = '200000';
  let paymentTPS: number = 0; // 0-100 TPS (0 = once, 0.1 = every 10s, 100 = max)

  // Auto-select entities when entities list changes
  $: if (entities.length >= 2 && !paymentFrom && !paymentTo) {
    const firstEntity = entities[0];
    const secondEntity = entities[1];
    if (firstEntity && secondEntity) {
      paymentFrom = firstEntity.id;
      paymentTo = secondEntity.id;
    }
  }

  // Active payment jobs
  interface PaymentJob {
    id: string;
    from: string;
    to: string;
    amount: string;
    tps: number;
    sentCount: number;
    startedAt: number;
    intervalId?: number;
  }
  let activeJobs: PaymentJob[] = [];

  // Ripple effects for balance changes
  interface Ripple {
    mesh: THREE.Mesh;
    startTime: number;
    duration: number;
    maxRadius: number;
  }
  let activeRipples: Ripple[] = [];

  // Payment route selection state
  let showRouteSelection = false;
  let availableRoutes: Array<{
    from: string;
    to: string;
    path: string[];
    type: 'direct' | 'multihop';
    description: string;
  }> = [];

  // Real-time activity ticker
  let recentActivity: Array<{
    id: string;
    message: string;
    timestamp: number;
    type: 'payment' | 'credit' | 'settlement';
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

      // Restore saved camera state if available
      if (savedSettings.camera) {
        const cam = savedSettings.camera;
        camera.position.set(cam.position.x, cam.position.y, cam.position.z);
        controls.target.set(cam.target.x, cam.target.y, cam.target.z);
        camera.zoom = cam.zoom;
        camera.updateProjectionMatrix();
        controls.update();
        console.log(`📷 Restored camera state from localStorage`);
      }

      // CRITICAL: Save camera state after manual user movements (rotate/pan/zoom)
      controls.addEventListener('end', () => {
        saveBirdViewSettings();
      });
    }

    // Raycaster for mouse interaction
    raycaster = new THREE.Raycaster();
    // Increase line threshold so connections can be hovered from further away
    // Default is 1, we increase to 5 for better UX (hover activates ~5 units from line)
    raycaster.params.Line = { threshold: 5 };
    mouse = new THREE.Vector2();

    // Lights
    const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
    scene.add(ambientLight);

    const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
    directionalLight.position.set(10, 10, 5);
    scene.add(directionalLight);

    // Mouse events
    renderer.domElement.addEventListener('mousedown', onMouseDown);
    renderer.domElement.addEventListener('mouseup', onMouseUp);
    renderer.domElement.addEventListener('mousemove', onMouseMove);
    renderer.domElement.addEventListener('mouseout', onMouseOut);
    renderer.domElement.addEventListener('click', onMouseClick);
    renderer.domElement.addEventListener('dblclick', onMouseDoubleClick);


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

    // Always use replicas (ground truth)
    if (currentReplicas.size > 0) {
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

    // Build connection and capacity maps for force-directed layout (always active)
    const connectionMap = new Map<string, Set<string>>();
    const capacityMap = new Map<string, number>();

    // Build connection map from replicas
    if (currentReplicas.size > 0) {
      for (const [replicaKey, replica] of currentReplicas.entries()) {
        const [entityId] = replicaKey.split(':');
        const entityAccounts = replica.state?.accounts;

        if (entityAccounts && entityAccounts.size > 0) {
          if (!connectionMap.has(entityId)) {
            connectionMap.set(entityId, new Set());
          }

          for (const [counterpartyId, accountData] of entityAccounts.entries()) {
            connectionMap.get(entityId)?.add(counterpartyId);

            // Calculate total capacity for this connection
            const accountTokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
            if (accountTokenDelta) {
              const derived = $xlnFunctions.deriveDelta(accountTokenDelta, entityId < counterpartyId);
              const capacityKey = [entityId, counterpartyId].sort().join('-');
              capacityMap.set(capacityKey, derived.totalCapacity);
            }
          }
        }
      }
    }

    // Calculate connection degrees and find top-3 hubs
    const connectionDegrees = new Map<string, number>();
    entityData.forEach(profile => {
      const degree = connectionMap.get(profile.entityId)?.size || 0;
      connectionDegrees.set(profile.entityId, degree);
    });

    // Find top-3 hubs (most connected entities)
    const sortedByDegree = [...connectionDegrees.entries()].sort((a, b) => b[1] - a[1]);
    const top3Hubs = new Set(sortedByDegree.slice(0, 3).map(([id]) => id));

    console.log(`🌟 Top-3 Hubs:`, Array.from(top3Hubs).map(id => `${id.slice(0,8)} (${connectionDegrees.get(id)} connections)`));

    // Try to load saved positions first (persistence)
    const savedPositions = loadEntityPositions();

    // Run force-directed layout simulation (fallback if no saved positions)
    const forceLayoutPositions = savedPositions || applyForceDirectedLayout(entityData, connectionMap, capacityMap);

    // Create entity nodes
    entityData.forEach((profile, index) => {
      const isHub = top3Hubs.has(profile.entityId);
      const degree = connectionDegrees.get(profile.entityId) || 0;
      createEntityNode(profile, index, entityData.length, forceLayoutPositions, isHub, degree);
    });

    // Save positions after layout (for persistence on reload)
    if (!savedPositions) {
      // Only save if we computed new layout (not using saved positions)
      saveEntityPositions();
    }

    // Create connections between entities that have accounts
    createConnections();

    // Create transaction flow particles and trigger activity pulses
    createTransactionParticles();
    updateEntityActivityFromCurrentFrame();

    // Enforce minimum spacing constraints (200px spread, 100px close)
    // This pushes entities apart if bars would pierce after initial layout
    enforceSpacingConstraints();
  }

  function clearNetwork() {
    // Remove entity meshes AND labels
    entities.forEach(entity => {
      scene.remove(entity.mesh);
      // CRITICAL: Remove labels to prevent orphaned sprites accumulating
      if (entity.label) {
        scene.remove(entity.label);
      }
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

  // Radial hub-centric layout: Hubs in center, leaves on periphery
  function applyForceDirectedLayout(profiles: any[], connectionMap: Map<string, Set<string>>, _capacityMap: Map<string, number>) {
    const positions = new Map<string, THREE.Vector3>();

    // Detect hubs vs users by connection count
    const connectionCounts = new Map<string, number>();
    profiles.forEach(profile => {
      const connections = connectionMap.get(profile.entityId);
      connectionCounts.set(profile.entityId, connections?.size || 0);
    });

    // Sort: hubs first (most connections), then users
    const sorted = [...profiles].sort((a, b) => {
      const countA = connectionCounts.get(a.entityId) || 0;
      const countB = connectionCounts.get(b.entityId) || 0;
      return countB - countA; // Descending - hubs first
    });

    // Radial layout: distance from center inversely proportional to degree
    // Hubs (high degree) stay near center, leaves (low degree) spread out
    const baseRadius = 5; // Minimum distance for hubs
    const maxRadius = 50; // Maximum distance for leaves
    const angleStep = (Math.PI * 2) / profiles.length;

    sorted.forEach((profile, index) => {
      const degree = connectionCounts.get(profile.entityId) || 0;

      // Calculate radius: hubs close to center, leaves far away
      // Using inverse relationship: radius = maxRadius / (degree + 1)
      const radius = degree > 0
        ? Math.max(baseRadius, maxRadius / (degree + 1))
        : maxRadius;

      // Arrange in circle at calculated radius
      const angle = index * angleStep;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const z = 0;

      positions.set(profile.entityId, new THREE.Vector3(x, y, z));

      console.log(`📍 ${profile.entityId.slice(0,8)}: degree=${degree}, radius=${radius.toFixed(1)}`);
    });

    console.log(`🎯 Radial hub-centric layout complete (${profiles.length} entities)`);
    return positions;
  }

  function createEntityNode(profile: any, index: number, total: number, forceLayoutPositions: Map<string, THREE.Vector3>, isHub: boolean, degree: number) {
    // Position entities using force-directed layout (always)
    let x: number, y: number, z: number;

    if (forceLayoutPositions.has(profile.entityId)) {
      // Use computed force-directed position
      const pos = forceLayoutPositions.get(profile.entityId)!;
      x = pos.x;
      y = pos.y;
      z = pos.z;
    } else {
      // Fallback: large circle if entity not in force layout
      const radius = 30;
      const angle = (index / total) * Math.PI * 2;
      x = Math.cos(angle) * radius;
      y = Math.sin(angle) * radius;
      z = 0;
    }

    // Calculate entity size based on selected token reserves
    const entitySize = getEntitySizeForToken(profile.entityId, selectedTokenId);

    // Create entity geometry - size based on token reserves
    const geometry = new THREE.SphereGeometry(entitySize, 32, 32);

    // Hub glow effect: Top-3 hubs get bright emissive glow
    const baseColor = 0x00ff88; // Bright green
    const emissiveColor = isHub ? 0x00ff88 : 0x002200; // Bright glow for hubs, subtle for others
    const emissiveIntensity = isHub ? 0.6 : 0.1; // Much brighter for hubs

    const material = new THREE.MeshLambertMaterial({
      color: baseColor,
      emissive: emissiveColor,
      emissiveIntensity: emissiveIntensity,
      transparent: true,
      opacity: 0.9
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(x, y, z);

    if (isHub) {
      console.log(`🌟 Created hub node: ${profile.entityId.slice(0,8)} with ${degree} connections (bright glow)`);
    }

    // Add entity label
    const entityId = profile.entityId.slice(0, 8) + '...';
    console.log('🔵 Created entity node:', entityId, 'at', x.toFixed(1), y.toFixed(1));

    scene.add(mesh);

    // Add entity name label (returns sprite to store with entity)
    const labelSprite = createEntityLabel(profile.entityId);

    entities.push({
      id: profile.entityId,
      position: new THREE.Vector3(x, y, z),
      mesh,
      label: labelSprite, // Store label with entity for dynamic positioning
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
                // Unicast: payment through network
                createParticleForTransaction(tx.data, entityInput.entityId);
              } else if (['deposit_reserve', 'withdraw_reserve', 'credit_from_reserve', 'debit_to_reserve'].includes(tx.type)) {
                // Broadcast: jurisdiction event (reserve operations)
                createBroadcastRipple(entityInput.entityId, tx.type);
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
              // Unicast: payment through network
              createParticleForTransaction(tx.data, entityInput.entityId);
            } else if (['deposit_reserve', 'withdraw_reserve', 'credit_from_reserve', 'debit_to_reserve'].includes(tx.type)) {
              // Broadcast: jurisdiction event (reserve operations)
              createBroadcastRipple(entityInput.entityId, tx.type);
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

  function createBroadcastRipple(entityId: string, txType: string) {
    // Find entity by ID
    const entity = entities.find(e => e.id === entityId);
    if (!entity) {
      console.log(`⚠️ Cannot create ripple: entity ${entityId.slice(-4)} not found`);
      return;
    }

    // Create expanding ring/sphere for broadcast visualization
    const startRadius = 0.5;
    const expandSpeed = 0.05;

    // Ring color based on tx type
    let color = 0x00ffff; // Cyan default
    switch (txType) {
      case 'deposit_reserve':
        color = 0x00ff00; // Green - money coming in
        break;
      case 'withdraw_reserve':
        color = 0xff0000; // Red - money going out
        break;
      case 'credit_from_reserve':
        color = 0xffaa00; // Orange - credit from reserve
        break;
      case 'debit_to_reserve':
        color = 0xff44ff; // Magenta - debit to reserve
        break;
    }

    // Create ring geometry (torus for 3D, circle for 2D)
    const geometry = new THREE.TorusGeometry(startRadius, 0.05, 16, 32);
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    });
    const ripple = new THREE.Mesh(geometry, material);

    // Position at entity location
    ripple.position.copy(entity.position);

    // Orient ring flat (perpendicular to camera view)
    ripple.rotation.x = Math.PI / 2;

    scene.add(ripple);

    // Add to particles array for animation (reuse particles system)
    particles.push({
      mesh: ripple,
      connectionIndex: -1, // -1 indicates broadcast ripple (not connection-based)
      progress: 0,
      speed: expandSpeed,
      type: `ripple_${txType}`,
      amount: 0n // No amount for ripples
    });

    console.log(`🌊 Created broadcast ripple for ${entityId.slice(-4)} (${txType})`);
  }

  function createConnectionLine(fromEntity: any, toEntity: any, fromId: string, toId: string, replica: any) {
    const geometry = new THREE.BufferGeometry().setFromPoints([
      fromEntity.position,
      toEntity.position
    ]);

    // Create dotted line material - more spaced and lightweight (user requirement)
    const material = new THREE.LineDashedMaterial({
      color: 0x00ff44,
      opacity: 0.3, // Much lighter (was 0.6)
      transparent: true,
      linewidth: 1,
      dashSize: 0.2, // Shorter dashes (was 0.3)
      gapSize: 0.5   // Much larger gaps (was 0.1)
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

    // FINTECH-SAFETY: Get available tokens for THIS specific connection
    if (!accountData.deltas) {
      console.log(`📊 Account has no deltas map for ${fromId} ↔ ${toId}`);
      scene.add(group);
      return group;
    }

    const availableTokens = Array.from(accountData.deltas.keys() as IterableIterator<number>).sort((a, b) => a - b);

    if (availableTokens.length === 0) {
      console.log(`📊 Account has no tokens in deltas for ${fromId} ↔ ${toId}`);
      scene.add(group);
      return group;
    }

    // Use single source of truth for delta access
    let tokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
    let displayTokenId = selectedTokenId;

    // FINTECH-GRADE: If selected token doesn't exist, use first available (same logic as tooltip)
    if (!tokenDelta && availableTokens.length > 0) {
      displayTokenId = availableTokens[0]!;
      tokenDelta = getAccountTokenDelta(accountData, displayTokenId);
      console.log(`📊 Token ${selectedTokenId} not in ${fromId.slice(-4)}↔${toId.slice(-4)}, using Token ${displayTokenId}. Available: [${availableTokens.join(', ')}]`);
    }

    if (!tokenDelta) {
      // This should never happen after fallback, but fail-fast
      throw new Error(`FINTECH-SAFETY: Token ${displayTokenId} not found in progress bars despite being in availableTokens: ${availableTokens}`);
    }

    console.log(`📊 Token ${displayTokenId} delta data:`, tokenDelta);

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

  /**
   * SINGLE SOURCE OF TRUTH: Get token delta from account with type safety
   * Used by both tooltip and progress bars to ensure consistent data access
   */
  function getAccountTokenDelta(accountData: any, tokenId: number): any | null {
    if (!accountData?.deltas) {
      return null;
    }
    // Type-safe access: both tokenId and Map key are guaranteed numbers
    return accountData.deltas.get(tokenId) ?? null;
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
    // INVARIANT: 1px = 1 unit of value - bars length directly proportional to capacity
    // Values come with 18 decimals (1e18 = 1 token), scale to visual units
    // Target: 1M tokens (1e24 with decimals) ≈ 10 visual units
    const globalScale = $settings.portfolioScale || 5000;
    const decimals = 18;
    const tokensToVisualUnits = 0.00001; // 1M tokens → 10 units
    const barScale = (tokensToVisualUnits / Math.pow(10, decimals)) * (globalScale / 5000);

    // Bar colors matching 2019 visualization
    // Structure: [peerCredit][collateral][ownCredit] with DELTA separator
    const colors = {
      peerCredit: 0xff9c9c,      // light red - their available credit to us
      collateral: 0x5cb85c,      // green - locked collateral (secured)
      ownCredit: 0xff9c9c        // light red - our available credit to them
    };

    // Calculate segment lengths - show LIMITS (invariant structure)
    // This visualizes [-leftCredit-.collateral-rightCredit] structure
    const segments = {
      peerCredit: derived.peerCreditLimit * barScale,
      collateral: derived.collateral * barScale,
      ownCredit: derived.ownCreditLimit * barScale
    };

    // Calculate entity radii to avoid collision
    const fromEntitySize = getEntitySizeForToken(fromId, selectedTokenId);
    const toEntitySize = getEntitySizeForToken(toId, selectedTokenId);

    // ENFORCED MINIMUM GAPS (user requirement):
    // - Spread mode: 2 visual units gap in middle (no delta separator)
    // - Close mode: 1 visual unit gap on each side + delta separator in front
    // Note: These are visual/world units, not screen pixels. At current scale ~40 units = full H-width
    const minGapSpread = 2; // Small gap in middle (spread mode)
    const minGapClose = 1; // Small gap on each side (close mode)

    const availableSpace = lineLength - fromEntitySize - toEntitySize;

    // Calculate total bars length - NO SCALING (maintain invariant: 1px = 1 value unit)
    const totalBarsLength = Object.values(segments).reduce((sum, length) => sum + length, 0);

    // Check if bars overflow (for debugging) - but DON'T scale them down
    const requiredSpace = barsMode === 'spread' ? totalBarsLength + minGapSpread : totalBarsLength + (2 * minGapClose);
    if (requiredSpace > availableSpace) {
      console.log(`📏 Bars overflow by ${(requiredSpace - availableSpace).toFixed(2)} units - entities should be farther apart`);
    }

    console.log(`📊 Creating bars with segments:`, segments);

    if (barsMode === 'spread') {
      // SPREAD MODE: bars extend FROM BOTH entities toward middle
      // Left entity: [peerCredit][collateral] →
      // Right entity: ← [ownCredit]
      // Gap in middle (no delta separator in spread mode)

      // FIRST PRINCIPLE: Bars must NEVER pierce entity surface
      // Bar has radius, so start position must be: entitySurface + barRadius + gap
      const barRadius = barHeight * 2.5;
      const safeGap = 0.2; // Small visual gap between entity surface and bar

      // Left-side bars (from left entity rightward) - START OUTSIDE ENTITY SPHERE
      const leftBarsLength = segments.peerCredit + segments.collateral;
      const leftStartPos = fromEntity.position.clone().add(
        direction.clone().normalize().multiplyScalar(fromEntitySize + barRadius + safeGap)
      );

      let leftOffset = 0;
      ['peerCredit', 'collateral'].forEach((barType) => {
        const length = segments[barType as keyof typeof segments];
        if (length > 0.01) {
          const radius = barHeight * 2.5; // 2x thinner (was 5.0)
          const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);
          const barColor = colors[barType as keyof typeof colors];

          // Credit bars: airy/transparent (unloaded trust), Collateral: solid (actual value)
          const isCredit = barType === 'peerCredit' || barType === 'ownCredit';
          const material = new THREE.MeshLambertMaterial({
            color: barColor,
            transparent: true,
            opacity: isCredit ? 0.3 : 0.9, // Credit: very airy (30%), Collateral: solid (90%)
            emissive: new THREE.Color(barColor).multiplyScalar(isCredit ? 0.05 : 0.1),
            wireframe: isCredit // Credit shows as wireframe (unloaded trust)
          });
          const bar = new THREE.Mesh(geometry, material);

          const barCenter = leftStartPos.clone().add(direction.clone().normalize().multiplyScalar(leftOffset + length/2));
          bar.position.copy(barCenter);

          const axis = new THREE.Vector3(0, 1, 0);
          const targetAxis = direction.clone().normalize();
          bar.quaternion.setFromUnitVectors(axis, targetAxis);

          group.add(bar);

          // Bar labels removed - shown only on hover
        }
        leftOffset += length;
      });

      // Right-side bars (from right entity leftward) - START OUTSIDE ENTITY SPHERE
      const rightStartPos = toEntity.position.clone().add(
        direction.clone().normalize().multiplyScalar(-(toEntitySize + barRadius + safeGap))
      );

      if (segments.ownCredit > 0.01) {
        const length = segments.ownCredit;
        const radius = barHeight * 2.5; // 2x thinner
        const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);
        const barColor = colors.ownCredit;

        // Credit: airy/transparent wireframe (unloaded trust)
        const material = new THREE.MeshLambertMaterial({
          color: barColor,
          transparent: true,
          opacity: 0.3, // Very airy for credit
          emissive: new THREE.Color(barColor).multiplyScalar(0.05),
          wireframe: true // Wireframe shows it's unloaded trust
        });
        const bar = new THREE.Mesh(geometry, material);

        const barCenter = rightStartPos.clone().add(direction.clone().normalize().multiplyScalar(-length/2));
        bar.position.copy(barCenter);

        const axis = new THREE.Vector3(0, 1, 0);
        const targetAxis = direction.clone().normalize();
        bar.quaternion.setFromUnitVectors(axis, targetAxis);

        group.add(bar);

        // Bar labels removed - shown only on hover
      }

      console.log(`🏗️ SPREAD: left bars (${leftBarsLength.toFixed(2)}) from left entity, right bars (${segments.ownCredit.toFixed(2)}) from right entity`);

    } else {
      // CLOSE MODE: bars clustered in CENTER with delta separator
      const centerPoint = fromEntity.position.clone().lerp(toEntity.position, 0.5);
      const halfBarsLength = totalBarsLength / 2;
      const startPos = centerPoint.clone().sub(direction.clone().normalize().multiplyScalar(halfBarsLength));
      const barDirection = direction.clone().normalize();

      let currentOffset = 0;
      const barOrder = ['peerCredit', 'collateral', 'ownCredit'] as const;

      barOrder.forEach((barType, index) => {
        const length = segments[barType as keyof typeof segments];
        if (length === undefined) {
          throw new Error(`FINTECH-SAFETY: Missing segment data for bar type: ${barType}`);
        }

        if (length > 0.01) {
          const radius = barHeight * 2.5; // 2x thinner (was 5.0)
          const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);
          const barColor = colors[barType as keyof typeof colors];
          if (!barColor) {
            throw new Error(`FINTECH-SAFETY: Unknown bar type: ${barType}`);
          }

          // Credit bars: airy/transparent wireframe (unloaded trust), Collateral: solid (actual value)
          const isCredit = barType === 'peerCredit' || barType === 'ownCredit';
          const material = new THREE.MeshLambertMaterial({
            color: barColor,
            transparent: true,
            opacity: isCredit ? 0.3 : 0.9, // Credit: airy (30%), Collateral: solid (90%)
            emissive: new THREE.Color(barColor).multiplyScalar(isCredit ? 0.05 : 0.1),
            wireframe: isCredit // Credit shows as wireframe (unloaded trust)
          });
          const bar = new THREE.Mesh(geometry, material);

          const barCenter = startPos.clone().add(barDirection.clone().multiplyScalar(currentOffset + length/2));
          bar.position.copy(barCenter);

          const axis = new THREE.Vector3(0, 1, 0);
          const targetAxis = barDirection.clone().normalize();
          bar.quaternion.setFromUnitVectors(axis, targetAxis);

          group.add(bar);

          // Bar labels removed - shown only on hover
        }

        currentOffset += length;

        // Add delta separator after collateral (index 1) in CLOSE mode only
        // SEAMLESS: No gap added - delta is part of the continuous bar structure
        if (index === 1) {
          const separatorPos = startPos.clone().add(barDirection.clone().multiplyScalar(currentOffset));
          createDeltaSeparator(group, separatorPos, barDirection, barHeight);
          // NO gap: currentOffset += 0.2; (removed - bars must be seamless)
        }
      });

      console.log(`🏗️ CLOSE: centered bars, total length: ${totalBarsLength.toFixed(2)}`);
    }
  }

  function createDeltaSeparator(group: THREE.Group, position: THREE.Vector3, direction: THREE.Vector3, barHeight: number) {
    // SHARP DISK separator marking delta (zero point) - sleek knife-like ==|== design
    const diskRadius = barHeight * 4; // Wide disk for visibility
    const diskThickness = barHeight * 0.3; // Very thin for sharp knife appearance

    // Create thin disk (very flat cylinder)
    const geometry = new THREE.CylinderGeometry(diskRadius, diskRadius, diskThickness, 32);
    const material = new THREE.MeshLambertMaterial({
      color: 0xff3333, // Bright red for delta marker
      transparent: true,
      opacity: 0.95,
      emissive: 0xff0000,
      emissiveIntensity: 0.3
    });
    const separator = new THREE.Mesh(geometry, material);

    separator.position.copy(position);

    // Align cylinder axis (Y) with line direction so disk face is perpendicular (splits bars)
    // Cylinder default axis is Y, we want Y to point along the line direction
    const axis = new THREE.Vector3(0, 1, 0); // Cylinder's default axis
    const targetAxis = direction.clone().normalize();
    separator.quaternion.setFromUnitVectors(axis, targetAxis);

    group.add(separator);
  }

  // Bar labels removed per user request - shown only on hover tooltips
  // function createBarLabel(group: THREE.Group, position: THREE.Vector3, value: number, _barType: string) {
  //   ...
  // }

  function createEntityLabel(entityId: string): THREE.Sprite {
    // Create canvas for entity name - minimalist, no background, square aspect ratio to avoid skewing
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d')!;
    // Use square canvas to prevent skewing (128x128 for clean rendering)
    canvas.width = 128;
    canvas.height = 128;

    // Get short entity name (just number, no prefix)
    const entityName = getEntityShortName(entityId);

    // NO background - transparent (user requirement: black background is ugly)
    context.clearRect(0, 0, canvas.width, canvas.height);

    // Text styling - minimalist monospace, bright green, larger font
    context.fillStyle = '#00ff88';
    context.font = 'bold 32px sans-serif'; // Larger, cleaner sans-serif
    context.textAlign = 'center';
    context.textBaseline = 'middle';

    // Draw text centered in square canvas
    context.fillText(entityName, 64, 64);

    // Create sprite with texture
    const texture = new THREE.CanvasTexture(canvas);
    texture.needsUpdate = true;

    const spriteMaterial = new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false, // Always visible on top
      sizeAttenuation: true // Scale with distance for better depth perception
    });
    const sprite = new THREE.Sprite(spriteMaterial);

    // Square sprite (1:1 aspect ratio) to match square canvas - prevents skewing
    sprite.scale.set(1.5, 1.5, 1);

    scene.add(sprite);
    return sprite; // Return sprite to store with entity
  }

  function updateEntityLabels() {
    // Update all entity labels to stay on top of spheres (neat, minimalist, always attached)
    // FIRST PRINCIPLE: Labels must never disconnect - every entity must have a visible label
    if (!camera) return;

    entities.forEach(entity => {
      if (!entity.label) {
        // Defensive: If label is missing, recreate it (should never happen but fail-safe)
        console.warn(`⚠️ Entity ${entity.id.slice(-4)} missing label - recreating`);
        entity.label = createEntityLabel(entity.id);
      }

      // Verify label is in scene (defensive check)
      if (!scene.children.includes(entity.label)) {
        console.warn(`⚠️ Label for ${entity.id.slice(-4)} not in scene - re-adding`);
        scene.add(entity.label);
      }

      // Position label above the entity sphere (attached to entity position)
      const entitySize = getEntitySizeForToken(entity.id, selectedTokenId);
      entity.label.position.set(
        entity.position.x,
        entity.position.y + entitySize + 0.8, // Slightly above sphere
        entity.position.z
      );

      // CRITICAL: Sprites must always face camera for readable text
      // Explicitly update rotation quaternion to face camera (billboard effect)
      entity.label.quaternion.copy(camera.quaternion);
    });
  }

  function animate() {
    animationId = requestAnimationFrame(animate);

    // Auto-rotate (adjustable speed from slider 0-10000)
    if (rotationSpeed > 0 && controls) {
      // Map slider value (0-10000) to rotation angle
      // 1000 = Earth-like slow rotation (~0.001 rad/frame = 1 rotation per ~100 seconds)
      // 10000 = Fast rotation (~0.01 rad/frame = 1 rotation per ~10 seconds)
      const maxRotationSpeed = 0.01; // Maximum rotation speed at slider = 10000
      const angle = (rotationSpeed / 10000) * maxRotationSpeed;

      const currentPosition = camera.position.clone();
      const target = controls.target.clone();

      // Rotate camera position around target (Y-axis for horizontal rotation)
      const offset = currentPosition.sub(target);
      const newX = offset.x * Math.cos(angle) - offset.z * Math.sin(angle);
      const newZ = offset.x * Math.sin(angle) + offset.z * Math.cos(angle);

      camera.position.x = target.x + newX;
      camera.position.z = target.z + newZ;
      camera.lookAt(target);

      // Save camera state periodically during auto-rotation (not every frame)
      if (Math.random() < 0.01) { // ~1% chance per frame = every few seconds
        saveBirdViewSettings();
      }
    }

    // Update controls
    if (controls) {
      controls.update();
    } else {
      // Fallback rotation if no controls
      if (scene) {
        scene.rotation.y += 0.002;
      }
    }

    // Continuous auto-repulsion when entities intersect in space
    applyCollisionRepulsion();

    // Update entity label positions (always on top of sphere)
    updateEntityLabels();

    // Animate transaction particles
    animateParticles();

    // Animate entity pulses
    animateEntityPulses();

    // Update balance change ripples
    updateRipples();

    // Detect jurisdictional events (j-events) and create ripples (throttled)
    if (Math.random() < 0.05) { // Check ~5% of frames = 3 times per second at 60fps
      detectJurisdictionalEvents();
    }

    if (renderer && camera) {
      renderer.render(scene, camera);
    }
  }

  // Throttle connection rebuilding (expensive operation)
  let lastConnectionRebuild = 0;
  let needsConnectionRebuild = false;

  function applyCollisionRepulsion() {
    // First principle: entities must never overlap in 3D space
    // Check all pairs and push apart if they're too close (sphere intersection)

    let anyMoved = false;

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entityA = entities[i];
        const entityB = entities[j];
        if (!entityA || !entityB) continue;

        // Calculate entity radii (approximate as sphere radius)
        const radiusA = getEntitySizeForToken(entityA.id, selectedTokenId);
        const radiusB = getEntitySizeForToken(entityB.id, selectedTokenId);

        // Current distance between centers
        const distance = entityA.position.distanceTo(entityB.position);

        // Minimum allowed distance (surfaces just touching)
        const minDistance = radiusA + radiusB;

        // If overlapping, push apart
        if (distance < minDistance && distance > 0.01) {
          const overlap = minDistance - distance;
          const direction = new THREE.Vector3().subVectors(entityB.position, entityA.position).normalize();

          // Push force proportional to overlap (spring-like)
          const pushStrength = overlap * 0.5; // Gentle continuous push

          // If neither pinned, push both equally
          if (!entityA.isPinned && !entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushStrength / 2));
            entityB.position.add(direction.clone().multiplyScalar(pushStrength / 2));
            entityA.mesh.position.copy(entityA.position);
            entityB.mesh.position.copy(entityB.position);
            anyMoved = true;
          }
          // If A pinned, push B only
          else if (entityA.isPinned && !entityB.isPinned) {
            entityB.position.add(direction.clone().multiplyScalar(pushStrength));
            entityB.mesh.position.copy(entityB.position);
            anyMoved = true;
          }
          // If B pinned, push A only
          else if (!entityA.isPinned && entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushStrength));
            entityA.mesh.position.copy(entityA.position);
            anyMoved = true;
          }
        }
      }
    }

    // Rebuild connections if entities moved (but throttle to avoid performance hit)
    if (anyMoved) {
      needsConnectionRebuild = true;
    }

    const now = Date.now();
    if (needsConnectionRebuild && (now - lastConnectionRebuild > 100)) { // Max 10 fps for rebuilds
      connections.forEach(connection => {
        scene.remove(connection.line);
        if (connection.progressBars) {
          scene.remove(connection.progressBars);
        }
      });
      connections = [];
      createConnections();
      needsConnectionRebuild = false;
      lastConnectionRebuild = now;
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

      // Broadcast ripple animation (connectionIndex === -1)
      if (particle.connectionIndex === -1) {
        // Expand ring and fade out
        const startRadius = 0.5;
        const maxRadius = 5.0;
        const currentRadius = startRadius + (maxRadius - startRadius) * particle.progress;

        // Update ring size (scale the torus)
        particle.mesh.scale.setScalar(currentRadius / startRadius);

        // Fade out as it expands
        const material = particle.mesh.material as THREE.MeshBasicMaterial;
        material.opacity = 0.8 * (1 - particle.progress);

        return;
      }

      // Unicast particle animation (along connection line)
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

                // Add to activity ticker
                addActivityToTicker(tx.data.fromEntityId, tx.data.toEntityId, tx.data.accountTx);

                console.log(`💫 Frame ${timeIndex}: Transaction activity ${tx.data.fromEntityId} → ${tx.data.toEntityId}`);
              }
            });
          }
        });
      }
    }
  }

  function enforceSpacingConstraints() {
    // Check all entity pairs and push them apart if bars would pierce or entities intersect
    // Run multiple iterations to ensure full separation (user requirement: no intersections)
    let anyAdjusted = true;
    let iterations = 0;
    const maxIterations = 10; // Prevent infinite loop

    while (anyAdjusted && iterations < maxIterations) {
      anyAdjusted = false;
      iterations++;

    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const entityA = entities[i];
        const entityB = entities[j];
        if (!entityA || !entityB) continue;

        // Check if these entities have an account connection
        const connection = connections.find(c =>
          (c.from === entityA.id && c.to === entityB.id) ||
          (c.from === entityB.id && c.to === entityA.id)
        );

        if (!connection) continue;

        // Calculate required spacing based on bars
        const entityASizeData = getEntitySizeForToken(entityA.id, selectedTokenId);
        const entityBSizeData = getEntitySizeForToken(entityB.id, selectedTokenId);

        // Get account data to calculate bar length
        const currentReplicas = $visibleReplicas;
        let totalBarsLength = 0;

        const fromReplica = Array.from(currentReplicas.entries() as [string, any][])
          .find(([key]) => key.startsWith(entityA.id + ':'));

        if (fromReplica?.[1]?.state?.accounts) {
          const accountData = fromReplica[1].state.accounts.get(entityB.id);
          if (accountData) {
            const tokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
            if (tokenDelta) {
              const derived = $xlnFunctions.deriveDelta(tokenDelta, entityA.id < entityB.id);
              const globalScale = $settings.portfolioScale || 5000;
              const decimals = 18;
              const tokensToVisualUnits = 0.00001;
              const barScale = (tokensToVisualUnits / Math.pow(10, decimals)) * (globalScale / 5000);

              totalBarsLength = (Number(derived.peerCreditLimit || 0n) + Number(derived.collateral || 0n) + Number(derived.ownCreditLimit || 0n)) * barScale;
            }
          }
        }

        // Minimum required distance based on mode (visual units, not pixels)
        const minGapSpread = 2; // Spread mode: small gap in middle
        const minGapClose = 1; // Close mode: small gap on each side

        const requiredGap = barsMode === 'spread' ? minGapSpread : (2 * minGapClose);
        const minDistance = entityASizeData + entityBSizeData + totalBarsLength + requiredGap;

        // Current distance
        const currentDistance = entityA.position.distanceTo(entityB.position);

        // If too close, push entities apart (prioritize non-pinned entities)
        if (currentDistance < minDistance) {
          const pushDistance = minDistance - currentDistance;
          const direction = new THREE.Vector3().subVectors(entityB.position, entityA.position).normalize();

          // Mark that we made an adjustment (need another iteration)
          anyAdjusted = true;

          // If neither is pinned, push both apart equally
          if (!entityA.isPinned && !entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushDistance / 2));
            entityB.position.add(direction.clone().multiplyScalar(pushDistance / 2));
            entityA.mesh.position.copy(entityA.position);
            entityB.mesh.position.copy(entityB.position);
          }
          // If A is pinned, push B away
          else if (entityA.isPinned && !entityB.isPinned) {
            entityB.position.add(direction.clone().multiplyScalar(pushDistance));
            entityB.mesh.position.copy(entityB.position);
          }
          // If B is pinned, push A away
          else if (!entityA.isPinned && entityB.isPinned) {
            entityA.position.add(direction.clone().multiplyScalar(-pushDistance));
            entityA.mesh.position.copy(entityA.position);
          }
          // If both pinned, show warning (can't fix)
          else {
            console.warn(`⚠️ Both entities pinned but too close: ${entityA.id.slice(-4)} ↔ ${entityB.id.slice(-4)}`);
          }
        }
      }
    }
    } // End while loop

    if (iterations > 1) {
      console.log(`🔄 Spacing enforcement completed in ${iterations} iterations`);
    }

    // Rebuild connections after adjustments (bars need to be repositioned)
    connections.forEach(connection => {
      scene.remove(connection.line);
      if (connection.progressBars) {
        scene.remove(connection.progressBars);
      }
    });
    connections = [];
    createConnections();
  }

  function onMouseDown(event: MouseEvent) {
    // Prevent default to avoid text selection
    event.preventDefault();

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
      if (!intersectedObject) return;

      const entity = entities.find(e => e.mesh === intersectedObject);
      if (!entity) return;

      // Disable orbit controls during drag
      if (controls) {
        controls.enabled = false;
      }

      // Start dragging
      isDragging = true;
      draggedEntity = entity;
      entity.isDragging = true;

      // Setup drag plane at entity's z position for 3D dragging
      dragPlane.setFromNormalAndCoplanarPoint(
        camera.getWorldDirection(new THREE.Vector3()).normalize(),
        entity.position
      );

      // Calculate offset between mouse ray intersection and entity position
      const intersection = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, intersection);
      dragOffset.subVectors(entity.position, intersection);

      // Visual feedback: brighten entity
      if (entity.mesh.material instanceof THREE.MeshLambertMaterial) {
        entity.mesh.material.emissive.setHex(0x00ff88);
      }
    }
  }

  function onMouseUp(_event: MouseEvent) {
    if (draggedEntity && isDragging) {
      // Mark entity as pinned (user has manually positioned it)
      draggedEntity.isPinned = true;
      draggedEntity.isDragging = false;

      // Reset visual feedback
      if (draggedEntity.mesh.material instanceof THREE.MeshLambertMaterial) {
        draggedEntity.mesh.material.emissive.setHex(0x002200);
      }

      // Check if entity violates spacing constraints after drag
      enforceSpacingConstraints();

      // Save positions after drag (persistence)
      saveEntityPositions();

      draggedEntity = null;
      isDragging = false;

      // Set flag to prevent click event from triggering camera refocus
      justDragged = true;
      setTimeout(() => {
        justDragged = false;
      }, 100); // Clear flag after 100ms
    }

    // Re-enable orbit controls WITHOUT refocusing
    if (controls) {
      controls.enabled = true;
      // Don't call controls.update() here - prevents annoying refocus
    }
  }

  function onMouseMove(event: MouseEvent) {
    // Calculate mouse position in normalized device coordinates
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

    // Update the raycaster with the camera and mouse position
    raycaster.setFromCamera(mouse, camera);

    // Handle dragging
    if (isDragging && draggedEntity) {
      const intersection = new THREE.Vector3();
      raycaster.ray.intersectPlane(dragPlane, intersection);

      // Apply offset and update entity position
      draggedEntity.position.copy(intersection.add(dragOffset));
      draggedEntity.mesh.position.copy(draggedEntity.position);

      // Rebuild connections in real-time during drag (bars follow entities)
      connections.forEach(connection => {
        scene.remove(connection.line);
        if (connection.progressBars) {
          scene.remove(connection.progressBars);
        }
      });
      connections = [];
      createConnections();

      return; // Skip hover logic while dragging
    }

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
        const entityName = getEntityShortName(entity.id);
        tooltip = {
          visible: true,
          x: event.clientX,
          y: event.clientY,
          content: `🏛️ Entity: ${entityName}\n📊 Capabilities: ${entity.profile?.capabilities?.join(', ') || 'N/A'}\n🔗 Accounts: ${getEntityAccountCount(entity.id)}\n💰 Balances:\n${balanceInfo}`
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

        // Show dual connection tooltips (both perspectives)
        const dualInfo = getDualConnectionAccountInfo(connection.from, connection.to);
        dualTooltip = {
          visible: true,
          x: event.clientX,
          y: event.clientY,
          leftContent: dualInfo.left,
          rightContent: dualInfo.right,
          leftEntity: dualInfo.leftEntity,
          rightEntity: dualInfo.rightEntity
        };

        // Hide single tooltip (not used for connections anymore)
        tooltip.visible = false;

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
        dualTooltip.visible = false;
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
    dualTooltip.visible = false;
  }

  function onMouseClick(event: MouseEvent) {
    // Don't trigger click actions if user just finished dragging
    if (justDragged) {
      return;
    }

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

      // DISABLED: Center camera on entity (user doesn't want ANY refocusing)
      // centerCameraOnEntity(entity);

      console.log(`🎯 Clicked entity: ${entity.id.slice(0, 8)}...`);
    }
  }

  function onMouseDoubleClick(event: MouseEvent) {
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
        throw new Error('FINTECH-SAFETY: No intersected object in double-click');
      }
      const entity = entities.find(e => e.mesh === intersectedObject);

      if (!entity) {
        throw new Error('FINTECH-SAFETY: Entity not found for double-clicked object');
      }

      // Switch to normal panel view and focus this entity
      console.log(`🎯 Double-clicked entity: ${entity.id} - switching to panel view`);

      // Save bird view as closed and trigger parent switch
      saveBirdViewSettings(false);
      if (onBirdViewStateChange) {
        onBirdViewStateChange(false);
      }

      // TODO: Focus specific entity panel - would need tabOperations.focusEntity(entity.id)
    }
  }

  function addActivityToTicker(fromId: string, toId: string, accountTx: any) {
    const fromShort = fromId.slice(0, 8);
    const toShort = toId.slice(0, 8);

    let message = '';
    let type: 'payment' | 'credit' | 'settlement' = 'payment';

    switch (accountTx.type) {
      case 'payment':
        const amount = Number(accountTx.amount || 0n);
        message = `${fromShort}→${toShort}: ${amount > 1000 ? Math.floor(amount/1000)+'k' : amount}`;
        type = 'payment';
        break;
      case 'credit_limit':
        message = `${fromShort}↔${toShort}: Credit limit`;
        type = 'credit';
        break;
      case 'settlement':
        message = `${fromShort}⚖${toShort}: Settlement`;
        type = 'settlement';
        break;
      default:
        message = `${fromShort}↔${toShort}: ${accountTx.type}`;
    }

    // Add to beginning of array (newest first)
    recentActivity.unshift({
      id: Date.now().toString(),
      message,
      timestamp: Date.now(),
      type
    });

    // Keep only last 10 activities
    if (recentActivity.length > 10) {
      recentActivity = recentActivity.slice(0, 10);
    }
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

      // FINTECH-SAFETY: reserves is Map<string, bigint>, so tokenId key is string
      replica.state.reserves.forEach((_: bigint, tokenIdStr: string) => {
        const tokenId = Number(tokenIdStr);
        if (!isNaN(tokenId)) {
          tokenSet.add(tokenId);
        }
      });
    }

    availableTokens = Array.from(tokenSet).sort((a, b) => a - b);
    if (availableTokens.length === 0) {
      availableTokens = [0]; // Default fallback
    }

    // Reset selected token if it's not available - prioritize token 0
    if (!availableTokens.includes(selectedTokenId)) {
      // Prefer token 0 if available, else use first available
      const preferredToken = availableTokens.includes(0) ? 0 : availableTokens[0];
      if (preferredToken === undefined) {
        throw new Error('FINTECH-SAFETY: No available tokens found');
      }
      selectedTokenId = preferredToken;
      saveBirdViewSettings(); // Persist the change
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
    // FINTECH-SAFETY: reserves Map uses string keys, not number
    const tokenAmount = reserves.get(String(tokenId)) || 0n;

    // Normalize size between 0.3 and 1.5 based on token amount
    const normalizedAmount = Number(tokenAmount) / 10000; // Adjust scale as needed
    return Math.max(0.3, Math.min(1.5, 0.5 + normalizedAmount * 0.001));
  }

  async function sendPayment() {
    try {
      console.log('🚀 ============ PAYMENT BUTTON CLICKED ============');
      console.log(`  From: ${paymentFrom}, To: ${paymentTo}, Amount: ${paymentAmount}, TPS: ${paymentTPS}`);

      if (!paymentFrom || !paymentTo) {
        console.error('❌ Missing from/to entities');
        alert('Please select from and to entities');
        return;
      }
      if (paymentFrom === paymentTo) {
        console.error('❌ Same entity selected');
        alert('Cannot send payment to same entity');
        return;
      }

      console.log('✅ Validation passed, proceeding with payment');

      // Ensure we're in LIVE mode for payments
      if (!$isLive) {
        console.log('🔴 Auto-switching to LIVE mode for payment');
        timeOperations.goToLive();
        await new Promise(resolve => setTimeout(resolve, 100)); // Wait for mode switch
      }

      const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      const job: PaymentJob = {
        id: jobId,
        from: paymentFrom,
        to: paymentTo,
        amount: paymentAmount,
        tps: paymentTPS,
        sentCount: 0,
        startedAt: Date.now()
      };

      console.log(`📦 Created job:`, job);

      if (paymentTPS === 0) {
        console.log('🔵 Single payment mode (TPS=0)');
        // Send once immediately
        await executeSinglePayment(job);
        console.log(`💸 Single payment sent: ${getEntityShortName(paymentFrom)} → ${getEntityShortName(paymentTo)}, amount: ${paymentAmount}`);
      } else {
        console.log(`🔵 Recurring payment mode (TPS=${paymentTPS})`);
        // Create recurring job
        const intervalMs = 1000 / paymentTPS; // Convert TPS to milliseconds
        const intervalId = window.setInterval(async () => {
          await executeSinglePayment(job);
          job.sentCount++;
        }, intervalMs);

        job.intervalId = intervalId;
        activeJobs = [...activeJobs, job];
        console.log(`💸 Payment job started: ${paymentTPS} TPS, ${getEntityShortName(paymentFrom)} → ${getEntityShortName(paymentTo)}`);
      }
    } catch (error) {
      console.error('🔥 CRITICAL ERROR in sendPayment:', error);
      console.error('Stack:', error instanceof Error ? error.stack : 'No stack');
      alert(`Payment failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function executeSinglePayment(job: PaymentJob) {
    try {
      // COPY EXACT PATTERN FROM PaymentPanel.svelte
      const xln = await getXLN();
      if (!xln) {
        throw new Error('XLN not available');
      }

      const env = $xlnEnvironment;
      if (!env) {
        throw new Error('XLN environment not available');
      }

      // Debug logging
      console.log(`💸 Starting payment: ${getEntityShortName(job.from)} (#${job.from.slice(-4)}) → ${getEntityShortName(job.to)} (#${job.to.slice(-4)}), amount: ${job.amount}`);

      // Step 1: Find routes (copy from PaymentPanel findRoutes logic)
      // Find our replica to check for direct account
      let ourReplica: any = null;
      for (const key of env.replicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          ourReplica = env.replicas.get(key);
          console.log(`📡 Found replica: ${key}`);
          break;
        }
      }

      if (!ourReplica) {
        throw new Error(`No replica found for entity ${getEntityShortName(job.from)} (${job.from})`);
      }

      const hasDirectAccount = ourReplica?.state?.accounts?.has(job.to);
      console.log(`🔍 Direct account check: ${hasDirectAccount}`);

      if (!hasDirectAccount) {
        throw new Error(`No direct account from ${getEntityShortName(job.from)} to ${getEntityShortName(job.to)}`);
      }

      // Convert amount to BigInt with decimals (copy from PaymentPanel)
      const decimals = 18;
      const amountStr = String(job.amount);
      const amountParts = amountStr.split('.');
      const wholePart = BigInt(amountParts[0] || 0);
      const decimalPart = amountParts[1] || '';
      const paddedDecimal = decimalPart.padEnd(decimals, '0').slice(0, decimals);
      const amountInSmallestUnit = wholePart * BigInt(10 ** decimals) + BigInt(paddedDecimal || 0);

      console.log(`💰 Amount: ${job.amount} → ${amountInSmallestUnit.toString()} (smallest unit)`);

      // Build route object (MUST match PaymentPanel structure)
      const routePath = [job.from, job.to];
      console.log(`🗺️ Route path: [${routePath.map(id => getEntityShortName(id)).join(' → ')}]`);

      // VALIDATE route construction
      if (!routePath || routePath.length !== 2) {
        throw new Error(`Invalid route: expected 2 entities, got ${routePath?.length || 0}`);
      }
      if (!job.from || !job.to) {
        throw new Error(`Invalid route: from=${job.from}, to=${job.to}`);
      }
      if (job.from === job.to) {
        throw new Error(`Invalid route: cannot send to same entity`);
      }
      if (routePath[0] !== job.from || routePath[1] !== job.to) {
        throw new Error(`Route mismatch: expected [${job.from}, ${job.to}], got [${routePath[0]}, ${routePath[1]}]`);
      }
      console.log(`✅ Route validation passed: ${job.from.slice(-4)} → ${job.to.slice(-4)}`);

      // Step 2: Find signerId (copy from PaymentPanel)
      let signerId = 's1'; // default
      for (const key of env.replicas.keys()) {
        if (key.startsWith(job.from + ':')) {
          signerId = key.split(':')[1] || 's1';
          console.log(`🔑 Found signerId: ${signerId}`);
          break;
        }
      }

      // Step 3: Send payment (copy EXACT structure from PaymentPanel)
      const paymentInput = {
        entityId: job.from,
        signerId,
        entityTxs: [{
          type: 'directPayment' as const,
          data: {
            targetEntityId: job.to,
            tokenId: selectedTokenId,
            amount: amountInSmallestUnit, // Use the converted amount
            route: routePath,  // Path array
            description: `Bird view payment: ${job.amount}`,
          },
        }],
      };

      console.log(`📤 Sending payment input:`, JSON.stringify(paymentInput, (_k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

      // Trigger visual feedback BEFORE processing
      triggerEntityActivity(job.from);
      triggerEntityActivity(job.to);

      // Process the payment (COPY EXACT CALL from PaymentPanel)
      await xln.processUntilEmpty(env, [paymentInput]);

      // Add to activity ticker AFTER successful processing
      recentActivity = [{
        id: `tx-${Date.now()}`,
        message: `${getEntityShortName(job.from)} → ${getEntityShortName(job.to)}: ${job.amount}`,
        timestamp: Date.now(),
        type: 'payment' as 'payment'
      }, ...recentActivity].slice(0, 10);

      console.log(`✅ Payment processed: ${getEntityShortName(job.from)} → ${getEntityShortName(job.to)}, ${job.amount} tokens`);

    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('❌ Payment failed:', error); // Log full error object
      console.error('❌ Error message:', errorMsg);
      console.error('❌ Stack trace:', error instanceof Error ? error.stack : 'No stack');

      // Show error to user
      alert(`Payment failed: ${errorMsg}`);

      // If it's a recurring job, cancel it on error
      if (job.intervalId) {
        cancelJob(job.id);
      }
    }
  }

  function cancelJob(jobId: string) {
    const job = activeJobs.find(j => j.id === jobId);
    if (job?.intervalId) {
      clearInterval(job.intervalId);
    }
    activeJobs = activeJobs.filter(j => j.id !== jobId);
    console.log(`❌ Cancelled payment job: ${jobId}`);
  }

  function createRipple(entityId: string) {
    const entity = entities.find(e => e.id === entityId);
    if (!entity || !scene) return;

    const rippleGeometry = new THREE.RingGeometry(0.1, 0.2, 32);
    const rippleMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff88,
      transparent: true,
      opacity: 0.8,
      side: THREE.DoubleSide
    });

    const rippleMesh = new THREE.Mesh(rippleGeometry, rippleMaterial);
    rippleMesh.position.copy(entity.position);

    // Random rotation for variety
    rippleMesh.rotation.x = Math.random() * Math.PI;
    rippleMesh.rotation.y = Math.random() * Math.PI;
    rippleMesh.rotation.z = Math.random() * Math.PI;

    scene.add(rippleMesh);

    const ripple: Ripple = {
      mesh: rippleMesh,
      startTime: Date.now(),
      duration: 1500, // 1.5 seconds
      maxRadius: 5.0  // Expand to 5 units
    };

    activeRipples.push(ripple);
  }

  function updateRipples() {
    const now = Date.now();
    activeRipples = activeRipples.filter(ripple => {
      const elapsed = now - ripple.startTime;
      const progress = Math.min(elapsed / ripple.duration, 1);

      if (progress >= 1) {
        // Remove completed ripple
        scene.remove(ripple.mesh);
        ripple.mesh.geometry.dispose();
        (ripple.mesh.material as THREE.Material).dispose();
        return false;
      }

      // Animate ripple expansion and fade
      const scale = 0.1 + progress * ripple.maxRadius;
      ripple.mesh.scale.set(scale, scale, 1);

      const material = ripple.mesh.material as THREE.MeshBasicMaterial;
      material.opacity = 0.8 * (1 - progress); // Fade out

      return true;
    });
  }

  function detectJurisdictionalEvents() {
    const env = $xlnEnvironment;
    if (!env) return;

    // Check the current server frame for jurisdictional events (j-events)
    const currentFrame = env.serverState?.history?.[env.serverState.history.length - 1];
    if (!currentFrame) return;

    // Look for entityFrames that contain j-events (reserve/collateral updates)
    const entityFrames = currentFrame.entityFrames;
    if (!entityFrames || !(entityFrames instanceof Map)) return;

    entityFrames.forEach((entityFrame: any, entityId: string) => {
      // Check if this entity frame has j-events (transactions that modify reserves/collateral)
      const jEvents = entityFrame.jEvents;
      if (jEvents && jEvents.length > 0) {
        // This entity experienced a jurisdictional event - create ripple
        createRipple(entityId);
        console.log(`🌊 Ripple triggered for entity ${getEntityShortName(entityId)} due to ${jEvents.length} j-events`);
      }
    });
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
        // FINTECH-SAFETY: reserves Map uses string keys, not number
        const tokenReserve = reserves.get(String(selectedTokenId)) || 0n;
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
    // FINTECH-SAFETY: reserves is Map<string, bigint>, so tokenId key is string
    reserves.forEach((amount: bigint, tokenIdStr: string) => {
      const tokenId = Number(tokenIdStr);
      if (isNaN(tokenId)) return; // Skip invalid token IDs

      const formattedAmount = (Number(amount) / 1000).toFixed(2);
      const marker = tokenId === selectedTokenId ? '👉' : '  ';
      balanceLines.push(`${marker} Token ${tokenId}: ${formattedAmount}k`);
    });

    return balanceLines.join('\n');
  }

  /**
   * Format financial amounts using same logic as EntityPanel
   * Example: 1500000000000000000n → "1.5"
   */
  function formatFinancialAmount(amount: bigint, decimals: number = 18): string {
    if (amount === 0n) return '0';

    const isNegative = amount < 0n;
    const absoluteAmount = isNegative ? -amount : amount;

    const divisor = BigInt(10 ** decimals);
    const wholePart = absoluteAmount / divisor;
    const fractionalPart = absoluteAmount % divisor;

    if (fractionalPart === 0n) {
      return `${isNegative ? '-' : ''}${wholePart.toLocaleString()}`;
    }

    const fractionalStr = fractionalPart.toString().padStart(decimals, '0');
    const trimmed = fractionalStr.replace(/0+$/, ''); // Remove trailing zeros
    const formatted = trimmed.slice(0, 4); // Max 4 decimal places for readability
    return `${isNegative ? '-' : ''}${wholePart.toLocaleString()}.${formatted}`;
  }

  /**
   * Get entity short name (just number, clean - no prefix)
   */
  function getEntityShortName(entityId: string): string {
    if (!$xlnFunctions?.getEntityNumber) return entityId.slice(-4);
    try {
      const entityNum = $xlnFunctions.getEntityNumber(entityId);
      return `${entityNum}`; // Just number, clean - no "#" or "Entity" prefix
    } catch {
      return entityId.slice(-4);
    }
  }

  /**
   * Get dual perspective account info (for connection hover tooltips)
   * Shows both left and right entity's view of the same account
   */
  function getDualConnectionAccountInfo(entityA: string, entityB: string): { left: string, right: string, leftEntity: string, rightEntity: string } {
    const currentReplicas = $visibleReplicas;

    // Determine canonical ordering (left is always smaller ID)
    const isALeft = entityA < entityB;
    const leftId = isALeft ? entityA : entityB;
    const rightId = isALeft ? entityB : entityA;

    // Find account data by checking BOTH replicas (same logic as createProgressBars)
    let accountData: any = null;

    // Try left entity's replica first
    const leftReplica = Array.from(currentReplicas.entries() as [string, any][])
      .find(([key]) => key.startsWith(leftId + ':'));

    if (leftReplica?.[1]?.state?.accounts) {
      // Account key is the counterparty ID
      accountData = leftReplica[1].state.accounts.get(rightId);
    }

    // Try right entity's replica if not found
    if (!accountData) {
      const rightReplica = Array.from(currentReplicas.entries() as [string, any][])
        .find(([key]) => key.startsWith(rightId + ':'));

      if (rightReplica?.[1]?.state?.accounts) {
        accountData = rightReplica[1].state.accounts.get(leftId);
      }
    }

    if (!accountData) {
      return {
        left: "No account",
        right: "No account",
        leftEntity: getEntityShortName(leftId),
        rightEntity: getEntityShortName(rightId)
      };
    }

    // Get available tokens for this connection
    const availableTokens = accountData.deltas ? Array.from(accountData.deltas.keys() as IterableIterator<number>).sort((a, b) => a - b) : [];

    if (availableTokens.length === 0) {
      return {
        left: "No tokens",
        right: "No tokens",
        leftEntity: getEntityShortName(leftId),
        rightEntity: getEntityShortName(rightId)
      };
    }

    // Get token delta (use selected or fallback to first available)
    let tokenDelta = getAccountTokenDelta(accountData, selectedTokenId);
    let displayTokenId = selectedTokenId;

    if (!tokenDelta && availableTokens.length > 0) {
      displayTokenId = availableTokens[0]!;
      tokenDelta = getAccountTokenDelta(accountData, displayTokenId);
    }

    if (!tokenDelta) {
      throw new Error(`FINTECH-SAFETY: Token ${displayTokenId} not found despite being in availableTokens`);
    }

    // Derive data for BOTH perspectives
    const leftDerived = deriveEntry(tokenDelta, true);  // Left entity's view
    const rightDerived = deriveEntry(tokenDelta, false); // Right entity's view

    // Format left entity's view
    const leftCollateral = formatFinancialAmount(BigInt(Math.floor(leftDerived.collateral)));
    const leftNet = formatFinancialAmount(BigInt(Math.floor(leftDerived.delta)));
    const leftPeerCredit = formatFinancialAmount(BigInt(Math.floor(leftDerived.peerCreditLimit)));
    const leftOwnCredit = formatFinancialAmount(BigInt(Math.floor(leftDerived.ownCreditLimit)));

    // Format right entity's view
    const rightCollateral = formatFinancialAmount(BigInt(Math.floor(rightDerived.collateral)));
    const rightNet = formatFinancialAmount(BigInt(Math.floor(rightDerived.delta)));
    const rightPeerCredit = formatFinancialAmount(BigInt(Math.floor(rightDerived.peerCreditLimit)));
    const rightOwnCredit = formatFinancialAmount(BigInt(Math.floor(rightDerived.ownCreditLimit)));

    const leftName = getEntityShortName(leftId);
    const rightName = getEntityShortName(rightId);

    // Build tooltip content for each perspective
    const leftContent = `🪙 Token ${displayTokenId}\n\n💚 Their Credit: ${leftPeerCredit}\n🔒 Collateral: ${leftCollateral}\n💙 Our Credit: ${leftOwnCredit}\n\n⚖️ Net: ${leftNet}${leftDerived.delta < 0 ? ' (owe)' : leftDerived.delta > 0 ? ' (owed)' : ''}`;
    const rightContent = `🪙 Token ${displayTokenId}\n\n💙 Our Credit: ${rightOwnCredit}\n🔒 Collateral: ${rightCollateral}\n💚 Their Credit: ${rightPeerCredit}\n\n⚖️ Net: ${rightNet}${rightDerived.delta < 0 ? ' (owe)' : rightDerived.delta > 0 ? ' (owed)' : ''}`;

    return {
      left: leftContent,
      right: rightContent,
      leftEntity: leftName,
      rightEntity: rightName
    };
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
          <select
            bind:value={selectedTokenId}
            on:change={(e) => {
              // FINTECH-SAFETY: Coerce string→number from select binding
              selectedTokenId = Number(e.currentTarget.value);
              saveBirdViewSettings();
              updateNetworkData();
            }}
          >
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

        <!-- Auto-Rotate Speed Slider (0 = stopped, 10000 = fast) -->
        <div class="control-group">
          <label>🌍 Rotate:</label>
          <input
            type="range"
            min="0"
            max="10000"
            bind:value={rotationSpeed}
            on:change={() => saveBirdViewSettings()}
            title="Rotation speed: 0=stopped, 1000=slow, 10000=fast"
            class="rotation-slider"
          />
        </div>

        <!-- Quick Payment Form -->
        <div class="payment-form">
          <div class="form-row">
            <label>💸 From:</label>
            <select bind:value={paymentFrom} class="form-select">
              <option value="">Select...</option>
              {#each entities as entity}
                <option value={entity.id}>{getEntityShortName(entity.id)}</option>
              {/each}
            </select>
          </div>

          <div class="form-row">
            <label>→ To:</label>
            <select bind:value={paymentTo} class="form-select">
              <option value="">Select...</option>
              {#each entities as entity}
                {#if entity.id !== paymentFrom}
                  <option value={entity.id}>{getEntityShortName(entity.id)}</option>
                {/if}
              {/each}
            </select>
          </div>

          <div class="form-row">
            <label>💰 Amount:</label>
            <input type="text" bind:value={paymentAmount} class="form-input" placeholder="200000" />
          </div>

          <div class="form-row">
            <label>⚡ TPS:</label>
            <input
              type="range"
              min="0"
              max="100"
              step="0.1"
              bind:value={paymentTPS}
              class="repeat-slider"
              title="TPS: 0=once, 0.1=every 10s, 100=max"
            />
            <span class="rate-value">{paymentTPS.toFixed(1)}</span>
          </div>

          <button class="send-btn" on:click={sendPayment}>
            {paymentTPS === 0 ? '💸 Send Once' : '▶ Start Flow'}
          </button>
        </div>
      </div>

      <small>Scroll to zoom, drag to rotate</small>
    </div>
  </div>

  <!-- Real-time Activity Ticker -->
  {#if recentActivity.length > 0}
    <div class="activity-ticker">
      <h4>⚡ Live Activity</h4>
      <div class="activity-list">
        {#each recentActivity as activity (activity.id)}
          <div class="activity-item {activity.type}">
            {activity.message}
          </div>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Active Payment Jobs (Flows) -->
  {#if activeJobs.length > 0}
    <div class="active-jobs">
      <h4>🌊 Active Flows</h4>
      <div class="jobs-list">
        {#each activeJobs as job (job.id)}
          <div class="job-item">
            <div class="job-info">
              <span class="job-route">{getEntityShortName(job.from)} → {getEntityShortName(job.to)}</span>
              <span class="job-amount">💰 {job.amount}</span>
              <span class="job-rate">⚡ {job.tps} TPS</span>
              <span class="job-count">📊 {job.sentCount} sent</span>
            </div>
            <button class="job-cancel" on:click={() => cancelJob(job.id)} title="Cancel flow">
              ✕
            </button>
          </div>
        {/each}
      </div>
    </div>
  {/if}

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

  {#if dualTooltip.visible}
    <div class="dual-tooltip-container" style="left: {dualTooltip.x}px; top: {dualTooltip.y}px;">
      <div class="dual-tooltip left">
        <div class="tooltip-header">{dualTooltip.leftEntity} View</div>
        {#each dualTooltip.leftContent.split('\n') as line}
          <div>{line}</div>
        {/each}
      </div>
      <div class="dual-tooltip right">
        <div class="tooltip-header">{dualTooltip.rightEntity} View</div>
        {#each dualTooltip.rightContent.split('\n') as line}
          <div>{line}</div>
        {/each}
      </div>
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

  .dual-tooltip-container {
    position: fixed;
    display: flex;
    gap: 20px;
    z-index: 30;
    pointer-events: none;
    transform: translate(-50%, -100%);
    margin-top: -20px;
  }

  .dual-tooltip {
    background: rgba(0, 0, 0, 0.95);
    color: #00ff88;
    padding: 10px 14px;
    border-radius: 8px;
    border: 2px solid #00ff44;
    font-family: monospace;
    font-size: 11px;
    line-height: 1.5;
    backdrop-filter: blur(10px);
    box-shadow: 0 4px 16px rgba(0, 255, 68, 0.4);
    min-width: 180px;
  }

  .dual-tooltip.left {
    border-color: #00aaff;
    box-shadow: 0 4px 16px rgba(0, 170, 255, 0.4);
  }

  .dual-tooltip.right {
    border-color: #ff8800;
    box-shadow: 0 4px 16px rgba(255, 136, 0, 0.4);
  }

  .tooltip-header {
    font-weight: bold;
    font-size: 12px;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid rgba(0, 255, 68, 0.3);
  }

  .dual-tooltip.left .tooltip-header {
    color: #00ccff;
    border-bottom-color: rgba(0, 170, 255, 0.3);
  }

  .dual-tooltip.right .tooltip-header {
    color: #ffaa00;
    border-bottom-color: rgba(255, 136, 0, 0.3);
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

  .rotation-slider {
    width: 100%;
    height: 6px;
    border-radius: 3px;
    background: linear-gradient(90deg,
      rgba(0, 100, 255, 0.3) 0%,
      rgba(0, 255, 136, 0.5) 50%,
      rgba(255, 0, 255, 0.7) 100%
    );
    outline: none;
    opacity: 0.8;
    transition: all 0.3s ease;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 255, 68, 0.3);
  }

  .rotation-slider:hover {
    opacity: 1;
    box-shadow: 0 2px 12px rgba(0, 255, 68, 0.6);
    transform: scaleY(1.2);
  }

  .rotation-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, #00ff88, #00ccff);
    cursor: pointer;
    box-shadow: 0 0 8px rgba(0, 255, 136, 1), 0 0 16px rgba(0, 255, 136, 0.5);
    border: 2px solid #ffffff;
    transition: all 0.2s ease;
  }

  .rotation-slider::-webkit-slider-thumb:hover {
    transform: scale(1.3);
    box-shadow: 0 0 12px rgba(0, 255, 136, 1), 0 0 24px rgba(0, 255, 136, 0.8);
  }

  .rotation-slider::-moz-range-thumb {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: linear-gradient(135deg, #00ff88, #00ccff);
    cursor: pointer;
    border: 2px solid #ffffff;
    box-shadow: 0 0 8px rgba(0, 255, 136, 1), 0 0 16px rgba(0, 255, 136, 0.5);
    transition: all 0.2s ease;
  }

  .rotation-slider::-moz-range-thumb:hover {
    transform: scale(1.3);
    box-shadow: 0 0 12px rgba(0, 255, 136, 1), 0 0 24px rgba(0, 255, 136, 0.8);
  }

  .payment-form {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(0, 255, 68, 0.3);
    border-radius: 6px;
    margin-top: 8px;
  }

  .form-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .form-row label {
    font-size: 9px;
    color: #00ff88;
    min-width: 60px;
    font-family: monospace;
  }

  .form-select,
  .form-input {
    flex: 1;
    background: rgba(0, 0, 0, 0.7);
    border: 1px solid rgba(0, 255, 68, 0.4);
    border-radius: 3px;
    color: #ffffff;
    padding: 4px 6px;
    font-size: 9px;
    font-family: monospace;
    outline: none;
    transition: all 0.2s ease;
  }

  .form-select:hover,
  .form-input:hover {
    border-color: #00ff88;
    box-shadow: 0 0 4px rgba(0, 255, 136, 0.3);
  }

  .form-select:focus,
  .form-input:focus {
    border-color: #00ff88;
    box-shadow: 0 0 8px rgba(0, 255, 136, 0.5);
  }

  .repeat-slider {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: linear-gradient(90deg,
      rgba(100, 100, 100, 0.3) 0%,
      rgba(0, 255, 136, 0.5) 100%
    );
    outline: none;
    cursor: pointer;
  }

  .repeat-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #00ff88;
    cursor: pointer;
    box-shadow: 0 0 4px rgba(0, 255, 136, 0.8);
    transition: all 0.2s ease;
  }

  .repeat-slider::-webkit-slider-thumb:hover {
    transform: scale(1.2);
    box-shadow: 0 0 8px rgba(0, 255, 136, 1);
  }

  .repeat-slider::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #00ff88;
    cursor: pointer;
    border: none;
    box-shadow: 0 0 4px rgba(0, 255, 136, 0.8);
    transition: all 0.2s ease;
  }

  .repeat-slider::-moz-range-thumb:hover {
    transform: scale(1.2);
    box-shadow: 0 0 8px rgba(0, 255, 136, 1);
  }

  .rate-value {
    font-size: 9px;
    font-family: monospace;
    color: #00ff88;
    min-width: 32px;
    text-align: right;
  }

  .send-btn {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.2), rgba(0, 200, 255, 0.2));
    border: 1px solid #00ff88;
    border-radius: 4px;
    color: #00ff88;
    padding: 6px 12px;
    font-size: 10px;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s ease;
    font-family: monospace;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .send-btn:hover {
    background: linear-gradient(135deg, rgba(0, 255, 136, 0.4), rgba(0, 200, 255, 0.4));
    box-shadow: 0 0 12px rgba(0, 255, 136, 0.6);
    transform: translateY(-1px);
  }

  .send-btn:active {
    transform: translateY(0);
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

  .activity-ticker {
    position: absolute;
    bottom: 20px;
    left: 20px;
    background: rgba(45, 45, 45, 0.9);
    border: 1px solid #007acc;
    border-radius: 8px;
    padding: 12px;
    min-width: 300px;
    max-width: 400px;
    z-index: 20;
    backdrop-filter: blur(10px);
  }

  .activity-ticker h4 {
    margin: 0 0 8px 0;
    color: #007acc;
    font-size: 12px;
  }

  .activity-list {
    max-height: 120px;
    overflow-y: auto;
  }

  .activity-item {
    font-family: monospace;
    font-size: 10px;
    padding: 2px 0;
    opacity: 0.9;
    animation: fadeIn 0.3s ease;
  }

  .activity-item.payment {
    color: #ffaa00;
  }

  .activity-item.credit {
    color: #0088ff;
  }

  .activity-item.settlement {
    color: #ff4444;
  }

  .active-jobs {
    position: absolute;
    bottom: 20px;
    right: 20px;
    background: rgba(0, 255, 136, 0.05);
    border: 2px solid rgba(0, 255, 136, 0.4);
    border-radius: 8px;
    padding: 12px;
    min-width: 400px;
    max-width: 600px;
    z-index: 20;
    backdrop-filter: blur(10px);
    box-shadow: 0 4px 16px rgba(0, 255, 136, 0.2);
  }

  .active-jobs h4 {
    margin: 0 0 12px 0;
    color: #00ff88;
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 1px;
  }

  .jobs-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .job-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: rgba(0, 0, 0, 0.5);
    border: 1px solid rgba(0, 255, 136, 0.3);
    border-radius: 4px;
    padding: 8px 12px;
    transition: all 0.2s ease;
    animation: slideIn 0.3s ease;
  }

  .job-item:hover {
    background: rgba(0, 255, 136, 0.1);
    border-color: #00ff88;
    box-shadow: 0 0 8px rgba(0, 255, 136, 0.3);
  }

  .job-info {
    display: flex;
    align-items: center;
    gap: 12px;
    font-family: monospace;
    font-size: 10px;
  }

  .job-route {
    color: #00ff88;
    font-weight: bold;
    min-width: 100px;
  }

  .job-amount {
    color: #ffaa00;
  }

  .job-rate {
    color: #00ccff;
  }

  .job-count {
    color: #9d9d9d;
    font-style: italic;
  }

  .job-cancel {
    background: rgba(255, 68, 68, 0.2);
    border: 1px solid #ff4444;
    border-radius: 3px;
    color: #ff4444;
    padding: 4px 8px;
    font-size: 12px;
    font-weight: bold;
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .job-cancel:hover {
    background: rgba(255, 68, 68, 0.4);
    box-shadow: 0 0 8px rgba(255, 68, 68, 0.5);
    transform: scale(1.1);
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(20px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateX(-10px); }
    to { opacity: 0.9; transform: translateX(0); }
  }
</style>