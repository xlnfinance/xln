<script lang="ts">
  const devices = [
    { icon: '/img/primitives/phone.svg', name: 'Phone', capacity: '~10 TPS', color: '#4fd18b' },
    { icon: '/img/primitives/laptop.svg', name: 'Laptop', capacity: '~100 TPS', color: '#5fe19b' },
    { icon: '/img/primitives/server.svg', name: 'Server', capacity: '~1K TPS', color: '#6ff1ab' },
    { icon: '/img/primitives/datacenter.svg', name: 'Datacenter', capacity: '~100K TPS', color: '#7fffbb' },
  ];
</script>

<div class="legend">
  <div class="legend-title">Network Participants (J-Machine Full Nodes)</div>
  <div class="legend-grid">
    {#each devices as device}
      <div class="legend-item">
        <div class="device-icon" style="color: {device.color}">
          {@html `<img src="${device.icon}" alt="${device.name}" />`}
        </div>
        <div class="device-info">
          <span class="device-name">{device.name}</span>
          <span class="device-capacity">{device.capacity}</span>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .legend {
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 2rem;
  }

  .legend-title {
    font-size: 0.9rem;
    font-weight: 600;
    color: rgba(255, 255, 255, 0.8);
    margin-bottom: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .legend-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 6px;
  }

  .device-icon {
    width: 50px;
    height: 50px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .device-icon :global(img) {
    width: 100%;
    height: 100%;
    filter: drop-shadow(0 0 4px currentColor);
  }

  .device-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .device-name {
    font-weight: 500;
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.9);
  }

  .device-capacity {
    font-size: 0.75rem;
    color: rgba(255, 255, 255, 0.5);
    font-family: 'JetBrains Mono', monospace;
  }

  @media (max-width: 768px) {
    .legend-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  /* Light mode overrides */
  :global(.light-mode) .legend {
    background: rgba(0, 0, 0, 0.03);
    border-color: rgba(0, 0, 0, 0.15);
  }

  :global(.light-mode) .legend-title {
    color: rgba(0, 0, 0, 0.8);
  }

  :global(.light-mode) .legend-item {
    background: rgba(0, 0, 0, 0.02);
  }

  :global(.light-mode) .device-name {
    color: rgba(0, 0, 0, 0.9);
  }

  :global(.light-mode) .device-capacity {
    color: rgba(0, 0, 0, 0.5);
  }
</style>
