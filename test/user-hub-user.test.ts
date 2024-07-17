import User from '../src/app/User';
import { sleep } from '../src/utils/Utils';
import IUserOptions from '../src/types/IUserOptions';

import ENV from './env';
import TextMessageTransition from '../src/types/Transitions/TextMessageTransition';
import PaymentTransition from '../src/types/Transitions/PaymentTransition';
import { channel } from 'diagnostics_channel';

import {encode, decode} from '../src/utils/Codec';

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
    address: ENV.hubAddress,
    jsonRPCUrl: ENV.rpcNodeUrl,
  }
  const hub = new User(ENV.hubAddress, opt);

  await hub.start()
  console.log("hub started")
  
  await sleep(100)

  await Promise.all([user.start(), user2.start()]);



  
  const channel2 = await user2.getChannel(ENV.hubAddress);

  //await channel1.createSubсhannel(1);
  const channel1 = await user.getChannel(ENV.hubAddress);

    
  await user.createSubchannel(ENV.hubAddress, 1);

  await channel1.flush()

 

  //await user2.createSubchannel(ENV.hubAddress, 1);
  //channel2.getSubChannel(1);

  //setTimeout(()=>{
    //channel1.flush();

  user.test_reserveToCollateral(ENV.hubAddress, 1, 1, 10n);
  console.log(channel1)
 
  channel1.flush()
  await sleep(1000);

  //}, 1000)
  await user2.createSubchannel(ENV.hubAddress, 1);
  await channel2.flush()

  await user2.setCreditLimit(ENV.hubAddress, 1, 1, 100n);
  await channel2.flush()
  //await sleep(5000);
  const hubch = await hub.getChannel(ENV.firstUserAddress);
  console.log(hubch.getState())

}

main();
