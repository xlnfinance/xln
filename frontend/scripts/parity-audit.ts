#!/usr/bin/env bun

import { safeStringify } from '../../core/protocol/serialization';
import { CAPABILITIES } from '../config/capabilities';
import {
  CAPABILITY_PARITY,
  CUTOVER_CHECKLIST,
  PARITY_GAPS,
  RETAINED_ROUTE_PARITY,
} from '../config/parity-audit';

const count = (values: readonly string[]): Record<string, number> => Object.fromEntries(
  [...new Set(values)].map((value) => [value, values.filter((candidate) => candidate === value).length]),
);

export const buildParityAuditReport = () => ({
  schemaVersion: 1,
  routes: {
    total: RETAINED_ROUTE_PARITY.length,
    implementation: count(RETAINED_ROUTE_PARITY.map(({ implementation }) => implementation)),
    browserEvidence: count(RETAINED_ROUTE_PARITY.map(({ browserEvidence }) => browserEvidence)),
  },
  capabilities: {
    total: CAPABILITIES.length,
    accounted: CAPABILITY_PARITY.length,
    status: count(CAPABILITIES.map(({ status }) => status)),
  },
  gaps: PARITY_GAPS.map(({ id, kind, routeIds, capabilityIds, nextSlice }) => ({
    id,
    kind,
    routes: routeIds.length,
    capabilities: capabilityIds.length,
    nextSlice,
  })),
  cutover: CUTOVER_CHECKLIST,
});

if (import.meta.main) console.info(`${safeStringify(buildParityAuditReport(), 2)}\n`);
