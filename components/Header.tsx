'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { ConnectWallet } from './ConnectWallet';

export function Header() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-3">
        <span className="mr-2 text-sm font-semibold">LadderFi</span>
        <Button asChild variant={pathname === '/' ? 'default' : 'secondary'} size="sm">
          <Link href="/">Home</Link>
        </Button>
        <Button asChild variant={pathname.startsWith('/pools') ? 'default' : 'secondary'} size="sm">
          <Link href="/pools">Pools</Link>
        </Button>
        <Button asChild variant={pathname === '/positions' ? 'default' : 'secondary'} size="sm">
          <Link href="/positions">All positions</Link>
        </Button>
        <div className="ml-auto">
          <ConnectWallet />
        </div>
      </div>
    </header>
  );
}
