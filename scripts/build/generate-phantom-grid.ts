#!/usr/bin/env bun
/**
 * Generate PhantomGrid 10x10x10 scenario
 * 1000 entities in perfect cubic lattice
 */

function entityId(x: number, y: number, z: number): number {
  return z * 100 + y * 10 + x + 1;
}

const lines: string[] = [];

// Header
lines.push('SEED phantom-grid-1000');
lines.push('');
lines.push('0: Genesis');
lines.push('One thousand nodes materialize in the void');
lines.push('A perfect cube of pure potential');
lines.push('');

// Import all 1000 entities with positions
lines.push('# 10x10x10 cubic lattice (1000 entities)');
for (let z = 0; z < 10; z++) {
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const id = entityId(x, y, z);
      // Position in 3D space (40px spacing = 360px cube total)
      const px = (x - 4.5) * 40; // Center around origin, -180 to +180
      const py = (y - 4.5) * 40;
      const pz = (z - 4.5) * 40;
      lines.push(`import ${id} x=${px.toFixed(1)} y=${py.toFixed(1)} z=${pz.toFixed(1)}`);
    }
  }
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 1: Horizontal connections (x-axis)
lines.push('1: Horizontal Lattice');
lines.push('East-west bonds form across the grid');
lines.push('Layer by layer, the structure emerges');
lines.push('');
for (let z = 0; z < 10; z++) {
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 9; x++) { // x < 9 to avoid edge
      const e1 = entityId(x, y, z);
      const e2 = entityId(x + 1, y, z);
      lines.push(`${e1} openAccount ${e2}`);
    }
  }
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 2: Vertical connections (y-axis)
lines.push('2: Vertical Lattice');
lines.push('North-south pillars rise through layers');
lines.push('The cube gains height');
lines.push('');
for (let z = 0; z < 10; z++) {
  for (let y = 0; y < 9; y++) { // y < 9 to avoid edge
    for (let x = 0; x < 10; x++) {
      const e1 = entityId(x, y, z);
      const e2 = entityId(x, y + 1, z);
      lines.push(`${e1} openAccount ${e2}`);
    }
  }
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 3: Depth connections (z-axis)
lines.push('3: Depth Lattice');
lines.push('Planes connect through dimensional space');
lines.push('The PhantomGrid awakens');
lines.push('');
for (let z = 0; z < 9; z++) { // z < 9 to avoid edge
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < 10; x++) {
      const e1 = entityId(x, y, z);
      const e2 = entityId(x, y, z + 1);
      lines.push(`${e1} openAccount ${e2}`);
    }
  }
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 4: Corner to corner pulse
lines.push('4: Corner Cascade');
lines.push('Eight corners pulse toward center');
lines.push('Value flows through 27 hops');
lines.push('');
const corners = [
  entityId(0, 0, 0),   // 1
  entityId(9, 0, 0),   // 10
  entityId(0, 9, 0),   // 91
  entityId(9, 9, 0),   // 100
  entityId(0, 0, 9),   // 901
  entityId(9, 0, 9),   // 910
  entityId(0, 9, 9),   // 991
  entityId(9, 9, 9),   // 1000
];
const center = entityId(5, 5, 5); // 556

for (const corner of corners) {
  lines.push(`pay ${corner} ${center} 100000`);
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 5: Center radiation
lines.push('5: Central Radiation');
lines.push('The heart of the grid pulses outward');
lines.push('Energy radiates to all 8 corners');
lines.push('');
for (const corner of corners) {
  lines.push(`pay ${center} ${corner} 50000`);
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 6: Diagonal waves
lines.push('6: Diagonal Interference');
lines.push('Multiple wavefronts collide');
lines.push('Harmonic patterns emerge');
lines.push('');
// Send from 4 corners of bottom layer to 4 corners of top layer
lines.push(`pay ${entityId(0, 0, 0)} ${entityId(9, 9, 9)} 75000`);
lines.push(`pay ${entityId(9, 0, 0)} ${entityId(0, 9, 9)} 75000`);
lines.push(`pay ${entityId(0, 9, 0)} ${entityId(9, 0, 9)} 75000`);
lines.push(`pay ${entityId(9, 9, 0)} ${entityId(0, 0, 9)} 75000`);

lines.push('');
lines.push('===');
lines.push('');

// Frame 7: Edge spiral
lines.push('7: Edge Spiral');
lines.push('Current flows along the cube perimeter');
lines.push('Following the boundaries of space');
lines.push('');
// Spiral along edges: bottom square, up, top square, down
const edgeSequence = [
  entityId(0, 0, 0), entityId(9, 0, 0), entityId(9, 9, 0), entityId(0, 9, 0), // Bottom square
  entityId(0, 9, 9), // Up to top
  entityId(9, 9, 9), entityId(9, 0, 9), entityId(0, 0, 9), // Top square
  entityId(0, 0, 0), // Back to start
];
for (let i = 0; i < edgeSequence.length - 1; i++) {
  lines.push(`pay ${edgeSequence[i]} ${edgeSequence[i + 1]} 25000`);
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 8: Chaos
lines.push('8: Random Flow');
lines.push('Spontaneous transactions across the manifold');
lines.push('The grid achieves consciousness');
lines.push('');
// Random payments between random nodes
const randomPairs = [
  [127, 873], [234, 456], [789, 123], [555, 444],
  [999, 111], [333, 777], [666, 222], [888, 555],
  [100, 900], [200, 800], [300, 700], [400, 600],
];
for (const [from, to] of randomPairs) {
  lines.push(`pay ${from} ${to} 30000`);
}

lines.push('');
lines.push('===');
lines.push('');

// Frame 9: Harmonic convergence
lines.push('9: Harmonic Convergence');
lines.push('All nodes synchronize');
lines.push('PhantomGrid complete');
lines.push('VIEW camera=orbital zoom=2.0');
lines.push('');

const output = lines.join('\n');
console.log(output);

// Write to file
import { writeFileSync } from 'fs';
writeFileSync('./scenarios/phantom-grid.scenario.txt', output);
console.log('\n✅ Generated phantom-grid.scenario.txt (1000 entities, ~2700 connections)');
