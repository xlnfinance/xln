#!/usr/bin/env bun
import { safeStringify } from '../../core/protocol/serialization';
import { readRoundtripArguments } from './usdc-reserve-roundtrip/inputs';
import { runUsdcReserveRoundtrip } from './usdc-reserve-roundtrip/runner';
import type { RoundtripEvidence } from './usdc-reserve-roundtrip/types';

export { runUsdcReserveRoundtrip } from './usdc-reserve-roundtrip/runner';

const reportValues = (report: RoundtripEvidence) => ({
  ...report,
  amount: report.amount.toString(),
  snapshots: Object.fromEntries(
    Object.entries(report.snapshots).map(([stage, value]) => [
      stage,
      {
        ...value,
        token: value.token.toString(),
        reserve: value.reserve.toString(),
        nativeWei: value.nativeWei.toString(),
        debt: value.debt.toString(),
        entityNonce: value.entityNonce.toString(),
        allowance: value.allowance.toString(),
      },
    ]),
  ),
  ...(report.native
    ? {
        native: {
          feesWei: report.native.feesWei.toString(),
          deltaWei: report.native.deltaWei.toString(),
          unaccountedDeltaWei: report.native.unaccountedDeltaWei.toString(),
        },
      }
    : {}),
});

if (import.meta.main) {
  try {
    const report = await runUsdcReserveRoundtrip(readRoundtripArguments(process.argv.slice(2)));
    process.stdout.write(`${safeStringify(reportValues(report), 2)}\n`);
    if (report.status !== 'complete') process.exitCode = 1;
  } catch {
    process.stderr.write('USDC_ROUNDTRIP_INVALID_ARGUMENTS\n');
    process.exitCode = 1;
  }
}
