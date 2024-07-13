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
import TextMessageTransition from '../src/types/Transitions/TextMessageTransition';

import { Signer, verifyMessage as ethersVerifyMessage, JsonRpcProvider } from 'ethers';
import { Depository, Depository__factory, ERC20Mock, ERC20Mock__factory, ERC721Mock, ERC721Mock__factory, ERC1155Mock, ERC1155Mock__factory } from '../contracts/typechain-types/index';
import { TransferReserveToCollateralEvent } from '../contracts/typechain-types/contracts/Depository.sol/Depository';

async function Test() {
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

  
  let provider = new JsonRpcProvider(ENV.rpcNodeUrl);

  const user1_signer = await provider.getSigner(ENV.firstUserAddress);

  let depository = Depository__factory.connect(ENV.depositoryContractAddress, user1_signer);
  let erc20Mock = ERC20Mock__factory.connect(ENV.erc20Address, user1_signer);
  
  erc20Mock.transfer(ENV.firstUserAddress, 5000);

  await erc20Mock.approve(await depository.getAddress(), 10000);

  const testBalance3 = await erc20Mock.balanceOf(await depository.getAddress());
  const testAllowance = await erc20Mock.allowance(ENV.firstUserAddress, ENV.depositoryContractAddress);

  const packedToken = await depository.packTokenReference(0, await erc20Mock.getAddress(), 0);
        
  await depository.externalTokenToReserve(
    { packedToken, internalTokenId: 0n, amount: 1n }
  );

  const reserveTest1 = await depository._reserves(ENV.firstUserAddress, 0);

  await depository.reserveToCollateral({
    tokenId: 0,
    receiver: ENV.firstUserAddress,
    pairs: [{ addr: ENV.secondUserAddress, amount: 50 }]
  });

  const collateralTest = await depository._collaterals(
    await depository.channelKey(ENV.firstUserAddress, ENV.secondUserAddress), 0
    );
  const reserveTest2 = await depository._reserves(ENV.firstUserAddress, 0);
}

async function main() {
  try {
    await Test();
  }
  catch (exp: any) {
    console.log(exp);
  }
  
}

main();
