import HubApp from './HubApp';

const hub = new HubApp({
  host: '127.0.0.1',
  port: 10000,
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  jsonRPCUrl: 'http://127.0.0.1:8545',
});
hub.start();
