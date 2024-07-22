import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import Channel from '../app/Channel';
import Transition from '../app/Transition';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';
import { sleep } from '../utils/Utils';

describe('Swaps', () => {
  let alice: User, bob: User;
  let aliceBobChannel: Channel, bobAliceChannel: Channel;
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
    await setupGlobalHub(10005);
    alice = new User('alice', 'password1');
    bob = new User('bob', 'password2');
    await Promise.all([alice.start(), bob.start()]);
  });

  after(async () => {
    await Promise.all([alice.stop(), bob.stop()]);
    await teardownGlobalHub();
  });

  async function setupChannels() {
    aliceBobChannel = await alice.createChannel(bob.thisUserAddress);
    bobAliceChannel = await bob.createChannel(alice.thisUserAddress);

    for (const channel of [aliceBobChannel, bobAliceChannel]) {
      await channel.push(new Transition.AddSubchannel(1));
      await channel.push(new Transition.AddDelta(1, 1)); // Token 1
      await channel.push(new Transition.AddDelta(1, 2)); // Token 2
      const creditLimit = ethers.parseEther('10');
      await channel.push(new Transition.SetCreditLimit(1, 1, creditLimit));
      await channel.push(new Transition.SetCreditLimit(1, 2, creditLimit));
      await channel.flush();
      await sleep()

    }
  }

  it('should successfully perform a swap between two tokens', async () => {
    await setupChannels();
    const swapAmount1 = ethers.parseEther('2');
    const swapAmount2 = ethers.parseEther('3');

    const swapTransition = new Transition.AddSwap(1, aliceBobChannel.isLeft, 1, swapAmount1, 2, swapAmount2);
    await aliceBobChannel.push(swapTransition);
    await aliceBobChannel.flush();
    await sleep()

    // Wait for Bob to process the swap
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Bob accepts the swap
    const updateSwapTransition = new Transition.UpdateSwap(1, 0, 1); // Assuming it's the first swap in the subcontracts array
    await bobAliceChannel.push(updateSwapTransition);
    await bobAliceChannel.flush();
    await sleep()

    // Wait for the swap to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    const aliceDelta1 = aliceBobChannel.getDelta(1, 1);
    const aliceDelta2 = aliceBobChannel.getDelta(1, 2);
    const bobDelta1 = bobAliceChannel.getDelta(1, 1);
    const bobDelta2 = bobAliceChannel.getDelta(1, 2);

    expect(aliceDelta1!.offdelta).to.equal(-swapAmount1);
    expect(aliceDelta2!.offdelta).to.equal(swapAmount2);
    expect(bobDelta1!.offdelta).to.equal(swapAmount1);
    expect(bobDelta2!.offdelta).to.equal(-swapAmount2);
  });

  it('should handle partial swap execution', async () => {
    await setupChannels();
    const swapAmount1 = ethers.parseEther('4');
    const swapAmount2 = ethers.parseEther('6');

    const swapTransition = new Transition.AddSwap(1, aliceBobChannel.isLeft, 1, swapAmount1, 2, swapAmount2);
    await aliceBobChannel.push(swapTransition);
    await aliceBobChannel.flush();
    await sleep()

    // Wait for Bob to process the swap
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Bob accepts half of the swap
    const updateSwapTransition = new Transition.UpdateSwap(1, 0, 0.5);
    await bobAliceChannel.push(updateSwapTransition);
    await bobAliceChannel.flush();
    await sleep()

    // Wait for the swap to be processed
    await new Promise(resolve => setTimeout(resolve, 1000));

    const aliceDelta1 = aliceBobChannel.getDelta(1, 1);
    const aliceDelta2 = aliceBobChannel.getDelta(1, 2);
    const bobDelta1 = bobAliceChannel.getDelta(1, 1);
    const bobDelta2 = bobAliceChannel.getDelta(1, 2);

    expect(aliceDelta1!.offdelta).to.equal(-swapAmount1 / 2n);
    expect(aliceDelta2!.offdelta).to.equal(swapAmount2 / 2n);
    expect(bobDelta1!.offdelta).to.equal(swapAmount1 / 2n);
    expect(bobDelta2!.offdelta).to.equal(-swapAmount2 / 2n);
  });

  it('should reject a swap exceeding available capacity', async () => {
    await setupChannels();
    const excessiveAmount = ethers.parseEther('11');

    const swapTransition = new Transition.AddSwap(1, aliceBobChannel.isLeft, 1, excessiveAmount, 2, excessiveAmount);
    
    await expect(
      aliceBobChannel.push(swapTransition)
    ).to.be.rejectedWith('Insufficient capacity');
  });
});