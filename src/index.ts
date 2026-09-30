/** Native counted NInfer route, mounted once beside the other provider adapters. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { LlmAdapter, type AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { Config, configSchema, validateConfiguration } from './config.js'
import type { Config as Options } from './config.js'
import { NinferAdapter } from './adapter.js'
export { Config } from './config.js'
export { NinferAdapter } from './adapter.js'
export const name = 'llm-ninfer'
export const inject = ['llm', 'credentials', 'attachments']
/** Each prepared call retains its endpoint, model limits and budgets across later edits. */
export class LiveNinferAdapter extends LlmAdapter {
  constructor(private readonly ctx: Context, private readonly config: Volatile<Options>) { super() }
  private snapshot() { return new NinferAdapter(this.ctx, configSchema.parse(this.config.get())) }
  override providerInfo(provider: string) { return { id: provider, name: 'NInfer local' } }
  override listModels(provider: string) { return this.snapshot().listModels(provider) }
  override resolveModel(provider: string, model: string) { return this.snapshot().resolveModel(provider, model) }
  override prepareCall(provider: string, model: string, signal?: AbortSignal) { return this.snapshot().prepareCall(provider, model, signal) }
  override stream(options: Parameters<NinferAdapter['stream']>[0]) { return this.snapshot().stream(options) }
}

export function apply(ctx: Context, config: Volatile<Options>): void {
  validateConfiguration(config.get())
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  const adapter = new LiveNinferAdapter(ctx, config)
  let registration: AdapterRegistrationHandle | undefined
  let provider: string | undefined
  ctx.on('internal/config', function (_raw, next) {
    const raw = next()
    if (this !== ctx.fiber) return raw
    validateConfiguration(raw)
    const candidate = Config(raw as Options).get()
    if (candidate.provider !== provider && ctx.llm.listProviders().some(row => row.id === candidate.provider)) {
      throw new Error('This provider identifier is already used by another adapter')
    }
    return raw
  })
  const update = () => {
    const next = config.get()
    const routes = next.baseURL && next.models?.length ? [next.provider ?? 'ninfer-local'] : []
    if (registration) registration.replace(routes)
    else if (routes.length) registration = ctx.llm.registerAdapter(routes, adapter)
    provider = routes[0]
  }
  update()
  ctx.on('loader/volatile-update', update)
}
