<script lang="ts">
  import { onMount } from 'svelte';

  interface Scenario {
    id: string;
    title: string;
    description: string;
    autoScript?: string; // JS to execute in iframe after load
  }

  const scenarios: Scenario[] = [
    {
      id: 'ahb',
      title: 'Alice → Hub → Bob',
      description: 'Basic 3-party payment flow. Watch funds route through the hub in real-time.',
      autoScript: `
        setTimeout(async () => {
          if (window.XLN?.r2r) {
            // Continuous loop
            const loop = async () => {
              await window.XLN.r2r('0', '1', 100);
              await new Promise(r => setTimeout(r, 2000));
              await window.XLN.r2r('1', '2', 50);
              await new Promise(r => setTimeout(r, 3000));
              loop();
            };
            loop();
          }
        }, 3000);
      `
    },
    {
      id: 'fed-chair',
      title: 'Fed Chair Demo',
      description: '3×3 hub grid with $1M per entity. Broadcast payments across the network.',
      autoScript: `
        setTimeout(async () => {
          if (window.XLN?.fundAll) {
            await window.XLN.fundAll(1000000);
            await new Promise(r => setTimeout(r, 2000));
            // Start continuous payments
            const loop = async () => {
              if (window.XLN?.r2r) {
                const from = Math.floor(Math.random() * 9).toString();
                const to = Math.floor(Math.random() * 9).toString();
                if (from !== to) {
                  await window.XLN.r2r(from, to, Math.floor(Math.random() * 10000));
                }
              }
              setTimeout(loop, 1500);
            };
            loop();
          }
        }, 4000);
      `
    },
    {
      id: 'scale-test',
      title: 'Scale Test: 100 Entities',
      description: 'Stress test with 100 entities. FPS should stay at 60+.',
      autoScript: `
        setTimeout(async () => {
          if (window.XLN?.createEntities) {
            await window.XLN.createEntities(100);
          }
        }, 3000);
      `
    }
  ];

  let fullscreenId: string | null = null;
  let iframeRefs: Record<string, HTMLIFrameElement> = {};

  function toggleFullscreen(id: string) {
    if (fullscreenId === id) {
      fullscreenId = null;
      document.body.style.overflow = '';
    } else {
      fullscreenId = id;
      document.body.style.overflow = 'hidden';
    }
  }

  function handleIframeLoad(scenario: Scenario, iframe: HTMLIFrameElement | undefined) {
    if (!iframe || !scenario.autoScript || !iframe.contentWindow) return;
    // Execute auto-script in iframe context
    setTimeout(() => {
      try {
        const win = iframe.contentWindow as Window & { eval: (code: string) => void };
        win?.eval(scenario.autoScript!);
      } catch (e) {
        console.log(`Scenario ${scenario.id} script:`, e);
      }
    }, 1000);
  }

  onMount(() => {
    return () => {
      document.body.style.overflow = '';
    };
  });
</script>

<svelte:head>
  <title>xln scenarios</title>
</svelte:head>

<div class="scenarios-page" class:has-fullscreen={fullscreenId !== null}>
  <header class="header">
    <h1>xln scenarios</h1>
    <p class="subtitle">Interactive demos of xln mechanics. Click expand for fullscreen.</p>
  </header>

  <div class="scenarios-grid">
    {#each scenarios as scenario}
      <article
        class="scenario-card"
        class:fullscreen={fullscreenId === scenario.id}
      >
        <div class="scenario-header">
          <h2>{scenario.title}</h2>
          <button
            class="expand-btn"
            on:click={() => toggleFullscreen(scenario.id)}
            title={fullscreenId === scenario.id ? 'Exit fullscreen' : 'Expand'}
          >
            {fullscreenId === scenario.id ? '✕' : '⤢'}
          </button>
        </div>

        <p class="description">{scenario.description}</p>

        <div class="iframe-container">
          <iframe
            bind:this={iframeRefs[scenario.id]}
            src="/view?embed=1&scenario={scenario.id}"
            title={scenario.title}
            on:load={() => handleIframeLoad(scenario, iframeRefs[scenario.id])}
            allow="accelerometer; autoplay; encrypted-media; gyroscope"
          ></iframe>

          <div class="live-badge">LIVE</div>
        </div>
      </article>
    {/each}
  </div>
</div>

<style>
  .scenarios-page {
    min-height: 100vh;
    background: #000;
    color: #fff;
    padding: 2rem;
    padding-top: 4rem; /* Account for fixed topbar */
    font-family: 'Inter', -apple-system, sans-serif;
  }

  .scenarios-page.has-fullscreen {
    overflow: hidden;
  }

  .header {
    text-align: center;
    margin-bottom: 3rem;
  }

  h1 {
    font-size: 2.5rem;
    font-weight: 300;
    margin: 0;
    letter-spacing: -0.02em;
  }

  .subtitle {
    color: rgba(255,255,255,0.5);
    margin-top: 0.5rem;
    font-size: 1rem;
  }

  .scenarios-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 2rem;
    max-width: 1800px;
    margin: 0 auto;
    padding: 0 2rem;
  }

  @media (max-width: 1200px) {
    .scenarios-grid {
      grid-template-columns: 1fr;
    }
  }

  .scenario-card {
    background: #000;
    border: none;
    border-radius: 8px;
    overflow: hidden;
    transition: all 0.3s ease;
  }

  .scenario-card:hover {
    box-shadow: 0 0 30px rgba(79, 209, 139, 0.15);
  }

  .scenario-card.fullscreen {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 10000;
    border-radius: 0;
    border: none;
    display: flex;
    flex-direction: column;
  }

  .scenario-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.5rem 0.75rem;
    background: rgba(0, 0, 0, 0.3);
  }

  .scenario-header h2 {
    margin: 0;
    font-size: 0.9rem;
    font-weight: 500;
  }

  .expand-btn {
    background: rgba(255,255,255,0.1);
    border: none;
    color: #fff;
    width: 28px;
    height: 28px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
  }

  .expand-btn:hover {
    background: #4fd18b;
    color: #000;
  }

  .description {
    padding: 0.4rem 0.75rem;
    color: rgba(255,255,255,0.5);
    font-size: 0.75rem;
    margin: 0;
    background: rgba(0, 0, 0, 0.2);
  }

  .scenario-card.fullscreen .description {
    display: none;
  }

  .iframe-container {
    position: relative;
    aspect-ratio: 16/10;
    background: #000;
  }

  .scenario-card.fullscreen .iframe-container {
    flex: 1;
    aspect-ratio: unset;
  }

  iframe {
    width: 100%;
    height: 100%;
    border: none;
    background: #000;
  }

  .live-badge {
    position: absolute;
    top: 12px;
    left: 12px;
    background: #e53935;
    color: white;
    font-size: 0.65rem;
    font-weight: 700;
    padding: 3px 8px;
    border-radius: 4px;
    animation: pulse-live 2s ease-in-out infinite;
    letter-spacing: 0.05em;
  }

  @keyframes pulse-live {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }

  @media (max-width: 600px) {
    .scenarios-page {
      padding: 1rem;
    }

    .scenarios-grid {
      grid-template-columns: 1fr;
    }

    .header h1 {
      font-size: 1.8rem;
    }
  }
</style>
