<script lang="ts">
  import * as jdenticon from 'jdenticon';

  export let entityId: string;
  export let name: string = '';
  export let size: number = 34;
  export let copyable: boolean = true;
  export let clickable: boolean = true;
  export let showAddress: boolean = true;
  export let compact: boolean = false;

  let copied = false;

  $: safeEntityId = (entityId || '').trim();
  $: hasRealName = (name || '').trim().length > 0;
  $: displayName = hasRealName ? (name || '').trim() : (safeEntityId || 'Unknown');
  $: detailAddress = safeEntityId;
  $: identiconSvg = safeEntityId
    ? `data:image/svg+xml;utf8,${encodeURIComponent(jdenticon.toSvg(safeEntityId.toLowerCase(), size))}`
    : '';
  $: href = safeEntityId ? `/address/${encodeURIComponent(safeEntityId)}` : '#';

  async function copyAddress(event: MouseEvent): Promise<void> {
    event.stopPropagation();
    if (!copyable || !safeEntityId || typeof navigator === 'undefined') return;
    try {
      await navigator.clipboard.writeText(safeEntityId);
      copied = true;
      setTimeout(() => {
        copied = false;
      }, 1200);
    } catch {
      copied = false;
    }
  }
</script>

{#if clickable}
  <a class="entity-identity" href={href} title={safeEntityId}>
    <img class="avatar" src={identiconSvg} alt="" width={size} height={size} />
    <div class="text">
      {#if hasRealName}
        <div class="name"><span class="explore">🧭</span>{displayName}</div>
      {/if}
      {#if showAddress}
        <div class="address-wrap">
          <code class="address">{detailAddress}</code>
          {#if copyable}
            <button class="copy" type="button" onclick={copyAddress}>{copied ? 'copied' : 'copy'}</button>
          {/if}
        </div>
      {:else if !hasRealName}
        <div class="address-wrap">
          <code class="address">{detailAddress}</code>
        </div>
      {/if}
    </div>
  </a>
{:else}
  <div class="entity-identity" title={safeEntityId}>
    <img class="avatar" src={identiconSvg} alt="" width={size} height={size} />
    <div class="text">
      {#if hasRealName}
        <div class="name"><span class="explore">🧭</span>{displayName}</div>
      {/if}
      {#if showAddress}
        <div class="address-wrap">
          <code class="address">{detailAddress}</code>
          {#if copyable}
            <button class="copy" type="button" onclick={copyAddress}>{copied ? 'copied' : 'copy'}</button>
          {/if}
        </div>
      {:else if !hasRealName}
        <div class="address-wrap">
          <code class="address">{detailAddress}</code>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .entity-identity {
    display: flex;
    align-items: center;
    gap: 10px;
    text-decoration: none;
    color: inherit;
  }

  .avatar {
    border-radius: 8px;
    background: #10151d;
    border: 1px solid #232c39;
    flex: 0 0 auto;
  }

  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .name {
    color: #d8dee8;
    font-size: 13px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .explore {
    margin-right: 6px;
    font-size: 12px;
    opacity: 0.9;
  }

  .address-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .address {
    color: #8ea1b9;
    font-family: 'JetBrains Mono', 'IBM Plex Mono', monospace;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .copy {
    border: 1px solid #2a3442;
    background: #101722;
    color: #94a6bc;
    border-radius: 6px;
    height: 20px;
    padding: 0 7px;
    font-size: 10px;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.3px;
  }

  .entity-identity:hover .name {
    color: #eef3fa;
  }
</style>
