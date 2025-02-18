import { strict as assert } from 'assert';
import { Buffer } from 'buffer';
import { 
  createChannelState, 
  createChannelData,
  toEntityState,
  fromEntityState,
  encodeForMerkleStore,
  ChannelState,
  ChannelData
} from './channel';

describe('Channel', () => {
  let state: ChannelState;
  let data: ChannelData;

  beforeEach(() => {
    const left = '0x1234567890123456789012345678901234567890';
    const right = '0x2234567890123456789012345678901234567890';
    state = createChannelState(left, right);
    data = createChannelData(true);
  });

  describe('State Management', () => {
    it('creates initial channel state correctly', () => {
      assert.equal(state.left < state.right, true, 'Left address should be smaller');
      assert.equal(state.blockId, 0);
      assert.equal(state.subchannels.length, 0);
      assert.equal(state.subcontracts.length, 0);
    });

    it('creates initial channel data correctly', () => {
      assert.equal(data.isLeft, true);
      assert.equal(data.rollbacks, 0);
      assert.equal(data.sentTransitions, 0);
      assert.equal(data.pendingBlock, null);
      assert.deepEqual(data.pendingSignatures, []);
    });
  });

  describe('Entity State Conversion', () => {
    it('converts to entity state correctly', () => {
      const entityState = toEntityState(state, data);
      assert.equal(entityState.status, 'idle');
      assert.equal(entityState.entityPool.size, 0);
      assert.ok(entityState.finalBlock);
      assert.equal(entityState.consensusBlock, undefined);
    });

    it('converts from entity state correctly', () => {
      const entityState = toEntityState(state, data);
      const recoveredState = fromEntityState(entityState);
      assert.ok(recoveredState);
      assert.equal(recoveredState.left, state.left);
      assert.equal(recoveredState.right, state.right);
      assert.equal(recoveredState.channelKey, state.channelKey);
    });
  });

  describe('Merkle Store Integration', () => {
    it('encodes for merkle store correctly', () => {
      const merkleData = encodeForMerkleStore(state);
      assert.ok(merkleData.has(0x01)); // StorageType.CURRENT_BLOCK
      const blockData = merkleData.get(0x01);
      assert.ok(blockData instanceof Buffer);
    });
  });
}); 