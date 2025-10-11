/**
 * Corporate Treasury Rebalancing
 *
 * Tesla diversifies $1B treasury across DeFi protocols
 *
 * Demonstrates:
 * - Multi-signature governance
 * - Proposal/voting system
 * - Batch treasury operations
 * - Risk committee oversight
 */

export default {
  seed: 'tesla-treasury-2024',
  title: 'Corporate Treasury Rebalancing',
  description: 'Tesla CFO rebalances $1B across Aave, Compound, Curve',

  frames: [
    {
      time: 0,
      title: 'Foundation Setup',
      narrative: 'Tesla treasury entity with multi-sig governance (CFO + Treasurer + Risk Committee)',
      actions: async (xln, env) => {
        // Entity 1 = Tesla (3 validators, 2/3 threshold)
        await xln.createEntity({
          name: 'Tesla Treasury',
          validators: ['CFO', 'Treasurer', 'RiskCommittee'],
          threshold: 2,
          reserves: { USDC: 10_000_000_000 } // $10B initial
        });

        // Entities 2-4 = DeFi protocols
        await xln.import(['Aave', 'Compound', 'Curve']);
      }
    },

    {
      time: 1,
      title: 'Open DeFi Accounts',
      narrative: 'Tesla establishes accounts with three major DeFi protocols',
      actions: async (xln, env) => {
        await xln.openAccount('Tesla', 'Aave');
        await xln.openAccount('Tesla', 'Compound');
        await xln.openAccount('Tesla', 'Curve');
      }
    },

    {
      time: 3,
      title: 'Diversification Proposal',
      narrative: 'CFO proposes: Allocate $1B to yield farming (40% Aave, 30% Compound, 30% Curve)',
      camera: { mode: 'follow', focus: 'Tesla', zoom: 2.0 },
      actions: async (xln, env) => {
        await xln.propose({
          entity: 'Tesla',
          proposer: 'CFO',
          title: 'Diversify $1B into DeFi',
          actions: [
            { type: 'transfer', to: 'Aave', amount: 400_000_000 },
            { type: 'transfer', to: 'Compound', amount: 300_000_000 },
            { type: 'transfer', to: 'Curve', amount: 300_000_000 }
          ]
        });
      }
    },

    {
      time: 5,
      title: 'Risk Committee Approves',
      narrative: 'Risk Committee reviews allocation, approves proposal',
      actions: async (xln, env) => {
        await xln.vote({
          entity: 'Tesla',
          proposalId: 1,
          voter: 'RiskCommittee',
          choice: 'YES'
        });
      }
    },

    {
      time: 7,
      title: 'Treasurer Signs',
      narrative: 'Treasurer adds second signature, reaching 2/3 quorum',
      actions: async (xln, env) => {
        await xln.vote({
          entity: 'Tesla',
          proposalId: 1,
          voter: 'Treasurer',
          choice: 'YES'
        });
        // Proposal auto-executes when quorum reached
      }
    },

    {
      time: 10,
      title: 'Atomic Execution',
      narrative: '$1B flows to three protocols in ONE XLN frame',
      camera: { mode: 'overview', zoom: 2.5 },
      actions: async (xln, env) => {
        // Actions execute automatically from approved proposal
        // This frame just shows the result
      }
    },

    {
      time: 15,
      title: 'Treasury Diversified',
      narrative: 'Cryptographic proof: CFO approved, Risk approved, Treasurer signed. Complete audit trail.',
      camera: { mode: 'orbital', zoom: 1.5 },
      actions: async (xln, env) => {
        // Verify final state
        const tesla = env.getEntity('Tesla');
        xln.assert(tesla.reserves.USDC === 9_000_000_000); // $9B remaining
        xln.assert(tesla.accounts.Aave.balance === -400_000_000);
        xln.assert(tesla.accounts.Compound.balance === -300_000_000);
        xln.assert(tesla.accounts.Curve.balance === -300_000_000);
      }
    }
  ]
};
