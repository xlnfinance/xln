import User from '../src/app/User';
import { sleep } from '../src/utils/Utils';
import IUserOptions from '../src/types/IUserOptions';

import ENV from './env';

import { channel } from 'diagnostics_channel';

import {encode, decode} from '../src/utils/Codec';



import Transition from '../src/types/Transition';

async function main() {


  const opt: IUserOptions = {
    hubConnectionDataList: [{ host: '127.0.0.1', port: 10000, address: ENV.hubAddress }],
    depositoryContractAddress: ENV.depositoryContractAddress,
    jsonRPCUrl: ENV.rpcNodeUrl,
  };

  const clone = (obj: any)=> {
    return decode(encode(obj));
  }

  const user = new User(ENV.firstUserAddress, clone(opt));
  const user2 = new User(ENV.secondUserAddress, clone(opt));


  opt.hub = {
    host: '127.0.0.1',
    port: 10000,
    address: ENV.hubAddress
  }
  const hub = new User(ENV.hubAddress, opt);

  await hub.start()
  console.log("hub started")
  
  await sleep(1000)

  await Promise.all([user.start(), user2.start()]);



  


  let channel1 = await user.getChannel(ENV.hubAddress);
  let channel2 = await user2.getChannel(ENV.hubAddress);



  await channel1.push(new Transition.AddSubchannel(1));

  await channel1.flush()

 
  await channel2.push(new Transition.AddSubchannel(1));
  await channel2.flush()

 


  //await channel1.push(new ProposedEventTransition(ENV.hubAddress, 1, 1, 10n))
  //await channel1.flush()

  await sleep(2000);

  //}, 1000)
  //await user2.addSubchannel(ENV.hubAddress, 1);
  //await channel2.flush()

  //await user2.setCreditLimit(ENV.hubAddress, 1, 1, 100n);
 // await channel2.flush()
  //await sleep(5000);
  let hubch1 = await hub.getChannel(ENV.firstUserAddress);
  let hubch2 = await hub.getChannel(ENV.secondUserAddress);
  //console.log(hubch.getState())

  channel1 = await user.getChannel(ENV.hubAddress);
  channel2 = await user2.getChannel(ENV.hubAddress);

  console.log(channel1.getState(), hubch1.getState(), channel2.getState(), hubch2.getState())


}

main();
