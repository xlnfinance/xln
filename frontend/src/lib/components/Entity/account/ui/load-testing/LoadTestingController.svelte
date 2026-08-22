<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { EntityReplica, RuntimeInput, RuntimeReplica } from '@xln/core/api/public/runtime-module';
  import { get } from 'svelte/store';
  import { xlnFunctions } from '$lib/stores/xlnStore';
  import type { PaymentPanelView } from '../../../payments/payment-panel-view';
  import type { SwapPanelRuntimeView } from '../../../swap/swap-panel-helpers';
  import { createLoadTestingController } from '../../load-testing-controller';
  import {
    LoadTestScheduler,
    type LoadTestSchedulerSnapshot,
  } from '../../load-testing-scheduler';
  import LoadTestingPanel, {
    type LoadTestingCallbacks,
    type LoadTestingControllerState,
  } from './LoadTestingPanel.svelte';

  export let entityId = '';
  export let workspaceAccountId = '';
  export let replica: EntityReplica | null = null;
  export let liveRuntimeEnv: RuntimeReplica | null = null;
  export let activeIsLive = false;
  export let paymentView: PaymentPanelView;
  export let swapRuntimeView: SwapPanelRuntimeView | null = null;
  export let submitRuntimeInput: ((input: RuntimeInput) => Promise<unknown> | unknown) | null = null;

  let payRate = 1;
  let swapRate = 1;
  let durationMinutes = 10;
  let snapshot: LoadTestSchedulerSnapshot = {
    running: false,
    elapsedSeconds: 0,
    metrics: {
      pay: { attempted: 0, submitted: 0, skipped: 0, failed: 0, stpPrevented: 0 },
      swap: { attempted: 0, submitted: 0, skipped: 0, failed: 0, stpPrevented: 0 },
    },
    lastResult: { pay: '', swap: '' },
  };

  const sourceReplica = (): EntityReplica | null => {
    const normalized = String(entityId || '').trim().toLowerCase();
    return swapRuntimeView?.localReplicaEntries.find(entry => entry.entityId === normalized)?.replica
      ?? replica;
  };

  const resolveSignerId = (targetEntityId: string): string => {
    const normalized = String(targetEntityId || '').trim().toLowerCase();
    const local = swapRuntimeView?.localReplicaEntries.find(entry => entry.entityId === normalized)?.signerId;
    if (local) return local;
    const runtime = get(xlnFunctions);
    const resolved = liveRuntimeEnv && runtime?.resolveEntityProposerId
      ? runtime.resolveEntityProposerId(liveRuntimeEnv, normalized, 'load-testing')
      : '';
    if (!resolved) throw new Error(`LOAD_TEST_SIGNER_UNAVAILABLE:${normalized}`);
    return resolved;
  };

  const controller = createLoadTestingController({
    sourceEntityId: () => entityId,
    selectedHubEntityId: () => workspaceAccountId,
    paymentView: () => paymentView,
    swapView: () => swapRuntimeView,
    sourceReplica,
    runtimeFunctions: () => get(xlnFunctions),
    resolveSignerId,
    submitRuntimeInput: input => {
      if (!submitRuntimeInput) throw new Error('LOAD_TEST_COMMAND_PATH_UNAVAILABLE');
      return submitRuntimeInput(input);
    },
    random: Math.random,
  });

  const scheduler = new LoadTestScheduler({
    now: Date.now,
    random: Math.random,
    setTimer: (run, delayMs) => setTimeout(run, delayMs),
    clearTimer: timer => clearTimeout(timer),
    attempt: lane => controller.attempt(lane),
    onSnapshot: next => snapshot = next,
  });

  const callbacks: LoadTestingCallbacks = {
    setPayRate: rate => payRate = rate,
    setSwapRate: rate => swapRate = rate,
    setDurationMinutes: minutes => durationMinutes = Math.floor(minutes),
    start: () => scheduler.start({
      durationMinutes,
      pay: { enabled: true, rate: payRate },
      swap: { enabled: true, rate: swapRate },
    }),
    stop: () => scheduler.stop(),
  };

  $: totals = {
    attempted: snapshot.metrics.pay.attempted + snapshot.metrics.swap.attempted,
    submitted: snapshot.metrics.pay.submitted + snapshot.metrics.swap.submitted,
    skipped: snapshot.metrics.pay.skipped + snapshot.metrics.swap.skipped,
    failed: snapshot.metrics.pay.failed + snapshot.metrics.swap.failed,
  };
  $: state = {
    payRate,
    swapRate,
    durationMinutes,
    elapsedSeconds: snapshot.elapsedSeconds,
    running: snapshot.running,
    metrics: {
      ...totals,
      stpPrevented: snapshot.metrics.swap.stpPrevented,
      stpPercent: snapshot.metrics.swap.attempted > 0
        ? snapshot.metrics.swap.stpPrevented * 100 / snapshot.metrics.swap.attempted
        : 0,
    },
  } satisfies LoadTestingControllerState;
  $: disabled = !activeIsLive || !liveRuntimeEnv || !submitRuntimeInput || !workspaceAccountId;

  onDestroy(() => scheduler.stop());
</script>

<LoadTestingPanel {state} {callbacks} {disabled} />
