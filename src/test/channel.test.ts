import User from '../app/User';
import { sleep } from '../utils/Utils';

import ENV from '../env';

import Logger from '../utils/Logger';

import {exec} from 'child_process'
exec('rm -rf local-storage')


  /*
async function main() {
    

  try { 
    const hub = new User(ENV.hubAddress, '');
    await hub.start();
    Logger.info('Hub started');

    const userOptions: IUserOptions = {
      hubConnectionDataList: [{
        host: '127.0.0.1',
        port: 10000,

        address: ENV.hubAddress
      }],
      depositoryContractAddress: ENV.depositoryContractAddress,
      jsonRPCUrl: ENV.rpcNodeUrl,
      onExternalChannelRequestCallback: () => true // Allow external channel requests for testing
    };

    const user1 = new User(ENV.firstUserAddress, '');
    const user2 = new User(ENV.secondUserAddress, '');

    await Promise.all([user1.start(), user2.start()]);
    Logger.info('Users started');

    const channel1 = await user1.getChannel(ENV.secondUserAddress);
    const channel2 = await user2.getChannel(ENV.firstUserAddress);

    // Ensure subchannel 0 exists
    await channel1.addSubchannel(0);
    await channel2.addSubchannel(0);

    await channel1.push(new TextMessageTransition('Hello world'));
    await channel1.push(new PaymentTransition(0, 0, 100));
    await channel1.flush();

    Logger.info('Channel 1 messages sent');

    await sleep(5000);

    await channel2.push(new PaymentTransition(0, 0, 150));
    await channel2.flush();

    Logger.info('Channel 2 messages sent');

    await sleep(5000);

    Logger.info('RESULT Channel 1 State:', channel1.getState());
    Logger.info('RESULT Channel 2 State:', channel2.getState());

    const subchannel1 = await channel1.getSubchannel(0);
    const subchannel2 = await channel2.getSubchannel(0);

    Logger.info('RESULT Subchannel 1:', subchannel1);
    Logger.info('RESULT Subchannel 2:', subchannel2);

    if (JSON.stringify(channel1.getState()) === JSON.stringify(channel2.getState())) {
      Logger.info('Test passed: Channel states match');
      process.exit(0);
    } else {
      Logger.error('Test failed: Channel states do not match');
      process.exit(1);
    }
  } catch (error) {
    Logger.error('Test failed with error:', error);
    process.exit(1);
  }
}

main().catch(error => {
  logger.error('Unhandled error in main:', error);
  process.exit(1);
});
    */