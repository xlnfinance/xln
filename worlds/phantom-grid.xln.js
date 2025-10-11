/**
 * Phantom Grid - Minimal 2×2×2 Cube Demo
 *
 * Shows:
 * - 3D grid topology
 * - Random payment flows
 * - Network dynamics
 */

export default {
  seed: 'phantom-grid-simple',
  title: 'Phantom Grid',
  description: 'A 2×2×2 cube where value flows through 3D space',

  frames: [
    {
      time: 0,
      title: 'Genesis',
      narrative: 'A perfect cube materializes',
      actions: async (xln, env) => {
        // Create 2×2×2 grid (8 entities)
        await xln.grid(2, 2, 2);
      }
    },

    {
      time: 1,
      title: 'Corner Pulse',
      narrative: 'Energy flows from corners to center',
      actions: async (xln, env) => {
        await xln.payRandom({
          count: 4,
          minHops: 1,
          maxHops: 3,
          minAmount: 50000,
          maxAmount: 100000,
          token: 1
        });
      }
    },

    {
      time: 2,
      title: 'Random Flow',
      narrative: 'Spontaneous transactions across the manifold',
      actions: async (xln, env) => {
        await xln.payRandom({
          count: 8,
          minHops: 0,
          maxHops: 5,
          minAmount: 10000,
          maxAmount: 50000,
          token: 1
        });
      }
    },

    {
      time: 3,
      title: 'Convergence',
      narrative: 'The grid finds harmonic equilibrium',
      camera: { mode: 'orbital', zoom: 1.5 },
      actions: async (xln, env) => {
        // No actions - just observe
      }
    }
  ]
};
