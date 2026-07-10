import { describe, expect, test } from 'bun:test';
import { deriveRcpanFinanceFrame, deriveFcuanFinanceFrame } from '../../frontend/src/lib/components/Rcpan/microscope-finance';
import { deriveRcpanMicroscopeFrame } from '../../frontend/src/lib/components/Rcpan/microscope-model';
import { cloneMicroscopeControls, type RcpanScenarioId } from '../../frontend/src/lib/components/Rcpan/microscope-playground';
import { deriveMicroscopeTimeline, phaseStartMs, type RcpanMicroscopePhase } from '../../frontend/src/lib/components/Rcpan/microscope-timeline';
import { RCPAN_MICROSCOPE_TOKENS } from '../../frontend/src/lib/components/Rcpan/microscope-tokens';

const BASE_MS = 1_000;
const USDC = RCPAN_MICROSCOPE_TOKENS[0]!;

function timeline(
  scenario: RcpanScenarioId,
  phase: RcpanMicroscopePhase,
  offsetMs = 0,
) {
  const elapsed = phaseStartMs(scenario, phase, BASE_MS, scenario) + offsetMs;
  return deriveMicroscopeTimeline(elapsed, BASE_MS, scenario);
}

describe('RCPAN account microscope finance', () => {
  test('uses canonical offdelta for a right-to-left payment', () => {
    const state = timeline('reserve-backed', 'signed');
    const rcpan = deriveRcpanFinanceFrame(USDC, state);
    const fcuan = deriveFcuanFinanceFrame(USDC, state);

    expect(rcpan.displayDelta.ondelta).toBe(0n);
    expect(rcpan.displayDelta.offdelta).toBe(USDC.grossAmount);
    expect(rcpan.derived.outCollateral).toBe(USDC.grossAmount * 70n / 100n);
    expect(rcpan.derived.outPeerCredit).toBe(USDC.grossAmount * 30n / 100n);
    expect(fcuan.displayDelta.collateral).toBe(0n);
    expect(fcuan.derived.outPeerCredit).toBe(USDC.grossAmount);
  });

  test('scenario 1 pays entirely from collateral and leaves H1 reserve untouched', () => {
    const frame = deriveRcpanFinanceFrame(USDC, timeline('full-collateral', 'settled'));
    expect(frame.initial.collateral).toBe(USDC.grossAmount);
    expect(frame.finalization.reservePaid.rightToLeft).toBe(0n);
    expect(frame.finalization.newDebt.rightToLeft).toBe(0n);
    expect(frame.current.userReserve).toBe(USDC.userReserve + USDC.grossAmount);
    expect(frame.current.hubReserve).toBe(USDC.hubReserve);
    expect(frame.current.collateral).toBe(0n);
  });

  test('scenario 2 pays 70% collateral and 30% H1 reserve', () => {
    const frame = deriveRcpanFinanceFrame(USDC, timeline('reserve-backed', 'settled'));
    expect(frame.initial.collateral).toBe(USDC.grossAmount * 70n / 100n);
    expect(frame.finalization.reservePaid.rightToLeft).toBe(USDC.grossAmount * 30n / 100n);
    expect(frame.finalization.newDebt.rightToLeft).toBe(0n);
    expect(frame.current.userReserve).toBe(USDC.userReserve + USDC.grossAmount);
    expect(frame.current.hubReserve).toBe(USDC.hubReserve - USDC.grossAmount * 30n / 100n);
  });

  test('scenario 3 queues debt, then tops reserve up, then enforces it', () => {
    const settled = deriveRcpanFinanceFrame(USDC, timeline('debt-recovery', 'settled'));
    const halfTopUp = deriveRcpanFinanceFrame(USDC, timeline('debt-recovery', 'treasury-topup', 500));
    const halfEnforced = deriveRcpanFinanceFrame(USDC, timeline('debt-recovery', 'debt-enforcement', 500));
    const repaid = deriveRcpanFinanceFrame(USDC, timeline('debt-recovery', 'repaid'));
    const expectedDebt = USDC.grossAmount * 35n / 100n;

    expect(settled.initial.collateral).toBe(USDC.grossAmount * 30n / 100n);
    expect(settled.finalization.reservePaid.rightToLeft).toBe(expectedDebt);
    expect(settled.current.debt).toBe(expectedDebt);
    expect(halfTopUp.current.hubReserve).toBe(expectedDebt / 2n);
    expect(halfTopUp.current.debt).toBe(expectedDebt);
    expect(halfEnforced.current.debt).toBe(expectedDebt / 2n);
    expect(halfEnforced.current.userReserve).toBe(settled.current.userReserve + expectedDebt / 2n);
    expect(repaid.current.debt).toBe(0n);
    expect(repaid.current.userReserve).toBe(USDC.userReserve + USDC.grossAmount);
  });

  test('supports one through four independent token lanes', () => {
    for (let tokenCount = 1; tokenCount <= 4; tokenCount += 1) {
      const controls = { ...cloneMicroscopeControls(), tokenCount, scenarioMode: 'reserve-backed' as const };
      const display = deriveRcpanMicroscopeFrame(timeline('reserve-backed', 'settled'), controls);
      expect(display.rcpan.account.lanes).toHaveLength(tokenCount);
      expect(display.rcpan.court.rows).toHaveLength(tokenCount);
      expect(display.metrics.allTokensConserved).toBe(true);
    }
  });

  test('payment changes the edge but not reserve-scaled nodes', () => {
    const controls = { ...cloneMicroscopeControls(), scenarioMode: 'full-collateral' as const };
    const payment = deriveRcpanMicroscopeFrame(timeline('full-collateral', 'payment', 500), controls);
    const signed = deriveRcpanMicroscopeFrame(timeline('full-collateral', 'signed'), controls);
    const settled = deriveRcpanMicroscopeFrame(timeline('full-collateral', 'settled'), controls);

    expect(payment.rcpan.account.left.reserveRadiusPx).toBe(signed.rcpan.account.left.reserveRadiusPx);
    expect(payment.rcpan.account.right.reserveRadiusPx).toBe(signed.rcpan.account.right.reserveRadiusPx);
    expect(settled.rcpan.account.left.reserveRadiusPx).toBeGreaterThan(signed.rcpan.account.left.reserveRadiusPx);
    expect(settled.rcpan.account.right.reserveRadiusPx).toBe(signed.rcpan.account.right.reserveRadiusPx);
  });

  test('packet duration and custom palette controls affect the rendered model', () => {
    const state = timeline('full-collateral', 'payment', 500);
    const fastControls = {
      ...cloneMicroscopeControls(),
      scenarioMode: 'full-collateral' as const,
      tokenCount: 1,
      packetMs: 300,
    };
    const slowControls = {
      ...fastControls,
      packetMs: 2_200,
      colorMode: 'custom' as const,
      palette: {
        ...fastControls.palette,
        proof: '#12ab34',
        danger: '#d01234',
        user: '#1234ab',
        hub: '#34ab12',
        court: '#ab7812',
      },
    };
    const fast = deriveRcpanMicroscopeFrame(state, fastControls);
    const slow = deriveRcpanMicroscopeFrame(state, slowControls);

    expect(fast.rcpan.account.lanes[0]!.payment.progressPercent)
      .toBeLessThan(slow.rcpan.account.lanes[0]!.payment.progressPercent);
    expect(slow.rcpan.account.left.color).toBe('#1234ab');
    expect(slow.rcpan.account.right.color).toBe('#34ab12');
    expect(slow.rcpan.account.palette.proof).toBe('#12ab34');
    expect(slow.rcpan.account.palette.danger).toBe('#d01234');
    expect(slow.rcpan.court.color).toBe('#ab7812');
    expect(slow.fcuan.court.machineLabel).toContain('Jurisdiction-machine');
    expect(slow.rcpan.account.left.reserveCaption).toBe('Size follows liquid reserves');
  });
});
