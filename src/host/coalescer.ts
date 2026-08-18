/**
 * Stream coalescer ported from dsh-pref-kit.
 *
 * Merges adjacent text/reasoning deltas inside a small time window before they
 * are written into the session log / pushed to clients. This reduces event
 * count and memory/bandwidth without changing protocol semantics.
 *
 * Deliberately removed from the original:
 * - experimental.chatContainment (browser rendering hint, not core)
 * - experimental.rowManager (runtime row disabling, not critical)
 * - settings card / remote endpoints (handled by the suite config instead)
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

export interface CoalescerOptions {
  windowMs: number
}

function isMergeable(chunk: StreamChunk): chunk is Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' }> {
  return chunk !== null
    && typeof chunk === 'object'
    && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta')
}

/**
 * Wrap an upstream async chunk stream and coalesce same-block text/reasoning
 * deltas within `windowMs`. `windowMs = 0` is a strict pass-through.
 */
export function coalesceStream(
  upstream: AsyncIterable<StreamChunk>,
  windowMs: number,
): AsyncIterable<StreamChunk> {
  if (windowMs <= 0) return upstream

  let queue: StreamChunk[] = []
  let heldKind: 'text' | 'reasoning' | null = null
  let heldText: string | null = null
  let heldHasIndex = false
  let heldIndex = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let wake: (() => void) | null = null
  let done = false
  let error: unknown = null

  const wakeUp = (): void => {
    wake?.()
  }

  const flushHeld = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (heldText !== null) {
      const merged = {
        type: heldKind === 'reasoning' ? 'reasoning-delta' : 'text-delta',
        text: heldText,
        ...(heldHasIndex ? { index: heldIndex } : {}),
      } as unknown as StreamChunk
      queue.push(merged)
    }
    heldKind = null
    heldText = null
    heldHasIndex = false
    wakeUp()
  }

  void (async () => {
    try {
      for await (const chunk of upstream) {
        if (isMergeable(chunk)) {
          const delta = chunk as Extract<StreamChunk, { type: 'text-delta' | 'reasoning-delta' }> & { index?: number }
          const kind = delta.type === 'reasoning-delta' ? 'reasoning' as const : 'text' as const
          const hasIndex = delta.index !== undefined && delta.index !== null
          const index = hasIndex ? (delta.index as number) : 0
          const piece = typeof delta.text === 'string' ? delta.text : ''
          if (heldText !== null
            && (heldKind !== kind || heldHasIndex !== hasIndex || (hasIndex && heldIndex !== index))) {
            flushHeld()
          }
          heldKind = kind
          heldText = (heldText === null ? '' : heldText) + piece
          heldHasIndex = hasIndex
          heldIndex = index
          if (timer === null) {
            timer = setTimeout(() => {
              timer = null
              flushHeld()
            }, windowMs)
          }
          continue
        }
        flushHeld()
        queue.push(chunk)
        wakeUp()
      }
    } catch (caught) {
      error = caught
    }
    done = true
    flushHeld()
    wakeUp()
  })()

  return {
    [Symbol.asyncIterator]() {
      return {
        next: (): Promise<IteratorResult<StreamChunk>> => {
          if (error !== null) return Promise.reject(error)
          if (queue.length > 0) return Promise.resolve({ value: queue.shift() as StreamChunk, done: false })
          if (done) return Promise.resolve({ value: undefined as never, done: true })
          return new Promise((resolve, reject) => {
            const attempt = (): void => {
              if (error !== null) {
                wake = null
                reject(error)
                return
              }
              if (queue.length > 0) {
                wake = null
                resolve({ value: queue.shift() as StreamChunk, done: false })
                return
              }
              if (done) {
                wake = null
                resolve({ value: undefined as never, done: true })
                return
              }
              wake = attempt
            }
            wake = attempt
          })
        },
      }
    },
  }
}
