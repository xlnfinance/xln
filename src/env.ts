export interface HubData {
  name: string;
  host: string;
  port: number;
  address: string;
  publicKey: string;
}

const ENV = {
  hubAddress: '0xE9a27A7dA7C0ECCce0586b2bA4F30a20AfB524f5',
  firstUserAddress: '0x7d577a597B2742b498Cb5Cf0C26cDCD726d39E6e',
  secondUserAddress: '0xDCEceAF3fc5C0a63d195d69b1A90011B7B19650D',

  depositoryContractAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  subcontractProviderAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',

  hubDataList: [] as HubData[],

  db: {} as any,
  users: {} as any,

  profiles: {} as any,
  erc20Address:'0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  rpcNodeUrl: 'http://127.0.0.1:8545'
};

/*
ENV.hubDataList.push({ 
  host: '127.0.0.1', 
  port: 10000, 
  address: '0xE9a27A7dA7C0ECCce0586b2bA4F30a20AfB524f5', 
  name: 'test', 
  publicKey: '0xE9a27A7dA7C0ECCce0586b2bA4F30a20AfB524f5' 
})*/

export default ENV;
