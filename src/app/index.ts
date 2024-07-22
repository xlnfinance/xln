import  User  from './User';
import { XLNTerminal } from './XLNTerminal';
import { XLNInteractiveDashboard } from './XLNInteractiveDashboard';
import { XLNCommandLine } from './XLNCommandLine';
import { setupGlobalHub, teardownGlobalHub } from '../test/hub';



const users: Map<string, User> = new Map();


main().catch(console.error);

async function main() {
  

  setupGlobalHub(10010);
  const terminal = new XLNTerminal(users);
  await terminal.start();
  /*
  const args = process.argv.slice(2);
  if (args.includes('--interactive')) {
    const dashboard = new XLNInteractiveDashboard(user);
    dashboard.start();
  } else if (args.includes('--cli')) {
    const cli = new XLNCommandLine(user);
    cli.start();
  } else {
    const terminal = new XLNTerminal(user);
    await terminal.start();
  }*/
}

main().catch(console.error);