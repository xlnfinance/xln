import type { HubChild } from '../orchestrator-types';
import { captureAuthorityEvidenceBase } from './authority-evidence-base';

export const completeResetStartup = async (startup: Readonly<{
  h1: HubChild;
  host: string;
  shouldStartMarketMaker: boolean;
  waitForMesh: () => Promise<void>;
  driveH1Bootstrap: () => Promise<void>;
  startMarketMaker: () => Promise<void>;
  startCustody: () => Promise<void>;
}>): Promise<void> => {
  const parallel = () => Promise.all([
    startup.driveH1Bootstrap(), startup.startMarketMaker(), startup.startCustody(),
  ]).then(() => undefined);
  if (process.env['XLN_HLT_AUTHORITY_EVIDENCE'] !== '1') {
    await Promise.all([startup.waitForMesh(), parallel()]);
    return;
  }
  // Capture H1 before MM or custody can open an Account, so the workload WAL
  // owns every later Account transition without a fabricated checkpoint frame.
  await startup.waitForMesh();
  await captureAuthorityEvidenceBase(startup.h1, startup.host);
  await parallel();
};
