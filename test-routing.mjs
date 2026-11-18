import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const ROOT = process.env.ROOT || path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(os.tmpdir(), 'bridge-route-test-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })
const PORT = 8798
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT) }
const assert = (cond, label) => { if (!cond) { console.error('FAIL: ' + label); process.exitCode = 1 } else console.log('ok: ' + label) }

const bus = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  bus.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
  bus.stderr.on('data', d => process.stderr.write('bus err: ' + d))
  setTimeout(() => reject(new Error('bus start timeout')), 8000)
})

const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()
const get = async p => (await fetch(BASE + p)).json()

// DSH side publishes two live sessions, the way wake-bundle does.
const published = await post('/registry', {
  peer: 'dsh', kind: 'session', items: [
    { id: 'sess-a', label: 'demo session', cwd: 'C:\\work\\demo', status: 'idle' },
    { id: 'sess-b', label: 'other session', cwd: 'C:\\work\\other', status: 'running' },
  ],
})
assert(published.ok && published.count === 2, 'registry accepts published sessions')

const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp.mjs')], { env: { ...env, BRIDGE_PEER: 'codex' }, stdio: ['pipe', 'pipe', 'inherit'] })
const rl = readline.createInterface({ input: mcp.stdout })
const pending = new Map()
rl.on('line', l => {
  const msg = JSON.parse(l)
  if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
})
let id = 0
const rpc = (method, params) => new Promise(resolve => {
  const myId = ++id
  pending.set(myId, resolve)
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
})
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result.content[0].text

await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
const tools = (await rpc('tools/list', {})).result.tools.map(t => t.name)
assert(tools.includes('bridge_sessions') && tools.includes('bridge_threads'), 'addressing tools are advertised')

const sessions = await call('bridge_sessions')
assert(sessions.includes('sess-a') && sessions.includes('sess-b'), 'bridge_sessions lists published sessions')
const filtered = await call('bridge_sessions', { cwd: 'C:\\work\\other' })
assert(filtered.includes('sess-b') && !filtered.includes('sess-a'), 'bridge_sessions honours the cwd filter')

const threads = await call('bridge_threads', { limit: 3 })
assert(/[0-9a-f]{8}-[0-9a-f]{4}-/.test(threads), 'bridge_threads reads real Codex threads from disk')

const toSession = await call('bridge_send', { to: 'dsh', body: '为 sess-a 写的任务', kind: 'task', session: 'sess-a' })
assert(toSession.includes('session sess-a'), 'bridge_send reports the session it targeted')
const prefixed = await call('bridge_send', { to: 'dsh:sess-b', body: '为 sess-b 写的任务', kind: 'task' })
assert(prefixed.includes('session sess-b'), 'dsh:<id> prefix routes as well')
await post('/send', { from: 'dsh', to: 'codex', kind: 'result', body: '给某个 thread 的结果', meta: { thread: '01a1e96d-1da3-73d1-b670-fff6a1785e65' } })

const inbox = await get('/inbox?peer=dsh')
const [a, b] = inbox.messages
assert(a.meta && a.meta.sessionId === 'sess-a', 'first message carries meta.sessionId=sess-a')
assert(b.meta && b.meta.sessionId === 'sess-b', 'second message carries meta.sessionId=sess-b')
const codexInbox = await get('/inbox?peer=codex')
assert(codexInbox.messages[0].meta.thread === '01a1e96d-1da3-73d1-b670-fff6a1785e65', 'codex-bound message carries meta.thread')

// --- routing/claim: a consumer that knows its thread only sees its own lane ---
const T1 = '01a1e96d-1da3-73d1-b670-fff6a1785e65'
const T2 = '01aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
await post('/send', { from: 'dsh', to: 'codex', kind: 'task', body: '给 T1 的任务', meta: { thread: T1 } })
await post('/send', { from: 'dsh', to: 'codex', kind: 'task', body: '没写线程的任务' })
const lane1 = await get('/inbox?peer=codex&target=' + encodeURIComponent(T1))
assert(lane1.messages.length === 3, 'lane T1 sees the default lane plus its own messages')
const lane2 = await get('/inbox?peer=codex&target=' + encodeURIComponent(T2))
assert(lane2.messages.length === 1, 'another lane does not see T1s message')
assert(lane1.messages.every(m => 'deliveredBy' in m), 'inbox reports who took each message')

const claims = await post('/deliver', { peer: 'codex', seq: lane1.messages.at(-1).seq, target: T1 })
assert(claims.ok && claims.target === T1, 'deliver records the claim')
const afterClaim = await get('/inbox?peer=codex')
assert(afterClaim.messages.some(m => m.seq === claims.seq), 'a claimed message stays in the log (claim is information, not deletion)')
const seeClaim = await get('/inbox?peer=codex&target=' + encodeURIComponent(T1))
assert(seeClaim.messages.some(m => m.seq === claims.seq && m.deliveredBy === T1), 'claim is visible to the lane that holds it')

const registered = await get('/registry?peer=dsh&kind=session')
assert(registered.registry.items.length === 2, 'registry survives a read back')
const health = await get('/health')
assert(health.registered.dsh.session === 2, 'health summarises the registry')

const fullBody = 'message full body\n' + 'x'.repeat(700)
const full = (await post('/send', { from: 'dsh', to: 'codex', kind: 'note', body: fullBody, meta: { thread: T1 }, replyTo: 1 })).message
const fullRead = await get('/message?seq=' + full.seq)
assert(fullRead.message.body === fullBody && fullRead.message.meta.thread === T1 && fullRead.message.replyTo === 1, 'message endpoint returns full body and original metadata')
assert('delivery' in fullRead.message && fullRead.message.seq === full.seq, 'message endpoint includes delivery and identity')
assert((await get('/status')).recent.find(m => m.seq === full.seq).body.length === 240, 'status preview remains capped at 240')
const missing = await fetch(BASE + '/message?seq=999999')
assert(missing.status === 404 && (await missing.json()).error === 'no such message', 'missing full message returns 404')
assert((await fetch(BASE + '/message?seq=' + full.seq, { headers: { origin: 'https://example.com' } })).status === 403, 'cross-origin full message read is rejected')
assert((await fetch(BASE + '/message?seq=' + full.seq, { headers: { origin: 'http://localhost:8000' } })).status === 200, 'allowed origin can read full message')
mcp.kill(); bus.kill()
console.log(process.exitCode ? 'ROUTING TEST FAILED' : 'ROUTING TEST PASSED')
