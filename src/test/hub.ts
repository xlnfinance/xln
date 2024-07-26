import User from '../app/User';
import ENV from '../env';
import fs from 'fs';
import path from 'path';


let globalHub: User | null = null;

export async function setupGlobalHub(port: number) {
  if (globalHub) {
    await globalHub.stop();
    throw new Error('Global hub already exists');
  }
  globalHub = new User('hub', 'hubpassword');
  
  ENV.hubAddress = globalHub.thisUserAddress;
  ENV.hubDataList = [{
    name: globalHub.username,
    host: '127.0.0.1',
    port: port,
    address: globalHub.thisUserAddress,
    publicKey: globalHub.encryptionKey.publicKey.toHex()
  }];
  console.log(ENV.hubDataList);
  await globalHub.start();

  return globalHub;
}

export async function teardownGlobalHub() {
  if (globalHub) {
    await globalHub.stop();
    globalHub = null;
    //await fs.remove(path.join(__dirname, '..', '..', 'local-storage')); 
  }
}