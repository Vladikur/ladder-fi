'use client';

import { useEffect, useState } from 'react';

/**
 * True only once mounted on the client. The server always renders as if no wallet is
 * connected, but a previously-connected wallet can be restored from storage before
 * hydration settles, so the client's very first paint can already show it connected -
 * a structural mismatch from the server's markup that React flags as a hydration error.
 * Components that branch their rendered DOM on wallet state (useAccount/useConnect)
 * must render the disconnected shape until this flips true, then it's a normal
 * post-hydration re-render instead of a mismatch.
 */
export function useIsMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
