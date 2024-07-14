import HubApp from '../src/hub/HubApp';

import User from '../src/app/User';
import TransportFactory from '../src/app/TransportFactory';
import { sleep } from '../src/utils/Utils';
import UserContext from '../src/app/UserContext';
import StorageContext from '../src/app/StorageContext';
import IUserOptions from '../src/types/IUserOptions';

import ENV from './env';
import TextMessageTransition from '../src/types/Transitions/TextMessageTransition';

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

  const user = new User(
    new UserContext<TransportFactory, StorageContext>(new TransportFactory(), new StorageContext(), userId1, opt),
  );

  const user2 = new User(
    new UserContext<TransportFactory, StorageContext>(new TransportFactory(), new StorageContext(), userId2, opt),
  );

  await Promise.all([user.start(), user2.start()]);

  const channel1 = await user.getChannelToHub('hub1');
  const channel2 = await user2.getChannelToHub('hub1');

  const subChannel12 = await channel1.openSubChannel(userId2, 0);
  const subChannel21 = await channel2.openSubChannel(userId1, 0);

  await subChannel12.push(new TextMessageTransition('Hello world'));
  await subChannel12.push(new TextMessageTransition('100'));
  await subChannel12.send();

  await sleep(5000);

  await subChannel21.push(new TextMessageTransition('150'));
  await subChannel21.send();

  await sleep(5000);
  console.log('RESULT', subChannel12.getState(), subChannel21.getState());

  if (JSON.stringify(subChannel12.getState()) === JSON.stringify(subChannel21.getState())) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
