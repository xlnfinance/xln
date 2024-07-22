import { describe, it, before, after, afterEach } from 'mocha';
import { expect } from 'chai';
import User from '../app/User';
import { ethers } from 'ethers';
import { setupGlobalHub, teardownGlobalHub } from './hub';

describe('User', () => {
  let user: User;
  let globalHub: User;

  before(async () => {
    globalHub = await setupGlobalHub(10006);
  });

  after(async () => {
    await teardownGlobalHub();
  });

  afterEach(async () => {
    if (user) {
      await user.stop();
    }
  });

  it('should create a user with correct address', async () => {
    user = new User('testuser', 'testpassword');
    await user.start();
    expect(user.thisUserAddress).to.be.a('string');
    expect(user.thisUserAddress).to.match(/^0x[a-fA-F0-9]{40}$/);
  });

  it('should generate consistent addresses for the same username and password', async () => {
    const user1 = new User('testuser', 'testpassword');
    const user2 = new User('testuser', 'testpassword');
    await user1.start();
    await user2.start();
    expect(user1.thisUserAddress).to.equal(user2.thisUserAddress);
  });

  it('should start and initialize correctly', async () => {
    user = new User('testuser', 'testpassword');
    await user.start();
    expect(user.signer).to.not.be.null;
    expect(user.encryptionKey).to.not.be.null;
    expect(user._transports.has(globalHub.thisUserAddress)).to.be.true;
  });

  it('should sign and verify messages correctly', async () => {
    user = new User('testuser', 'testpassword');
    await user.start();
    const message = 'Test message';
    const signature = await user.signMessage(message);
    const isValid = await user.verifyMessage(message, signature, user.thisUserAddress);
    expect(isValid).to.be.true;
  });

  it('should encrypt and decrypt messages correctly', async () => {
    user = new User('testuser', 'testpassword');
    await user.start();
    const message = 'Secret message';
    const encrypted = await user.encryptForRecipient(user.thisUserAddress, message);
    const decrypted = await user.decryptPackage(encrypted);
    expect(decrypted).to.equal(message);
  });

  it('should calculate fees correctly', async () => {
    user = new User('testuser', 'testpassword');
    await user.start();
    const amount = ethers.parseEther('1');
    const fee = user.calculateFee(amount);
    expect(fee).to.equal(ethers.parseEther('0.001')); // 0.1% of 1 ETH
  });

  it('should connect to the hub', async () => {
    user = new User('testuser', 'testpassword');
    await user.start();
    expect(user._transports.has(globalHub.thisUserAddress)).to.be.true;
  });
});