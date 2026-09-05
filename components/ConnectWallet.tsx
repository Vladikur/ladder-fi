'use client';

import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '@/lib/constants';
import { useIsMounted } from '@/lib/wallet/use-mounted';

function truncate(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function ConnectWallet() {
  const mounted = useIsMounted();
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();

  // Render the same "disconnected" shape the server rendered until the client has
  // mounted - see lib/wallet/use-mounted.ts.
  if (!mounted || !isConnected) {
    const connector = connectors[0];
    return (
      <button
        onClick={() => connector && connect({ connector })}
        disabled={!connector || isPending}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm disabled:opacity-40"
      >
        {isPending ? 'Connecting…' : connector ? 'Connect wallet' : 'No wallet found'}
      </button>
    );
  }

  if (chainId !== CHAIN_ID) {
    return (
      <button
        onClick={() => switchChain({ chainId: CHAIN_ID })}
        disabled={isSwitching}
        className="rounded bg-amber-700 px-3 py-1.5 text-sm disabled:opacity-40"
      >
        {isSwitching ? 'Switching…' : 'Switch network'}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <span className="rounded bg-neutral-800 px-2 py-1 font-mono">{truncate(address!)}</span>
      <button onClick={() => disconnect()} className="rounded bg-neutral-700 px-2 py-1 text-xs">
        Disconnect
      </button>
    </div>
  );
}
