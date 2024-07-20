
import User from '../src/app/User';
import Channel from '../src/app/Channel';
import { sleep } from '../src/utils/Utils';
import IUserOptions from '../src/types/IUserOptions';
import ENV from './env';
import Transition from '../src/app/Transition';
import assert from 'assert';
import { ethers } from 'ethers';
import Logger from '../src/utils/Logger';

import * as crypto from 'crypto';

const logger = new Logger('ChannelLogicTest');


import {exec} from 'child_process'

async function main() {
  exec('rm -rf local-storage')
  await sleep(100)

  const opt: IUserOptions = {
    hubConnectionDataList: ENV.hubConnectionDataList,
    depositoryContractAddress: ENV.depositoryContractAddress,
    jsonRPCUrl: ENV.rpcNodeUrl
  };

  const user1 = new User(ENV.firstUserAddress, {...opt});
  const user2 = new User(ENV.secondUserAddress, {...opt});



  opt.hub = {
    host: '127.0.0.1',
    port: 10000,
    address: ENV.hubAddress
  }
  const hub = new User(ENV.hubAddress, structuredClone(opt));
  await hub.start()
  console.log("hub started")
  

  await Promise.all([user1.start(), user2.start()]);

  const channel1 = await user1.getChannel(ENV.secondUserAddress);
  const channel2 = await user2.getChannel(ENV.firstUserAddress);

  // Test 1: Basic flush and receive
  await channel1.push(new Transition.AddSubchannel(1));
  await channel1.push(new Transition.AddDelta(1, 1));
  await channel1.flush();


  console.log('compar', channel1, channel2)

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

  assert(delta1 && delta1.offdelta === 50n, "Both channels should have the same state after rollback&reapply");
  assert(delta2 && delta2.offdelta === 50n, "Both channels should have the same state after rollback&reapply");

  // Test 3: Add and resolve payment subcontract
  const secret = crypto.randomBytes(32).toString('hex');
  const paymentHash = ethers.keccak256(ethers.toUtf8Bytes(secret));

  const nextHops = [ENV.secondUserAddress];

  await sleep(700);

  console.log(channel1.state, channel2.state, channel1.data.mempool);


  await channel1.push(new Transition.AddPaymentSubcontract(1, 1, 200n, paymentHash, nextHops, {secret}));
  console.log(channel1.state, channel2.state, channel1.data.mempool);
  await channel1.flush();
  await sleep(700);
  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());

  console.log(delta1, delta2, channel1.state, channel2.state)
  console.log(channel1.state)
  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());

  assert(channel2.state.subcontracts.length === 1, "Payment subcontract should be added");
  console.log(channel1.getDelta(1, 1));

  await channel2.push(new Transition.UpdatePaymentSubcontract(1, 0, secret));
  await channel2.flush();
  await sleep(500);

  console.log(channel1.state)
  assert(channel1.state.subcontracts.length === 0, "Payment subcontract should be resolved");
  console.log(channel1.getDelta(1, 1));
  assert(channel1.getDelta(1, 1)?.offdelta === -150n, "Offdelta should be updated after resolving payment");

  // Test 4: Add and resolve swap subcontract
  await channel1.push(new Transition.AddDelta(1, 2));
  await channel1.flush();
  await sleep(100);

  
  await channel1.push(new Transition.AddSwapSubcontract(1, true, 1, 100n, 2, 200n));
  await channel1.flush();
  await sleep(100);

  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());

  assert(channel2.state.subcontracts.length === 1, "Swap subcontract should be added");

  await channel2.push(new Transition.UpdateSwapSubcontract(1, 0, 0.5));
  await channel2.flush();
  await sleep(100);

  
  assert(channel1.state.subcontracts.length === 0, "Swap subcontract should be resolved");
  const delta1After = channel1.getDelta(1, 1);
  const delta2After = channel1.getDelta(1, 2);
  console.log(await user1.renderAsciiUI());
  console.log(await user2.renderAsciiUI());
  assert(delta1After && delta1After.offdelta === -200n, "Offdelta for token 1 should be updated after resolving swap");
  assert(delta2After && delta2After.offdelta === 100n, "Offdelta for token 2 should be updated after resolving swap");

  // Test 5: Generate and verify subchannel proofs
  const proofs = await channel1.getSubchannelProofs();
  assert(proofs.encodedProofBody.length > 0, "Subchannel proofs should be generated");
  assert(proofs.sigs.length > 0, "Proof signatures should be generated");

  console.log("All channel logic tests passed successfully!");
}

main().catch(error => {
    console.log(error)
  logger.error("Test failed", error);
  process.exit(1);
});