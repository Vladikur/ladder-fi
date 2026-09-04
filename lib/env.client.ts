import { z } from 'zod';

// The client never needs an RPC URL, contract address, or secret: it only ever talks
// to this app's own /api/* routes, which do all chain access server-side. This file
// exists to keep the client/server env split explicit even though it's nearly empty -
// nothing here may be renamed to drop the NEXT_PUBLIC_ prefix without becoming a leak.
const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_NAME: z.string().default('LadderFi'),
});

export const clientEnv = clientEnvSchema.parse({
  NEXT_PUBLIC_APP_NAME: process.env.NEXT_PUBLIC_APP_NAME,
});
