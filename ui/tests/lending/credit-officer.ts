import type { Expect, Page } from '@playwright/test';
import {
  decodeCreditRequest,
  validCreditProof,
  type CreditRequest,
} from '../../../core/orchestrator/credit-officer/proof';
import { creditDifficulty, creditUsd } from '../../../core/orchestrator/credit-officer/policy';
import type { Parties } from './financial-evidence';

/** Observe the real wallet worker and officer; never submit a proof or grant a facility here. */
export async function borrowThroughOfficer(page: Page, ids: Parties, expect: Expect): Promise<void> {
  const approval = page.waitForResponse(
    response =>
      new URL(response.url()).pathname === '/api/credit-officer/approve' && response.request().method() === 'POST',
    { timeout: 90_000 },
  );
  await page.getByTestId('lend-submit').click();
  const response = await approval;
  expect(response.ok()).toBe(true);
  const proof = decodeCreditRequest(response.request().postDataJSON());
  expect(proof).toMatchObject({
    hubEntityId: ids.hubId,
    borrowerEntityId: ids.ownerId,
    tokenId: ids.tokenId,
    amount: '2000000',
    termId: '1d',
  });
  expect(
    validCreditProof(
      proof,
      ids.hubId,
      Date.parse(`${proof.day}T00:00:00Z`),
      creditDifficulty(creditUsd(proof.tokenId, BigInt(proof.amount))),
    ),
  ).toBe(true);
  const decision = await response.json();
  expect(decision).toMatchObject({ success: true, approved: true, reason: 'APPROVAL_SUBMITTED' });
  await expectCommittedFacility(page, ids, proof, decision.expiresAt, expect);
  await expect(page.getByTestId('credit-officer-decision')).toContainText('Facility check complete', {
    timeout: 30_000,
  });
  await expect(page.getByTestId('lending-request-status')).toContainText('Loan active', { timeout: 30_000 });
}

async function expectCommittedFacility(
  page: Page,
  ids: Parties,
  proof: CreditRequest,
  expiresAt: number,
  expect: Expect,
): Promise<void> {
  const facility = {
    borrowerEntityId: ids.ownerId,
    tokenId: ids.tokenId,
    termId: proof.termId,
    maxPrincipal: proof.amount,
    expiresAt,
  };
  await expect
    .poll(
      async () => {
        const response = await page.request.get('/api/lending/state', {
          params: { hubEntityId: ids.hubId, userEntityId: ids.ownerId, tokenId: String(ids.tokenId) },
        });
        expect(response.ok()).toBe(true);
        return response.json();
      },
      { timeout: 30_000 },
    )
    .toMatchObject({
      success: true,
      facilities: expect.arrayContaining([expect.objectContaining(facility)]),
      loans: expect.arrayContaining([
        expect.objectContaining({
          borrowerEntityId: ids.ownerId,
          tokenId: ids.tokenId,
          termId: proof.termId,
          principalAmount: proof.amount,
          status: 'active',
          approval: expect.objectContaining(facility),
        }),
      ]),
    });
}
