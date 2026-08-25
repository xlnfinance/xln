import { CandidateShell } from '../../../packages/ui/src/candidate-shell';
import { TestnetPage } from './testnet-page';
import type { WalletPage } from './wallet-model';

export function WalletApp({ page }: Readonly<{ page: WalletPage }>) {
  if (page.kind === 'testnet') return <TestnetPage />;
  return (
    <CandidateShell
      copy={{
        eyebrow: 'Financial surface',
        title: 'Wallet, independently built.',
        summary: `${page.pathname} remains on the canonical Svelte wallet while its React flow is migrated. Runtime projections stay unchanged.`,
      }}
      surfaceId="wallet"
    />
  );
}
