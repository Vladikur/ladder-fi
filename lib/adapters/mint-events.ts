import { decodeEventLog } from 'viem';
import { erc721TransferEvent } from './abis';

/**
 * Both the v3 NonfungiblePositionManager and the v4 PositionManager are plain ERC721s,
 * so a newly-minted position is always exactly a Transfer(from=0x0, to=owner, tokenId)
 * log from the position manager itself - protocol-agnostic, unlike v3's IncreaseLiquidity
 * event (which v4's PositionManager doesn't emit at all). Client-safe (no 'server-only')
 * since the wallet's own receipt is decoded in the browser now, not on the server.
 */
export function extractMintedTokenIds(
  logs: readonly { address: string; topics: readonly `0x${string}`[]; data: `0x${string}` }[],
  positionManager: `0x${string}`,
): string[] {
  const ids: string[] = [];
  for (const log of logs) {
    if (log.address.toLowerCase() !== positionManager.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({
        abi: erc721TransferEvent,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      if (decoded.args.from === '0x0000000000000000000000000000000000000000') {
        ids.push(decoded.args.tokenId.toString());
      }
    } catch {
      // not a Transfer log - ignore
    }
  }
  return ids;
}
