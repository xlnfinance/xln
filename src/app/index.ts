import User from './User';
import TransportFactory from './TransportFactory';
import Transition from '../types/Transition';
import { TransitionMethod } from '../types/TransitionMethod';
import UserContext from './UserContext';
import StorageContext from './StorageContext';
import IUserOptions from '../types/IUserOptions';

const opt: IUserOptions = {
  hubConnectionDataList: [
    { host: '127.0.0.1', port: 10000, name: 'hub1', address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' },
  ],
  depositoryContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  jsonRPCUrl: 'http://127.0.0.1:8545',
};

const userId1 = '1';
const userId2 = '2';

const user = new User(
  new UserContext<TransportFactory, StorageContext>(new TransportFactory(), new StorageContext(), userId1, opt),
);

const user2 = new User(
  new UserContext<TransportFactory, StorageContext>(new TransportFactory(), new StorageContext(), userId2, opt),
);

Promise.all([user.start(), user2.start()]).then(async () => {
  const channel1 = await user.getChannelToUser(userId2, 'hub1');

  const channel2 = await user2.getChannelToUser(userId1, 'hub1');

  await channel1.push({ method: TransitionMethod.TextMessage, message: 'Hello world' } as Transition);
  await channel1.push({ method: TransitionMethod.TextMessage, message: '100' } as Transition);
  await channel1.send();

  await channel2.push({ method: TransitionMethod.TextMessage, message: '150' } as Transition);
  await channel2.send();

  await channel2.push({ method: TransitionMethod.TextMessage, message: '200' } as Transition);
  await channel2.send();

  await channel2.push({ method: TransitionMethod.TextMessage, message: '23' } as Transition);
  await channel2.send();

  setTimeout(() => {
    console.log('RESULT', channel1.getState(), channel2.getState());
  }, 1000);
});
