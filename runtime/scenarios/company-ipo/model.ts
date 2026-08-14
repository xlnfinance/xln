import type { ConsensusConfig } from '../../entity/types';
import type { JAdapter } from '../../jurisdiction/adapter/types';
import type { JurisdictionConfig } from '../../protocol/config/jurisdiction-config';

export type CompanyActor = Readonly<{
  id: string;
  name: string;
  validators: string[];
  config: ConsensusConfig;
}>;

export type CompanyScenarioActors = Readonly<{
  jadapter: JAdapter;
  jurisdiction: JurisdictionConfig;
  hub: CompanyActor;
  investor: CompanyActor;
  soloCompany: CompanyActor;
  boardCompany: CompanyActor;
}>;

export type CompanyShareTokens = Readonly<{
  controlTokenId: number;
  dividendTokenId: number;
  controlExternalTokenId: bigint;
  dividendExternalTokenId: bigint;
}>;

export const USDT = 3;
export const USDT_UNIT = 1_000_000n;
export const CONTROL_SUPPLY = 100_000_000_000n;
export const DIVIDEND_SUPPLY = 100_000_000_000n;
