/** Native counted NInfer route, mounted once beside the other provider adapters. */
import type { Context } from '@deepseek-ai/cordis'
import { configSchema } from './config.js'
import type { Config } from './config.js'
import { NinferAdapter } from './adapter.js'
export type { Config } from './config.js'
export { NinferAdapter } from './adapter.js'
export const name = 'llm-ninfer'
export const inject = ['llm', 'credentials', 'attachments']
export function apply(ctx: Context, config: Config): void {
  const settings = configSchema.parse(config)
  const adapter = new NinferAdapter(ctx, settings)
  ctx.effect(() => ctx.llm.registerAdapter([settings.provider], adapter))
}
