import assert from 'node:assert/strict'
import { ContextPool } from '../lib/host/context-pool/pool.js'

const pool = new ContextPool()
const MAX_FETCH_CHARS = 4000

// Effect: compact root summaries should be much smaller than original.
{
  const original = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ id: i, data: 'x'.repeat(100) })) }, null, 2)
  const { root } = pool.pool(original, 'json')
  assert.ok(root.summary.length < original.length / 10, 'root summary is compact')
}

// Stability: same input yields same locator; repeated reads don't mutate.
{
  const text = 'line\n'.repeat(5000)
  const a = pool.pool(text, 'text')
  const b = pool.pool(text, 'text')
  assert.equal(a.locator, b.locator)
  const before = JSON.stringify(pool.explore(a.locator))
  for (let i = 0; i < 100; i++) {
    pool.explore(a.locator)
    pool.fetch(a.locator)
  }
  assert.equal(JSON.stringify(pool.explore(a.locator)), before)
}

// Safety: path traversal and unknown hashes are rejected.
{
  const { locator } = pool.pool('hello world', 'text')
  assert.equal(pool.fetch(locator, '../secret'), undefined)
  assert.equal(pool.fetch(locator, '0000000000000000000000000000000000000000000000000000000000000000'), undefined)
  assert.equal(pool.explore('not-a-real-locator'), undefined)
}

// Fetch is bounded.
{
  const big = JSON.stringify({ blob: 'z'.repeat(20000) }, null, 2)
  const { locator } = pool.pool(big, 'json')
  const fetched = pool.fetch(locator)
  assert.ok(fetched && fetched.content.length <= MAX_FETCH_CHARS)
  assert.equal(fetched.truncated, true)
}

console.log('context-pool stress/safety tests passed')
