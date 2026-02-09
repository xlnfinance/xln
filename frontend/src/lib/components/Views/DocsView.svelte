<script lang="ts">
  import { onMount } from 'svelte';
  import { marked } from 'marked';
  let currentDoc = 'README';
  let docContent = '';
  let renderedHtml = '';
  let searchQuery = '';

  interface DocItem {
    label: string;
    file: string;
  }

  interface DocSection {
    title: string;
    items: DocItem[];
  }

  const sections: DocSection[] = [
    {
      title: 'Core Documentation',
      items: [
        { label: 'Introduction', file: 'README' },
        { label: 'JEA Model', file: 'JEA' },
        { label: 'Payment Spec', file: 'payment-spec' },
        { label: 'Protocol Summary', file: 'summary' },
        { label: 'FAQ', file: 'faq' }
      ]
    },
    {
      title: 'Architecture',
      items: [
        { label: 'Smart Contracts', file: 'architecture/contracts' },
        { label: 'Hanko System', file: 'architecture/hanko' },
        { label: 'Visual Debugger', file: 'architecture/visual-debugger' }
      ]
    },
    {
      title: 'Deployment',
      items: [
        { label: 'Setup Guide', file: 'deployment/README' }
      ]
    },
    {
      title: 'Frontend Development',
      items: [
        { label: 'Network Topology', file: 'frontend-dev/network-topology-integration' },
        { label: 'Refactor Plan', file: 'frontend-dev/refactor-plan' },
        { label: 'Design Patterns', file: 'frontend-dev/design-patterns' }
      ]
    },
    {
      title: 'Comparisons',
      items: [
        { label: 'XLN vs Others', file: 'comparisons/README' }
      ]
    },
    {
      title: 'Strategy',
      items: [
        { label: 'Go-to-Market', file: 'strategy/go-to-market' },
        { label: 'Foundation', file: 'strategy/foundation-governance' }
      ]
    },
    {
      title: 'Philosophy',
      items: [
        { label: 'Programmable Entities', file: 'philosophy/programmable-entities' },
        { label: 'Data Sovereignty', file: 'philosophy/the-data-sovereignty-manifesto' },
        { label: 'TradFi + DeFi = XLN', file: 'philosophy/tradfi-plus-defi-equals-xln' }
      ]
    },
    {
      title: 'Consensus & Debugging',
      items: [
        { label: 'Transaction Flow', file: 'consensus/transaction-flow-specification' },
        { label: 'Debugging Guide', file: 'debugging/consensus-debugging-guide' }
      ]
    }
  ];

  $: filteredSections = searchQuery
    ? sections.map(section => ({
        ...section,
        items: section.items.filter(item =>
          item.label.toLowerCase().includes(searchQuery.toLowerCase())
        )
      })).filter(section => section.items.length > 0)
    : sections;

  async function loadDoc(file: string) {
    currentDoc = file;

    try {
      const response = await fetch(`/docs-static/${file}.md`);
      if (response.ok) {
        docContent = await response.text();
        renderedHtml = await marked(docContent);
      } else {
        renderedHtml = `<h1>Document Not Found</h1><p>Could not load: ${file}.md</p>`;
      }
    } catch (error) {
      console.error('Failed to load doc:', error);
      renderedHtml = `<h1>Error</h1><p>Failed to load document: ${error}</p>`;
    }
  }

  onMount(() => {
    loadDoc('README');
  });
</script>

<div class="docs-view">
  <!-- Sidebar -->
  <aside class="docs-sidebar">
    <div class="sidebar-header">
      <h2>XLN Documentation</h2>
    </div>

    <div class="search-box">
      <input
        type="text"
        placeholder="Search docs..."
        bind:value={searchQuery}
      />
    </div>

    <nav class="sidebar-nav">
      {#each filteredSections as section}
        <div class="nav-section">
          <h3>{section.title}</h3>
          {#each section.items as item}
            <button
              class="nav-item"
              class:active={currentDoc === item.file}
              on:click={() => loadDoc(item.file)}
            >
              {item.label}
            </button>
          {/each}
        </div>
      {/each}
    </nav>
  </aside>

  <!-- Main content -->
  <main class="docs-content">
    <!-- Show scenario player on intro page -->
    {#if currentDoc === 'README'}
      <div class="intro-scenario">
        <h1>🧠 XLN Architecture</h1>
        <p style="font-size: 1.125rem; margin-bottom: 2rem; color: rgba(255, 255, 255, 0.6);">
          Reserve-Credit Provable Account Network — bilateral consensus with on-chain finality.
        </p>
      </div>
    {/if}

    <article class="markdown-body">
      {@html renderedHtml}
    </article>
  </main>
</div>

<style>
  .docs-view {
    display: grid;
    grid-template-columns: 280px 1fr;
    height: calc(100vh - 56px);
    overflow: hidden;
    background: #0a0a0a;
    color: #e0e0e0;
  }

  /* Sidebar */
  .docs-sidebar {
    border-right: 1px solid rgba(255, 255, 255, 0.1);
    overflow-y: auto;
    padding: 1.5rem 1rem;
    background: #111;
  }

  .sidebar-header h2 {
    font-size: 1.25rem;
    margin: 0 0 1.5rem 0;
    color: #4fd18b;
    font-weight: 600;
  }

  .search-box {
    margin-bottom: 1.5rem;
  }

  .search-box input {
    width: 100%;
    padding: 0.5rem 0.75rem;
    background: #0a0a0a;
    border: 1px solid rgba(255, 255, 255, 0.1);
    border-radius: 6px;
    color: #e0e0e0;
    font-size: 0.875rem;
  }

  .search-box input:focus {
    outline: none;
    border-color: #4fd18b;
  }

  .search-box input::placeholder {
    color: rgba(255, 255, 255, 0.4);
  }

  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .nav-section h3 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.4);
    margin: 0 0 0.5rem 0;
    padding: 0 0.75rem;
    font-weight: 600;
  }

  .nav-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.75rem;
    background: none;
    border: none;
    color: #e0e0e0;
    cursor: pointer;
    border-radius: 6px;
    transition: all 0.2s;
    font-size: 0.875rem;
  }

  .nav-item:hover {
    background: #0a0a0a;
    color: #4fd18b;
  }

  .nav-item.active {
    background: #4fd18b;
    color: white;
    font-weight: 500;
  }

  /* Main content */
  .docs-content {
    overflow-y: auto;
    padding: 3rem;
    background: #0a0a0a;
  }

  .intro-scenario {
    margin-bottom: 3rem;
  }

  .intro-scenario h1 {
    font-size: 2.5rem;
    margin-bottom: 1rem;
    color: #e0e0e0;
  }

  .intro-scenario p {
    margin-bottom: 2rem;
  }

  .markdown-body {
    max-width: 900px;
    margin: 0 auto;
  }

  /* Markdown styling */
  .markdown-body :global(h1) {
    font-size: 2.5rem;
    font-weight: 700;
    margin: 0 0 1.5rem 0;
    color: #e0e0e0;
    line-height: 1.2;
  }

  .markdown-body :global(h2) {
    font-size: 2rem;
    font-weight: 600;
    margin: 3rem 0 1rem 0;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    color: #e0e0e0;
  }

  .markdown-body :global(h3) {
    font-size: 1.5rem;
    font-weight: 600;
    margin: 2rem 0 0.75rem 0;
    color: #e0e0e0;
  }

  .markdown-body :global(h4) {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 1.5rem 0 0.75rem 0;
    color: #e0e0e0;
  }

  .markdown-body :global(p) {
    line-height: 1.7;
    margin-bottom: 1rem;
    color: #e0e0e0;
  }

  .markdown-body :global(a) {
    color: #4fd18b;
    text-decoration: none;
  }

  .markdown-body :global(a:hover) {
    text-decoration: underline;
    opacity: 0.8;
  }

  .markdown-body :global(ul),
  .markdown-body :global(ol) {
    margin: 1rem 0;
    padding-left: 2rem;
  }

  .markdown-body :global(li) {
    line-height: 1.7;
    margin-bottom: 0.5rem;
    color: #e0e0e0;
  }

  .markdown-body :global(code) {
    background: #111;
    padding: 0.2em 0.4em;
    border-radius: 3px;
    font-family: 'Courier New', Courier, monospace;
    font-size: 0.9em;
    color: #4fd18b;
  }

  .markdown-body :global(pre) {
    background: #111;
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 1rem;
    border-radius: 8px;
    overflow-x: auto;
    margin: 1.5rem 0;
  }

  .markdown-body :global(pre code) {
    background: none;
    padding: 0;
    color: #e0e0e0;
    font-size: 0.875rem;
  }

  .markdown-body :global(blockquote) {
    border-left: 4px solid #4fd18b;
    padding-left: 1rem;
    margin: 1.5rem 0;
    color: rgba(255, 255, 255, 0.6);
    font-style: italic;
  }

  .markdown-body :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: 1.5rem 0;
    font-size: 0.875rem;
  }

  .markdown-body :global(th),
  .markdown-body :global(td) {
    border: 1px solid rgba(255, 255, 255, 0.1);
    padding: 0.75rem;
    text-align: left;
  }

  .markdown-body :global(th) {
    background: #111;
    font-weight: 600;
    color: #e0e0e0;
  }

  .markdown-body :global(td) {
    color: #e0e0e0;
  }

  .markdown-body :global(tr:hover) {
    background: #111;
  }

  .markdown-body :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    margin: 1.5rem 0;
  }

  .markdown-body :global(hr) {
    border: none;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    margin: 2rem 0;
  }

  .markdown-body :global(strong) {
    font-weight: 600;
    color: #e0e0e0;
  }

  .markdown-body :global(em) {
    font-style: italic;
  }

  @media (max-width: 1024px) {
    .docs-view {
      grid-template-columns: 1fr;
    }

    .docs-sidebar {
      display: none;
    }

    .docs-content {
      padding: 1.5rem;
    }
  }
</style>
