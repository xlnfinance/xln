const fs = require('fs');

// Read the compiled artifact
const artifact = JSON.parse(fs.readFileSync('artifacts/contracts/Depository.sol/Depository.json', 'utf8'));

// Find the processBatch function
const processBatchAbi = artifact.abi.find(item => item.name === 'processBatch');

if (processBatchAbi) {
  console.log('✅ Found processBatch function in ABI');
  
  // Extract the function signature for ethers
  const ethers = require('ethers');
  const iface = new ethers.Interface(artifact.abi);
  const fragment = iface.getFunction('processBatch');
  
  console.log('\n🔍 Function signature for ethers ABI:');
  console.log(fragment.format());
  
  console.log('\n🔍 Function selector:');
  console.log(fragment.selector);
  
} else {
  console.log('❌ processBatch function not found in ABI');
}

// Also extract other key functions
const keyFunctions = ['debugFundReserves', 'processBatch', 'watchtowerCounterDispute', '_reserves'];
console.log('\n🔍 Other key functions:');

keyFunctions.forEach(name => {
  const func = artifact.abi.find(item => item.name === name);
  if (func) {
    const ethers = require('ethers');
    const iface = new ethers.Interface(artifact.abi);
    const fragment = iface.getFunction(name);
    console.log(`${name}: ${fragment.format()}`);
  }
});

// Events
const keyEvents = ['ReserveUpdated', 'ReserveTransferred'];
console.log('\n🔍 Key events:');

keyEvents.forEach(name => {
  const event = artifact.abi.find(item => item.name === name);
  if (event) {
    const ethers = require('ethers');
    const iface = new ethers.Interface(artifact.abi);
    const fragment = iface.getEvent(name);
    console.log(`${name}: ${fragment.format()}`);
  }
});
