import { expect } from 'chai';
import { Transition } from '../app/Transition';
import ChannelState from '../types/ChannelState';
import { Subchannel, Delta } from '../types/Subchannel';

describe('Transition Unit Tests', function() {
  let mockState: ChannelState;

  beforeEach(function() {
    mockState = {
      left: '0x1234...', // replace with full address
      right: '0x5678...', // replace with full address
      channelKey: '0xabcd...',
      previousBlockHash: '0x0000...',
      previousStateHash: '0x0000...',
      timestamp: Date.now(),
      blockId: 0,
      transitionId: 0,
      subchannels: [
        {
          chainId: 1,
          deltas: [
            {
              tokenId: 1,
              collateral: 0n,
              ondelta: 0n,
              offdelta: 0n,
              leftCreditLimit: 100n,
              rightCreditLimit: 100n,
              leftAllowence: 0n,
              rightAllowence: 0n
            }
          ],
          cooperativeNonce: 0,
          disputeNonce: 0,
          proposedEvents: [],
          proposedEventsByLeft: false
        }
      ],
      subcontracts: []
    };
  });

  it('should correctly apply DirectPayment transition', function() {
    const transition = new Transition.DirectPayment(1, 1, 50n);
    transition.apply({ state: mockState } as any, true, true);
    
    expect(mockState.subchannels[0].deltas[0].offdelta).to.equal(-50n);
  });

  it('should correctly apply AddSubchannel transition', function() {
    const transition = new Transition.AddSubchannel(2);
    transition.apply({ state: mockState } as any, true, true);
    
    expect(mockState.subchannels.length).to.equal(2);
    expect(mockState.subchannels[1].chainId).to.equal(2);
  });

  it('should correctly apply AddDelta transition', function() {
    const transition = new Transition.AddDelta(1, 2);
    transition.apply({ state: mockState } as any, true, true);
    
    expect(mockState.subchannels[0].deltas.length).to.equal(2);
    expect(mockState.subchannels[0].deltas[1].tokenId).to.equal(2);
  });

  it('should correctly apply SetCreditLimit transition', function() {
    const transition = new Transition.SetCreditLimit(1, 1, 200n);
    transition.apply({ state: mockState } as any, true, true);
    
    expect(mockState.subchannels[0].deltas[0].leftCreditLimit).to.equal(200n);
  });

  // Add more tests for other transition types...
});