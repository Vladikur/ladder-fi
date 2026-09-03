'use client';

import { useState } from 'react';
import { Banner } from '@/components/Banner';
import { Header } from '@/components/Header';
import { PositionsPanel } from '@/components/PositionsPanel';
import { CHAIN_ID } from '@/lib/constants';

export default function AllPositionsPage() {
  const [protocol, setProtocol] = useState<'uniswap-v3' | 'uniswap-v4'>('uniswap-v4');

  return (
    <main className="min-h-screen">
      <Banner />
      <Header />
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        <h1 className="text-2xl font-semibold">All positions — every token</h1>

        <div className="flex gap-2">
          {(['uniswap-v3', 'uniswap-v4'] as const).map((p) => (
            <button
              key={p}
              onClick={() => setProtocol(p)}
              className={`rounded px-3 py-1.5 text-sm ${protocol === p ? 'bg-blue-600' : 'bg-neutral-800'}`}
            >
              {p === 'uniswap-v3' ? 'Uniswap v3 (bins)' : 'Uniswap v4 (bins)'}
            </button>
          ))}
        </div>

        <PositionsPanel chainId={CHAIN_ID} protocol={protocol} />
      </div>
    </main>
  );
}
