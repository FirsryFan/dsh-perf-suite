/**
 * Pure helpers for automatically pooling long tool results before they enter
 * the model context.
 */
import type { ContextPool } from './pool.js'

export function flattenText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') return undefined
    const item = block as { type?: string; text?: string; content?: unknown }
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
      continue
    }
    if (item.type === 'tool-result') {
      const inner = flattenText(item.content)
      if (inner === undefined) return undefined
      parts.push(inner)
      continue
    }
    return undefined
  }
  return parts.join('')
}

export interface PostExecuteDecision {
  kind?: string
  content?: unknown
  value?: unknown
  additionalContexts?: unknown
}

/**
 * If the accepted tool result is longer than `threshold`, replace the model-
 * visible content with a compact pool locator + root summary and store the full
 * text in the pool. Returns the original decision when nothing should change.
 */
export function poolToolResult(
  decision: PostExecuteDecision,
  result: unknown,
  pool: ContextPool,
  threshold: number,
): PostExecuteDecision {
  if (decision === null || typeof decision !== 'object' || decision.kind !== 'accept') return decision
  if (Object.hasOwn(decision, 'value')) return decision
  const rawContent = decision.content ?? (result as { content?: unknown } | null)?.content
  const text = flattenText(rawContent)
  if (text === undefined || text.length < threshold) return decision
  const { locator, root } = pool.pool(text)
  const compact = `<<pool:${locator}>>\n${root.summary}`
  return {
    kind: 'accept',
    content: [{ type: 'text', text: compact }],
    ...(Object.hasOwn(decision, 'additionalContexts')
      ? { additionalContexts: decision.additionalContexts }
      : {}),
  }
}
