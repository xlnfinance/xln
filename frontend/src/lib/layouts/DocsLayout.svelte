<script lang="ts">
  import { page } from '$app/stores';

  interface NavItem {
    label: string;
    href: string;
  }

  interface NavSection {
    title: string;
    items: NavItem[];
  }

  const sections: NavSection[] = [
    {
      title: 'Getting Started',
      items: [
        { label: 'Introduction', href: '/docs' },
        { label: 'Core Concepts', href: '/docs/concepts' }
      ]
    },
    {
      title: 'Architecture',
      items: [
        { label: 'Overview', href: '/docs/architecture' },
        { label: 'Smart Contracts', href: '/docs/architecture/contracts' },
        { label: 'Hanko System', href: '/docs/architecture/hanko' },
        { label: 'Visual Debugger', href: '/docs/architecture/visual-debugger' }
      ]
    },
    {
      title: 'Deployment',
      items: [
        { label: 'Local Development', href: '/docs/deployment' }
      ]
    },
    {
      title: 'Frontend',
      items: [
        { label: 'Network Topology', href: '/docs/frontend/network-topology' },
        { label: 'Graph 3D Embed', href: '/docs/frontend/graph3d' },
        { label: 'VR Support', href: '/docs/frontend/vr' },
        { label: 'Refactoring Guide', href: '/docs/frontend/refactor' }
      ]
    },
    {
      title: 'Comparisons',
      items: [
        { label: 'XLN vs Others', href: '/docs/comparisons' }
      ]
    },
    {
      title: 'Strategy',
      items: [
        { label: 'Go-to-Market', href: '/docs/strategy/go-to-market' },
        { label: 'Foundation Governance', href: '/docs/strategy/foundation' }
      ]
    },
    {
      title: 'Philosophy',
      items: [
        { label: 'Programmable Entities', href: '/docs/philosophy/programmable-entities' },
        { label: 'Data Sovereignty', href: '/docs/philosophy/data-sovereignty' },
        { label: 'TradFi + DeFi = XLN', href: '/docs/philosophy/tradfi-plus-defi' }
      ]
    }
  ];

  let searchQuery = '';
  let mobileMenuOpen = false;

  $: filteredSections = searchQuery
    ? sections.map(section => ({
        ...section,
        items: section.items.filter(item =>
          item.label.toLowerCase().includes(searchQuery.toLowerCase())
        )
      })).filter(section => section.items.length > 0)
    : sections;
</script>

<div class="docs-container">
  <!-- Mobile header -->
  <header class="mobile-header">
    <a href="/" class="logo">XLN</a>
    <button
      class="mobile-menu-toggle"
      on:click={() => mobileMenuOpen = !mobileMenuOpen}
      aria-label="Toggle menu"
    >
      ☰
    </button>
  </header>

  <!-- Sidebar -->
  <aside class="docs-sidebar" class:open={mobileMenuOpen}>
    <div class="sidebar-header">
      <a href="/" class="logo">← XLN</a>
    </div>

    <div class="search-box">
      <input
        type="text"
        placeholder="Search docs..."
        bind:value={searchQuery}
        class="search-input"
      />
    </div>

    <nav class="sidebar-nav">
      {#each filteredSections as section}
        <div class="nav-section">
          <h3 class="section-title">{section.title}</h3>
          <div class="section-items">
            {#each section.items as item}
              <a
                href={item.href}
                class="nav-item"
                class:active={$page.url.pathname === item.href}
                on:click={() => mobileMenuOpen = false}
              >
                {item.label}
              </a>
            {/each}
          </div>
        </div>
      {/each}
    </nav>
  </aside>

  <!-- Main content -->
  <main class="docs-content">
    <slot />
  </main>
</div>

<style>
  .docs-container {
    --sidebar-width: 280px;
    --content-max-width: 800px;
    --spacing-xs: 0.25rem;
    --spacing-sm: 0.5rem;
    --spacing-md: 1rem;
    --spacing-lg: 1.5rem;
    --spacing-xl: 2rem;
    --spacing-2xl: 3rem;

    display: grid;
    grid-template-columns: var(--sidebar-width) 1fr;
    min-height: 100vh;
    background: var(--bg);
    color: var(--text);
  }

  /* Mobile header - hidden on desktop */
  .mobile-header {
    display: none;
  }

  /* Sidebar */
  .docs-sidebar {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    background: var(--bg-secondary);
    border-right: 1px solid var(--border);
    padding: var(--spacing-xl) var(--spacing-md);
  }

  .sidebar-header {
    margin-bottom: var(--spacing-xl);
  }

  .logo {
    display: block;
    font-weight: bold;
    font-size: 1.5rem;
    color: var(--accent);
    text-decoration: none;
    transition: opacity 0.2s;
  }

  .logo:hover {
    opacity: 0.8;
  }

  .search-box {
    margin-bottom: var(--spacing-lg);
  }

  .search-input {
    width: 100%;
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text);
    font-size: 0.875rem;
    transition: border-color 0.2s;
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent);
  }

  .search-input::placeholder {
    color: var(--text-secondary);
  }

  /* Navigation */
  .sidebar-nav {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-lg);
  }

  .nav-section {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }

  .section-title {
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
    margin: 0;
    padding: var(--spacing-sm) var(--spacing-md);
  }

  .section-items {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    display: block;
    padding: var(--spacing-sm) var(--spacing-md);
    color: var(--text);
    text-decoration: none;
    border-radius: 6px;
    font-size: 0.875rem;
    transition: all 0.2s;
    position: relative;
  }

  .nav-item:hover {
    background: var(--bg);
    color: var(--accent);
  }

  .nav-item.active {
    background: var(--accent);
    color: white;
    font-weight: 500;
  }

  .nav-item.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 3px;
    height: 60%;
    background: white;
    border-radius: 0 2px 2px 0;
  }

  /* Main content */
  .docs-content {
    padding: var(--spacing-2xl);
    max-width: var(--content-max-width);
    width: 100%;
    margin: 0 auto;
  }

  /* Markdown styling */
  .docs-content :global(h1) {
    font-size: 2.5rem;
    font-weight: bold;
    margin-bottom: var(--spacing-lg);
    color: var(--text);
    line-height: 1.2;
  }

  .docs-content :global(h2) {
    font-size: 2rem;
    font-weight: bold;
    margin-top: var(--spacing-2xl);
    margin-bottom: var(--spacing-lg);
    padding-bottom: var(--spacing-sm);
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }

  .docs-content :global(h3) {
    font-size: 1.5rem;
    font-weight: 600;
    margin-top: var(--spacing-xl);
    margin-bottom: var(--spacing-md);
    color: var(--text);
  }

  .docs-content :global(h4) {
    font-size: 1.25rem;
    font-weight: 600;
    margin-top: var(--spacing-lg);
    margin-bottom: var(--spacing-md);
    color: var(--text);
  }

  .docs-content :global(p) {
    line-height: 1.7;
    margin-bottom: var(--spacing-md);
    color: var(--text);
  }

  .docs-content :global(a) {
    color: var(--accent);
    text-decoration: none;
    transition: opacity 0.2s;
  }

  .docs-content :global(a:hover) {
    opacity: 0.8;
    text-decoration: underline;
  }

  .docs-content :global(ul),
  .docs-content :global(ol) {
    margin-bottom: var(--spacing-md);
    padding-left: var(--spacing-xl);
  }

  .docs-content :global(li) {
    line-height: 1.7;
    margin-bottom: var(--spacing-sm);
  }

  .docs-content :global(code) {
    background: var(--bg-secondary);
    padding: 0.2em 0.4em;
    border-radius: 3px;
    font-family: 'Courier New', Courier, monospace;
    font-size: 0.875em;
    color: var(--accent);
  }

  .docs-content :global(pre) {
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    padding: var(--spacing-lg);
    border-radius: 8px;
    overflow-x: auto;
    margin: var(--spacing-lg) 0;
  }

  .docs-content :global(pre code) {
    background: none;
    padding: 0;
    color: var(--text);
  }

  .docs-content :global(blockquote) {
    border-left: 4px solid var(--accent);
    padding-left: var(--spacing-lg);
    margin: var(--spacing-lg) 0;
    color: var(--text-secondary);
    font-style: italic;
  }

  .docs-content :global(table) {
    width: 100%;
    border-collapse: collapse;
    margin: var(--spacing-lg) 0;
    font-size: 0.875rem;
  }

  .docs-content :global(th),
  .docs-content :global(td) {
    border: 1px solid var(--border);
    padding: var(--spacing-sm) var(--spacing-md);
    text-align: left;
  }

  .docs-content :global(th) {
    background: var(--bg-secondary);
    font-weight: 600;
    color: var(--text);
  }

  .docs-content :global(td) {
    background: var(--bg);
    color: var(--text);
  }

  .docs-content :global(tr:hover td) {
    background: var(--bg-secondary);
  }

  .docs-content :global(img) {
    max-width: 100%;
    height: auto;
    border-radius: 8px;
    margin: var(--spacing-lg) 0;
  }

  .docs-content :global(hr) {
    border: none;
    border-top: 1px solid var(--border);
    margin: var(--spacing-2xl) 0;
  }

  /* Responsive */
  @media (max-width: 768px) {
    .docs-container {
      grid-template-columns: 1fr;
    }

    .mobile-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: var(--spacing-md) var(--spacing-lg);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .mobile-menu-toggle {
      background: none;
      border: none;
      color: var(--text);
      font-size: 1.5rem;
      cursor: pointer;
      padding: var(--spacing-sm);
    }

    .docs-sidebar {
      position: fixed;
      top: 0;
      left: -100%;
      width: 280px;
      height: 100vh;
      z-index: 200;
      transition: left 0.3s ease;
    }

    .docs-sidebar.open {
      left: 0;
    }

    .docs-content {
      padding: var(--spacing-lg);
    }
  }
</style>
