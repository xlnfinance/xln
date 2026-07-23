<script lang="ts">
  type HubOption = {
    value: string;
    label: string;
  };

  export let hubMenuOpen = false;
  export let createOrderAccountId = '';
  export let activeOrderAccountId = '';
  export let selectedHubDisplayLabel = '';
  export let selectedHubLabel = '';
  export let selectedHubJurisdictionLabel = '';
  export let selectedHubOptions: HubOption[] = [];
  export let toggleHubMenu: () => void = () => {};
  export let handleSelectedHubChange: (nextValue: string) => void = () => {};
  export let selectHubOption: (nextValue: string) => void = () => {};
  export let entityAvatarSrc: (entityIdValue: string) => string = () => '';
  export let entityInitials: (entityIdValue: string, label?: string) => string = () => '';
  export let jurisdictionBadgeText: (jurisdictionName: string) => string = () => '';
  export let formatEntityNetworkLabel: (label: string, jurisdictionLabel: string) => string = (label) => label;
  export let hubJurisdictionLabel: (entityIdValue: string) => string = () => '';
</script>

<div class="venue-row" data-testid="swap-hub-selector">
  <span>Hub</span>
  <div class="entity-select-wrap hub-select-wrap" data-swap-menu-root>
    <button
      type="button"
      class="entity-select-button"
      aria-haspopup="listbox"
      aria-expanded={hubMenuOpen}
      title={selectedHubDisplayLabel}
      on:click|stopPropagation={toggleHubMenu}
    >
      <span class="entity-avatar-wrap">
        {#if createOrderAccountId && entityAvatarSrc(createOrderAccountId)}
          <img class="entity-avatar-mini" src={entityAvatarSrc(createOrderAccountId)} alt="" />
        {:else}
          <span class="entity-avatar-mini placeholder">{entityInitials(createOrderAccountId, selectedHubLabel)}</span>
        {/if}
        <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(selectedHubJurisdictionLabel)}</span>
      </span>
      <span class="entity-select-copy">
        <strong>{formatEntityNetworkLabel(selectedHubLabel, selectedHubJurisdictionLabel)}</strong>
      </span>
      <span class="entity-select-chevron" aria-hidden="true">⌄</span>
    </button>
    <select
      class="entity-select-native"
      bind:value={createOrderAccountId}
      data-testid="swap-account-select"
      data-active-order-account-id={activeOrderAccountId}
      title={selectedHubDisplayLabel}
      aria-label="Swap venue"
      on:change={(event) => handleSelectedHubChange((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each selectedHubOptions as hub (hub.value)}
        <option
          value={hub.value}
          selected={hub.value === activeOrderAccountId}
          title={formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}
        >
          {formatEntityNetworkLabel(hub.label, hubJurisdictionLabel(hub.value))}
        </option>
      {/each}
    </select>
    {#if hubMenuOpen}
      <div class="entity-menu hub-menu" role="listbox" aria-label="Hub">
        {#each selectedHubOptions as hub (hub.value)}
          {@const hubJurisdiction = hubJurisdictionLabel(hub.value)}
          <button
            type="button"
            data-testid="swap-hub-option"
            class:selected={hub.value === createOrderAccountId}
            class="entity-option"
            role="option"
            aria-selected={hub.value === createOrderAccountId}
            title={formatEntityNetworkLabel(hub.label, hubJurisdiction)}
            on:click|stopPropagation={() => selectHubOption(hub.value)}
          >
            <span class="entity-avatar-wrap">
              {#if entityAvatarSrc(hub.value)}
                <img class="entity-avatar-mini" src={entityAvatarSrc(hub.value)} alt="" />
              {:else}
                <span class="entity-avatar-mini placeholder">{entityInitials(hub.value, hub.label)}</span>
              {/if}
              <span class="jurisdiction-mini-badge">{jurisdictionBadgeText(hubJurisdiction)}</span>
            </span>
            <span class="entity-select-copy">
              <strong>{formatEntityNetworkLabel(hub.label, hubJurisdiction)}</strong>
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
