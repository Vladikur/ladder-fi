import 'server-only';
import { RPC_HICCUP_MESSAGE } from './hiccup';

/**
 * The chain's RPC node occasionally truncates JSON-RPC batch responses under load,
 * which trips a viem bug (it indexes the batch response array by request order and
 * assumes one entry per request) and surfaces as this exact generic message. It's
 * transient and retrying shortly after usually works, so tell the user that instead
 * of leaking viem's internal "Cannot read properties of undefined" crash text.
 */
const RPC_GLITCH_PATTERN = /unknown rpc error|cannot read properties of undefined \(reading 'error'\)/i;

export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'Unknown error';
  if (RPC_GLITCH_PATTERN.test(message)) {
    return RPC_HICCUP_MESSAGE;
  }
  return message;
}
