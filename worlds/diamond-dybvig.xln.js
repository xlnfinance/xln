/**
 * Diamond-Dybvig Bank Run Scenario
 *
 * Demonstrates classic bank run dynamics:
 * - Fractional reserve banking
 * - Coordinated withdrawals
 * - Liquidity crisis
 * - System collapse
 */

export default {
  seed: 'diamond-dybvig-2024',
  title: 'Diamond-Dybvig Bank Run',
  description: 'Classic demonstration of fractional reserve fragility',

  frames: [
    {
      time: 0,
      title: 'A Bank Is Born',
      narrative: 'Six entities: one bank, five depositors',
      actions: async (xln, env) => {
        // Import 6 entities (1=bank, 2-6=depositors)
        await xln.import([1, 2, 3, 4, 5, 6]);
      }
    },

    {
      time: 1,
      title: 'Accounts Open',
      narrative: 'The bank establishes bilateral relationships with all depositors',
      actions: async (xln, env) => {
        // Depositors 2-6 open accounts with bank (entity 1)
        for (let depositor = 2; depositor <= 6; depositor++) {
          await xln.openAccount(depositor, 1);
        }
      }
    },

    {
      time: 5,
      title: 'First Deposits',
      narrative: 'Trust begins. Customers deposit their savings.',
      camera: { mode: 'orbital', zoom: 1.5, focus: 1 },
      actions: async (xln, env) => {
        await xln.deposit(2, 1, 500);
        await xln.deposit(3, 1, 500);
      }
    },

    {
      time: 8,
      title: 'More Capital Flows In',
      narrative: 'Growing confidence. More depositors join.',
      actions: async (xln, env) => {
        await xln.deposit(4, 1, 300);
        await xln.deposit(5, 1, 400);
        await xln.deposit(6, 1, 300);
      }
    },

    {
      time: 12,
      title: 'The Bank Lends',
      narrative: 'Fractional reserve begins. 80% deployed, 20% held.',
      camera: { mode: 'overview', zoom: 2.0 },
      actions: async (xln, env) => {
        // Bank transfers 800 to entity 2 (lending operation)
        await xln.transfer(1, 2, 800);
      }
    },

    {
      time: 18,
      title: 'First Withdrawal',
      narrative: 'One customer needs funds. Normal operations.',
      actions: async (xln, env) => {
        await xln.withdraw(2, 1, 250);
      }
    },

    {
      time: 20,
      title: 'Panic Spreads',
      narrative: 'Simultaneous withdrawals. The run begins.',
      camera: { mode: 'follow', focus: 1, zoom: 2.5, speed: 0.5 },
      actions: async (xln, env) => {
        await xln.withdraw(3, 1, 500);
        await xln.withdraw(4, 1, 300);
      }
    },

    {
      time: 22,
      title: 'Liquidity Crisis',
      narrative: 'Everyone rushes for the exits. Reserves depleting fast.',
      camera: { mode: 'orbital', zoom: 3.0 },
      actions: async (xln, env) => {
        await xln.withdraw(5, 1, 400);
        await xln.withdraw(6, 1, 300);
      }
    },

    {
      time: 25,
      title: 'Aftermath',
      narrative: 'The fragility of fractional reserve, revealed.',
      camera: { mode: 'overview', zoom: 1.0, speed: 1.0 },
      actions: async (xln, env) => {
        // No actions - just observe the state
      }
    }
  ]
};
