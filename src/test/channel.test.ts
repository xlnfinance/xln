import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('Channel Tests', () => {
  let alice: User;
  let bob: User;
  let aliceChannel: Channel;
  let bobChannel: Channel;
  let globalHub: User;
  let shouldContinue = true;

  before(async () => {
    globalHub = await setupGlobalHub(10001);
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
    if (aliceChannel) await aliceChannel.save();
    if (bobChannel) await bobChannel.save();
  });

  it('should create channels between two users', async () => {
    try {
      aliceChannel = await alice.getChannel(bob.thisUserAddress);
      bobChannel = await bob.getChannel(alice.thisUserAddress);
      console.log('Alice channel state:', aliceChannel.getState());
      console.log('Bob channel state:', bobChannel.getState());
      expect(aliceChannel.thisUserAddress).to.equal(alice.thisUserAddress);
      expect(aliceChannel.otherUserAddress).to.equal(bob.thisUserAddress);
      expect(bobChannel.thisUserAddress).to.equal(bob.thisUserAddress);
      expect(bobChannel.otherUserAddress).to.equal(alice.thisUserAddress);
    } catch (error) {
      console.error('Error creating channels:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should add a subchannel correctly', async () => {
    try {
      await alice.addToMempool(aliceChannel.otherUserAddress, new Transition.AddSubchannel(1), true);

      await sleep(500);
      console.log('Alice channel state after adding subchannel:', aliceChannel.getState());
      console.log('Bob channel state after adding subchannel:', bobChannel.getState());
      const aliceSubchannel = aliceChannel.getSubchannel(1);
      const bobSubchannel = bobChannel.getSubchannel(1);
      expect(aliceSubchannel, 'Alice subchannel should be defined').to.not.be.undefined;
      expect(bobSubchannel, 'Bob subchannel should be defined').to.not.be.undefined;
      expect(aliceSubchannel!.chainId).to.equal(1);
      expect(bobSubchannel!.chainId).to.equal(1);
    } catch (error) {
      console.error('Error adding subchannel:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should add a delta to a subchannel', async () => {
    try {
      await alice.addToMempool(aliceChannel.otherUserAddress, new Transition.AddDelta(1, 1),true);
      await sleep(500);
      console.log('Alice channel state after adding delta:', aliceChannel.getState());
      console.log('Bob channel state after adding delta:', bobChannel.getState());
      const aliceDelta = aliceChannel.getDelta(1, 1);
      const bobDelta = bobChannel.getDelta(1, 1);
      expect(aliceDelta, 'Alice delta should be defined').to.not.be.undefined;
      expect(bobDelta, 'Bob delta should be defined').to.not.be.undefined;
      expect(aliceDelta!.tokenId).to.equal(1);
      expect(bobDelta!.tokenId).to.equal(1);
    } catch (error) {
      console.error('Error adding delta:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should set credit limit correctly', async () => {
    try {
      const creditLimit = ethers.parseEther('10');
      await alice.addToMempool(aliceChannel.otherUserAddress, new Transition.SetCreditLimit(1, 1, creditLimit),true);

      await sleep(500);
      console.log('Alice channel state after setting credit limit:', aliceChannel.getState());
      console.log('Bob channel state after setting credit limit:', bobChannel.getState());
      const aliceDelta = aliceChannel.getDelta(1, 1);
      const bobDelta = bobChannel.getDelta(1, 1);
      expect(aliceDelta, 'Alice delta should be defined').to.not.be.undefined;
      expect(bobDelta, 'Bob delta should be defined').to.not.be.undefined;
      // Check the credit limit we set (for the other side)
      expect(aliceDelta![aliceChannel.isLeft ? 'rightCreditLimit' : 'leftCreditLimit']).to.equal(creditLimit);
      // Check the credit limit we received (our own side)
      expect(bobDelta![bobChannel.isLeft ? 'leftCreditLimit' : 'rightCreditLimit']).to.equal(creditLimit);
    } catch (error) {
      console.error('Error setting credit limit:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should calculate derived delta correctly', async () => {
    try {
      const creditLimit = ethers.parseEther('10');
      const aliceDerivedDelta = aliceChannel.deriveDelta(1, 1, aliceChannel.isLeft);
      const bobDerivedDelta = bobChannel.deriveDelta(1, 1, bobChannel.isLeft);
      console.log(aliceDerivedDelta, bobDerivedDelta);
      console.log('Alice derived delta:', aliceChannel.isLeft, aliceDerivedDelta);
      console.log('Bob derived delta:', bobChannel.isLeft, bobDerivedDelta);

      expect(aliceDerivedDelta.totalCapacity).to.equal(creditLimit);
      expect(bobDerivedDelta.totalCapacity).to.equal(creditLimit);
      expect(aliceDerivedDelta.inCapacity).to.equal(creditLimit);
      expect(aliceDerivedDelta.outCapacity).to.equal(0n);
      expect(bobDerivedDelta.inCapacity).to.equal(0n);
      expect(bobDerivedDelta.outCapacity).to.equal(creditLimit);
    } catch (error) {
      console.error('Error calculating derived delta:', error);
      shouldContinue = false;
      throw error;
    }
  });

  (shouldContinue ? it : it.skip)('should use hub as transport proxy', async () => {
    try {
      await alice.addToMempool(aliceChannel.otherUserAddress, new Transition.AddSubchannel(2), true);

      await sleep(500);
      console.log('Global hub transports:', globalHub._transports);
      expect(globalHub._transports.has(alice.thisUserAddress), 'Alice should be connected to the hub').to.be.true;
      expect(globalHub._transports.has(bob.thisUserAddress), 'Bob should be connected to the hub').to.be.true;
    } catch (error) {
      console.error('Error using hub as transport proxy:', error);
      shouldContinue = false;
      throw error;
    }
  });
});