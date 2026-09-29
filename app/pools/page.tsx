'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Header } from '@/components/Header';
import { PoolSearch } from '@/components/PoolSearch';
import { GeckoPoolsTable } from '@/components/GeckoPoolsTable';
import type { PoolListItem } from '@/lib/adapters/pool-search';
import { CHAIN_ID, EXPLORER_URL } from '@/lib/constants';
import { Button } from '@/components/ui/button';

export default function PoolsPage() {
  const router = useRouter();
  const [protocol, setProtocol] = useState<'uniswap-v3' | 'uniswap-v4'>('uniswap-v4');
  const [searchToken, setSearchToken] = useState('');

  function handleSelect(pool: PoolListItem) {
    router.push(`/pools/${pool.ref.id}?protocol=${protocol}`);
  }

  return (
    <main className="min-h-screen">
      <Header />
      <div className="mx-auto max-w-6xl space-y-8 p-6">
        <div>
          <h1 className="text-2xl font-semibold">Pools</h1>
          <p className="text-sm text-muted-foreground">Browse pools by trading volume, or look one up directly by token/pool address.</p>
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Manual lookup</h2>
          <p className="text-sm text-muted-foreground">Search on-chain by token address, or look up a pool directly (fallback for pools GeckoTerminal hasn&apos;t indexed yet).</p>

          <div className="flex gap-2">
            {(['uniswap-v3', 'uniswap-v4'] as const).map((p) => (
              <Button key={p} variant={protocol === p ? 'default' : 'secondary'} onClick={() => setProtocol(p)}>
                {p === 'uniswap-v3' ? 'Uniswap v3' : 'Uniswap v4'}
              </Button>
            ))}
          </div>

          <PoolSearch
            chainId={CHAIN_ID}
            protocol={protocol}
            explorerUrl={EXPLORER_URL}
            token={searchToken}
            onTokenChange={setSearchToken}
            onSelect={handleSelect}
          />
        </section>

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Top pools</h2>
          <GeckoPoolsTable />
        </section>
      </div>
    </main>
  );
}
