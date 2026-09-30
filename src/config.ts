/** Validated deployment policy; server counts own capacity, client policy owns reserves. */
import { z } from 'zod'
import Schema from '@deepseek-ai/schemastery'

const endpoint = z.string().refine(value => {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
  } catch { return false }
}, 'Use an HTTP(S) base URL without credentials, query or fragment')
export const configSchema = z
  .object({
    provider: z.string().min(1).default('ninfer-local'),
    baseURL: endpoint,
    credentialRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
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
  .refine(value => new Set(value.models.map(model => model.id)).size === value.models.length, 'Model identifiers must be unique')
export type Config = z.input<typeof configSchema>
export type Settings = z.output<typeof configSchema>

/** Native editable configuration; an empty connection remains configurable without registering a route. */
export const Config = Schema.object({
  provider: Schema.string().default('ninfer-local'),
  baseURL: Schema.string().default(''),
  credentialRef: Schema.string().role('credential-ref').default('NINFER_API_KEY'),
  models: Schema.array(Schema.object({
    id: Schema.string().required(), name: Schema.string(),
    contextWindow: Schema.number().step(1).min(1).required(),
    maxTokens: Schema.number().step(1).min(1),
  })).default([]),
  contentReserve: Schema.number().step(1).min(1).default(16384),
  safetyMargin: Schema.number().step(1).min(0).default(4096),
  compactionThreshold: Schema.number().min(0.000001).max(1).default(0.7),
  requestTimeoutMs: Schema.number().step(1).min(1).max(2147483647).default(1800000),
}).default({}).volatile()

/** Validate incomplete setup as well as full configurations before persistence. */
export function validateConfiguration(value: unknown): void {
  const setup = Config(value as Config).get()
  configSchema.parse({
    ...setup,
    baseURL: setup.baseURL || 'http://localhost/v1',
    models: setup.models.length ? setup.models : [{ id: 'setup', contextWindow: 131072 }],
  })
}
