import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';
import { sleep } from '../utils/Utils';
describe('Payment Tests', () => {
  let alice: User;
  let bob: User;
  let aliceBobChannel: Channel;
  let bobAliceChannel: Channel;
  let globalHub: User;
  let shouldContinue = true;

  let offdeltas: any = {};

  before(async () => {
    globalHub = await setupGlobalHub(10004);
    alice = new User('alice', 'password1');
    bob = new User('bob', 'password2');
    await alice.start();
    await bob.start();
  });

  after(async () => {
    await alice.stop();
    await bob.stop();
    await teardownGlobalHub();
  });

  afterEach(async () => {
    if (aliceBobChannel) await aliceBobChannel.save();
    if (bobAliceChannel) await bobAliceChannel.save();
  });

  async function setupChannels() {
    aliceBobChannel = await alice.getChannel(bob.thisUserAddress);
    bobAliceChannel = await bob.getChannel(alice.thisUserAddress);

    offdeltas['alice-bob'] = 0n;

    await alice.addToMempool(bob.thisUserAddress, new Transition.AddSubchannel(1));
    await alice.addToMempool(bob.thisUserAddress, new Transition.AddDelta(1, 1));
    const creditLimit = ethers.parseEther('10');
    await alice.addToMempool(bob.thisUserAddress, new Transition.SetCreditLimit(1, 1, creditLimit), true);

    await sleep(100)

    
    //await bob.addToMempool(alice.thisUserAddress, new Transition.AddSubchannel(1));
    //await bob.addToMempool(alice.thisUserAddress, new Transition.AddDelta(1, 1));
    await bob.addToMempool(alice.thisUserAddress,new Transition.SetCreditLimit(1, 1, creditLimit),true);

    await sleep()
  }

  it('should set up channels correctly', async () => {
    try {
      await setupChannels();
      console.log('Alice-Bob Channel State:', aliceBobChannel.getState());
      console.log('Bob-Alice Channel State:', bobAliceChannel.getState());
      expect(aliceBobChannel.getSubchannel(1), 'Alice-Bob subchannel should exist').to.not.be.undefined;
      expect(bobAliceChannel.getSubchannel(1), 'Bob-Alice subchannel should exist').to.not.be.undefined;
    } catch (error) {
      console.error('Error setting up channels:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should perform a direct payment correctly', async () => {
    try {
      const paymentAmount = ethers.parseEther('1');
      await alice.addToMempool(bob.thisUserAddress, new Transition.DirectPayment(1, 1, paymentAmount), true);

      offdeltas['alice-bob'] += aliceBobChannel.isLeft ? -paymentAmount : paymentAmount;
      await sleep()

      const aliceDelta = aliceBobChannel.getDelta(1, 1);
      const bobDelta = bobAliceChannel.getDelta(1, 1);

      console.log('Alice Delta after payment:', aliceDelta);
      console.log('Bob Delta after payment:', bobDelta);

      expect(aliceDelta!.offdelta).to.equal(offdeltas['alice-bob']);
      expect(bobDelta!.offdelta).to.equal(offdeltas['alice-bob']);
    } catch (error) {
      console.error('Error performing direct payment:', error);
      shouldContinue = false;
      throw error;
    }
  });

  /*
  (shouldContinue ? it : it.skip)('should reject a payment exceeding available capacity', async () => {
    try {
      const excessiveAmount = ethers.parseEther('11');
      let errorThrown = false;
      try {
        await aliceBobChannel.push(new Transition.DirectPayment(1, 1, excessiveAmount));
        await aliceBobChannel.flush();
        await sleep()
      } catch (error: any) {
        errorThrown = true;
        expect(error.message).to.include('Insufficient capacity');
      }
      expect(errorThrown).to.be.true;
    } catch (error) {
      console.error('Error testing payment rejection:', error);
      shouldContinue = false;
      throw error;
    }
  });*/

  (shouldContinue ? it : it.skip)('should handle multiple payments correctly', async () => {
    try {
      const payment1 = ethers.parseEther('2');
      const payment2 = ethers.parseEther('3');
      
      await alice.addToMempool(bob.thisUserAddress, new Transition.DirectPayment(1, 1, payment1), true);
      await sleep(1000)

      offdeltas['alice-bob'] += aliceBobChannel.isLeft ? -payment1 : payment1;

      await bob.addToMempool(alice.thisUserAddress, new Transition.DirectPayment(1, 1, payment2), true);

      offdeltas['alice-bob'] += bobAliceChannel.isLeft ? -payment2 : payment2;

      await sleep(1000)

      const aliceDelta = aliceBobChannel.getDelta(1, 1);
      const bobDelta = bobAliceChannel.getDelta(1, 1);

      console.log('Alice Delta after multiple payments:', aliceDelta);
      console.log('Bob Delta after multiple payments:', bobDelta);

      expect(aliceDelta!.offdelta).to.equal(offdeltas['alice-bob']);
      expect(bobDelta!.offdelta).to.equal(offdeltas['alice-bob']);
      console.log('offdeltas', offdeltas)
    } catch (error) {
      console.error('Error handling multiple payments:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should update derived delta correctly after payment', async () => {
    try {
      const paymentAmount = ethers.parseEther('1');
      await alice.addToMempool(bob.thisUserAddress, new Transition.DirectPayment(1, 1, paymentAmount), true);
      offdeltas['alice-bob'] += aliceBobChannel.isLeft ? -paymentAmount : paymentAmount;

      await sleep()

      const aliceDerivedDelta = aliceBobChannel.deriveDelta(1, 1, aliceBobChannel.isLeft);
      const bobDerivedDelta = bobAliceChannel.deriveDelta(1, 1, bobAliceChannel.isLeft);

      console.log('Alice Derived Delta:', aliceDerivedDelta);
      console.log('Bob Derived Delta:', bobDerivedDelta);

      expect(aliceDerivedDelta.outCapacity).to.equal(ethers.parseEther('9'));
      expect(bobDerivedDelta.outCapacity).to.equal(ethers.parseEther('11'));
    } catch (error) {
      console.error('Error updating derived delta:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should use hub as transport proxy for payments', async () => {
    try {
      const paymentAmount = ethers.parseEther('1');
      await alice.addToMempool(bob.thisUserAddress, new Transition.DirectPayment(1, 1, paymentAmount));
      offdeltas['alice-bob'] += aliceBobChannel.isLeft ? -paymentAmount : paymentAmount;

      await aliceBobChannel.flush();
      await sleep()

      //console.log('Global hub transports:', globalHub._transports);
      expect(globalHub._transports.has(alice.thisUserAddress), 'Alice should be connected to the hub').to.be.true;
      expect(globalHub._transports.has(bob.thisUserAddress), 'Bob should be connected to the hub').to.be.true;
    } catch (error) {
      console.error('Error using hub as transport proxy for payments:', error);
      shouldContinue = false;
      throw error;
    }
  });
});