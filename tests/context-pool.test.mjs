import assert from 'node:assert/strict'
import { ContextPool } from '../lib/host/context-pool/pool.js'

const pool = new ContextPool()

// JSON tree
{
  const big = JSON.stringify({ users: Array.from({ length: 20 }, (_, i) => ({ id: i, name: `u${i}` })), meta: { ok: true } }, null, 2)
  const { locator, root } = pool.pool(big, 'json')
  assert.ok(locator.length === 64, 'locator is sha256')
  assert.ok(root.children && root.children.length === 2, 'root has object children')
  const explore = pool.explore(locator)
  assert.ok(explore && explore.children.length === 2, 'explore returns children')
  const users = explore.children.find(c => c.summary.includes('users'))
  assert.ok(users, 'users branch exists')
  const usersNode = pool.find(locator, users.hash)
  assert.ok(usersNode && usersNode.children && usersNode.children.length === 20, 'users has 20 children')
  const first = pool.fetch(locator, usersNode.children[0].hash)
  assert.ok(first && first.content.includes('"id":0'), 'fetch leaf returns original')
}

// Log tree
{
  const log = ['INFO start', 'ERROR boom', 'INFO done', 'WARN slow', 'ERROR again'].join('\n')
  const { locator } = pool.pool(log, 'log')
  const explore = pool.explore(locator)
  assert.ok(explore && explore.children.some(c => c.summary.includes('ERROR ×2')), 'error group summarized')
  const err = explore.children.find(c => c.summary.includes('ERROR'))
  const fetched = pool.fetch(locator, err.hash)
  assert.ok(fetched && fetched.content.includes('boom'), 'log group fetch works')
}

// Diff tree
{
  const diff = 'diff --git a/a.txt b/a.txt\n@@ -1 +1 @@\n-old\n+new\ndiff --git a/b.txt b/b.txt\n@@ -1 +1 @@\n-x\n+y\n'
  const { locator } = pool.pool(diff, 'diff')
  const explore = pool.explore(locator)
  assert.ok(explore && explore.children.length === 2, 'diff has two file children')
}

// Text tree
{
  const text = Array.from({ length: 50 }, (_, i) => `Paragraph ${i}: ${'x'.repeat(100)}`).join('\n\n')
  const { locator } = pool.pool(text, 'text')
  const explore = pool.explore(locator)
  assert.ok(explore && explore.children.length === 50, 'text paragraphs are children')
}

// Safety: unknown locator and path-like input are rejected
{
  assert.equal(pool.explore('deadbeef'), undefined)
  assert.equal(pool.fetch('/etc/passwd'), undefined)
  assert.equal(pool.fetch('deadbeef', '../../etc/passwd'), undefined)
}

// Stability: same content → same hash; pool doesn't mutate on reads
{
  const text = 'same content '.repeat(1000)
  const a = pool.pool(text, 'text')
  const b = pool.pool(text, 'text')
  assert.equal(a.locator, b.locator, 'hash is stable')
  const before = JSON.stringify(pool.explore(a.locator))
  pool.fetch(a.locator)
  pool.explore(a.locator)
  assert.equal(JSON.stringify(pool.explore(a.locator)), before, 'reads do not mutate')
}

console.log('context-pool tests passed')
