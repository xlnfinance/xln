
import User from '../src/app/User';
import Channel from '../src/app/Channel';
import { sleep } from '../src/utils/Utils';
import IUserOptions from '../src/types/IUserOptions';
import ENV from './env';
import Transition from '../src/app/Transition';
import assert from 'assert';
import { ethers } from 'ethers';
import Logger from '../src/utils/Logger';


const logger = new Logger('ChannelLogicTest');


import {exec} from 'child_process'
exec('rm -rf local-storage')

async function main() {
    
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

  await sleep(100);
  await channel1.load();
  await channel2.load();

  // Check that only one payment was applied (the one from the left channel)
  const delta1 = channel1.getDelta(1, 1);
  const delta2 = channel2.getDelta(1, 1);
  assert(delta1 && delta1.offdelta === 50n, "Both channels should have the same state after rollback&reapply");
  assert(delta2 && delta2.offdelta === 50n, "Both channels should have the same state after rollback&reapply");

  // Test 3: Add and resolve payment subcontract
  const paymentHash = ethers.keccak256(ethers.toUtf8Bytes("secret"));
  await channel1.push(new Transition.AddPayment(1, 1, 200n, paymentHash));
  await channel1.flush();
  await sleep(100);
  await channel2.load();

  assert(channel2.getSubchannel(1)?.subcontracts.length === 1, "Payment subcontract should be added");

  await channel2.push(new Transition.ResolvePayment(1, 0, "secret"));
  await channel2.flush();
  await sleep(100);
  await channel1.load();

  assert(channel1.getSubchannel(1)?.subcontracts.length === 0, "Payment subcontract should be resolved");
  assert(channel1.getDelta(1, 1)?.offdelta === 100n, "Offdelta should be updated after resolving payment");

  // Test 4: Add and resolve swap subcontract
  await channel1.push(new Transition.AddDelta(1, 2));
  await channel1.flush();
  await sleep(100);
  await channel2.load();

  await channel1.push(new Transition.AddSwap(1, true, 1, 100n, 2, 200n));
  await channel1.flush();
  await sleep(100);
  await channel2.load();

  assert(channel2.getSubchannel(1)?.subcontracts.length === 1, "Swap subcontract should be added");

  await channel2.push(new Transition.ResolveSwap(1, 0, 0.5));
  await channel2.flush();
  await sleep(100);
  await channel1.load();

  assert(channel1.getSubchannel(1)?.subcontracts.length === 0, "Swap subcontract should be resolved");
  const delta1After = channel1.getDelta(1, 1);
  const delta2After = channel1.getDelta(1, 2);
  assert(delta1After && delta1After.offdelta === 50n, "Offdelta for token 1 should be updated after resolving swap");
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