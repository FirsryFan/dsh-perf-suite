/**
 * Core host logic for dsh-plugin-perf. Pure functions plus small mount
 * helpers are exported separately so unit tests can exercise them with fake
 * webServer/clientModules contexts (no real dsh process needed).
 *
 * Everything here is additive: the registered routes shadow the frontend
 * fallback for exactly the paths listed in the verified extension points and
 * replicate its observable semantics (405 for non-GET/HEAD, traversal 403,
 * SPA index fallback on miss, MIME map, unknown extensions as octet-stream)
 * while adding negotiated compression and immutable caching where safe.
 */

import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, gzip } from 'node:zlib'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { CompressionMode, PreloadMode, ResolvedConfig } from './config.js'

const gzipAsync = promisify(gzip)
const brotliAsync = promisify(brotliCompress)

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Mirrors @deepseek-ai/dsh-host-frontend-static's MIME map. */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

const COMPRESSIBLE_EXT = new Set(['.html', '.js', '.css', '.svg', '.json', '.map', '.webmanifest'])

/** Structural subset of the webServer service used by this plugin. */
export interface WebServerLike {
  register(route: WebRoute): () => void
  tapIndex(transform: (html: string) => string): () => void
  applyIndexTaps(html: string): string
  /** Listening port once the webserver service is up; absent until then. */
  port?: number
  /** Bound host literal; defaults to loopback for capability probes. */
  host?: string
}

/** Structural subset of one client module graph row. */
export interface PerfGraphEntry {
  id: string
  url: string
  rev: string
  immediately?: boolean
  inject?: string[]
}

/** Structural subset of the client module graph. */
export interface PerfGraph {
  rev: string
  entries: PerfGraphEntry[]
}

/** Structural subset of the clientModules service used by this plugin. */
export interface ClientModulesLike {
  graph(): PerfGraph
  clientPath(id: string): string | undefined
  onGraphChanged(listener: () => void): () => void
}

/** Logger subset; the real ctx.logger('dsh-plugin-perf') satisfies it. */
export interface PerfLogger {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Shared counters for the optional unload summary. */
export interface PerfCounters {
  requests: number
  staticRequests: number
  bundleRequests: number
  rawBytes: number
  encodedBytes: number
}

export function createCounters(): PerfCounters {
  return { requests: 0, staticRequests: 0, bundleRequests: 0, rawBytes: 0, encodedBytes: 0 }
}

function formatBytes(bytes: number): string {
  const kib = bytes / 1024
  if (kib < 1024) return `${kib.toFixed(1)} KiB`
  return `${(kib / 1024).toFixed(1)} MiB`
}

/**
 * Parse an Accept-Encoding header into coding -> q-value. Identity is left at
 * the default 0 because we only return a coding when one is actually accepted.
 */
function parseAcceptEncoding(header: string | undefined): Map<string, number> {
  const accepted = new Map<string, number>()
  if (header === undefined) return accepted
  for (const part of header.split(',')) {
    const [rawCoding, ...params] = part.trim().split(';')
    const coding = rawCoding.trim().toLowerCase()
    if (coding === '') continue
    let q = 1
    for (const param of params) {
      const eq = param.indexOf('=')
      if (eq === -1) continue
      const key = param.slice(0, eq).trim().toLowerCase()
      if (key !== 'q') continue
      const value = Number(param.slice(eq + 1).trim())
      if (!Number.isNaN(value)) q = value
    }
    accepted.set(coding, q)
  }
  return accepted
}

/**
 * Pick the encoding to emit for one request, honoring q-values. For
 * `gzip+br`, brotli wins ties (smaller on text); gzip is the fallback.
 */
export function negotiateEncoding(
  acceptHeader: string | undefined,
  mode: CompressionMode,
): 'gzip' | 'br' | undefined {
  if (mode === 'none') return undefined
  const accepted = parseAcceptEncoding(acceptHeader)
  const q = (coding: string): number => {
    const direct = accepted.get(coding)
    if (direct !== undefined) return direct
    const star = accepted.get('*')
    return star ?? 0
  }
  if (mode === 'gzip') return q('gzip') > 0 ? 'gzip' : undefined
  if (mode === 'br') return q('br') > 0 ? 'br' : undefined
  const br = q('br')
  const gz = q('gzip')
  if (br > 0 && br >= gz) return 'br'
  if (gz > 0) return 'gzip'
  return undefined
}

function isCompressibleExt(ext: string): boolean {
  return COMPRESSIBLE_EXT.has(ext)
}

/** True for Vite-style content-hashed asset paths (e.g. `assets/index-Dqw48FrP.js`). */
export function isHashedAssetPath(pathname: string): boolean {
  return pathname.startsWith('/assets/') && /[-_][A-Za-z0-9_-]{6,}\.[A-Za-z0-9][A-Za-z0-9_-]*/i.test(pathname)
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

/**
 * Inject `<link rel="preload" as="script" fetchpriority="low">` tags for
 * client bundles. `immediate` preloads only stage-one (`immediately:true`)
 * entries; `all` preloads every entry; `none` returns the html unchanged.
 */
export function buildPreloadLinks(
  html: string,
  graph: PerfGraph | undefined,
  mode: PreloadMode,
): string {
  if (mode === 'none' || graph === undefined || graph.entries.length === 0) return html
  const entries = mode === 'immediate'
    ? graph.entries.filter(entry => entry.immediately === true)
    : graph.entries
  if (entries.length === 0) return html
  const links = entries
    .map(entry => `<link rel="preload" as="script" fetchpriority="low" href="${escapeHtmlAttribute(entry.url)}">`)
    .join('')
  const head = /<head(?:\s[^>]*)?>/i.exec(html)
  if (head === null) return `${links}${html}`
  const at = head.index + head[0].length
  return `${html.slice(0, at)}${links}${html.slice(at)}`
}

/**
 * Resolve the shell dist index without hardcoding any machine path: the
 * loader's `baseUrl` (the profile directory) is the resolution anchor whose
 * `node_modules` chain contains the installed `@deepseek-ai/dsh-web-frontend`.
 * Returns undefined when the package (or a frontend build) is absent so the
 * plugin can degrade to a no-op for static routes.
 */
export function resolveDistIndex(baseUrl: string | undefined): string | undefined {
  if (baseUrl === undefined) return undefined
  try {
    const require = createRequire(baseUrl)
    try {
      return require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')
    } catch { /* fall through */ }
    try {
      const pkgPath = require.resolve('@deepseek-ai/dsh-web-frontend/package.json')
      return join(dirname(pkgPath), 'dist', 'index.html')
    } catch { /* fall through */ }
    try {
      return require.resolve('@deepseek-ai/dsh-frontend/dist/index.html')
    } catch { /* fall through */ }
  } catch { /* invalid baseUrl */ }
  return undefined
}


/** Feature switches the plugin applies; false means "leave it to the official code". */
export interface PerfFeatureFlags {
  /** Negotiate gzip/brotli for responses served by this route. */
  compression?: boolean
  /** Emit immutable Cache-Control for content-addressed URLs. */
  cache?: boolean
}

/** What the official server already implements, as observed by startup probes. */
export interface OfficialCapabilities {
  /** Official responses already carry Content-Encoding. */
  compression: boolean
  /** Official responses already carry immutable Cache-Control. */
  cache: boolean
  /** Official index.html already preloads `/plugins/.../client.js` bundles. */
  preload: boolean
  /** True when a live official response was actually observed. */
  probed: boolean
}

interface ProbeResult {
  status?: number
  headers: IncomingMessage['headers']
  body: string
}

/** One bounded HEAD/GET probe against the already-listening local webserver. */
function probeOnce(
  host: string,
  port: number,
  path: string,
  timeoutMs: number,
  withBody: boolean,
  acceptEncoding: string,
): Promise<ProbeResult | undefined> {
  return new Promise((resolveProbe) => {
    const req = httpRequest({
      host,
      port,
      path,
      method: withBody ? 'GET' : 'HEAD',
      headers: { 'accept-encoding': acceptEncoding, connection: 'close' },
    }, (res) => {
      if (!withBody) {
        res.resume()
        resolveProbe({ status: res.statusCode, headers: res.headers, body: '' })
        return
      }
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => { body += chunk })
      res.on('end', () => resolveProbe({ status: res.statusCode, headers: res.headers, body }))
      res.on('error', () => resolveProbe(undefined))
    })
    req.setTimeout(timeoutMs, () => {
      req.destroy()
      resolveProbe(undefined)
    })
    req.on('error', () => resolveProbe(undefined))
    req.end()
  })
}

function headerValue(headers: IncomingMessage['headers'], name: string): string | undefined {
  const value = headers[name.toLowerCase()]
  if (value === undefined) return undefined
  return Array.isArray(value) ? value.join(', ') : value
}

function hasContentEncoding(headers: IncomingMessage['headers']): boolean {
  const value = headerValue(headers, 'content-encoding')
  return value !== undefined && value.trim() !== ''
}

function hasImmutableCache(headers: IncomingMessage['headers']): boolean {
  const value = headerValue(headers, 'cache-control')
  return value !== undefined && /immutable/i.test(value) && /max-age\s*=\s*[1-9]/i.test(value)
}

function hasBundlePreloads(html: string): boolean {
  return /<link\b[^>]*\brel=["']preload["'][^>]*\bhref=["']\/plugins\/[^"']+client\.js/i.test(html)
}

/** First hashed JS/CSS asset referenced by the shell index, for the static probe. */
function firstShellAssetPath(distIndex: string): string | undefined {
  try {
    const html = readFileSync(distIndex, 'utf8')
    const match = /(?:src|href)="(\/assets\/[^"]+\.(?:js|css))"/i.exec(html)
    return match?.[1]
  } catch {
    return undefined
  }
}

/**
 * Probe the official server for the static-serving features this plugin adds.
 * A failed probe leaves `probed: false`, which keeps the plugin active.
 */
export async function detectStaticCapabilities(
  webServer: WebServerLike,
  distIndex: string,
  config: ResolvedConfig,
  logger?: PerfLogger,
): Promise<OfficialCapabilities> {
  if (!config.autoDetect || webServer.port === undefined) {
    return { compression: false, cache: false, preload: false, probed: false }
  }
  const host = webServer.host ?? '127.0.0.1'
  const timeout = config.probeTimeoutMs
  const assetPath = firstShellAssetPath(distIndex) ?? '/manifest.webmanifest'
  const asset = await probeOnce(host, webServer.port, assetPath, timeout, false, 'gzip, br')
  const compression = asset?.status === 200 && hasContentEncoding(asset.headers)
  const cache = asset?.status === 200 && hasImmutableCache(asset.headers)
  const index = await probeOnce(host, webServer.port, '/', timeout, true, 'identity')
  const preload = index?.status === 200 && hasBundlePreloads(index.body)
  if (compression || cache || preload) {
    logger?.info(`dsh-plugin-perf: official server already provides static compression=${String(compression)} cache=${String(cache)} preload=${String(preload)}; the matching plugin features stay off to avoid conflicts`)
  }
  return { compression, cache, preload, probed: true }
}

/**
 * Probe the official `/plugins` route through one current bundle URL.
 * A failed probe keeps the plugin active.
 */
export async function detectBundleCapabilities(
  webServer: WebServerLike,
  clientModules: ClientModulesLike,
  config: ResolvedConfig,
  logger?: PerfLogger,
): Promise<OfficialCapabilities> {
  const first = clientModules.graph().entries[0]
  if (!config.autoDetect || webServer.port === undefined || first === undefined) {
    return { compression: false, cache: false, preload: false, probed: false }
  }
  const host = webServer.host ?? '127.0.0.1'
  const response = await probeOnce(host, webServer.port, first.url, config.probeTimeoutMs, false, 'gzip, br')
  const compression = response?.status === 200 && hasContentEncoding(response.headers)
  const cache = response?.status === 200 && hasImmutableCache(response.headers)
  if (compression || cache) {
    logger?.info(`dsh-plugin-perf: official server already provides bundle compression=${String(compression)} cache=${String(cache)}; the matching plugin features stay off to avoid conflicts`)
  }
  return { compression, cache, preload: false, probed: true }
}

/** LRU cache for compressed buffers, bounded by entries and total bytes. */
export class CompressionCache {
  private readonly map = new Map<string, Buffer>()
  private bytes = 0

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes: number,
  ) {}

  get(key: string): Buffer | undefined {
    const value = this.map.get(key)
    if (value === undefined) return undefined
    // Refresh insertion order for LRU eviction.
    this.map.delete(key)
    this.map.set(key, value)
    return value
  }

  set(key: string, value: Buffer): void {
    if (this.maxEntries <= 0 || value.length > this.maxBytes) return
    const existing = this.map.get(key)
    if (existing !== undefined) {
      this.map.delete(key)
      this.bytes -= existing.length
    }
    this.map.set(key, value)
    this.bytes += value.length
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      const buffer = this.map.get(oldest)
      if (buffer === undefined) break
      this.map.delete(oldest)
      this.bytes -= buffer.length
    }
  }

  clear(): void {
    this.map.clear()
    this.bytes = 0
  }
}

interface SendBodyOptions {
  body: Buffer
  contentType: string
  cacheControl?: string
  compressible: boolean
  /** When set, compressed output may be cached under size+mtime of this file. */
  filePath?: string
}

interface SendContext {
  config: ResolvedConfig
  cache: CompressionCache
  counters: PerfCounters
  features: PerfFeatureFlags
}

async function compressIfSmaller(body: Buffer, encoding: 'gzip' | 'br'): Promise<Buffer | undefined> {
  const compressed = encoding === 'gzip' ? await gzipAsync(body) : await brotliAsync(body)
  return compressed.length < body.length ? Buffer.from(compressed) : undefined
}

async function compressedForPath(
  filePath: string,
  body: Buffer,
  encoding: 'gzip' | 'br',
  cache: CompressionCache,
): Promise<Buffer | undefined> {
  const fileStat = await stat(filePath).catch(() => undefined)
  if (fileStat === undefined || !fileStat.isFile() || fileStat.size !== body.length) return undefined
  const key = `${filePath}\0${encoding}\0${String(fileStat.size)}\0${String(fileStat.mtimeMs)}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const compressed = await compressIfSmaller(body, encoding)
  if (compressed !== undefined) cache.set(key, compressed)
  return compressed
}

async function sendBody(
  req: IncomingMessage,
  res: ServerResponse,
  options: SendBodyOptions,
  sendCtx: SendContext,
): Promise<void> {
  let out = options.body
  const headers: Record<string, string | number> = {
    'content-type': options.contentType,
    'content-length': options.body.length,
  }
  if (options.cacheControl !== undefined) headers['cache-control'] = options.cacheControl

  let encoding: 'gzip' | 'br' | undefined
  if (options.compressible && sendCtx.config.compression !== 'none' && sendCtx.features.compression !== false) {
    headers.vary = 'Accept-Encoding'
    encoding = negotiateEncoding(req.headers['accept-encoding'], sendCtx.config.compression)
  }
  if (encoding !== undefined) {
    const compressed = options.filePath === undefined
      ? await compressIfSmaller(options.body, encoding)
      : await compressedForPath(options.filePath, options.body, encoding, sendCtx.cache)
    if (compressed !== undefined) {
      out = compressed
      headers['content-length'] = compressed.length
      headers['content-encoding'] = encoding
    }
  }

  sendCtx.counters.rawBytes += options.body.length
  sendCtx.counters.encodedBytes += out.length
  res.writeHead(200, headers)
  res.end(out)
}

interface StaticHandlerOptions {
  distRoot: string
  distIndex: string
  renderIndex: () => Promise<string>
  config: ResolvedConfig
  cache: CompressionCache
  counters: PerfCounters
  features?: PerfFeatureFlags
}

/** Replicate frontend-static serving semantics for the shadowed paths. */
export function createStaticHandler(options: StaticHandlerOptions): WebRoute['handler'] {
  const sendCtx: SendContext = {
    config: options.config,
    cache: options.cache,
    counters: options.counters,
    features: { compression: options.features?.compression ?? true, cache: options.features?.cache ?? true },
  }

  const serveIndex = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const html = await options.renderIndex()
    await sendBody(req, res, {
      body: Buffer.from(html),
      contentType: MIME['.html'],
      compressible: true,
    }, sendCtx)
  }

  return async (req, res) => {
    options.counters.requests += 1
    options.counters.staticRequests += 1
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* node:http always sets url on server requests; `?? '/'` keeps the type check honest. */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const pathname = decodeURIComponent(rawPath)
    const target = resolve(normalize(join(options.distRoot, pathname)))
    // Traversal rejection: target must be distRoot itself or stay under it.
    if (target !== options.distRoot && !target.startsWith(options.distRoot + sep)) {
      res.writeHead(403)
      res.end()
      return
    }
    if (target === options.distRoot || target === options.distIndex) {
      await serveIndex(req, res)
      return
    }
    let body: Buffer
    try {
      body = await readFile(target)
    } catch {
      // Miss (ENOENT/EISDIR) falls back to index.html with 200 (SPA routing).
      await serveIndex(req, res)
      return
    }
    const ext = extname(target)
    await sendBody(req, res, {
      body,
      contentType: MIME[ext] ?? 'application/octet-stream',
      cacheControl: sendCtx.features.cache !== false
          && options.config.immutableCache
          && isHashedAssetPath(pathname)
        ? IMMUTABLE_CACHE_CONTROL
        : undefined,
      compressible: isCompressibleExt(ext),
      filePath: target,
    }, sendCtx)
  }
}

interface BundleHandlerOptions {
  id: string
  clientModules: ClientModulesLike
  config: ResolvedConfig
  cache: CompressionCache
  counters: PerfCounters
  features?: PerfFeatureFlags
}

/**
 * Serve `/plugins/<id>/client.js` and `.map` with the same 404/405 and
 * source-map behavior as the client-modules owner, plus compression and
 * immutable caching (the bundle URL carries `?rev=<content-hash>`).
 */
export function createBundleHandler(options: BundleHandlerOptions): WebRoute['handler'] {
  const sendCtx: SendContext = {
    config: options.config,
    cache: options.cache,
    counters: options.counters,
    features: { compression: options.features?.compression ?? true, cache: options.features?.cache ?? true },
  }
  const prefix = `/plugins/${options.id}`
  const bundlePath = `${prefix}/client.js`
  const mapPath = `${prefix}/client.js.map`

  return async (req, res) => {
    options.counters.requests += 1
    options.counters.bundleRequests += 1
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* node:http always sets url on server requests; `?? '/'` keeps the type check honest. */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    const pathname = decodeURIComponent(rawPath)
    let isSourceMap: boolean
    if (pathname === bundlePath) {
      isSourceMap = false
    } else if (pathname === mapPath) {
      isSourceMap = true
    } else {
      res.writeHead(404)
      res.end()
      return
    }

    const clientPath = options.clientModules.clientPath(options.id)
    if (clientPath === undefined) {
      res.writeHead(404)
      res.end()
      return
    }
    const filePath = isSourceMap ? `${clientPath}.map` : clientPath
    let body: Buffer
    try {
      body = await readFile(filePath)
    } catch {
      // Registered but unreadable: loud 404 beats a silent SPA-fallback HTML page.
      res.writeHead(404)
      res.end()
      return
    }
    await sendBody(req, res, {
      body,
      contentType: isSourceMap ? 'application/json; charset=utf-8' : 'text/javascript; charset=utf-8',
      cacheControl: sendCtx.features.cache !== false && options.config.immutableCache
        ? IMMUTABLE_CACHE_CONTROL
        : 'no-cache',
      compressible: true,
      filePath,
    }, sendCtx)
  }
}

export interface StaticPerfOptions {
  webServer: WebServerLike
  baseUrl?: string
  config: ResolvedConfig
  logger?: PerfLogger
  counters?: PerfCounters
  /** Resolves client bundles lazily for the index preload tap. */
  getClientModules?: () => ClientModulesLike | undefined
  /** Test override; defaults to resolving through `baseUrl`. */
  distIndex?: string
}

const STATIC_ROUTE_PATHS: readonly WebRoute['kind'][] = ['exact', 'exact', 'exact', 'prefix']
const STATIC_ROUTE_PATHNAMES: readonly string[] = ['/', '/favicon.svg', '/manifest.webmanifest', '/assets']

/**
 * Register the static shadow routes and the preload index tap. Returns a
 * disposer that removes every registration.
 */
export async function mountStaticPerf(options: StaticPerfOptions): Promise<() => void> {
  const counters = options.counters ?? createCounters()
  const cache = new CompressionCache(options.config.cacheMaxEntries, options.config.cacheMaxBytes)
  const distIndex = options.distIndex ?? resolveDistIndex(options.baseUrl)
  const disposers: (() => void)[] = []
  const capable = { compression: false, cache: false, preload: false, probed: false }

  if (distIndex !== undefined && existsSync(distIndex) && options.config.autoDetect && options.webServer.port !== undefined) {
    Object.assign(capable, await detectStaticCapabilities(options.webServer, distIndex, options.config, options.logger))
  }

  const wantsCompression = options.config.compression !== 'none'
  const wantsCache = options.config.immutableCache
  const applyCompression = wantsCompression && !capable.compression
  const applyCache = wantsCache && !capable.cache

  if (distIndex !== undefined && existsSync(distIndex) && (applyCompression || applyCache)) {
    const distRoot = dirname(distIndex)
    const renderIndex = async (): Promise<string> =>
      options.webServer.applyIndexTaps(await readFile(distIndex, 'utf8'))
    const handler = createStaticHandler({
      distRoot,
      distIndex,
      renderIndex,
      config: options.config,
      cache,
      counters,
      features: { compression: applyCompression, cache: applyCache },
    })
    for (let i = 0; i < STATIC_ROUTE_PATHNAMES.length; i += 1) {
      const kind = STATIC_ROUTE_PATHS[i]
      const path = STATIC_ROUTE_PATHNAMES[i]
      try {
        disposers.push(options.webServer.register({ kind, path, handler }))
      } catch (error) {
        options.logger?.warn(`dsh-plugin-perf: cannot register ${kind} route "${path}" (${String(error)}); leaving it to the fallback owner`)
      }
    }
  } else if (distIndex === undefined || !existsSync(distIndex)) {
    options.logger?.warn('dsh-plugin-perf: frontend dist not found; static asset routes disabled')
  } else if (options.logger !== undefined) {
    options.logger.info('dsh-plugin-perf: official server already provides the static compression and caching features this plugin would add; static routes stay unregistered')
  }

  if (options.config.preloadClientBundles !== 'none' && !capable.preload) {
    try {
      disposers.push(options.webServer.tapIndex(html => {
        const graph = options.getClientModules === undefined
          ? undefined
          : options.getClientModules()?.graph()
        return buildPreloadLinks(html, graph, options.config.preloadClientBundles)
      }))
    } catch (error) {
      options.logger?.warn(`dsh-plugin-perf: cannot tap index for preload hints (${String(error)})`)
    }
  } else if (capable.preload && options.logger !== undefined) {
    options.logger.info('dsh-plugin-perf: official index already preloads client bundles; preload tap stays off')
  }

  return () => {
    for (const dispose of disposers.reverse()) dispose()
    cache.clear()
  }
}

export interface BundlePerfOptions {
  webServer: WebServerLike
  clientModules: ClientModulesLike
  config: ResolvedConfig
  logger?: PerfLogger
  counters?: PerfCounters
}

/**
 * Register per-entry `/plugins/<id>` prefix routes for every current client
 * bundle and re-sync when the graph changes. Returns a disposer that unwinds
 * the graph subscription and every route.
 */
export async function mountBundlePerf(options: BundlePerfOptions): Promise<() => void> {
  const counters = options.counters ?? createCounters()
  const cache = new CompressionCache(options.config.cacheMaxEntries, options.config.cacheMaxBytes)
  const disposers = new Map<string, () => void>()
  const capable = { compression: false, cache: false, preload: false, probed: false }

  if (options.config.autoDetect && options.webServer.port !== undefined && options.clientModules.graph().entries.length > 0) {
    Object.assign(capable, await detectBundleCapabilities(options.webServer, options.clientModules, options.config, options.logger))
  }

  const wantsCompression = options.config.compression !== 'none'
  const wantsCache = options.config.immutableCache
  const applyCompression = wantsCompression && !capable.compression
  const applyCache = wantsCache && !capable.cache
  if (!applyCompression && !applyCache) {
    if (options.logger !== undefined) {
      options.logger.info('dsh-plugin-perf: official server already provides bundle compression and caching; per-entry bundle routes stay unregistered')
    }
    return () => {}
  }

  const sync = (): void => {
    const entries = options.clientModules.graph().entries
    const seen = new Set<string>()
    for (const entry of entries) {
      seen.add(entry.id)
      if (disposers.has(entry.id)) continue
      try {
        const handler = createBundleHandler({
          id: entry.id,
          clientModules: options.clientModules,
          config: options.config,
          cache,
          counters,
          features: { compression: applyCompression, cache: applyCache },
        })
        disposers.set(entry.id, options.webServer.register({
          kind: 'prefix',
          path: `/plugins/${entry.id}`,
          handler,
        }))
      } catch (error) {
        options.logger?.warn(`dsh-plugin-perf: cannot register /plugins/${entry.id} bundle route (${String(error)})`)
      }
    }
    for (const [id, dispose] of [...disposers]) {
      if (seen.has(id)) continue
      dispose()
      disposers.delete(id)
    }
  }

  sync()
  const unsubscribe = options.clientModules.onGraphChanged(sync)

  return () => {
    unsubscribe()
    for (const dispose of disposers.values()) dispose()
    disposers.clear()
    cache.clear()
  }
}

export interface WebPerfOptions {
  webServer: WebServerLike
  baseUrl?: string
  config: ResolvedConfig
  logger?: PerfLogger
  clientModules?: ClientModulesLike
  getClientModules?: () => ClientModulesLike | undefined
  distIndex?: string
}

/**
 * Mount everything this plugin does. Tests use this directly with fake
 * services; the Cordis entry point wires it through `ctx.inject` so service
 * absence degrades to a no-op.
 */
export async function mountWebPerf(options: WebPerfOptions): Promise<() => void> {
  const counters = createCounters()
  const logger = options.logger
  const getClientModules = options.getClientModules
    ?? (options.clientModules === undefined ? () => undefined : () => options.clientModules)

  const disposeStatic = await mountStaticPerf({
    webServer: options.webServer,
    baseUrl: options.baseUrl,
    config: options.config,
    logger,
    counters,
    getClientModules,
    distIndex: options.distIndex,
  })
  const disposeBundles = options.clientModules === undefined
    ? undefined
    : await mountBundlePerf({
        webServer: options.webServer,
        clientModules: options.clientModules,
        config: options.config,
        logger,
        counters,
      })

  return () => {
    disposeBundles?.()
    disposeStatic()
    if (options.config.logSummary && logger !== undefined) {
      logger.info(`dsh-plugin-perf: served ${String(counters.requests)} requests (static ${String(counters.staticRequests)}, bundles ${String(counters.bundleRequests)}); ${formatBytes(counters.rawBytes)} raw -> ${formatBytes(counters.encodedBytes)} encoded`)
    }
  }
}

