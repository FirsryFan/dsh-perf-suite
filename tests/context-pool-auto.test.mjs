import assert from 'node:assert/strict'
import { ContextPool } from '../lib/host/context-pool/pool.js'
import { flattenText, poolToolResult } from '../lib/host/context-pool/auto.js'

// flattenText handles text blocks and tool-result nesting.
{
  assert.equal(flattenText('plain'), 'plain')
  assert.equal(flattenText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab')
  assert.equal(flattenText([{ type: 'tool-result', content: [{ type: 'text', text: 'inner' }] }]), 'inner')
  assert.equal(flattenText([{ type: 'unknown' }]), undefined)
}

// poolToolResult replaces long accepted results with a compact locator.
{
  const pool = new ContextPool()
  const long = 'x'.repeat(5000)
  const decision = poolToolResult({ kind: 'accept', content: [{ type: 'text', text: long }] }, null, pool, 4000)
  assert.equal(decision.kind, 'accept')
  const text = decision.content[0].text
  assert.match(text, /^<<pool:[0-9a-f]{64}>>/)
  assert.ok(text.length < 500, 'compact text is small')
}

// poolToolResult preserves short results unchanged.
{
  const pool = new ContextPool()
  const decision = poolToolResult({ kind: 'accept', content: [{ type: 'text', text: 'short' }] }, null, pool, 4000)
  assert.equal(decision.content[0].text, 'short')
}

// Non-accept decisions and decisions with a value pass through untouched.
{
  const pool = new ContextPool()
  const reject = { kind: 'reject' }
  assert.equal(poolToolResult(reject, null, pool, 1), reject)
  const valued = { kind: 'accept', value: 1 }
  assert.equal(poolToolResult(valued, null, pool, 1), valued)
}

console.log('context-pool auto tests passed')
