<script lang="ts">
  /**
   * XLN Comprehensive Tutorial
   * From Alice & Bob to Central Banking - FCUAN → FRPAP → RCPAN Evolution
   */

  import { createEventDispatcher } from 'svelte';
  import { panelBridge } from '../utils/panelBridge';

  export let isVRMode = false;

  const dispatch = createEventDispatcher();

  let currentStep = 0;
  let currentScenario = 0;

  // Tutorial scenarios: Simple → Complex (FCUAN → FRPAP → RCPAN)
  const SCENARIOS = [
    {
      id: 'alice-bob',
      title: '👥 FCUAN: Alice & Bob (Friendship Money)',
      subtitle: '~5000 BC - Full Credit, Unprovable Accounts',
      emoji: '🤝',
      color: '#ffa500',
      steps: [
        {
          title: 'Meet Alice & Bob',
          description: 'Two friends who trust each other completely.',
          action: 'create-two-entities',
          visual: 'Show 2 entities with no connections'
        },
        {
          title: 'Alice Owes Bob',
          description: 'Alice: "I owe you $50 for dinner"\nBob: "Cool, I trust you"',
          action: 'show-verbal-promise',
          visual: 'Speech bubble between entities'
        },
        {
          title: 'The Problem',
          description: '❌ No proof\n❌ Bob can\'t verify\n❌ Alice could forget or lie',
          action: 'highlight-trust-issue',
          visual: 'Red warning signs'
        },
        {
          title: 'FCUAN Reality',
          description: 'This is how 99% of human transactions worked for 7,000 years.\n\nIt works... until it doesn\'t.',
          action: 'show-historical-context',
          visual: 'Timeline from 5000 BC'
        }
      ]
    },
    {
      id: 'bitcoin',
      title: '🪙 FRPAP: Bitcoin Era (Provable, But Slow)',
      subtitle: '2009-2015 - Full Reserve, Provable Account Primitives',
      emoji: '⚡',
      color: '#ff9500',
      steps: [
        {
          title: 'Alice & Bob Level Up',
          description: 'Now they use Bitcoin. Every transaction goes on-chain.',
          action: 'create-blockchain',
          visual: 'Add golden blockchain layer'
        },
        {
          title: 'The Promise',
          description: '✅ Cryptographic proof\n✅ Bob can verify\n✅ Alice can\'t cheat\n\n...but wait...',
          action: 'show-proof',
          visual: 'Green checkmarks + math symbols'
        },
        {
          title: 'The Cost',
          description: '❌ 10 minute confirmation\n❌ $5 transaction fee\n❌ Entire network validates\n❌ Can\'t buy coffee',
          action: 'show-blockchain-cost',
          visual: 'Clock ticking, gas fees burning'
        },
        {
          title: 'FRPAP Reality',
          description: 'Bitcoin solved trust... but killed speed.\n\nGreat for $1M transfers.\nTerrible for daily life.',
          action: 'compare-use-cases',
          visual: 'Split screen: bank transfer vs coffee'
        }
      ]
    },
    {
      id: 'lightning',
      title: '⚡ Payment Channels (Getting Warmer)',
      subtitle: '2015-2024 - Off-chain bilateral consensus',
      emoji: '🔄',
      color: '#00ff88',
      steps: [
        {
          title: 'Alice & Bob Open Channel',
          description: 'Lock $1000 on-chain → transact off-chain instantly',
          action: 'create-channel',
          visual: 'Draw line between Alice & Bob'
        },
        {
          title: 'Instant Payments!',
          description: '$5 coffee → instant\n$20 lunch → instant\n$50 gas → instant\n\nNo blockchain needed!',
          action: 'rapid-payments',
          visual: 'Fast yellow particles back and forth'
        },
        {
          title: 'The Limitation',
          description: 'Alice can only pay Bob.\n\nWhat if Alice wants to pay Charlie?\n→ Must open new channel\n→ More on-chain transactions\n→ Liquidity fragmentation',
          action: 'show-routing-problem',
          visual: 'Alice → ? → Charlie (broken path)'
        },
        {
          title: 'Multi-Hop Routing',
          description: 'Alice → Bob → Charlie works...\n\nBut:\n❌ Bob must be online\n❌ Bob must have liquidity\n❌ Trust/route discovery hard',
          action: 'show-routing',
          visual: 'Complex web with dead ends'
        }
      ]
    },
    {
      id: 'xln-rcpan',
      title: '🌐 XLN: The Endgame (RCPAN)',
      subtitle: '2026 → ∞ - Reserve-Credit Provable Account Network',
      emoji: '💎',
      color: '#4fd18b',
      steps: [
        {
          title: 'Enter: The Entity',
          description: 'Not "Alice the person"\nNot "Bob\'s wallet"\n\n→ Chase Bank\n→ Bank of America\n→ Federal Reserve\n\nInstitutions with RESERVES',
          action: 'create-entities',
          visual: 'Transform Alice/Bob into banks'
        },
        {
          title: 'Bilateral Accounts',
          description: 'Every pair of entities has an account.\n\nChase ↔ BoA\nChase ↔ Fed\nBoA ↔ Fed\n\nNo routing needed - direct settlement!',
          action: 'show-mesh',
          visual: 'All entities connected (mesh topology)'
        },
        {
          title: 'Reserve vs Credit',
          description: 'Reserve = real collateral locked\nCredit = trusted overdraft\n\n→ Each account has BOTH\n→ Dynamic ratio based on risk\n→ Crisis mode = more reserve required',
          action: 'show-rc-model',
          visual: 'Account bars with R/C split'
        },
        {
          title: 'The Magic',
          description: '✅ Instant (off-chain bilateral consensus)\n✅ Scalable (no routing)\n✅ Provable (state hashes + signatures)\n✅ Settles eventually (batch to chain)\n✅ Crisis-resilient (can require 100% reserve)',
          action: 'show-advantages',
          visual: 'All green checkmarks pulsing'
        },
        {
          title: 'This Is The Endgame',
          description: 'FCUAN → trust required\nFRPAP → speed killed\nChannels → routing hell\n\nXLN → mathematical perfection\n\n🎯 Best of all worlds',
          action: 'show-evolution',
          visual: 'Timeline from 5000 BC → 2026'
        }
      ]
    },
    {
      id: 'central-banking',
      title: '🏛️ Central Banking Mode (You Are Bernanke)',
      subtitle: 'See how Fed controls the entire system',
      emoji: '🇺🇸',
      color: '#FFD700',
      steps: [
        {
          title: 'The Federal Reserve',
          description: 'Golden entity at the center.\n\nCan mint infinite reserves.\nSets credit limits for banks.\nStabilizes during crises.',
          action: 'highlight-fed',
          visual: 'Fed glows gold, pulses'
        },
        {
          title: 'Normal Operations',
          description: 'Banks trade with each other.\nFed watches reserves.\nPayments flow smoothly.\n\nGreen numbers = healthy system',
          action: 'show-normal-flow',
          visual: 'Peaceful payment flow'
        },
        {
          title: 'Crisis Mode',
          description: 'One bank runs low on reserves!\n\nWatch what happens:\n→ System detects stress\n→ Fed activates\n→ Liquidity injected\n→ Crisis averted',
          action: 'trigger-crisis',
          visual: 'Bank turns red → Fed shoots money → green again'
        },
        {
          title: 'You Control This',
          description: 'In VR, you ARE the Federal Reserve.\n\n- See all reserves in real-time\n- Mint money to stressed banks\n- Watch ripple effects instantly\n\nThis is monetary policy visualized.',
          action: 'show-controls',
          visual: 'Fed controls panel appears'
        }
      ]
    }
  ];

  function nextStep() {
    const scenario = SCENARIOS[currentScenario];
    if (!scenario) return;
    if (currentStep < scenario.steps.length - 1) {
      currentStep++;
    } else if (currentScenario < SCENARIOS.length - 1) {
      currentScenario++;
      currentStep = 0;
    } else {
      // Tutorial complete!
      dispatch('complete');
    }

    // Emit event for 3D panel to execute visual actions
    const step = scenario.steps[currentStep];
    if (step) {
      panelBridge.emit('tutorial:action', {
        action: step.action,
        data: { scenarioId: scenario.id }
      });
    }
  }

  function prevStep() {
    if (currentStep > 0) {
      currentStep--;
    } else if (currentScenario > 0) {
      currentScenario--;
      const prevScenario = SCENARIOS[currentScenario];
      currentStep = prevScenario ? prevScenario.steps.length - 1 : 0;
    }

    const scenario = SCENARIOS[currentScenario];
    if (!scenario) return;
    const step = scenario.steps[currentStep];
    if (step) {
      panelBridge.emit('tutorial:action', {
        action: step.action,
        data: { scenarioId: scenario.id }
      });
    }
  }

  function skip() {
    dispatch('skip');
  }

  $: currentScenarioData = SCENARIOS[currentScenario] ?? SCENARIOS[0];
  $: currentStepData = currentScenarioData?.steps[currentStep] ?? currentScenarioData?.steps[0];
  $: progress = ((currentScenario * 10 + currentStep) / (SCENARIOS.length * 10)) * 100;
</script>

{#if currentScenarioData && currentStepData}
<div class="tutorial-overlay" class:vr-mode={isVRMode}>
  <div class="tutorial-panel" style="border-color: {currentScenarioData.color}">
    <!-- Progress bar -->
    <div class="progress-bar">
      <div class="progress-fill" style="width: {progress}%"></div>
    </div>

    <!-- Scenario header -->
    <div class="scenario-header">
      <div class="scenario-emoji">{currentScenarioData.emoji}</div>
      <div class="scenario-info">
        <h2>{currentScenarioData.title}</h2>
        <p class="scenario-subtitle">{currentScenarioData.subtitle}</p>
      </div>
    </div>

    <!-- Step content -->
    <div class="step-content">
      <h3>{currentStepData.title}</h3>
      <p class="step-description">{currentStepData.description}</p>

      <!-- Step indicator -->
      <div class="step-indicator">
        Step {currentStep + 1} of {currentScenarioData.steps.length}
        <span class="scenario-progress">
          (Scenario {currentScenario + 1}/{SCENARIOS.length})
        </span>
      </div>
    </div>

    <!-- Navigation -->
    <div class="tutorial-nav">
      <button class="nav-btn" on:click={prevStep} disabled={currentScenario === 0 && currentStep === 0}>
        ← Back
      </button>

      <button class="nav-btn skip-btn" on:click={skip}>
        Skip Tutorial
      </button>

      <button class="nav-btn primary" on:click={nextStep}>
        {currentScenario === SCENARIOS.length - 1 && currentStep === currentScenarioData.steps.length - 1
          ? '🎉 Finish'
          : 'Next →'}
      </button>
    </div>
  </div>
</div>
{/if}

<style>
  .tutorial-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    backdrop-filter: blur(10px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    animation: fadeIn 0.3s ease;
  }

  .tutorial-overlay.vr-mode {
    /* VR mode: brighter, larger text */
    background: rgba(0, 0, 0, 0.85);
  }

  .tutorial-panel {
    width: 90%;
    max-width: 800px;
    background: linear-gradient(135deg, rgba(10, 20, 30, 0.98), rgba(20, 30, 40, 0.98));
    border-radius: 12px;
    border: 3px solid #4fd18b;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.8), 0 0 40px rgba(79, 209, 139, 0.3);
    padding: 2.5rem;
    animation: slideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
  }

  .vr-mode .tutorial-panel {
    max-width: 1000px;
    font-size: 1.3em;
  }

  .progress-bar {
    height: 6px;
    background: rgba(255, 255, 255, 0.1);
    border-radius: 3px;
    margin-bottom: 2rem;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: linear-gradient(90deg, #4fd18b, #00ff88);
    transition: width 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
    box-shadow: 0 0 20px rgba(79, 209, 139, 0.6);
  }

  .scenario-header {
    display: flex;
    align-items: center;
    gap: 1.5rem;
    margin-bottom: 2rem;
    padding-bottom: 1.5rem;
    border-bottom: 2px solid rgba(255, 255, 255, 0.1);
  }

  .scenario-emoji {
    font-size: 4rem;
    line-height: 1;
    filter: drop-shadow(0 4px 12px rgba(0, 0, 0, 0.5));
  }

  .scenario-info h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1.8rem;
    color: #ffffff;
    font-weight: 700;
  }

  .scenario-subtitle {
    margin: 0;
    font-size: 1rem;
    color: rgba(255, 255, 255, 0.7);
    font-style: italic;
  }

  .step-content {
    min-height: 200px;
    margin-bottom: 2rem;
  }

  .step-content h3 {
    margin: 0 0 1rem 0;
    font-size: 1.6rem;
    color: #4fd18b;
    font-weight: 700;
  }

  .step-description {
    font-size: 1.2rem;
    line-height: 1.8;
    color: rgba(255, 255, 255, 0.95);
    white-space: pre-line;
    margin: 0 0 1.5rem 0;
  }

  .step-indicator {
    font-size: 0.9rem;
    color: rgba(255, 255, 255, 0.5);
    font-family: monospace;
  }

  .scenario-progress {
    margin-left: 0.5rem;
    color: rgba(255, 255, 255, 0.3);
  }

  .tutorial-nav {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
  }

  .nav-btn {
    padding: 0.8rem 1.5rem;
    font-size: 1rem;
    font-weight: 600;
    border: 2px solid rgba(255, 255, 255, 0.2);
    background: rgba(255, 255, 255, 0.05);
    color: #ffffff;
    border-radius: 6px;
    cursor: pointer;
    transition: all 0.2s;
    font-family: monospace;
  }

  .nav-btn:hover:not(:disabled) {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.4);
    transform: translateY(-1px);
  }

  .nav-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }

  .nav-btn.primary {
    background: linear-gradient(135deg, #4fd18b, #00ff88);
    border-color: #4fd18b;
    color: #000000;
  }

  .nav-btn.primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #5fe19b, #10ff98);
    box-shadow: 0 4px 12px rgba(79, 209, 139, 0.4);
  }

  .nav-btn.skip-btn {
    color: rgba(255, 255, 255, 0.5);
    border-color: rgba(255, 255, 255, 0.1);
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  @keyframes slideIn {
    from {
      transform: translateY(-30px) scale(0.95);
      opacity: 0;
    }
    to {
      transform: translateY(0) scale(1);
      opacity: 1;
    }
  }
</style>
