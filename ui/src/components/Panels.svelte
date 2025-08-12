<script lang="ts">
  import { onMount } from 'svelte';
  import { xlnEnv, xln, getCurrentXLN, sendChatMessage, proposeCollectiveMessage, voteOnProposal, timeIndex, historyLen, setTimePosition, getReplicaAtTime, runDemoIfAvailable } from '../stores/xln';
  import { get } from 'svelte/store';

  type Tab = { id: string; signer: string | null; entityId: string | null; title: string };
  type ReplicaMinimal = { signerId: string; entityId: string; state?: { messages?: any[]; proposals?: Map<string, any> } };
  let tabs: Tab[] = [];
  let activeTabId: string | null = null;
  let dropdownOpen: Record<string, boolean> = {};
  // controls helpers
  const textareaElMap: Record<string, HTMLTextAreaElement> = {} as any;

  function genId(n: number) { return `tab-${n}`; }

  function initTabs() {
    const env = get(xlnEnv);
    const defaultTabs = 4;
    tabs = [];
    for (let i = 1; i <= defaultTabs; i++) {
      tabs.push({ id: genId(i), signer: null, entityId: null, title: `Entity Panel ${i}` });
      dropdownOpen[genId(i)] = false;
    }
    activeTabId = tabs[0]?.id ?? null;
    if (env && env.replicas && env.replicas.size > 0) {
      // Auto-select first replica for first tab
      const r = Array.from(env.replicas.values())[0] as ReplicaMinimal;
      tabs[0].signer = r.signerId;
      tabs[0].entityId = r.entityId;
    }
  }

  function toggleTab(id: string) { activeTabId = id; }
  function toggleDropdown(tabId: string) { dropdownOpen[tabId] = !dropdownOpen[tabId]; }

  function addPanel() {
    if (tabs.length >= 4) return;
    const id = genId(tabs.length + 1);
    tabs = [...tabs, { id, signer: null, entityId: null, title: `Entity Panel ${tabs.length + 1}` }];
    dropdownOpen[id] = false;
  }

  function removePanel(tabId: string) {
    if (tabs.length <= 1) return;
    tabs = tabs.filter(t => t.id !== tabId).map((t, i) => ({ ...t, id: genId(i + 1), title: `Entity Panel ${i + 1}` }));
    // reset dropdown states
    dropdownOpen = {}; tabs.forEach(t => dropdownOpen[t.id] = false);
    activeTabId = tabs[0]?.id ?? null;
  }

  function replicasBySigner(): Record<string, Array<{ signerId: string; entityId: string }>> {
    const env = get(xlnEnv);
    const grouped: Record<string, Array<{ signerId: string; entityId: string }>> = {};
    if (!env?.replicas) return grouped;
    for (const r of env.replicas.values() as Array<ReplicaMinimal>) {
      const signerId: string = r.signerId;
      const entityId: string = r.entityId;
      if (!grouped[signerId]) grouped[signerId] = [];
      grouped[signerId].push({ signerId, entityId });
    }
    return grouped;
  }

  function selectEntity(tabId: string, signerId: string, entityId: string) {
    const t = tabs.find(t => t.id === tabId);
    if (t) { t.signer = signerId; t.entityId = entityId; }
    dropdownOpen[tabId] = false;
  }

  function getReplica(tab: Tab): ReplicaMinimal | null {
    if (!tab.signer || !tab.entityId) return null;
    const idx = get(timeIndex);
    if (typeof idx === 'number' && idx >= 0) {
      return (getReplicaAtTime(tab.entityId, tab.signer) as ReplicaMinimal) ?? null;
    }
    const env = get(xlnEnv);
    if (!env?.replicas) return null;
    return (env.replicas.get(`${tab.entityId}:${tab.signer}`) as ReplicaMinimal) ?? null;
  }

  function vote(tab: Tab, proposalId: string, choice: 'yes' | 'no') {
    if (!tab.signer || !tab.entityId) return;
    voteOnProposal(tab.entityId, tab.signer, proposalId, choice);
  }

  function proposalEntries(tab: Tab): Array<[string, any]> {
    const replica = getReplica(tab) as any;
    const proposals = replica?.state?.proposals as Map<string, any> | undefined;
    return proposals ? Array.from(proposals.entries()) : [];
  }

  function formatEntityTitle(tab: Tab): string {
    const r = getReplica(tab) as any;
    if (!r) return 'Select Entity';
    // If entityId looks like numbered (#0001), show 4-digit; else short hex
    const id = String(r.entityId);
    if (/^0x0{60}\d+$/i.test(id)) {
      const num = Number(BigInt(id)).toString().padStart(4, '0');
      return `Entity ${num}`;
    }
    return id.length > 10 ? `Entity ${id.slice(0,6)}…${id.slice(-4)}` : `Entity ${id}`;
  }

  function roleBadge(tab: Tab): 'Proposer' | 'Validator' | null {
    const r = getReplica(tab) as any;
    if (!r) return null;
    return r.isProposer ? 'Proposer' : 'Validator';
  }

  function boardSummary(tab: Tab): { threshold: number; total: number } | null {
    const r = getReplica(tab) as any;
    const cfg = r?.state?.config;
    if (!cfg) return null;
    const shares: Record<string, bigint> = cfg.shares || {};
    const total = Object.values(shares).reduce((s, v) => s + Number(v), 0);
    return { threshold: Number(cfg.threshold ?? 0), total };
  }

  function boardChips(tab: Tab): Array<{ id: string; weight: number }> {
    const r = getReplica(tab) as any;
    const cfg = r?.state?.config;
    if (!cfg) return [];
    const shares: Record<string, bigint> = cfg.shares || {};
    return (cfg.validators || []).map((v: string) => ({ id: v, weight: Number(shares[v] ?? 1) }));
  }

  async function sendChat(tab: Tab, message: string) {
    if (!tab.signer || !tab.entityId) return;
    await sendChatMessage(tab.entityId, tab.signer, message);
  }

  onMount(() => { initTabs(); });

  function onSendChat(tab: Tab) {
    const el = textareaElMap[tab.id];
    const msg = el?.value?.trim();
    if (!msg) return;
    sendChat(tab, msg);
    el.value = '';
  }

  function onChangeTime(e: Event) {
    const val = Number((e.target as HTMLInputElement).value);
    setTimePosition(val);
  }
</script>

<div class="panels-toolbar" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
  <div style="font-size:12px; color:#aaa;">Panels: {tabs.length}/4</div>
  <div style="display:flex; gap:8px;">
    <button class="form-button" on:click={addPanel} disabled={tabs.length>=4}>＋</button>
  </div>
</div>
<div id="entityPanelsContainer" class="entity-panels-container" data-panel-count={tabs.length} style={`grid-template-columns: repeat(${tabs.length}, minmax(0,1fr));`}>
  {#each tabs as tab, i}
    <div class="entity-panel" data-panel-id={tab.id}>
      <div class="panel-header">
        <div class="unified-dropdown" id={`dropdown-${tab.id}`}>
          <button class="unified-dropdown-btn" on:click={() => toggleDropdown(tab.id)} style="width:100%">
            <span class="dropdown-icon">🏛️</span>
            <span class="dropdown-text" id={`dropdownText-${tab.id}`}>
              {#if tab.signer && tab.entityId}
                {tab.signer}.eth → {formatEntityTitle(tab)}
              {:else}
                Select Entity
              {/if}
            </span>
            <span class="dropdown-arrow">▼</span>
          </button>
          {#if dropdownOpen[tab.id]}
            <div class="unified-dropdown-content" id={`dropdownContent-${tab.id}`}
                 style="max-height:260px; overflow:auto; border:1px solid #3e3e3e; background:#252526;">
              <!-- signer-first grouping -->
              {#each Object.entries(replicasBySigner()) as [signer, reps]}
                <div class="dropdown-item header indent-1">
                  <span class="item-text">👤 {signer}.eth</span>
                </div>
                {#each reps as r}
                  <button class="dropdown-item indent-2" type="button" on:click={() => selectEntity(tab.id, r.signerId, r.entityId)}>
                    <span class="item-text">🏢 {r.entityId}</span>
                  </button>
                {/each}
              {/each}
            </div>
          {/if}
        </div>
        <button class="form-button" on:click={() => removePanel(tab.id)} disabled={tabs.length<=1} title="Close">✕</button>
      </div>

      <!-- Chat -->
      <div class="panel-component" id={`chat-${tab.id}`}>
        <button class="component-header" type="button">
          <div class="component-title"><span>💬</span><span>Chat</span>
            {#if roleBadge(tab)}<span class="role-badge">{roleBadge(tab)}</span>{/if}
            {#if boardSummary(tab)}
              {@const bs = boardSummary(tab)}
              <span class="board-badge">{bs?.threshold}/{bs?.total} threshold</span>
            {/if}
          </div>
          <div class="component-toggle">▼</div>
        </button>
      <div class="component-content" style="max-height:25vh; overflow:auto">
          <div class="scrollable-component" id={`chatContent-${tab.id}`}>
            {#if (getReplica(tab)?.state?.messages || []).length}
              {#each (getReplica(tab)?.state?.messages || []) as msg, idx}
                {@const rep = getReplica(tab)}
                {#if rep}
                  <div class="chat-message"><div class="chat-meta">Message #{idx+1} • {rep.signerId}</div><div class="chat-content">{msg}</div></div>
                {/if}
              {/each}
            {:else}
              <div class="empty-state">- no messages</div>
            {/if}
          </div>
        </div>
      </div>

      <!-- Proposals -->
      <div class="panel-component" id={`proposals-${tab.id}`}>
        <button class="component-header" type="button">
          <div class="component-title"><span>📋</span><span>Proposals</span></div>
          <div class="component-toggle">▼</div>
        </button>
        <div class="component-content" style="max-height:25vh; overflow:auto">
          <div class="scrollable-component" id={`proposalsContent-${tab.id}`}>
            {#if getReplica(tab)?.state?.proposals?.size}
              {#each proposalEntries(tab) as [key, p]}
                <div class="proposal-item">
                  <div class="proposal-title">{p?.action?.data?.message || key}</div>
                  <div class="proposal-meta">{p.status}</div>
                  {#if tab.signer && tab.entityId}
                    <div class="proposal-actions">
                      <button class="small" on:click={() => vote(tab, key, 'yes')}>👍</button>
                      <button class="small" on:click={() => vote(tab, key, 'no')}>👎</button>
                    </div>
                  {/if}
                </div>
              {/each}
            {:else}
              <div class="empty-state">- no proposals</div>
            {/if}
          </div>
        </div>
      </div>

      <!-- History -->
      <div class="panel-component" id={`history-${tab.id}`}>
        <button class="component-header" type="button">
          <div class="component-title"><span>🗂️</span><span>History</span></div>
          <div class="component-toggle">▼</div>
        </button>
        <div class="component-content" style="max-height:25vh; overflow:auto">
          <div class="entity-history-container" id={`historyContent-${tab.id}`}>
            <div class="empty-state">- no frame history</div>
          </div>
        </div>
      </div>

      <!-- Controls -->
      <div class="panel-component" id={`controls-${tab.id}`}>
        <button class="component-header" type="button">
          <div class="component-title"><span>⚙️</span><span>Controls</span></div>
          <div class="component-toggle">▼</div>
        </button>
        <div class="component-content" style="max-height:400px; overflow:auto">
          <div class="controls-section" id={`controlsContent-${tab.id}`}>
            <div class="controls-form" id={`controlsForm-${tab.id}`}>
              <div class="form-group">
                <label class="form-label" for={`message-${tab.id}`}>Message:</label>
                <textarea id={`message-${tab.id}`} class="form-textarea" bind:this={textareaElMap[tab.id]} placeholder="Enter your message..."></textarea>
              </div>
              <div class="form-row">
                <button class="form-button" on:click={() => onSendChat(tab)}>Send Message</button>
                <button class="form-button" on:click={() => {
                  const el = textareaElMap[tab.id];
                  const msg = el?.value?.trim();
                  if (!msg || !tab.entityId || !tab.signer) return;
                  proposeCollectiveMessage(tab.entityId, tab.signer, msg);
                  if (el) el.value = '';
                }}>Propose</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  {/each}
</div>
<style>
  .entity-panels-container{ display:grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap:12px; width:100%; min-height:40vh; }
  .entity-panel{ background:#2d2d2d; border:1px solid #3e3e3e; padding:16px; min-width:0; }
  .panel-header{ display:flex; align-items:center; justify-content:space-between; margin-bottom:8px; padding-bottom:8px; border-bottom:1px solid #3e3e3e; }
  .unified-dropdown-content .dropdown-item{ padding:4px 8px; cursor:pointer; }
  .dropdown-item.indent-1{ padding-left:8px; color:#ddd }
  .dropdown-item.indent-2{ padding-left:24px; }
  .chat-message{ background:#2d2d2d; border-left:3px solid #007acc; padding:8px; border-radius:4px; margin-bottom:6px; }
  .empty-state{ color:#777; font-style:italic; padding:6px; }
  .role-badge{ margin-left:8px; font-size:12px; background:#0b5; color:#fff; padding:2px 6px; border-radius:10px; }
  .board-badge{ margin-left:6px; font-size:12px; color:#bbb; }
</style>

<!-- Time machine bar -->
<div class="time-machine" style="position:sticky; bottom:0; left:0; right:0; background:#1e1e1e; border-top:1px solid #3e3e3e; padding:8px 12px; display:flex; align-items:center; gap:12px;">
  <span style="font-size:12px; color:#aaa;">Time</span>
  <input type="range" min="0" max={$historyLen > 0 ? $historyLen - 1 : 0} value={$timeIndex >= 0 ? $timeIndex : ($historyLen > 0 ? $historyLen - 1 : 0)} on:input={onChangeTime} style="flex:1"/>
  <button class="form-button" on:click={runDemoIfAvailable}>Run Demo</button>
</div>


