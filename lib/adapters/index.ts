import { getProtocol, type ProtocolDescriptor } from '@/lib/registry/protocols';
import { UniswapV3ForkAdapter } from './uniswap-v3-fork';
import { UniswapV4Adapter } from './uniswap-v4';
import type { ILiquidityAdapter } from './types';

/**
 * Dispatches on protocol.family (an enum inherent to the adapter contract), never on
 * chainId or a specific protocol key - new chains/forks are added purely via registry
 * entries (TZ §4 "Критерий приёмки по расширяемости").
 */
export function getAdapter(chainId: number, protocolKey: string): ILiquidityAdapter {
  const protocol = getProtocol(chainId, protocolKey);
  return adapterForFamily(protocol);
}

function adapterForFamily(protocol: ProtocolDescriptor): ILiquidityAdapter {
  switch (protocol.family) {
    case 'univ3-fork':
      return new UniswapV3ForkAdapter(protocol);
    case 'univ4':
      return new UniswapV4Adapter(protocol);
  }
}

export * from './types';
