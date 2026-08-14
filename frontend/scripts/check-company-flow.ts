import assert from 'node:assert/strict';
import { toEntityId } from '../../runtime/protocol/identity';
import {
  COMPANY_DIVIDEND_TOKEN_FLAG,
  COMPANY_SHARE_SUPPLY,
  buildCompanyShareReleaseInput,
  getCompanyShareExternalTokenIds,
  projectCompanyShareTokens,
  selectDefaultCompanyHub,
} from '../src/lib/components/Entity/company/company-flow';
import {
  buildEntityPanelHashRouteFromState,
  resolveEntityPanelDeepLink,
} from '../src/lib/components/Entity/workspace/entity-panel-routing';

const companyId = toEntityId(`0x${'0'.repeat(63)}1`);
const ids = getCompanyShareExternalTokenIds(companyId);
assert.deepEqual(ids, { control: 1n, dividend: COMPANY_DIVIDEND_TOKEN_FLAG | 1n });

const projection = projectCompanyShareTokens(
  companyId,
  [
    { tokenId: 7, tokenType: 2, externalTokenId: ids.control.toString() },
    { tokenId: 8, tokenType: 2, externalTokenId: ids.dividend.toString() },
    { tokenId: 9, tokenType: 0, externalTokenId: ids.control.toString() },
  ],
  new Map([[7, 80n], [8, 40n], [9, 999n]]),
);
assert.deepEqual(projection.map((share) => [share.shareClass, share.internalTokenId, share.reserve]), [
  ['control', 7, 80n],
  ['dividend', 8, 40n],
]);

const release = buildCompanyShareReleaseInput({
  entityId: companyId,
  signerId: '0x1111111111111111111111111111111111111111',
  depositoryAddress: '0x2222222222222222222222222222222222222222',
});
assert.deepEqual(release.entityTxs, [{
  type: 'entityProviderReleaseControlShares',
  data: {
    recipientAddress: '0x2222222222222222222222222222222222222222',
    controlAmount: COMPANY_SHARE_SUPPLY,
    dividendAmount: COMPANY_SHARE_SUPPLY,
    purpose: 'Company treasury issuance',
  },
}]);

const defaultHub = selectDefaultCompanyHub([
  { entityId: '0x03', isConnected: false, isOpening: false, metadata: { fee: 20, peerCount: 100 } },
  { entityId: '0x02', isConnected: false, isOpening: false, metadata: { fee: 10, peerCount: 5 } },
  { entityId: '0x01', isConnected: false, isOpening: false, metadata: { fee: 10, peerCount: 5 } },
  { entityId: '0x00', isConnected: true, isOpening: false, metadata: { fee: 0, peerCount: 1000 } },
]);
assert.equal(defaultHub?.entityId, '0x01');
assert.deepEqual(resolveEntityPanelDeepLink({ hashRoute: 'company' }), { activeTab: 'company' });
assert.equal(buildEntityPanelHashRouteFromState({
  activeTab: 'company',
  assetWorkspaceTab: 'move',
  accountWorkspaceTab: 'open',
  settingsSubview: 'wallet',
}), 'company');
console.info('COMPANY_FLOW_CHECK_OK cases=6');
