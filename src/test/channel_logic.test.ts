
import User from '../app/User';
import Channel from '../app/Channel';
import { sleep } from '../utils/Utils';

import ENV from '../env';
import Transition from '../app/Transition';
import assert from 'assert';
import { ethers } from 'ethers';
import Logger from '../utils/Logger';

import * as crypto from 'crypto';

const logger = new Logger('ChannelLogicTest');


import {exec} from 'child_process'

async function main() {
  exec('rm -rf local-storage')
  await sleep(100)

  
  const user1 = new User('1', '');
  const user2 = new User('2', '');



  const hub = new User('hub', '');
  await hub.start()
  console.log("hub started")
  

  await Promise.all([user1.start(), user2.start()]);

  const channel1 = await user1.getChannel(ENV.secondUserAddress);
  const channel2 = await user2.getChannel(ENV.firstUserAddress);

  // Test 1: Basic flush and receive
  console.log('compar', channel1, channel2)

  await channel1.push(new Transition.AddSubchannel(1));
  await channel1.push(new Transition.AddDelta(1, 1));
  await channel1.flush();



  await sleep(1040);

  assert(channel2.getSubchannel(1), "Subchannel 1 should exist for user2");
  assert(channel2.getDelta(1, 1), "Delta for token 1 should exist in subchannel 1 for user2");

  // Test 2: Rollback situation
  const directPayment1 = new Transition.DirectPayment(1, 1, 100n);
  const directPayment2 = new Transition.DirectPayment(1, 1, 50n);

  // Simulate simultaneous sends
  await Promise.all([
    channel1.push(directPayment1),
    channel2.push(directPayment2)
  ]);

  await Promise.all([
    channel1.flush(),
    channel2.flush()
  ]);

  await sleep(500);

  
  // Check that only one payment was applied (the one from the left channel)
  const delta1 = channel1.getDelta(1, 1);
  const delta2 = channel2.getDelta(1, 1);

  console.log(delta1, delta2, channel1.data.mempool, channel1.data.sentTransitions, channel2.data.mempool)

  assert(delta1 && delta1.offdelta === -50n, "Both channels should have the same state after rollback&reapply");
  assert(delta2 && delta2.offdelta === -50n, "Both channels should have the same state after rollback&reapply");

  // Test 3: Add and resolve payment subcontract
  
  
  await sleep(700);

  console.log(channel1.state, channel2.state, channel1.data.mempool);

  channel1.createOnionEncryptedPayment(ENV.secondUserAddress, 200n, 1, 1, [ENV.hubAddress]);

  console.log(channel1.state, channel2.state, channel1.data.mempool);
  await channel1.flush();


  //await sleep(2);
  //assert(channel2.state.subcontracts.length === 1, "Payment subcontract should be added");
  //console.log(channel1.getDelta(1, 1));



  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());

  console.log(delta1, delta2, channel1.state, channel2.state)
  console.log(channel1.state)


  //await channel2.push(new Transition.UpdatePaymentSubcontract(1, 0, secret));

  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());

  //await channel2.flush();
  //await sleep(500);

  console.log(channel1.state)
  //assert(channel1.state.subcontracts.length === 0, "Payment subcontract should be resolved");
  console.log(channel1.getDelta(1, 1));
  //assert(channel1.getDelta(1, 1)?.offdelta === -150n, "Offdelta should be updated after resolving payment");

  // Test 4: Add and resolve swap subcontract
  await channel1.push(new Transition.AddDelta(1, 2));
  await channel1.flush();
  await sleep(100);

  
  await channel1.push(new Transition.AddSwapSubcontract(1, channel1.isLeft, 1, 100n, 2, 200n));
  await channel1.flush();
  await sleep(400);

  assert(channel2.state.subcontracts.length === 1, "Swap subcontract should be added");

  await channel2.push(new Transition.UpdateSwapSubcontract(1, 0, 0.5));

  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());

  await channel2.flush();
  await sleep(100);

  
  assert(channel1.state.subcontracts.length === 0, "Swap subcontract should be resolved");
  const delta1After = channel1.getDelta(1, 1);
  const delta2After = channel1.getDelta(1, 2);
  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());
  //assert(delta1After && delta1After.offdelta === -200n, "Offdelta for token 1 should be updated after resolving swap");
  //assert(delta2After && delta2After.offdelta === 100n, "Offdelta for token 2 should be updated after resolving swap");

  // Test 5: Generate and verify subchannel proofs
  const proofs = await channel1.getSubchannelProofs();
  assert(proofs.encodedProofBody.length > 0, "Subchannel proofs should be generated");
  assert(proofs.sigs.length > 0, "Proof signatures should be generated");

  console.log("All channel logic tests passed successfully!");
}

main()