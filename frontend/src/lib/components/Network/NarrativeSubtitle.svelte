<script lang="ts">
  import { currentTimeIndex, isLive } from '../../stores/timeStore';
  import { history } from '../../stores/xlnStore';
  import { fade, fly } from 'svelte/transition';

  $: currentFrame = $isLive ? null : $history[$currentTimeIndex];
  $: hasNarrative = currentFrame?.title || currentFrame?.narrative;

  // Typewriter effect state
  let displayedTitle = '';
  let displayedNarrative = '';
  let titleComplete = false;
  let narrativeComplete = false;

  const CHAR_DELAY = 15; // ms per character (faster for readability)
  let activeIntervals: number[] = [];

  // Typewriter effect function
  function typewriterEffect(text: string, setter: (val: string) => void, onComplete: () => void): () => void {
    let charIndex = 0;
    setter('');

    const interval = setInterval(() => {
      if (charIndex < text.length) {
        setter(text.substring(0, charIndex + 1));
        charIndex++;
      } else {
        clearInterval(interval);
        onComplete();
      }
    }, CHAR_DELAY);

    activeIntervals.push(interval as unknown as number);
    return () => clearInterval(interval);
  }

  // Cleanup function
  function cleanup() {
    activeIntervals.forEach(id => clearInterval(id));
    activeIntervals = [];
  }

  // React to frame changes
  $: {
    cleanup();

    if (currentFrame) {
      titleComplete = false;
      narrativeComplete = false;

      if (currentFrame.title) {
        typewriterEffect(
          currentFrame.title,
          (val) => displayedTitle = val,
          () => {
            titleComplete = true;
            // Start narrative after title completes
            if (currentFrame.narrative && currentFrame.narrative.length > 0) {
              setTimeout(() => {
                typewriterEffect(
                  currentFrame.narrative,
                  (val) => displayedNarrative = val,
                  () => narrativeComplete = true
                );
              }, 100);
            }
          }
        );
      } else if (currentFrame.narrative && currentFrame.narrative.length > 0) {
        // No title, start narrative immediately
        typewriterEffect(
          currentFrame.narrative,
          (val) => displayedNarrative = val,
          () => narrativeComplete = true
        );
      }
    } else {
      displayedTitle = '';
      displayedNarrative = '';
      titleComplete = false;
      narrativeComplete = false;
    }
  }
</script>

{#if hasNarrative}
  <div class="narrative-overlay" transition:fade={{ duration: 300 }}>
    {#if currentFrame?.title}
      <h2 class="narrative-title" transition:fly={{ y: -20, duration: 400 }}>
        {displayedTitle}<span class="cursor" class:blink={!titleComplete}>|</span>
      </h2>
    {/if}

    {#if currentFrame?.narrative && (titleComplete || !currentFrame?.title)}
      <p class="narrative-text" transition:fly={{ y: 20, duration: 400, delay: 100 }}>
        {displayedNarrative}<span class="cursor" class:blink={!narrativeComplete}>|</span>
      </p>
    {/if}
  </div>
{/if}

<style>
  .narrative-overlay {
    position: fixed;
    bottom: 100px; /* Above time machine */
    left: 50%;
    transform: translateX(-50%);
    max-width: 800px;
    padding: 20px 30px;
    background: rgba(0, 0, 0, 0.85);
    border: 2px solid #007acc;
    border-radius: 12px;
    backdrop-filter: blur(10px);
    z-index: 100;
    pointer-events: none; /* Don't block interaction */
  }

  .narrative-title {
    font-size: 24px;
    font-weight: 700;
    color: #00d9ff;
    margin: 0 0 12px 0;
    text-align: center;
    text-shadow: 0 0 20px rgba(0, 217, 255, 0.5);
  }

  .narrative-text {
    font-size: 16px;
    color: #e8e8e8;
    margin: 0;
    text-align: center;
    line-height: 1.6;
  }

  /* Typewriter cursor */
  .cursor {
    color: #00d9ff;
    font-weight: normal;
    opacity: 0;
  }

  .cursor.blink {
    animation: blink 0.8s infinite;
    opacity: 1;
  }

  @keyframes blink {
    0%, 49% { opacity: 1; }
    50%, 100% { opacity: 0; }
  }

  /* Cinematic subtitle style */
  @media (max-width: 768px) {
    .narrative-overlay {
      max-width: 90%;
      padding: 15px 20px;
      bottom: 80px;
    }

    .narrative-title {
      font-size: 20px;
    }

    .narrative-text {
      font-size: 14px;
    }
  }
</style>
