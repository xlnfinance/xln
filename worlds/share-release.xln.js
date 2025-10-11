/**
 * Employee Share Release (Vesting Schedule)
 *
 * Demonstrates:
 * - Token issuance
 * - Time-based vesting
 * - Cliff + linear release
 * - Secondary market trading
 */

export default {
  seed: 'startup-vesting-2024',
  title: 'Employee Share Vesting',
  description: 'Startup issues shares to employees with 1-year cliff + 4-year vest',

  frames: [
    {
      time: 0,
      title: 'Company Formation',
      narrative: 'TechCorp issues 10M shares to founders',
      actions: async (xln, env) => {
        // Entity 1 = TechCorp (company)
        await xln.createEntity({
          name: 'TechCorp',
          validators: ['Founder1', 'Founder2'],
          threshold: 2,
          shares: {
            total: 10_000_000,
            holders: {
              'Founder1': 5_000_000,
              'Founder2': 5_000_000
            }
          }
        });

        // Entities 2-5 = Employees
        await xln.import(['Alice', 'Bob', 'Charlie', 'Diana']);
      }
    },

    {
      time: 1,
      title: 'Employee Option Grants',
      narrative: 'Each employee receives 100k options (1-year cliff, 4-year vest)',
      actions: async (xln, env) => {
        for (const employee of ['Alice', 'Bob', 'Charlie', 'Diana']) {
          await xln.grantOptions({
            company: 'TechCorp',
            recipient: employee,
            amount: 100_000,
            vestingSchedule: {
              cliff: 365,      // 1 year in days
              duration: 1460,  // 4 years total
              type: 'linear'
            }
          });
        }
      }
    },

    {
      time: 365,  // 1 year later
      title: 'Cliff Vesting',
      narrative: 'After 1 year, employees hit cliff - 25% of shares vest immediately',
      camera: { mode: 'follow', focus: 'Alice' },
      actions: async (xln, env) => {
        // Alice's 25k shares vest (25% of 100k)
        await xln.vestShares('Alice', 25_000);

        // Alice exercises options (converts to shares)
        await xln.exerciseOptions('Alice', 25_000, {
          strikePrice: 1.00,  // $1 per share
          payment: 25_000     // Pays company $25k
        });
      }
    },

    {
      time: 730,  // 2 years
      title: 'Year 2 Vesting',
      narrative: 'Another 25% vests for all employees',
      actions: async (xln, env) => {
        for (const employee of ['Alice', 'Bob', 'Charlie', 'Diana']) {
          await xln.vestShares(employee, 25_000);
          await xln.exerciseOptions(employee, 25_000, { strikePrice: 1.00 });
        }
      }
    },

    {
      time: 800,
      title: 'Secondary Market Trade',
      narrative: 'Alice sells 10k shares to external investor (Entity 6)',
      camera: { mode: 'orbital', zoom: 2.0 },
      actions: async (xln, env) => {
        await xln.createEntity({ name: 'VentureCapital' });

        // Alice transfers shares to VC
        await xln.transferShares({
          from: 'Alice',
          to: 'VentureCapital',
          company: 'TechCorp',
          amount: 10_000,
          price: 5.00  // $5/share (5x since grant)
        });

        // VC pays Alice $50k
        await xln.pay('VentureCapital', 'Alice', 50_000);
      }
    },

    {
      time: 1460,  // 4 years
      title: 'Full Vesting',
      narrative: 'All shares fully vested. Employees own 4% of company.',
      actions: async (xln, env) => {
        // Final 50% vests
        for (const employee of ['Alice', 'Bob', 'Charlie', 'Diana']) {
          await xln.vestShares(employee, 50_000);
        }

        // Verify ownership
        const company = env.getEntity('TechCorp');
        xln.assert(company.shares.Alice === 40_000);  // 50k granted - 10k sold
        xln.assert(company.shares.Bob === 100_000);
        xln.assert(company.shares.total === 10_400_000);  // Original 10M + 400k employee shares
      }
    }
  ]
};
