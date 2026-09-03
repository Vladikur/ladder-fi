import 'server-only';
import { z } from 'zod';

const hexPrivateKeySchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 32-byte hex private key');

const boolFromString = z
  .string()
  .optional()
  .default('false')
  .transform((v) => v.toLowerCase() === 'true' || v === '1');

const serverEnvSchema = z
  .object({
    // --- Signer ---
    SIGNER_MODE: z.enum(['env', 'keystore']).default('env'),
    PRIVATE_KEY: hexPrivateKeySchema.optional(),
    KEYSTORE_PATH: z.string().optional(),
    SIGNER_KEYSTORE_PASSWORD: z.string().optional(),

    // --- CSRF / network binding ---
    APP_TOKEN: z.string().min(16, 'APP_TOKEN must be at least 16 characters'),
    ALLOW_PUBLIC_BIND: boolFromString,

    // --- Guard-rails (TZ §5) - checked server-side, not just in the UI ---
    KILL_SWITCH: boolFromString,
    // Notional limits are denominated in USDG raw units (6 decimals) - the chain's
    // stable quote token. There is no price oracle in this app (out of scope per TZ
    // §7), so a deposit that doesn't involve USDG on either leg cannot be priced and
    // is exempt from these two checks specifically (all other guards still apply).
    MAX_NOTIONAL_PER_RUN: z.coerce.bigint().default(0n),
    MAX_NOTIONAL_PER_DAY: z.coerce.bigint().default(0n),
    MAX_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).default(200),
    MAX_POSITIONS_PER_RUN: z.coerce.number().int().min(1).max(500).default(50),
    MAX_GAS_PER_RUN: z.coerce.bigint().default(50_000_000n),

    // --- Audit ---
    AUDIT_LOG_PATH: z.string().default('./audit.jsonl'),
  })
  .superRefine((env, ctx) => {
    if (env.SIGNER_MODE === 'env' && !env.PRIVATE_KEY) {
      ctx.addIssue({ code: 'custom', message: 'PRIVATE_KEY is required when SIGNER_MODE=env' });
    }
    if (env.SIGNER_MODE === 'keystore' && !env.KEYSTORE_PATH) {
      ctx.addIssue({ code: 'custom', message: 'KEYSTORE_PATH is required when SIGNER_MODE=keystore' });
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | null = null;

/** Lazily parsed and cached - importing this module must never crash a build with no env configured yet. */
export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = serverEnvSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(`Invalid server environment:\n${parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n')}`);
  }
  cached = parsed.data;
  return cached;
}
