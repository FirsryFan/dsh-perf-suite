/**
 * Context Pool DSH integration.
 *
 * Registers two model-facing tools:
 * - context_pool_explore(locator, nodeHash?) → reveal one level of the tree.
 * - context_pool_fetch(locator, nodeHash?) → return a bounded content chunk.
 *
 * The tools only accept locators/hashes that came from this pool; they never
 * read arbitrary filesystem paths.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContextPool } from './pool.js'

export interface PoolToolContext {
  tools: {
    register(tool: unknown): unknown
  }
  logger?: { info?(msg: string): void; warn?(msg: string): void }
}

const TOOL_DESCRIPTION = `On-demand context pool navigation.

Use these tools when you need details behind a compact locator such as <<pool:hash>>.

- context_pool_explore: list the next-level branches of a pooled object.
- context_pool_fetch: retrieve a bounded content chunk for a branch/leaf.

Locators are opaque pool handles, not filesystem paths. Never try to read them with file tools.`

export function installContextPool(ctx: PoolToolContext, pool: ContextPool): void {
  try {
    ctx.tools.register(defineTool({
      name: 'context_pool_explore',
      description: `${TOOL_DESCRIPTION}\n\nParameters: locator (required), nodeHash (optional).`,
      parameters: {
        locator: { type: 'string', required: true, description: 'Pool locator returned by the pool.' },
        nodeHash: { type: 'string', description: 'Optional branch hash to explore deeper.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const result = pool.explore(String(args.locator), args.nodeHash === undefined ? undefined : String(args.nodeHash))
        if (result === undefined) return 'Pool locator not found or invalid.'
        const lines = [`Summary: ${result.summary}`]
        if (result.children.length === 0) {
          lines.push('(leaf node — call context_pool_fetch to read content)')
        } else {
          for (const child of result.children) {
            lines.push(`- ${child.hash.slice(0, 16)} ${child.summary}`)
          }
        }
        return lines.join('\n')
      },
    }))

    ctx.tools.register(defineTool({
      name: 'context_pool_fetch',
      description: `${TOOL_DESCRIPTION}\n\nParameters: locator (required), nodeHash (optional).`,
      parameters: {
        locator: { type: 'string', required: true, description: 'Pool locator returned by the pool.' },
        nodeHash: { type: 'string', description: 'Optional branch/leaf hash to fetch.' },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args) {
        const result = pool.fetch(String(args.locator), args.nodeHash === undefined ? undefined : String(args.nodeHash))
        if (result === undefined) return 'Pool locator not found or invalid.'
        if (result.truncated) {
          return `${result.content}\n\n[truncated: content is larger than the fetch limit; call context_pool_explore to navigate deeper branches]`
        }
        return result.content
      },
    }))

    ctx.logger?.info?.('[dsh-perf-suite] context pool tools installed')
  } catch (error) {
    ctx.logger?.warn?.(`[dsh-perf-suite] context pool tool registration failed: ${String(error)}`)
  }
}
