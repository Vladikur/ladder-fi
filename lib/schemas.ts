import { z } from 'zod';

/** Validates a 0x-prefixed 40-hex-char address and brands the output as the viem Address literal type. */
export const addressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'must be a 0x-prefixed 40-hex-char address')
  .transform((v) => v as `0x${string}`);

/** A pool identifier: a contract address (v3-family) or a 32-byte PoolId (v4's singleton PoolManager). */
export const poolIdSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$|^0x[a-fA-F0-9]{64}$/, 'must be a 0x-prefixed 40-hex-char address or 64-hex-char PoolId')
  .transform((v) => v as `0x${string}`);

export const decimalStringSchema = z.string().regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal number');
