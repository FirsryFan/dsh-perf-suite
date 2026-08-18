import z from '@deepseek-ai/schemastery'

export type CompressionMode = 'gzip' | 'br' | 'gzip+br' | 'none'
export type PreloadMode = 'none' | 'immediate' | 'all'

/** Plugin config surface. Every switch is additive/disableable. */
export interface Config {
  /** Which Content-Encoding(s) the plugin may emit when the request accepts them. */
  compression?: CompressionMode
  /** Emit `Cache-Control: public, max-age=31536000, immutable` for content-addressed URLs. */
  immutableCache?: boolean
  /** Inject `<link rel="preload" as="script">` for client bundle entries via tapIndex. */
  preloadClientBundles?: PreloadMode
  /** Maximum number of compressed-buffer cache entries. */
  cacheMaxEntries?: number
  /** Maximum total bytes of cached compressed buffers. */
  cacheMaxBytes?: number
  /** Log one bytes-served summary line when the plugin unloads. */
  logSummary?: boolean
  /**
   * Probe the official server at startup for each optimization point and skip
   * any point the official code already implements, so a stale plugin version
   * degrades gracefully after upstream adopts the same fix.
   */
  autoDetect?: boolean
  /** Timeout for one official-capability probe request, in milliseconds. */
  probeTimeoutMs?: number
}

/** Config with schema defaults applied. */
export interface ResolvedConfig {
  compression: CompressionMode
  immutableCache: boolean
  preloadClientBundles: PreloadMode
  cacheMaxEntries: number
  cacheMaxBytes: number
  logSummary: boolean
  autoDetect: boolean
  probeTimeoutMs: number
}

export const Config: z<Config> = z.object({
  compression: z.union([
    z.const('gzip').description('gzip only'),
    z.const('br').description('brotli only'),
    z.const('gzip+br').description('brotli when accepted, otherwise gzip'),
    z.const('none').description('disable compression'),
  ]).default('gzip').description('Which Content-Encoding(s) the plugin may emit'),
  immutableCache: z.boolean().default(true).description('Emit immutable Cache-Control for content-addressed shell assets and plugin bundles'),
  preloadClientBundles: z.union([
    z.const('none').description('inject no preload links'),
    z.const('immediate').description('preload only immediately:true boot entries'),
    z.const('all').description('preload every client bundle entry'),
  ]).default('immediate').description('Client bundle preload links injected into index.html'),
  cacheMaxEntries: z.natural().max(4096).default(128).description('Maximum compressed-buffer cache entries'),
  cacheMaxBytes: z.natural().max(1073741824).default(67108864).description('Maximum total bytes of cached compressed buffers (64 MiB default)'),
  logSummary: z.boolean().default(false).description('Log one bytes-served summary line on unload'),
  autoDetect: z.boolean().default(true).description('Probe the official server and skip optimization points it already implements'),
  probeTimeoutMs: z.natural().max(10000).default(2000).description('Timeout per official-capability probe request'),
})

export function resolveConfig(input: Config | undefined): ResolvedConfig {
  const config = Config(input ?? {})
  return {
    compression: config.compression ?? 'gzip',
    immutableCache: config.immutableCache ?? true,
    preloadClientBundles: config.preloadClientBundles ?? 'immediate',
    cacheMaxEntries: config.cacheMaxEntries ?? 128,
    cacheMaxBytes: config.cacheMaxBytes ?? 67108864,
    logSummary: config.logSummary ?? false,
    autoDetect: config.autoDetect ?? true,
    probeTimeoutMs: config.probeTimeoutMs ?? 2000,
  }
}
