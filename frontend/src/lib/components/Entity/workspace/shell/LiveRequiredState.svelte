<script lang="ts">
  import { AlertTriangle } from 'lucide-svelte';

  export let message: string;
</script>

<div class="live-required configure-empty">
  <AlertTriangle size={18} />
  <p>{message}</p>
</div>

<style>
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

  .configure-empty {
    margin: 0;
  }
</style>
