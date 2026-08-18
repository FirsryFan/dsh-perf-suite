/**
 * Context Pool — tree-structured on-demand expansion for long tool results and
 * reasoning text.
 *
 * Design:
 * - Long content is pooled once into a tree.
 * - Each node has a stable content-hash locator and a compact summary.
 * - The model first sees only the root summary.
 * - `context_pool_explore` reveals one level of children.
 * - `context_pool_fetch` returns the content of a leaf (or a bounded chunk).
 * - Original history is never rewritten; fetched content is appended as a tool
 *   result at the tail, preserving prefix cache hits.
 *
 * Extraction is rule-based and deterministic (no micro-model):
 * - JSON: split by keys/array indices.
 * - Logs: group by level/component, summarize counts + first/last + errors.
 * - Diffs: split by file/hunk.
 * - Plain text: split by blank-line paragraphs / markdown headings.
 */
import { createHash } from 'node:crypto'

export interface PoolNode {
  hash: string
  summary: string
  content?: string
  children?: PoolNode[]
  lineStart?: number
  lineEnd?: number
}

export interface PoolEntry {
  root: PoolNode
  createdAt: number
}

const MAX_SUMMARY_CHARS = 240
const MAX_FETCH_CHARS = 4000

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function truncate(text: string, max = MAX_SUMMARY_CHARS): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`
}

function lines(text: string): string[] {
  return text.split(/\r?\n/)
}

function summarizeLines(text: string): string {
  const ls = lines(text).filter(line => line.trim() !== '')
  if (ls.length === 0) return '(empty)'
  const head = ls.slice(0, 3).join(' | ')
  const tail = ls.slice(-2).join(' | ')
  return truncate(`${head}${ls.length > 5 ? ` …(${ls.length} lines)… ${tail}` : ''}`)
}

/** Build a JSON tree. Object keys and array indices become children. */
function buildJsonTree(value: unknown, path = '$'): PoolNode {
  const raw = JSON.stringify(value)
  const hash = sha256(raw)
  if (value === null || typeof value !== 'object') {
    return { hash, summary: truncate(raw), content: raw }
  }
  const entries = Array.isArray(value)
    ? value.map((item, index) => [`[${index}]`, item] as const)
    : Object.entries(value as Record<string, unknown>)
  const children = entries.map(([key, item]) => buildJsonTree(item, `${path}.${key}`))
  return {
    hash,
    summary: truncate(`${Array.isArray(value) ? 'array' : 'object'} ${path} (${entries.length} keys)`),
    content: raw,
    children,
  }
}

/** Build a log tree: group lines by level, summarize each group. */
function buildLogTree(text: string): PoolNode {
  const ls = lines(text)
  const groups = new Map<string, string[]>()
  const levelRe = /\b(DEBUG|INFO|WARN|WARNING|ERROR|FATAL|TRACE)\b/
  for (const line of ls) {
    const m = levelRe.exec(line)
    const key = m?.[1] ?? 'OTHER'
    const arr = groups.get(key) ?? []
    arr.push(line)
    groups.set(key, arr)
  }
  const children = [...groups.entries()].map(([level, group]) => {
    const body = group.join('\n')
    return {
      hash: sha256(body),
      summary: truncate(`${level} ×${group.length}: ${summarizeLines(body)}`),
      content: body,
    }
  })
  return {
    hash: sha256(text),
    summary: truncate(`log (${ls.length} lines, ${children.length} groups)`),
    children,
  }
}

/** Build a diff tree: split by `diff --git` file headers. */
function buildDiffTree(text: string): PoolNode {
  const parts = text.split(/(?=^diff --git )/m).filter(Boolean)
  const children = parts.map((part) => ({
    hash: sha256(part),
    summary: truncate(part.split('\n').find(line => line.startsWith('diff --git')) ?? summarizeLines(part)),
    content: part,
  }))
  return {
    hash: sha256(text),
    summary: truncate(`diff (${parts.length} files)`),
    children,
  }
}

/** Build a plain text tree: split by markdown headings or blank-line paragraphs. */
function buildTextTree(text: string): PoolNode {
  const headingRe = /^(#{1,6})\s+(.+)$/m
  if (headingRe.test(text)) {
    const parts = text.split(/(?=^#{1,6}\s+)/m).filter(Boolean)
    const children = parts.map((part) => {
      const heading = part.match(headingRe)?.[2] ?? 'section'
      return {
        hash: sha256(part),
        summary: truncate(`${heading}: ${summarizeLines(part)}`),
        content: part,
      }
    })
    return {
      hash: sha256(text),
      summary: truncate(`document (${children.length} sections)`),
      children,
    }
  }
  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim() !== '')
  if (paragraphs.length > 1 && text.length > MAX_FETCH_CHARS) {
    const children = paragraphs.map((part) => ({
      hash: sha256(part),
      summary: truncate(summarizeLines(part)),
      content: part,
    }))
    return {
      hash: sha256(text),
      summary: truncate(`text (${paragraphs.length} paragraphs)`),
      children,
    }
  }
  return { hash: sha256(text), summary: summarizeLines(text), content: text }
}

export type PoolContentType = 'json' | 'log' | 'diff' | 'text'

export function detectContentType(text: string): PoolContentType {
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return 'json'
  if (/diff --git /.test(text)) return 'diff'
  if (/\b(DEBUG|INFO|WARN|ERROR|FATAL)\b/.test(text)) return 'log'
  return 'text'
}

export function buildPoolTree(text: string, type?: PoolContentType): PoolNode {
  const t = type ?? detectContentType(text)
  switch (t) {
    case 'json': {
      try {
        return buildJsonTree(JSON.parse(text))
      } catch {
        return buildTextTree(text)
      }
    }
    case 'log': return buildLogTree(text)
    case 'diff': return buildDiffTree(text)
    default: return buildTextTree(text)
  }
}

export class ContextPool {
  private readonly entries = new Map<string, PoolEntry>()

  /** Pool a long text and return the root locator + root summary. */
  pool(text: string, type?: PoolContentType): { locator: string; root: PoolNode } {
    const root = buildPoolTree(text, type)
    this.entries.set(root.hash, { root, createdAt: Date.now() })
    return { locator: root.hash, root }
  }

  /** Return the root node for a locator. */
  root(locator: string): PoolNode | undefined {
    return this.entries.get(locator)?.root
  }

  /** Return the node with the given hash anywhere in the tree. */
  find(locator: string, nodeHash?: string): PoolNode | undefined {
    const root = this.root(locator)
    if (root === undefined) return undefined
    if (nodeHash === undefined || nodeHash === root.hash) return root
    const stack = [...(root.children ?? [])]
    while (stack.length > 0) {
      const node = stack.pop()
      if (node === undefined) continue
      if (node.hash === nodeHash) return node
      stack.push(...(node.children ?? []))
    }
    return undefined
  }

  /** Children of a node, bounded to a summary list. */
  explore(locator: string, nodeHash?: string): { summary: string; children: { hash: string; summary: string }[] } | undefined {
    const node = this.find(locator, nodeHash)
    if (node === undefined) return undefined
    return {
      summary: node.summary,
      children: (node.children ?? []).map(child => ({ hash: child.hash, summary: child.summary })),
    }
  }

  /** Fetch content for a node. If content is larger than MAX_FETCH_CHARS, return the first bounded chunk and a note. */
  fetch(locator: string, nodeHash?: string): { content: string; truncated: boolean; more: boolean } | undefined {
    const node = this.find(locator, nodeHash)
    if (node === undefined) return undefined
    if (node.content !== undefined) {
      const truncated = node.content.length > MAX_FETCH_CHARS
      return {
        content: truncated ? node.content.slice(0, MAX_FETCH_CHARS) : node.content,
        truncated,
        more: truncated,
      }
    }
    // Internal node without direct content: aggregate children summaries.
    const children = node.children ?? []
    const content = children.map(child => `[${child.hash.slice(0, 12)}] ${child.summary}`).join('\n')
    return { content, truncated: false, more: false }
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
