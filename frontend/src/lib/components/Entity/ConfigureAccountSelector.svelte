<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import type { Profile as GossipProfile } from '@xln/runtime/xln-api';
  import EntityInput from '../shared/EntityInput.svelte';

  export let value = '';
  export let accountIds: string[] = [];
  export let excludeId = '';
  export let disabled = false;
  export let profiles: GossipProfile[] = [];

  const dispatch = createEventDispatcher<{
    change: { value?: string };
  }>();
</script>

<div class="workspace-inline-selector">
  <EntityInput
    label="Manage Account"
    {value}
    entities={accountIds}
    {profiles}
    testId="configure-account-selector"
    {excludeId}
    placeholder="Select account for manage..."
    {disabled}
    on:change={(event) => dispatch('change', event.detail)}
  />
</div>

<style>
  .workspace-inline-selector {
    margin-bottom: 10px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--theme-card-border, var(--theme-border, #27272a)) 86%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--theme-card-bg, var(--theme-surface, #18181b)) 98%, transparent);
    box-shadow: 0 10px 24px color-mix(in srgb, var(--theme-background, #09090b) 6%, transparent);
  }
</style>
