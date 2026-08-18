/**
 * Session data-path optimizations from dsh-session-slim.
 *
 * At runtime this wraps ApiProxy:
 * - history responses: strip sourceEventSeqs, prune settled assistant/chunk
 *   events, and attach/derive stream summaries so trajectory timing survives.
 * - live frames: strip sourceEventSeqs.
 *
 * The deeper core changes (sourceEventSeqs intervalization, client live-window
 * chunk pruning) are shipped as a patch in `patches/` and are not duplicated
 * here.
 */
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamSummary, SessionEvent } from '@deepseek-ai/dsh-session'

export interface SessionSlimContext {
  apiProxy: {
    sessions: {
      history(request: unknown): Promise<{
        result: { ok: true; value: { events: { event: SessionEvent; view?: unknown }[] } } | { ok: false; value?: unknown }
      }>
    }
    events: {
      mux(request: unknown, signal: AbortSignal): AsyncIterable<{
        rpcId?: unknown
        payload: { type: 'session/event'; sessionId: unknown; event: SessionEvent; view?: unknown } | Record<string, unknown>
      }>
    }
  }
  logger?: { info?(msg: string): void }
}

function withoutSourceEventSeqs(event: SessionEvent): SessionEvent {
  if (!Object.prototype.hasOwnProperty.call(event, 'sourceEventSeqs')) return event
  const copy = { ...event } as SessionEvent & { sourceEventSeqs?: unknown }
  delete copy.sourceEventSeqs
  return copy
}

function isTokenDeltaChunk(chunk: { type: string }): boolean {
  return chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta'
}

function assistantStreamSummaries(events: readonly SessionEvent[]): Map<string, AssistantStreamSummary> {
  const chunkStats = new Map<string, {
    firstChunkSeq: number
    firstChunkTime: number
    firstTokenTime?: number
    chunkCount: number
  }>()
  for (const event of events) {
    if (event.type !== 'assistant/chunk') continue
    const { turn, step, chunk } = event.data
    const key = `${turn}:${step}`
    const stats = chunkStats.get(key) ?? {
      firstChunkSeq: event.seq,
      firstChunkTime: event.time,
      chunkCount: 0,
    }
    if (stats.firstTokenTime === undefined && isTokenDeltaChunk(chunk as { type: string })) {
      stats.firstTokenTime = event.time
    }
    stats.chunkCount += 1
    chunkStats.set(key, stats)
  }
  const summaries = new Map<string, AssistantStreamSummary>()
  for (const event of events) {
    if (event.type !== 'assistant/message' || !isAppendSurfaceEvent(event)) continue
    const key = `${event.data.turn}:${event.data.step}`
    const summary = event.data.stream ?? chunkStats.get(key)
    if (summary !== undefined) summaries.set(key, summary)
  }
  return summaries
}

function pruneSettledAssistantChunks(
  events: readonly SessionEvent[],
  summaries: ReadonlyMap<string, AssistantStreamSummary>,
): SessionEvent[] {
  if (summaries.size === 0) return [...events]
  return events.filter(event => {
    if (event.type !== 'assistant/chunk') return true
    const { turn, step } = event.data
    return !summaries.has(`${turn}:${step}`)
  })
}

function transformHistoryEntries(entries: { event: SessionEvent; view?: unknown }[]): { event: SessionEvent; view?: unknown }[] {
  const events = entries.map(entry => entry.event)
  const summaries = assistantStreamSummaries(events)
  const pageEvents = pruneSettledAssistantChunks(events, summaries)
  return pageEvents.map(event => {
    const entry = entries.find(candidate => candidate.event.seq === event.seq)
    let wireEvent = withoutSourceEventSeqs(event)
    if (event.type === 'assistant/message'
      && isAppendSurfaceEvent(event)
      && event.data.stream === undefined) {
      const summary = summaries.get(`${event.data.turn}:${event.data.step}`)
      if (summary !== undefined) {
        wireEvent = {
          ...wireEvent,
          data: { ...wireEvent.data, stream: summary },
        } as SessionEvent
      }
    }
    return { event: wireEvent, ...(entry?.view === undefined ? {} : { view: entry.view }) }
  })
}

async function* transformMux(
  source: AsyncIterable<{ rpcId?: unknown; payload: { type: 'session/event'; sessionId: unknown; event: SessionEvent; view?: unknown } | Record<string, unknown> }>,
): AsyncIterable<{ rpcId?: unknown; payload: { type: 'session/event'; sessionId: unknown; event: SessionEvent; view?: unknown } | Record<string, unknown> }> {
  for await (const request of source) {
    if (request.payload?.type === 'session/event') {
      const payload = request.payload as { type: 'session/event'; sessionId: unknown; event: SessionEvent; view?: unknown }
      yield {
        ...request,
        payload: {
          ...payload,
          event: withoutSourceEventSeqs(payload.event),
        },
      }
    } else {
      yield request
    }
  }
}

export function installSessionSlim(ctx: SessionSlimContext): void {
  const apiProxy = ctx.apiProxy
  const originalHistory = apiProxy.sessions.history.bind(apiProxy.sessions)
  apiProxy.sessions.history = async (request: unknown) => {
    const response = await originalHistory(request)
    if (response.result.ok) {
      response.result.value.events = transformHistoryEntries(response.result.value.events)
    }
    return response
  }

  const originalMux = apiProxy.events.mux.bind(apiProxy.events)
  apiProxy.events.mux = (request: unknown, signal: AbortSignal) =>
    transformMux(originalMux(request, signal))

  ctx.logger?.info?.('[dsh-perf-suite] session-slim history/live wrappers installed')
}
