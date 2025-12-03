<script lang="ts">
  import { replicas } from '../../stores/xlnStore';

  export let selectedEntityId: string = '';
  export let currentEntityId: string = ''; // Exclude this entity
  export let placeholder: string = 'Select entity...';
  export let label: string = 'Entity:';

  // Get all available entities
  $: availableEntities = $replicas ? [...$replicas.entries()]
    .map(([replicaKey, replica]) => {
      const [entityId, signerId] = replicaKey.split(':');
      return { entityId: entityId || '', signerId: signerId || '', replica };
    })
    .filter(({ entityId }) => entityId !== currentEntityId)
    .reduce((unique, item) => {
      if (!unique.find(u => u.entityId === item.entityId)) {
        unique.push(item);
      }
      return unique;
    }, [] as { entityId: string; signerId: string; replica: any }[])
    .map(({ entityId }) => {
      const entityNumber = parseInt(entityId, 16);
      return {
        entityId,
        displayName: `Entity #${entityNumber}`,
        shortId: entityId.slice(-4)
      };
    })
    .sort((a, b) => {
      const aNum = parseInt(a.entityId, 16);
      const bNum = parseInt(b.entityId, 16);
      return aNum - bNum;
    }) : [];
</script>

<div class="entity-picker">
  <label for="entitySelect">{label}</label>
  <select id="entitySelect" bind:value={selectedEntityId}>
    <option value="">{placeholder}</option>
    {#each availableEntities as entity}
      <option value={entity.entityId}>
        {entity.displayName} (...{entity.shortId})
      </option>
    {/each}
  </select>

  {#if availableEntities.length === 0}
    <small class="no-entities">No other entities available</small>
  {/if}
</div>

<style>
  .entity-picker {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  label {
    font-size: 0.9em;
    color: #d4d4d4;
    font-weight: 500;
  }

  select {
    padding: 8px 12px;
    background: #2d2d2d;
    border: 1px solid #555;
    border-radius: 6px;
    color: #d4d4d4;
    font-size: 14px;
  }

  select:focus {
    border-color: #007acc;
    outline: none;
  }

  .no-entities {
    color: #999;
    font-size: 0.8em;
    font-style: italic;
  }
</style>