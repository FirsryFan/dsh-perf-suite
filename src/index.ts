/**
 * @dsh-external/dsh-perf-suite — unified DSH performance plugin.
 *
 * Merged from:
 * - dsh-pref-kit         → stream coalescing (chatContainment/rowManager removed)
 * - dsh-session-slim     → history/live sourceEventSeqs stripping + settled chunk pruning
 * - dsh-plugin-perf      → gzip/brotli + immutable cache + preload for web resources
 * - dsh-webui-perf       → WebUI performance switch channel (source patches in patches/)
 * - dsh-chat-content-visibility-auto → content-visibility CSS in client half
 * - dsh-large-proj-perf  → optional large-session fork/projection/materialize patches
 *
 * `contextCompression` (dsh-compressor) is not yet wired into this unified
 * package; it remains available as a separate plugin and is planned for a later
 * round.
 */
import type { Context } from 'cordis'
import z from '@deepseek-ai/schemastery'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { coalesceStream } from './host/coalescer.js'
import { installSessionSlim, type SessionSlimContext } from './host/session-slim.js'
import { mountWebPerf } from './host/webperf/perf.js'
import { resolveConfig, type Config as WebPerfConfig, type CompressionMode, type PreloadMode } from './host/webperf/config.js'
import { ContextPool } from './host/context-pool/pool.js'
import { installContextPool } from './host/context-pool/index.js'
import { poolToolResult } from './host/context-pool/auto.js'

// Large-session monkey-patch module is plain JS and intentionally kept separate.
// @ts-expect-error -- no bundled type declarations for the vendored JS module
import { apply as applyLargeSession } from './host/large-session.js'

export const name = '@dsh-external/dsh-perf-suite'
export const inject = ['llm', 'apiProxy', 'webServer', 'sessions']

export interface Config {
  windowMs?: number
  webCompression?: CompressionMode
  immutableCache?: boolean
  preloadClientBundles?: PreloadMode
  webuiPerfEnabled?: boolean
  contentVisibility?: boolean
  contextCompression?: boolean
  contextPool?: boolean
  poolThreshold?: number
  largeSessionPerf?: boolean
}

export const Config = z.object({
  windowMs: z.number().min(0).max(200).default(30),
  webCompression: z.string().default('gzip+br') as never,
  immutableCache: z.boolean().default(true),
  preloadClientBundles: z.string().default('immediate') as never,
  webuiPerfEnabled: z.boolean().default(true),
  contentVisibility: z.boolean().default(true),
  contextCompression: z.boolean().default(false),
  contextPool: z.boolean().default(true),
  poolThreshold: z.number().min(100).max(100000).default(4000),
  largeSessionPerf: z.boolean().default(false),
})

type AppContext = Context & {
  llm: {
    stream(options: unknown): AsyncIterable<StreamChunk>
  }
  on(event: string, listener: (...args: any[]) => unknown): unknown
  inject<T extends string>(services: T[], callback: (ctx: Context & Record<T, unknown>) => void): unknown
  baseUrl?: string
  logger?: { info(msg: string): void; warn(msg: string): void }
}

export function apply(ctx: AppContext, config: Config): void {
  const windowMs = config.windowMs ?? 30

  // 1) Stream coalescing (dsh-pref-kit).
  ctx.on('llm/stream', (_options: unknown, next: () => AsyncIterable<StreamChunk>) =>
    coalesceStream(next(), windowMs))

  // 2) Session history/live optimization (dsh-session-slim).
  ctx.inject(['apiProxy'], (sctx) => {
    installSessionSlim(sctx as unknown as SessionSlimContext)
  })

  // 3) Web resource compression/cache/preload (dsh-plugin-perf).
  const webPerfConfig: WebPerfConfig = {
    compression: config.webCompression as CompressionMode,
    immutableCache: config.immutableCache,
    preloadClientBundles: config.preloadClientBundles as PreloadMode,
    autoDetect: true,
  }
  const resolvedWebPerf = resolveConfig(webPerfConfig)
  ctx.inject(['webServer'], (httpCtx) => {
    const webServer = (httpCtx as unknown as { webServer: Parameters<typeof mountWebPerf>[0]['webServer'] }).webServer
    httpCtx.effect(async () => mountWebPerf({
      webServer,
      baseUrl: ctx.baseUrl,
      config: resolvedWebPerf,
      logger: ctx.logger,
      getClientModules: () => (httpCtx as unknown as { get(name: 'clientModules'): unknown }).get('clientModules') as never,
    }), '@dsh-external/dsh-perf-suite: web perf routes')
  })

  // 4) Context Pool: on-demand expansion for long tool results.
  const contextPool = new ContextPool()
  if (config.contextPool !== false) {
    installContextPool(ctx as never, contextPool)
    const poolThreshold = config.poolThreshold ?? 4000
    ctx.on('tools/post-execute', async (_exec: unknown, result: unknown, next: () => unknown) => {
      const decision = await next() as Parameters<typeof poolToolResult>[0] | undefined
      return poolToolResult(decision ?? {}, result, contextPool, poolThreshold)
    })
    ctx.logger?.info?.(`[dsh-perf-suite] context pool active (threshold ${poolThreshold})`)

    // Debug/status route: prove the pool is live and how many entries it holds.
    ctx.inject(['webServer'], (httpCtx) => {
      const webServer = (httpCtx as unknown as { webServer: { register(route: unknown): () => void } }).webServer
      httpCtx.effect(() => webServer.register({
        kind: 'exact',
        path: '/dsh-perf-suite/pool/stats',
        handler: (_req: unknown, res: { writeHead(code: number, headers?: Record<string, string>): void; end(body: string): void }) => {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({
            ok: true,
            entries: contextPool.size,
            tools: ['context_pool_explore', 'context_pool_fetch'],
            threshold: poolThreshold,
          }))
        },
      }), '@dsh-external/dsh-perf-suite: pool stats route')
    })
  }

  // 5) Optional large-session monkey-patches (dsh-large-proj-perf).
  if (config.largeSessionPerf === true) {
    ctx.inject(['sessions'], (sctx) => {
      const disposer = applyLargeSession(sctx, {})
      ctx.effect(() => disposer, '@dsh-external/dsh-perf-suite: large-session patches')
    })
  }

  // 6) Optional context compression (dsh-compressor).
  if (config.contextCompression === true) {
    void (async () => {
      try {
        const mod = await import('./host/compressor/index.js')
        mod.apply(ctx as never)
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-perf-suite] context compression failed to load: ${String(error)}`)
      }
    })()
  }

  ctx.logger?.info?.('[dsh-perf-suite] unified performance plugin active')
}
