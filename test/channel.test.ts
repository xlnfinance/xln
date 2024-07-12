import HubApp from '../src/hub/HubApp';

import User from '../src/app/User';
import TransportFactory from '../src/app/TransportFactory';
import Transition from '../src/types/Transition';
import { TransitionMethod } from '../src/types/TransitionMethod';
import { sleep } from '../src/utils/Utils';
import UserContext from '../src/app/UserContext';
import StorageContext from '../src/app/StorageContext';
import IUserOptions from '../src/types/IUserOptions';

import ENV from './env';

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

  const channel1 = await user.getChannelToUser(userId2, 'hub1');
  const channel2 = await user2.getChannelToUser(userId1, 'hub1');

  await channel1.push({ method: TransitionMethod.TextMessage, message: 'Hello world' } as Transition);
  await channel1.push({ method: TransitionMethod.TextMessage, message: '100' } as Transition);
  await channel1.send();

  await sleep(5000);

  await channel2.push({ method: TransitionMethod.TextMessage, message: '150' } as Transition);
  await channel2.send();

  await sleep(5000);
  console.log('RESULT', channel1.getState(), channel2.getState());

  if (JSON.stringify(channel1.getState()) === JSON.stringify(channel2.getState())) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

main();
