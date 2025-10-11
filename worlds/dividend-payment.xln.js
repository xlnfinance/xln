/**
 * Quarterly Dividend Payment
 *
 * Public company distributes $500M to shareholders
 *
 * Demonstrates:
 * - Shareholder registry
 * - Pro-rata distribution
 * - Record date mechanics
 * - Payment batching
 */

export default {
  seed: 'quarterly-dividend-2024',
  title: 'Quarterly Dividend Distribution',
  description: 'MegaCorp pays $500M dividend to 1000 shareholders',

  frames: [
    {
      time: 0,
      title: 'MegaCorp Entity',
      narrative: 'Public company with 1000 shareholders, $10B market cap',
      actions: async (xln, env) => {
        await xln.createEntity({
          name: 'MegaCorp',
          validators: ['Board', 'CFO', 'Treasurer'],
          threshold: 2,
          reserves: { USDC: 2_000_000_000 },  // $2B cash reserves
          shares: {
            total: 10_000_000,
            holders: generateShareholders(1000)  // 1000 retail + institutional
          }
        });
      }
    },

    {
      time: 1,
      title: 'Board Proposes Dividend',
      narrative: 'Board votes to distribute $500M ($0.05/share)',
      camera: { mode: 'follow', focus: 'MegaCorp' },
      actions: async (xln, env) => {
        await xln.propose({
          entity: 'MegaCorp',
          proposer: 'Board',
          title: 'Q4 2024 Dividend - $0.05/share',
          actions: [{
            type: 'dividend',
            amountPerShare: 0.05,
            totalAmount: 500_000_000,
            recordDate: Date.now(),
            paymentDate: Date.now() + 30 * 86400000  // 30 days
          }]
        });
      }
    },

    {
      time: 3,
      title: 'CFO Approves',
      narrative: 'CFO verifies reserves sufficient ($2B > $500M)',
      actions: async (xln, env) => {
        await xln.vote({
          entity: 'MegaCorp',
          proposalId: 1,
          voter: 'CFO',
          choice: 'YES'
        });
        // Reaches quorum (2/3), auto-executes
      }
    },

    {
      time: 5,
      title: 'Payment Processing',
      narrative: 'XLN batches 1000 payments into ONE entity frame',
      camera: { mode: 'overview', zoom: 3.0 },
      actions: async (xln, env) => {
        // Dividend payments execute atomically
        // All 1000 shareholders paid in single frame
        // Traditional system: 1000 separate ACH transfers
        // XLN: 1 frame, 1 state root, cryptographic proof
      }
    },

    {
      time: 10,
      title: 'Distribution Complete',
      narrative: '$500M distributed. Audit trail: board→CFO signatures, shareholder registry snapshot, payment proof.',
      actions: async (xln, env) => {
        const megacorp = env.getEntity('MegaCorp');

        // Verify reserves reduced
        xln.assert(megacorp.reserves.USDC === 1_500_000_000);

        // Verify all shareholders received payment
        const shareholders = megacorp.getShareholderRegistry();
        shareholders.forEach(holder => {
          const expectedDividend = holder.shares * 0.05;
          xln.assert(holder.received === expectedDividend);
        });
      }
    }
  ]
};

// Helper: Generate 1000 shareholders with Pareto distribution
function generateShareholders(count) {
  const holders = {};

  // Top 10 = 50% ownership (institutional)
  for (let i = 1; i <= 10; i++) {
    holders[`Institution${i}`] = 500_000;  // 5% each
  }

  // Next 90 = 30% ownership (large retail)
  for (let i = 11; i <= 100; i++) {
    holders[`Retail${i}`] = 33_333;  // 0.33% each
  }

  // Remaining 900 = 20% ownership (small retail)
  for (let i = 101; i <= 1000; i++) {
    holders[`Small${i}`] = 2_222;  // 0.02% each
  }

  return holders;
}
