<script lang="ts">
  import TransactionHistoryIO from './lib/components/IO/TransactionHistoryIO.svelte';
  import EntityFormation from './lib/components/Formation/EntityFormation.svelte';
  import JurisdictionStatus from './lib/components/Jurisdiction/JurisdictionStatus.svelte';
</script>

<main class="test-app">
  <h1>🧪 Component Test Page</h1>
  
  <div class="test-section">
    <h2>TransactionHistoryIO Component</h2>
    <TransactionHistoryIO />
  </div>

  <div class="test-section">
    <h2>EntityFormation Component</h2>
    <EntityFormation />
  </div>

  <div class="test-section">
    <h2>JurisdictionStatus Component</h2>
    <JurisdictionStatus />
  </div>
</main>

<style>
  .test-app {
    padding: 20px;
    background: #1a1a1a;
    color: #e8e8e8;
    min-height: 100vh;
  }

  .test-section {
    background: #2d2d2d;
    border: 2px solid #007acc;
    border-radius: 8px;
    padding: 20px;
    margin: 20px 0;
  }

  .test-section h2 {
    color: #007acc;
    margin-bottom: 20px;
  }

  h1 {
    color: #007acc;
    text-align: center;
    margin-bottom: 40px;
  }
</style>
