import HubApp from '../src/hub/HubApp';

import User from '../src/app/User';
import { sleep } from '../src/utils/Utils';
import IUserOptions from '../src/types/IUserOptions';

import ENV from './env';
import TextMessageTransition from '../src/types/Transitions/TextMessageTransition';
import PaymentTransition from '../src/types/Transitions/PaymentTransition';
import { channel } from 'diagnostics_channel';

async function main() {
  const hub = new HubApp({
    host: '127.0.0.1',
    port: 10000,
    address: ENV.hubAddress,
    jsonRPCUrl: ENV.rpcNodeUrl,
  });
  await hub.start();

  const user_hub_name: string = 'usr_hub';

  const opt: IUserOptions = {
    hubConnectionDataList: [{ host: '127.0.0.1', port: 10000, name: user_hub_name, address: ENV.hubAddress }],
    depositoryContractAddress: ENV.depositoryContractAddress,
    jsonRPCUrl: ENV.rpcNodeUrl,
  };

  const userId1 = ENV.firstUserAddress;
  const userId2 = ENV.secondUserAddress;

  const user = new User(userId1, opt);
  const user2 = new User(userId2, opt);

  await Promise.all([user.start(), user2.start()]);



  
  
  const channel2 = await user2.getChannel(user_hub_name);

  //await channel1.createSubсhannel(1);
  const channel1 = await user.getChannel(user_hub_name);

    
  await user.createSubchannel(user_hub_name, 1);

  await channel1.flush()
 
  //await user2.createSubchannel(user_hub_name, 1);
  //channel2.getSubChannel(1);

  //setTimeout(()=>{
    //channel1.flush();

  user.test_reserveToCollateral(user_hub_name, 1, 1, 10n);
  console.log(channel1)
 
  channel1.flush()
  //}, 1000)
  //await user2.setCreditLimit(user_hub_name, 1, 1, 100n);
  //channel2.flush()
  //await sleep(5000);

}

main();
