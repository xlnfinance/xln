import { demonstrateTradingWithFrames } from './src/activate-frame-orderbook-integration';

demonstrateTradingWithFrames()
  .then(() => {
    console.log("\nDemonstration complete!");
    process.exit(0);
  })
  .catch(error => {
    console.error("Error:", error);
    process.exit(1);
  });
