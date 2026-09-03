import { getChain, type ChainDescriptor } from './chains';
import { getProtocol, listProtocolsForChain, type ProtocolDescriptor } from './protocols';

export interface ResolvedTarget {
  chain: ChainDescriptor;
  protocol: ProtocolDescriptor;
}

export function resolveTarget(chainId: number, protocolKey: string): ResolvedTarget {
  const chain = getChain(chainId);
  const protocol = getProtocol(chainId, protocolKey);
  return { chain, protocol };
}

export { getChain, getProtocol, listProtocolsForChain };
