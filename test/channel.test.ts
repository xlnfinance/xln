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

  const channel1 = await user.getChannelToUser(userId2, 'hub1');
  const channel2 = await user2.getChannelToUser(userId1, 'hub1');

  await channel1.getSubсhannel(0);
  await channel2.getSubсhannel(0);

  await channel1.push(new TextMessageTransition('Hello world'));
  await channel1.push(new PaymentTransition(100, 0));
  await channel1.flush();

  await sleep(5000);

  await channel2.push(new PaymentTransition(150, 0));
  await channel2.flush();

  await sleep(5000);
  console.log('RESULT', channel1.getState(), channel2.getState());
  console.log('RESULT', await channel1.getSubсhannel(0), await channel2.getSubсhannel(0));

  if (JSON.stringify(channel1.getState()) === JSON.stringify(channel2.getState())) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
