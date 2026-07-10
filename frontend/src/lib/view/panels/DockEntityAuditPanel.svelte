<script lang="ts">
  import EntityAuditPanel from '$lib/components/Entity/EntityAuditPanel.svelte';
  import { runtimeView } from '$lib/stores/runtimeViewStore';

  $: entityId = String($runtimeView.activeEntityId || $runtimeView.frame?.activeEntityId || '').trim().toLowerCase();
</script>

<EntityAuditPanel {entityId} />
