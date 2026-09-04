/** Shared with lib/rpc/errors.ts (server) and lib/api-client.ts (client) - no
 *  'server-only' tag here since the client needs it too, to auto-retry on this message. */
export const RPC_HICCUP_MESSAGE = 'Temporary RPC hiccup - please try again.';
