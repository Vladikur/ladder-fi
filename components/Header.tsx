'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Header() {
  const pathname = usePathname();

  const linkClass = (href: string) =>
    `rounded px-3 py-1.5 text-sm ${pathname === href ? 'bg-blue-600' : 'bg-neutral-800 hover:bg-neutral-700'}`;

  return (
    <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-6 py-3">
        <span className="mr-2 text-sm font-semibold">Liquidity Ladder</span>
        <Link href="/" className={linkClass('/')}>
          Main
        </Link>
        <Link href="/positions" className={linkClass('/positions')}>
          All positions
        </Link>
      </div>
    </header>
  );
}
