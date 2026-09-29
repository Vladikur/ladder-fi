'use client';

import { useState } from 'react';
import { Header } from '@/components/Header';
import { PositionsPanel } from '@/components/PositionsPanel';
import { CHAIN_ID } from '@/lib/constants';
import { Button } from '@/components/ui/button';

export default function AllPositionsPage() {
  const [protocol, setProtocol] = useState<'uniswap-v3' | 'uniswap-v4'>('uniswap-v4');

  return (
    <main className="min-h-screen">
      <Header />
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">All positions — every token</h1>

        <div className="flex gap-2">
          {(['uniswap-v3', 'uniswap-v4'] as const).map((p) => (
            <Button key={p} variant={protocol === p ? 'default' : 'secondary'} onClick={() => setProtocol(p)}>
              {p === 'uniswap-v3' ? 'Uniswap v3' : 'Uniswap v4'}
            </Button>
          ))}
        </div>

        <PositionsPanel chainId={CHAIN_ID} protocol={protocol} />
      </div>
    </main>
  );
}
