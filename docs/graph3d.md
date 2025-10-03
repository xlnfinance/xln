# xln Graph3D Embeddable Component

## Overview

The xln Graph3D component is a self-contained, embeddable 3D network visualization that can be injected into any website with a single `<script>` tag, similar to YouTube embeds.

## Quick Start

```html
<!-- Single line embed -->
<script src="https://xln.finance/embed.js"></script>
<xln-graph scenario="diamond-dybvig" loop="5:15" width="800px" height="600px"></xln-graph>
```

## Web Component API

### Element: `<xln-graph>`

A custom HTML element that renders xln network topology in 3D.

#### Attributes

```html
<xln-graph
  scenario="string"           # Scenario ID or base64-encoded scenario text
  loop="start:end"           # Frame range to loop (optional)
  camera="orbital|overview"  # Initial camera mode (default: orbital)
  width="800px"              # Container width (default: 100%)
  height="600px"             # Container height (default: 600px)
  autoplay="true|false"      # Auto-start playback (default: true)
  controls="true|false"      # Show sidebar controls (default: false for embeds)
  speed="0.5|1.0|2.0"       # Playback speed multiplier (default: 1.0)
  theme="dark|light"         # Visual theme (default: dark)
></xln-graph>
```

#### Scenario Attribute Modes

**1. Named Scenario (fetch from xln.finance)**
```html
<xln-graph scenario="diamond-dybvig"></xln-graph>
```
Fetches `/scenarios/diamond-dybvig.scenario.txt` from xln.finance

**2. Base64 Encoded Scenario (self-contained)**
```html
<xln-graph scenario="U0VFRCBteS1zY2VuYXJpbwowOiBHZW5lc2lz..."></xln-graph>
```
Decodes and executes embedded scenario

**3. URL Scenario (external)**
```html
<xln-graph scenario-url="https://example.com/my-scenario.txt"></xln-graph>
```
Fetches scenario from arbitrary URL

### JavaScript API

```javascript
// Get component reference
const graph = document.querySelector('xln-graph');

// Programmatic control
graph.play();
graph.pause();
graph.goToFrame(10);
graph.setCamera('orbital');
graph.exportImage(); // Returns PNG blob
graph.getState(); // Returns current frame data

// Events
graph.addEventListener('framechange', (e) => {
  console.log('Now at frame:', e.detail.frameIndex);
});

graph.addEventListener('scenariocomplete', (e) => {
  console.log('Scenario finished');
});
```

## Entity Formation Modes

### Manual Positioning

Scenario can specify exact entity positions:

```
0: Custom Formation
import 1..5
VIEW entity_positions="1:-50,0,0;2:0,50,0;3:0,-50,0;4:50,50,0;5:50,-50,0"
```

This creates 5 entities at fixed (x,y,z) coordinates in 3D space.

### ASCII Text Formation (Tool-Generated)

A sidebar tool converts ASCII art to scenario:

**Input:**
```
 x   l   n
xxx  l   n n
 x   lll n n
```

**Generated Scenario:**
```
SEED ascii-xln

0: Text Formation
Entities positioned to form "xln"
import 1..19

1: Connect entities to form structure
VIEW entity_positions="1:-100,50,0;2:-100,0,0;3:-100,-50,0;4:-75,50,0;5:-75,-50,0;6:-50,50,0;7:-25,0,0;8:-25,50,0;9:-25,-50,0;10:0,0,0;11:0,50,0;12:25,0,0;13:50,50,0;14:50,0,0;15:50,-50,0;16:75,50,0;17:75,0,0;18:75,-50,0;19:100,0,0"

2: Link structure with accounts
1 openAccount 2
2 openAccount 3
# ... connections to make letters stable
```

**ASCII Tool Features:**
- Text input: User types "xln" or multi-line ASCII art
- Font selector: Mono, Sans, Serif (affects spacing)
- Scale slider: Controls entity spacing (10-500px)
- Generate button: Creates scenario text
- Preview: Shows entity positions in 2D grid
- Export: Copies scenario to clipboard

### Molecule Formation (Future)

**Input:** PDB/MOL2 file or SMILES string
```
FORMATION molecule
SOURCE ketamine.pdb
SCALE 50
```

**Generated:** Entity per atom, accounts for bonds

## Embedding Architecture

### File Structure

```
xln.finance/
  embed.js          # Web component loader (5KB gzipped)
  graph-bundle.js   # Full graph component (200KB gzipped)
  scenarios/        # Public scenario library
    diamond-dybvig.scenario.txt
    lightning-capacity.scenario.txt
    ...
```

### embed.js Implementation

```javascript
// xln.finance/embed.js
(function() {
  // Define <xln-graph> custom element
  class XLNGraph extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      this.render();
    }

    async render() {
      const scenario = this.getAttribute('scenario');
      const loop = this.getAttribute('loop');
      const width = this.getAttribute('width') || '100%';
      const height = this.getAttribute('height') || '600px';

      // Create iframe to sandbox xln runtime
      const iframe = document.createElement('iframe');
      iframe.style.width = width;
      iframe.style.height = height;
      iframe.style.border = 'none';
      iframe.style.borderRadius = '8px';

      // Build iframe src with parameters
      const params = new URLSearchParams({
        scenario,
        loop: loop || '',
        embed: 'true'
      });

      iframe.src = `https://xln.finance/embed.html?${params}`;

      this.shadowRoot.appendChild(iframe);
    }
  }

  customElements.define('xln-graph', XLNGraph);
})();
```

### Embed Page (xln.finance/embed.html)

Minimal page that:
1. Loads full xln runtime
2. Parses URL params
3. Executes scenario
4. Renders graph only (no sidebar if `embed=true`)
5. Enables loop mode automatically

## ASCII-to-Scenario Tool Specification

### UI Location

Graph sidebar, below "Slice & Export"

### Interface

```
┌─ ASCII to Scenario ────────────────┐
│                                    │
│ ┌────────────────────────────────┐ │
│ │  x   l   n                     │ │
│ │ xxx  l   n n                   │ │
│ │  x   lll n n                   │ │
│ └────────────────────────────────┘ │
│                                    │
│ Font: [Mono ▼] Scale: [100px]     │
│                                    │
│ [Generate Scenario]                │
│                                    │
│ Preview: 19 entities, 8 connections│
└────────────────────────────────────┘
```

### Algorithm

1. **Parse ASCII Grid**
   ```typescript
   function parseASCII(text: string): Position[] {
     const lines = text.split('\n');
     const positions: Position[] = [];

     lines.forEach((line, y) => {
       [...line].forEach((char, x) => {
         if (char !== ' ') {
           positions.push({ x, y, char });
         }
       });
     });

     return positions;
   }
   ```

2. **Convert to 3D Coordinates**
   ```typescript
   function toWorldCoords(
     positions: Position[],
     scale: number
   ): EntityPosition[] {
     // Center the text
     const centerX = positions.reduce((sum, p) => sum + p.x, 0) / positions.length;
     const centerY = positions.reduce((sum, p) => sum + p.y, 0) / positions.length;

     return positions.map((p, i) => ({
       id: i + 1,
       x: (p.x - centerX) * scale,
       y: (centerY - p.y) * scale, // Flip Y for screen coords
       z: 0
     }));
   }
   ```

3. **Generate Connections**
   ```typescript
   function generateConnections(positions: EntityPosition[]): Connection[] {
     const connections: Connection[] = [];

     // Connect adjacent entities (4-way: up, down, left, right)
     positions.forEach((p1, i) => {
       positions.forEach((p2, j) => {
         if (i >= j) return;

         const dx = Math.abs(p1.x - p2.x);
         const dy = Math.abs(p1.y - p2.y);
         const distance = Math.sqrt(dx*dx + dy*dy);

         // Connect if distance ≈ 1 grid unit
         if (distance < scale * 1.5) {
           connections.push({ from: p1.id, to: p2.id });
         }
       });
     });

     return connections;
   }
   ```

4. **Build Scenario**
   ```typescript
   function buildScenario(
     positions: EntityPosition[],
     connections: Connection[]
   ): string {
     const lines: string[] = [];

     lines.push(`SEED ascii-${Date.now()}`);
     lines.push('');
     lines.push('0: Formation');
     lines.push('Entities positioned in ASCII pattern');
     lines.push(`import 1..${positions.length}`);

     // Encode positions as VIEW param
     const posStr = positions
       .map(p => `${p.id}:${p.x},${p.y},${p.z}`)
       .join(';');
     lines.push(`VIEW entity_positions="${posStr}"`);
     lines.push('');
     lines.push('===');
     lines.push('');
     lines.push('1: Link Structure');
     lines.push('Accounts form the text shape');

     connections.forEach(c => {
       lines.push(`${c.from} openAccount ${c.to}`);
     });

     return lines.join('\n');
   }
   ```

### Example Transformations

**Input:** "xln"
**Output:** 19 entities positioned as:
```
Entity 1-3: 'x' left diagonal
Entity 4-5: 'x' right diagonal
Entity 6: 'x' center
Entity 7-11: 'l' vertical + base
Entity 12-19: 'n' verticals + bridge
```

**Input:** Custom ASCII
```
   O
  /|\
 / | \
```
**Output:** Tree structure with 7 entities, 6 connections

## Formation Coordinate System

### World Space

- Origin: (0, 0, 0) at network center
- X-axis: Left (-) to Right (+)
- Y-axis: Down (-) to Up (+)
- Z-axis: Back (-) to Front (+)
- Units: Pixels in 3D space

### Entity Positioning via VIEW

```
VIEW entity_positions="1:x,y,z;2:x,y,z;..."
```

Overrides force-directed layout for specified entities. Unspecified entities use default physics.

### Pinning Behavior

Positioned entities are "pinned" (fixed in space, not affected by simulation). Connections to them remain elastic.

## Use Cases

### 1. Educational Embeds

Blog posts explaining Diamond-Dybvig with live interactive demo:

```html
<p>Here's a bank run in action:</p>
<xln-graph scenario="diamond-dybvig" loop="18:25" width="600px"></xln-graph>
<p>Notice how withdrawals cascade...</p>
```

### 2. Branding

Homepage hero with "xln" spelled out in entities:

```html
<xln-graph
  scenario="ascii-xln-logo"
  camera="orbital"
  autoplay="true"
  width="100%"
  height="400px"
></xln-graph>
```

### 3. Research Papers

Academic papers embedding exact reproductions:

```html
<xln-graph
  scenario="<base64-encoded-experiment>"
  loop="0:100"
></xln-graph>
```

Readers can verify results by replaying the exact state sequence.

### 4. Social Media

Twitter/X posts with embedded network visualizations:

```html
<!-- Shareable card -->
<xln-graph
  scenario="liquidity-crisis"
  loop="10:20"
  width="500px"
  height="400px"
  controls="false"
></xln-graph>
```

## Implementation Roadmap

### Phase 1: Core Component (Current Session)
- [x] Scenario system with parser/executor
- [x] Base64 URL encoding
- [ ] Web component wrapper
- [ ] Embed page template

### Phase 2: ASCII Tool (Current Session)
- [ ] Text input UI in sidebar
- [ ] ASCII → entity positions parser
- [ ] Connection graph generator
- [ ] Scenario text builder
- [ ] Copy to clipboard

### Phase 3: Advanced Features (Future)
- [ ] Molecule formation (PDB/MOL2 import)
- [ ] Custom shapes library (star, circle, grid)
- [ ] Animation keyframes (rotate formation over time)
- [ ] Multi-layer formations (3D depth)

## Technical Considerations

### Browser Compatibility

Web Components supported in:
- Chrome/Edge 67+
- Firefox 63+
- Safari 10.1+
- All modern browsers (95%+ coverage)

### Performance

- Lazy-load Three.js (only when component visible)
- Use IntersectionObserver for autoplay
- Limit to 100 entities per embed (performance)
- Debounce position updates

### Security

- Iframe sandbox prevents script injection
- CSP headers restrict resource loading
- Scenario validation before execution
- Rate limit scenario fetches

## ASCII Formation Examples

### Simple Text

**Input:**
```
xln
```

**Generates:** 3 letter formations, ~19 entities

### Multi-Line

**Input:**
```
BANK
RUN!
```

**Generates:** 2 rows, ~32 entities

### Shapes

**Input:**
```
    *
   ***
  *****
 *******
*********
```

**Generates:** Triangle with 25 entities

### Complex

**Input:**
```
  O     O
   \   /
    \ /
     V
    / \
   /   \
  O     O
```

**Generates:** Network diagram with 7 nodes, 8 edges

## Molecule Formation Specification

### Supported Formats

1. **PDB (Protein Data Bank)**
   - Standard atomic coordinates
   - Widely used for proteins, molecules
   - Example: ketamine.pdb

2. **MOL2 (Tripos)**
   - Molecular structure with bonds
   - Includes bond types (single, double, triple)

3. **XYZ (Simple)**
   - Atom symbol + coordinates
   - Minimal format

4. **SMILES (String)**
   - Chemical structure notation
   - Requires 3D coordinate generation (RDKit)

### PDB Parsing

```
ATOM      1  C   KET     1      -1.234   0.567  -2.345  1.00  0.00           C
ATOM      2  N   KET     1       0.123  -1.234   1.567  1.00  0.00           N
```

Maps to:
```typescript
interface Atom {
  id: number;
  element: 'C' | 'N' | 'O' | ...;
  x: number;
  y: number;
  z: number;
}
```

### Molecule → Scenario

```
SEED ketamine-molecule

0: Molecule Formation
13 atoms form ketamine structure
import 1..13
VIEW entity_positions="1:-12.34,5.67,-23.45;2:1.23,-12.34,15.67;..."

1: Covalent Bonds
Atoms connect via accounts
1 openAccount 2
2 openAccount 3
# ... bonds from PDB CONECT records
```

### Atom Type Mapping

```typescript
const ATOM_COLORS: Record<string, number> = {
  C: 0x909090, // Carbon - gray
  N: 0x3050F8, // Nitrogen - blue
  O: 0xFF0D0D, // Oxygen - red
  H: 0xFFFFFF, // Hydrogen - white
  S: 0xFFFF30, // Sulfur - yellow
  P: 0xFF8000, // Phosphorus - orange
};
```

Each atom becomes an entity with color-coded sphere.

## Advanced: Formation Animations

### Rotating Text

```
0: Initial formation
import 1..19
VIEW entity_positions="..."

10: Rotation begins
VIEW entity_positions="..." rotation_y=0

20: 90 degrees
VIEW entity_positions="..." rotation_y=90

30: 180 degrees
VIEW entity_positions="..." rotation_y=180
```

### Morphing Shapes

```
0: Form "xln"
VIEW entity_positions="..."

30: Morph to triangle
VIEW entity_positions="..." transition_duration=5

60: Morph to circle
VIEW entity_positions="..." transition_duration=5
```

## Best Practices

### For Embeds

1. **Keep it simple**: Use named scenarios, not base64
2. **Set dimensions**: Always specify width/height
3. **Disable controls**: `controls="false"` for cleaner embeds
4. **Short loops**: 5-20 frames ideal for attention span
5. **Autoplay with caution**: Consider user's data/CPU

### For ASCII Formation

1. **Start small**: Test with 3-5 char words first
2. **Monospace fonts**: Ensures predictable grid
3. **Connect wisely**: Don't connect every entity (cluttered)
4. **Add semantics**: Use accounts to represent relationships

### For Sharing

1. **Use base64 for experiments**: Ensures reproducibility
2. **Use named for education**: Easier to reference
3. **Include loop param**: Highlights key moments
4. **Set camera wisely**: `orbital` for overview, `follow` for focus

## Future Enhancements

1. **Formation Library**
   - Pre-made shapes: star, grid, helix, lattice
   - One-click apply

2. **Interactive Formation Editor**
   - Drag entities in 3D space
   - Auto-generate scenario positions
   - Real-time preview

3. **Video Export**
   - Render scenario to MP4
   - Share on social media
   - Embed in presentations

4. **Collaborative Scenarios**
   - Fork and remix others' scenarios
   - Version control for scenarios
   - Community voting/curation

5. **AI Scenario Generation**
   - "Generate a bank run with 20 entities"
   - GPT creates scenario text
   - User reviews and executes
