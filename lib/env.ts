import 'server-only';
import { z } from 'zod';

const boolFromString = z
  .string()
  .optional()
  .default('false')
  .transform((v) => v.toLowerCase() === 'true' || v === '1');

const serverEnvSchema = z.object({
  // --- CSRF / network binding ---
  APP_TOKEN: z.string().min(16, 'APP_TOKEN must be at least 16 characters'),
  ALLOW_PUBLIC_BIND: boolFromString,
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
