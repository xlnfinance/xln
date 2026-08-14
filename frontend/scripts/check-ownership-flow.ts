import assert from 'node:assert/strict';
import { toEntityId } from '../../runtime/protocol/identity';
import {
  ENTITY_DIVIDEND_TOKEN_FLAG,
  ENTITY_SHARE_SUPPLY,
  buildEntityShareReleaseInput,
  getEntityShareExternalTokenIds,
  projectEntityShareTokens,
} from '../src/lib/components/Entity/ownership/ownership-flow';
import {
  buildEntityPanelHashRouteFromState,
  resolveEntityPanelDeepLink,
} from '../src/lib/components/Entity/workspace/entity-panel-routing';

const entityId = toEntityId(`0x${'0'.repeat(63)}1`);
const ids = getEntityShareExternalTokenIds(entityId);
assert.deepEqual(ids, { control: 1n, dividend: ENTITY_DIVIDEND_TOKEN_FLAG | 1n });

const projection = projectEntityShareTokens(
  entityId,
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

const release = buildEntityShareReleaseInput({
  entityId,
  signerId: '0x1111111111111111111111111111111111111111',
  depositoryAddress: '0x2222222222222222222222222222222222222222',
});
assert.deepEqual(release.entityTxs, [{
  type: 'entityProviderReleaseControlShares',
  data: {
    recipientAddress: '0x2222222222222222222222222222222222222222',
    controlAmount: ENTITY_SHARE_SUPPLY,
    dividendAmount: ENTITY_SHARE_SUPPLY,
    purpose: 'Entity treasury issuance',
  },
}]);

assert.deepEqual(resolveEntityPanelDeepLink({ hashRoute: 'ownership' }), { activeTab: 'ownership' });
assert.equal(buildEntityPanelHashRouteFromState({
  activeTab: 'ownership',
  assetWorkspaceTab: 'move',
  accountWorkspaceTab: 'open',
  settingsSubview: 'wallet',
}), 'ownership');
console.info('OWNERSHIP_FLOW_CHECK_OK cases=5');
