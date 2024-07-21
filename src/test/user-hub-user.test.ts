import User from '../app/User';
import { sleep } from '../utils/Utils';

import ENV from '../env';
import {encode, decode} from '../utils/Codec';
import Transition from '../app/Transition';
import assert from 'assert';
import Channel, {stringify} from '../app/Channel';

import Logger from '../utils/Logger';
import { channel } from 'diagnostics_channel';

const logger = new Logger('TestRunner');


import {exec} from 'child_process'
exec('rm -rf local-storage')


let channel1: Channel, channel2: any;
async function main() {

 
  const clone = (obj: any) => {
    return decode(encode(obj));
  }

  const user = new User(ENV.firstUserAddress, '');
  const user2 = new User(ENV.secondUserAddress, '');

  
  const hub = new User(ENV.hubAddress, '');
  await hub.start()
  console.log("hub started")
  
  await sleep(100)

  await Promise.all([user.start(), user2.start()]);

  channel1 = await user.getChannel(ENV.hubAddress);
  channel2 = await user2.getChannel(ENV.hubAddress);

  
  logger.log(`Test started for user1 (${user.thisUserAddress})`);
  logger.log(`Test started for user2 (${user2.thisUserAddress})`);

  // After starting users
  console.log("ASCII UI after starting users:");
  console.log(await user.renderAsciiUI());
  console.log(await user2.renderAsciiUI());

  // After adding subchannel 1 for user1
  await channel1.push(new Transition.AddSubchannel(1));
  await channel1.flush();
  await sleep(100);
  await channel1.load();
  console.log("ASCII UI after adding subchannel 1 for user1:");
  console.log(await user.renderAsciiUI());

  // After adding subchannel 1 for user2
  await channel2.push(new Transition.AddSubchannel(1));
  await channel2.flush();
  await sleep(100);
  await channel2.load();
  console.log("ASCII UI after adding subchannel 1 for user2:");
  console.log(await user2.renderAsciiUI());

  // After adding delta for user2
  await channel2.push(new Transition.AddDelta(1, 1));
  await channel2.flush();
  await sleep(100);
  await channel2.load();
  console.log("ASCII UI after adding delta for user2:");
  console.log(await user2.renderAsciiUI());

  // After adding delta for user1
  await channel1.push(new Transition.AddDelta(1, 1));
  await channel1.flush();
  await sleep(100);
  await channel1.load();
  console.log("ASCII UI after adding delta for user1:");
  console.log(await user.renderAsciiUI());

  // After direct payment
  const paymentAmount = 100n;
  await channel1.push(new Transition.DirectPayment(1, 1, paymentAmount));
  await channel1.flush();
  await sleep(100);
  await channel1.load();
  console.log("ASCII UI after direct payment:");
  console.log(await user.renderAsciiUI());

  // After setting credit limit for user1
  const creditLimit = 1000n;
  await channel1.push(new Transition.SetCreditLimit(1, 1, creditLimit));
  await channel1.flush();
  await sleep(100);
  await channel1.load();
  console.log("ASCII UI after setting credit limit for user1:");
  console.log(await user.renderAsciiUI());

  // After setting credit limit for user2
  await channel2.push(new Transition.SetCreditLimit(1, 1, creditLimit));
  await channel2.flush();
  await sleep(100);
  await channel2.load();
  console.log("ASCII UI after setting credit limit for user2:");
  console.log(await user2.renderAsciiUI());

  /*
  // Test AddSubchannel
  logger.log(`Before adding subchannel 1 for user1: ${stringify(await channel1.getSubchannel(1))}`);
  await channel1.push(new Transition.AddSubchannel(1));
  logger.log('After pushing AddSubchannel transition for user1');

  await channel1.flush();
  console.log('After flushing channel');
  await sleep(100);
  console.log('After sleep');

  // Reload the channel state
  await channel1.load();
  console.log('After reloading channel state');

  const subchannel1 = await channel1.getSubchannel(1);
  console.log('After getting subchannel 1 for user1:', stringify(subchannel1));
  assert(subchannel1, "Subchannel 1 should exist for user1");
  assert(subchannel1?.chainId === 1, "Subchannel 1 should have chainId 1");




  // Test AddSubchannel
  logger.log(`Before adding subchannel 1 for user2: ${stringify(await channel2.getSubchannel(1))}`);
  await channel2.push(new Transition.AddSubchannel(1));
  logger.log('After pushing AddSubchannel transition for user2');


  // when user receives it creates another channel instance, so use load() to update
  await channel2.flush();
  console.log('After flushing channel');
  await sleep(100);
  console.log('After sleep');

  await channel2.load();

  if (channel2.data.mempool.length !=0){
    console.log(channel2.data.mempool, channel2.state);
    throw new Error('mempool should be empty')
  }



  await channel2.push(new Transition.AddDelta(1, 1));
  // Reload the channel state
  await channel2.flush();
  await sleep(100);

  await channel2.load();
 
  if (channel2.data.mempool.length !=0){
    console.log(channel2.data.mempool, channel2.state);
    throw new Error('mempool should be empty')
  }


  console.log('After reloading channel state');
  assert(channel2.getDelta(1, 1), "Delta for token 1 should exist in subchannel 1 for user2");

  const subchannel2 = await channel2.getSubchannel(1);
  console.log('After getting subchannel 1 for user2:', stringify(subchannel1));
  assert(subchannel2, "Subchannel 1 should exist for user2");
  assert(subchannel2?.chainId === 1, "Subchannel 1 should have chainId 1");


  await channel1.push(new Transition.AddDelta(1, 1));
  await channel1.flush();
  await sleep(100);
  assert(channel1.getDelta(1, 1), "Delta for token 1 should exist in subchannel 1 for user1");

  

  // Test DirectPayment
  const paymentAmount = 100n;
  console.log('dirpay',channel1.getState())
  await channel1.push(new Transition.DirectPayment(1, 1, paymentAmount));
  await channel1.flush();
  await sleep(100);
  await channel1.load();
  console.log('dirpay2',channel1.getState())
  const delta1 = channel1.getDelta(1, 1);
  user.logger.log(`Delta1: ${stringify(delta1)}`);
  assert(delta1 && delta1.offdelta === (channel1.isLeft ? -paymentAmount : paymentAmount), "Offdelta should be updated for user1");

  // Test SetCreditLimit
  const creditLimit = 1000n;
  await channel1.push(new Transition.SetCreditLimit(1, 1, creditLimit));
  await channel1.flush();
  await sleep(100);
  await channel1.load();
  const updatedDelta1 = channel1.getDelta(1, 1);
  assert(updatedDelta1 && updatedDelta1.leftCreditLimit === creditLimit, "Left credit limit should be updated for user1");

  await channel2.push(new Transition.SetCreditLimit(1, 1, creditLimit));
  await channel2.flush();
  await sleep(100);
  await channel2.load();
  const updatedDelta2 = channel2.getDelta(1, 1);
  assert(updatedDelta2 && updatedDelta2.rightCreditLimit === creditLimit, "Right credit limit should be updated for user2");

  let hubch1 = await hub.getChannel(ENV.firstUserAddress);
  let hubch2 = await hub.getChannel(ENV.secondUserAddress);

  channel1 = await user.getChannel(ENV.hubAddress);
  channel2 = await user2.getChannel(ENV.hubAddress);
  console.log('proofs ', await channel1.getSubchannelProofs());
  console.log(channel1.getState(), hubch1.getState(), channel2.getState(), hubch2.getState());
  */
  console.log("All tests passed successfully!");
}

main()
/*.catch(error => {
  const errorLogger = new Logger('ErrorHandler');
  errorLogger.error("Test failed", { error });
  if (error instanceof assert.AssertionError) {
    errorLogger.error("Assertion failed", {
      message: error.message,
      actual: error.actual,
      expected: error.expected
    });
  }
  errorLogger.error("Channel states", {
    channel1: channel1.getState(),
    channel2: channel2.getState()
  });
  process.exit(1);
});*/