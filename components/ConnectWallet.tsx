'use client';

import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { CHAIN_ID } from '@/lib/constants';
import { useIsMounted } from '@/lib/wallet/use-mounted';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Spinner } from '@/components/ui/spinner';

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
      <Button onClick={() => connector && connect({ connector })} disabled={!connector || isPending} size="sm">
        {isPending && <Spinner />}
        {isPending ? 'Connecting…' : connector ? 'Connect wallet' : 'No wallet found'}
      </Button>
    );
  }

  if (chainId !== CHAIN_ID) {
    return (
      <Button onClick={() => switchChain({ chainId: CHAIN_ID })} disabled={isSwitching} size="sm" variant="outline">
        {isSwitching && <Spinner />}
        {isSwitching ? 'Switching…' : 'Switch network'}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <Badge variant="secondary" className="font-mono">
        {truncate(address!)}
      </Badge>
      <Button onClick={() => disconnect()} size="sm" variant="secondary">
        Disconnect
      </Button>
    </div>
  );
}
