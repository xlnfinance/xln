# XLN Scenario Embed System

YouTube-style embeddable 3D network visualizations for docs and external websites.

---

## Usage in XLN Docs

### ScenarioPlayer Component

```svelte
<script>
  import ScenarioPlayer from '$lib/components/Embed/ScenarioPlayer.svelte';
</script>

<ScenarioPlayer
  scenario="phantom-grid"
  height="500px"
  autoplay={true}
  loop={true}
  slice="0:3"
/>
```

### Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `scenario` | string | 'phantom-grid' | Scenario file name (without .scenario.txt) or inline SEED text |
| `width` | string | '100%' | Player width (CSS value) |
| `height` | string | '600px' | Player height (CSS value) |
| `autoplay` | boolean | true | Start playing automatically |
| `loop` | boolean | false | Loop back to start when done |
| `slice` | string | '' | Play subset of frames (e.g., "0:10") |
| `speed` | number | 1.0 | Playback speed multiplier |

### Examples

**Simple embed:**
```svelte
<ScenarioPlayer scenario="diamond-dybvig" />
```

**Looping intro (like in DocsView):**
```svelte
<ScenarioPlayer
  scenario="phantom-grid"
  height="400px"
  loop={true}
  slice="0:3"
/>
```

**Inline scenario:**
```svelte
<ScenarioPlayer
  scenario={`SEED custom-demo

0: Create Network
import alice, bob, hub

1: Payment
alice pay hub 100
`}
  height="300px"
/>
```

---

## External Website Embed (iframe)

### Basic Embed

```html
<iframe
  src="https://xln.finance/embed?scenario=phantom-grid"
  width="800"
  height="600"
  frameborder="0"
  allow="accelerometer; gyroscope; xr-spatial-tracking"
></iframe>
```

### With Options

```html
<iframe
  src="https://xln.finance/embed?scenario=diamond-dybvig&autoplay=true&loop=true&slice=0:5&speed=1.5"
  width="100%"
  height="500"
  style="border: 1px solid #ccc; border-radius: 8px;"
></iframe>
```

### URL Parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `scenario` | `phantom-grid` | Scenario name or base64 encoded inline scenario |
| `width` | `800px` or `100%` | Player width |
| `height` | `600px` | Player height |
| `autoplay` | `true` or `false` | Auto-start playback |
| `loop` | `true` or `false` | Loop playback |
| `slice` | `0:10` | Play frames 0-10 only |
| `speed` | `1.5` | Playback speed (0.5 = half speed, 2.0 = double speed) |

---

## Available Scenarios

Located in `/scenarios/`:

- **phantom-grid** - 2×2×2 cube grid (8 entities)
- **diamond-dybvig** - Bank run simulation
- **h-network** - H-shaped topology with hubs

---

## ScenarioPlayer Controls

The player includes YouTube-style controls:

**Playback:**
- ▶ Play / ⏸ Pause
- ↻ Restart
- Progress bar (click to seek)

**Options:**
- Loop checkbox
- Speed indicator

**Time Display:**
- Shows current frame / total frames
- Updates in real-time

---

## Creating Custom Scenarios

### Inline in Component

```svelte
<ScenarioPlayer
  scenario={`SEED my-demo

0: Setup
import alice, bob, charlie
grid 1 3 1

1: Payments
alice pay bob 100
bob pay charlie 50
`}
/>
```

### As Separate File

1. Create `/scenarios/my-scenario.scenario.txt`
2. Use: `<ScenarioPlayer scenario="my-scenario" />`

---

## GitHub Markdown (No iframe Support)

Use clickable thumbnail:

```markdown
[![XLN Network Demo](https://xln.finance/embed-thumbnail?scenario=phantom-grid)](https://xln.finance/embed?scenario=phantom-grid)

👆 Click to view interactive 3D visualization
```

---

## Integration in DocsView

The docs intro page automatically shows phantom-grid scenario:

```svelte
{#if currentDoc === 'README'}
  <ScenarioPlayer
    scenario="phantom-grid"
    height="500px"
    loop={true}
    slice="0:3"
  />
{/if}
```

To add more embedded scenarios in specific docs, update `loadDoc()` to inject ScenarioPlayer at specific positions.

---

## Theme Support

ScenarioPlayer automatically inherits app theme via CSS custom properties:
- `--bg` - Background
- `--bg-secondary` - Controls background
- `--text` - Text color
- `--text-secondary` - Muted text
- `--accent` - Progress bar, active states
- `--border` - Borders

Works with all themes: dark, light, retro, gruvbox, etc.

---

## Advanced: Programmatic Control

```svelte
<script>
  let playerRef;
</script>

<ScenarioPlayer bind:this={playerRef} scenario="demo" />

<button on:click={() => playerRef?.play()}>Play</button>
<button on:click={() => playerRef?.pause()}>Pause</button>
```

---

## Performance Notes

- Each ScenarioPlayer instance runs its own NetworkTopology
- Limit to 1-2 players visible at once for performance
- Use `slice` to show only relevant frames
- Pause automatically when scrolled out of view (future optimization)

---

## Next Steps

1. **Add more scenarios** to `/scenarios/`
2. **Embed in specific docs** - Add ScenarioPlayer to architecture docs
3. **Create thumbnail endpoint** - For GitHub markdown previews
4. **Add copy embed code** - Button to copy iframe snippet
5. **Lazy loading** - Only load when scrolled into view
