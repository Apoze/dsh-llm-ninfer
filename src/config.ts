/** Validated deployment policy; server counts own capacity, client policy owns reserves. */
import { z } from 'zod'
export const configSchema = z
  .object({
    provider: z.string().min(1).default('ninfer-local'),
    baseURL: z.url(),
    credentialRef: z.string().min(1),
    models: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().optional(),
          contextWindow: z.number().int().positive(),
          maxTokens: z.number().int().positive().optional(),
        }),
      )
      .min(1),
    contentReserve: z.number().int().positive().default(16384),
    safetyMargin: z.number().int().nonnegative().default(4096),
    compactionThreshold: z.number().positive().max(1).default(0.7),
    requestTimeoutMs: z.number().int().positive().default(1800000),
  })
  .strict()
export type Config = z.input<typeof configSchema>
export type Settings = z.output<typeof configSchema>
