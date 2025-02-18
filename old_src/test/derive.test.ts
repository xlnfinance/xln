import { describe, it, before } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';
import { Delta } from '../types/Subchannel';
import { sleep } from '../utils/Utils';

describe('DerivedDelta Tests', () => {
  let alice: User;
  let bob: User;
  let channel: Channel;
  let shouldSkipRemainingTests = false;

  beforeEach(function() {
    if (shouldSkipRemainingTests) {
      // Skip the test by throwing a special error recognized by Mocha
      this.skip();
    }
  });
  
  afterEach(function() {
    // If the current test failed, set the flag to true
    if (this.currentTest!.state === 'failed') {
      shouldSkipRemainingTests = true;
    }
  });
  before(async () => {
    await setupGlobalHub(10007);
    alice = new User('alice', 'password1');
    bob = new User('bob', 'password2');
    await alice.start();
    await bob.start();
    channel = await alice.getChannel(bob.thisUserAddress);
    await alice.addToMempool(bob.thisUserAddress, new Transition.AddSubchannel(1));
    await alice.addToMempool(bob.thisUserAddress, new Transition.AddDelta(1, 1), true);

    await sleep(500);

    console.log(channel.state);
  });

  after(async () => {
    await alice.stop();
    await bob.stop();
    await teardownGlobalHub();
  });

  function setDeltaValues(collateral: bigint, ondelta: bigint, offdelta: bigint, leftCreditLimit: bigint, rightCreditLimit: bigint) {
    const delta = channel.getDelta(1, 1) as Delta;
    //throw new Error('Not implemented');
    delta.collateral = collateral;
    delta.ondelta = ondelta;
    delta.offdelta = offdelta;
    delta.leftCreditLimit = leftCreditLimit;
    delta.rightCreditLimit = rightCreditLimit;

    console.log('set delta', delta);
  }

  function testDerivedDelta(description: string, isLeft: boolean, expectedValues: any) {
    it(description, () => {
      const derived = channel.deriveDelta(1, 1, isLeft);
      console.log('compare '+description, derived, expectedValues)
      expect(derived.delta).to.equal(expectedValues.delta);
      expect(derived.collateral).to.equal(expectedValues.collateral);
      expect(derived.inCollateral).to.equal(expectedValues.inCollateral);
      expect(derived.outCollateral).to.equal(expectedValues.outCollateral);
      expect(derived.inOwnCredit).to.equal(expectedValues.inOwnCredit);
      expect(derived.outPeerCredit).to.equal(expectedValues.outPeerCredit);
      expect(derived.totalCapacity).to.equal(expectedValues.totalCapacity);
      expect(derived.inCapacity).to.equal(expectedValues.inCapacity);
      expect(derived.outCapacity).to.equal(expectedValues.outCapacity);
      console.log(`ASCII representation:\n${derived.ascii}`);
    });
  }

  describe('Basic Scenarios', () => {
    it('should handle empty state correctly', () => {
      setDeltaValues(0n, 0n, 0n, 0n, 0n);
      const derived = channel.deriveDelta(1, 1, true);
      expect(derived.delta).to.equal(0n);
      expect(derived.totalCapacity).to.equal(0n);
      setDeltaValues(100n, 0n, 0n, 0n, 0n);

    });


    testDerivedDelta('should handle only collateral', true, {
      delta: 0n,
      collateral: 100n,
      inCollateral: 100n,
      outCollateral: 0n,
      inOwnCredit: 0n,
      outPeerCredit: 0n,
      totalCapacity: 100n,
      inCapacity: 100n,
      outCapacity: 0n,
    });
  });

  describe('Credit Limit Scenarios', () => {
    before(() => {
      setDeltaValues(100n, 0n, 0n, 50n, 50n);
    });

    testDerivedDelta('should handle credit limits for left side', true, {
      delta: 0n,
      collateral: 100n,
      inCollateral: 100n,
      outCollateral: 0n,
      inOwnCredit: 0n,
      outPeerCredit: 0n,
      totalCapacity: 200n,
      inCapacity: 150n,
      outCapacity: 50n,
    });

    testDerivedDelta('should handle credit limits for right side', false, {
      delta: 0n,
      collateral: 100n,
      inCollateral: 0n,
      outCollateral: 100n,
      inOwnCredit: 0n,
      outPeerCredit: 0n,
      totalCapacity: 200n,
      inCapacity: 50n,
      outCapacity: 150n,
    });
  });

  describe('Delta Scenarios', () => {
    it('should handle positive delta', () => {
      setDeltaValues(100n, 0n, 50n, 50n, 50n);
      const derived = channel.deriveDelta(1, 1, true);
      expect(derived.delta).to.equal(50n);
      expect(derived.inCollateral).to.equal(50n);
      expect(derived.outCollateral).to.equal(50n);
    });

    it('should handle negative delta', () => {
      setDeltaValues(100n, 0n, -50n, 50n, 50n);
      const derived = channel.deriveDelta(1, 1, true);
      expect(derived.delta).to.equal(-50n);
      expect(derived.inCollateral).to.equal(100n);
      expect(derived.outCollateral).to.equal(0n);
    });
  });

  describe('Edge Cases', () => {
    it('should handle delta exceeding collateral', () => {
      setDeltaValues(100n, 0n, 150n, 50n, 50n);
      const derived = channel.deriveDelta(1, 1, true);
      expect(derived.delta).to.equal(150n);
      expect(derived.inCollateral).to.equal(0n);
      expect(derived.outCollateral).to.equal(100n);
      expect(derived.outPeerCredit).to.equal(50n);
    });
    it('should handle negative delta exceeding credit limit', () => {
      setDeltaValues(100n, 0n, -150n, 50n, 50n);
      const derived = channel.deriveDelta(1, 1, true);
      expect(derived.delta).to.equal(-150n);
      expect(derived.inCollateral).to.equal(100n);
      expect(derived.inOwnCredit).to.equal(50n); // Changed from 150n to 50n
    });
  });

  describe('Random Scenarios', () => {
    function randomBigInt(max: bigint): bigint {
      return BigInt(Math.floor(Math.random() * Number(max)));
    }

    for (let i = 0; i < 5; i++) {
      it(`should handle random scenario ${i + 1}`, () => {
        const collateral = randomBigInt(1000n);
        const ondelta = randomBigInt(200n) - 100n;
        const offdelta = randomBigInt(200n) - 100n;
        const leftCreditLimit = randomBigInt(500n);
        const rightCreditLimit = randomBigInt(500n);

        setDeltaValues(collateral, ondelta, offdelta, leftCreditLimit, rightCreditLimit);
        
        const derivedLeft = channel.deriveDelta(1, 1, true);
        const derivedRight = channel.deriveDelta(1, 1, false);

        console.log(`Scenario ${i + 1}:`);
        console.log(`Collateral: ${collateral}, OnDelta: ${ondelta}, OffDelta: ${offdelta}`);
        console.log(`Left Credit Limit: ${leftCreditLimit}, Right Credit Limit: ${rightCreditLimit}`);
        console.log('Left derived:', derivedLeft);
        console.log('Right derived:', derivedRight);
        console.log('Left ASCII:\n', derivedLeft.ascii);
        console.log('Right ASCII:\n', derivedRight.ascii);

        expect(derivedLeft.totalCapacity).to.equal(derivedRight.totalCapacity);
        expect(derivedLeft.collateral).to.equal(derivedRight.collateral);

      
        expect(Number(derivedLeft.inCapacity + derivedLeft.outCapacity))
        .to.be.at.most(Number(derivedLeft.totalCapacity));
        expect(Number(derivedRight.inCapacity + derivedRight.outCapacity))
        .to.be.at.most(Number(derivedRight.totalCapacity));

  
          
      });
    }
  });
});