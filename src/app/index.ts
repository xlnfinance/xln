import  User  from './User';
import { XLNTerminal } from './XLNTerminal';
import { XLNInteractiveDashboard } from './XLNInteractiveDashboard';
import { XLNCommandLine } from './XLNCommandLine';

async function main() {
  const email = process.env.XLN_EMAIL;
  const password = process.env.XLN_PASSWORD;

  if (!email || !password) {
    console.error('Please set XLN_EMAIL and XLN_PASSWORD environment variables');
    process.exit(1);
  }

  const user = new User(email, password);
  await user.start();

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
  }
}

main().catch(console.error);