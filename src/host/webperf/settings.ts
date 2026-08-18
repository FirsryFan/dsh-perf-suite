/** Durable user-settings namespace for dsh-plugin-perf, plus merge helpers. */

import z from '@deepseek-ai/schemastery'
import { resolveConfig, type Config, type CompressionMode, type PreloadMode } from './config.js'

export const PERF_SETTINGS_NAMESPACE = 'dsh-plugin-perf'

export const PerfSettingsSchema = z.object({
  compression: z.union([
    z.const('gzip'),
    z.const('br'),
    z.const('gzip+br'),
    z.const('none'),
  ]).default('gzip'),
  immutableCache: z.boolean().default(true),
  preloadClientBundles: z.union([
    z.const('none'),
    z.const('immediate'),
    z.const('all'),
  ]).default('immediate'),
  autoDetect: z.boolean().default(true),
  probeTimeoutMs: z.natural().max(10000).default(2000),
  cacheMaxEntries: z.natural().max(4096).default(128),
  cacheMaxBytes: z.natural().max(1073741824).default(67108864),
  logSummary: z.boolean().default(false),
})

export interface PerfSettings {
  compression: CompressionMode
  immutableCache: boolean
  preloadClientBundles: PreloadMode
  autoDetect: boolean
  probeTimeoutMs: number
  cacheMaxEntries: number
  cacheMaxBytes: number
  logSummary: boolean
}

/** Composition-layer defaults exposed to the settings document. */
export function perfSettingsBase(config: Config | undefined): PerfSettings {
  const resolved = resolveConfig(config)
  return {
    compression: resolved.compression,
    immutableCache: resolved.immutableCache,
    preloadClientBundles: resolved.preloadClientBundles,
    autoDetect: resolved.autoDetect,
    probeTimeoutMs: resolved.probeTimeoutMs,
    cacheMaxEntries: resolved.cacheMaxEntries,
    cacheMaxBytes: resolved.cacheMaxBytes,
    logSummary: resolved.logSummary,
  }
}

/** User settings override the bundle-patch config; absence falls back to config. */
export function mergePerfSettings(config: Config | undefined, section: PerfSettings | undefined): Config {
  if (section === undefined) return config ?? {}
  return {
    ...config ?? {},
    compression: section.compression,
    immutableCache: section.immutableCache,
    preloadClientBundles: section.preloadClientBundles,
    autoDetect: section.autoDetect,
    probeTimeoutMs: section.probeTimeoutMs,
    cacheMaxEntries: section.cacheMaxEntries,
    cacheMaxBytes: section.cacheMaxBytes,
    logSummary: section.logSummary,
  }
}
