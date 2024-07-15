import HubApp from '../src/hub/HubApp';

import User from '../src/app/User';
import { sleep } from '../src/utils/Utils';
import IUserOptions from '../src/types/IUserOptions';

import ENV from './env';
import TextMessageTransition from '../src/types/Transitions/TextMessageTransition';
import PaymentTransition from '../src/types/Transitions/PaymentTransition';

async function main() {
  const hub = new HubApp({
    host: '127.0.0.1',
    port: 10000,
    address: ENV.hubAddress,
    jsonRPCUrl: ENV.rpcNodeUrl,
  });
  await hub.start();

  const opt: IUserOptions = {
    hubConnectionDataList: [{ host: '127.0.0.1', port: 10000, name: 'hub1', address: ENV.hubAddress }],
    depositoryContractAddress: ENV.depositoryContractAddress,
    jsonRPCUrl: ENV.rpcNodeUrl,
  };

  const userId1 = ENV.firstUserAddress;
  const userId2 = ENV.secondUserAddress;

  const user = new User(userId1, opt);
  const user2 = new User(userId2, opt);

  await Promise.all([user.start(), user2.start()]);

  const channel1 = await user.getChannelToHub('hub1');
  //const channel2 = await user2.getChannelToHub('hub1');

  //await channel1.createSubсhannel(1);
  await user.createSubchannel('hub1', 1);
  //channel2.getSubChannel(1);

  await sleep(5000);
}

main();
