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

  const user = new User(userId1, opt);

  const user2 = new User(userId2, opt);

  await Promise.all([user.start(), user2.start()]);

  
  let provider = new JsonRpcProvider(ENV.rpcNodeUrl);

  const user1_signer = await provider.getSigner(ENV.firstUserAddress);

  let depository = Depository__factory.connect(ENV.depositoryContractAddress, user1_signer);
  let erc20Mock = ERC20Mock__factory.connect(ENV.erc20Address, user1_signer);
  
  const testAllowance1 = await erc20Mock.allowance(ENV.firstUserAddress, await depository.getAddress());

  await erc20Mock.approve(await depository.getAddress(), 10000);
  //await erc20Mock.transfer(await depository.getAddress(), 10000);
  
  console.log("user1_balance_before", await erc20Mock.balanceOf(ENV.firstUserAddress));
  console.log("depository_balance_before", await erc20Mock.balanceOf(await depository.getAddress()));

  const packedToken = await depository.packTokenReference(0, await erc20Mock.getAddress(), 0);
  console.log(packedToken);
  console.log(await depository.unpackTokenReference(packedToken));
  console.log(await erc20Mock.getAddress());
  /*       TODO FIX ERROR
  console.log( 
    await depository.externalTokenToReserve(
      { packedToken, internalTokenId: 0n, amount: 10n }
    ) 
  );
*/
  console.log("user1_balance_after", await erc20Mock.balanceOf(ENV.firstUserAddress))
  console.log("depository_balance_after", await erc20Mock.balanceOf(await depository.getAddress()))
  console.log("reserveTest1", await depository._reserves(ENV.firstUserAddress, 0));


  // Query the console.log events
  const filter = {
    address: await depository.getAddress(),
    topics: [
      // Add the event topics you are interested in
    ],
  };

  const logs = await provider.getLogs(filter);

  logs.forEach(log => {
    //const parsedLog = ethers.utils.defaultAbiCoder.decode(["address", "uint256", "uint256"], log.data);
    console.log(log);
  });



  await depository.reserveToCollateral({
    tokenId: 0,
    receiver: ENV.firstUserAddress,
    pairs: [{ addr: ENV.secondUserAddress, amount: 50 }]
  });

  const collateralTest = await depository._collaterals(
    await depository.channelKey(ENV.firstUserAddress, ENV.secondUserAddress), 0
    );
  const reserveTest2 = await depository._reserves(ENV.firstUserAddress, 0n);
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
