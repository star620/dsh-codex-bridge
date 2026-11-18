// Stub-level test of the wake plugin against a real bus process.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './index.js'

// Random port: a fixed one accumulates TIME_WAIT sockets across runs on Windows and
// eventually makes connect() time out mid-test.
const PORT = 8800 + Math.floor(Math.random() * 900)
const DIR = path.join(os.tmpdir(), 'bridge-wake-test-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })

const bus = spawn(process.execPath, [fileURLToPath(new URL('../bus.mjs', import.meta.url))], {
  env: { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT) },
  stdio: 'ignore',
})
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function health() {
  for (let i = 0; i < 50; i += 1) {
    try { const r = await fetch('http://127.0.0.1:' + PORT + '/health'); if (r.ok) return } catch {}
    await sleep(100)
  }
  throw new Error('bus did not start')
}

await health()

const calls = []
const PROJ = 'C:\\Users\\星梦\\Desktop\\11_神秘项目'
const agent = {
  status: 'idle',
  session: { id: 'sess-1', header: { cwd: PROJ } },
  options: {},
  followup(message) { calls.push(['followup', message]) },
  inbox: { inject(message) { calls.push(['inject', message]) } },
}

// Two unrelated sessions are open in the same window: they must stay quiet.
const otherCalls = []
const other = (id, cwd) => ({
  status: 'idle',
  session: { id, header: { cwd } },
  options: {},
  followup(message) { otherCalls.push([id, message]) },
  inbox: { inject(message) { otherCalls.push([id, message]) } },
})
const bystanders = [other('sess-2', 'C:\\Users\\星梦\\Desktop\\01_UTSL平台'), other('sess-3', 'C:\\Users\\星梦\\Desktop\\12_备忘记')]
// A delegated child session: depth 1, so the default config must leave it alone.
const childCalls = []
const child = {
  status: 'idle',
  session: { id: 'sess-child', header: { delegationDepth: 1, cwd: PROJ } },
  options: {},
  followup(message) { childCalls.push(message) },
  inbox: { inject(message) { childCalls.push(message) } },
}
// Sessions opened later in the test (other lanes), appended to the live list.
const extra = []
const flushed = []
const logs = []
const ctx = {
  logger: { info: (m) => logs.push(m), warn: (m) => logs.push(m) },
  agents: { list: () => [...bystanders, agent, child, ...extra] },
  sessions: { flush: async (s) => { flushed.push(s.id); return true } },
  effect(fn) { cleanup = fn() },
}

let cleanup
const dispose = apply(ctx, { port: PORT, peer: 'dsh', waitSeconds: 5, retryMs: 200, cwd: PROJ, retryPendingMs: 400 })
await sleep(300)

const send = (body, kind) => fetch('http://127.0.0.1:' + PORT + '/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ from: 'codex', to: 'dsh', kind, body }),
})

await send('请评审 auth.py', 'task')
await sleep(1200)
console.log('after first message:', JSON.stringify(calls.map(c => c[0])))
if (calls.length !== 1) { console.log('FAIL: expected exactly one nudge'); process.exit(1) }
const message = calls[0][1]
console.log('message:', JSON.stringify(message))
const ok = message.role === 'user'
  && message.content[0].type === 'text'
  && message.content[0].text.includes('1 条未读消息')
  && message.content[0].text.includes('bridge_inbox')
  && message.source.kind === 'codex-bridge'
  && typeof message.id === 'string' && message.id.length === 36
  && Object.isFrozen(message)
console.log('shape ok:', ok, '| flushed:', flushed.length, '| child nudges:', childCalls.length)
if (childCalls.length !== 0) { console.log('FAIL: nudged a delegated child session'); process.exit(1) }
console.log('bystander nudges:', otherCalls.length)
if (otherCalls.length !== 0) { console.log('FAIL: nudged a session from another project'); process.exit(1) }
if (!ok) process.exit(1)

// A second message before any ack must nudge again; the same batch must not repeat.
await send('还有第二件事', 'task')
await sleep(1200)
const countAfterSecond = calls.length
console.log('nudges after second message:', countAfterSecond)
if (countAfterSecond !== 2) { console.log('FAIL: expected a nudge for the new sequence'); process.exit(1) }

// Reaching the same pending batch again must be silent.
await sleep(6000)
console.log('nudges after idle wait:', calls.length)
if (calls.length !== 2) { console.log('FAIL: repeated nudge for an unacked batch'); process.exit(1) }

// Acking the batch and receiving a new one must nudge with the new range only.
await fetch('http://127.0.0.1:' + PORT + '/ack', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ peer: 'dsh', upTo: 2 }),
})
await send('第三件事', 'question')
await sleep(1200)
console.log('final nudges:', calls.length, '| last text:', calls.at(-1)?.[1]?.content?.[0]?.text)
if (calls.length !== 3) { console.log('FAIL: expected a nudge after ack'); process.exit(1) }

// --- lanes: one conversation per addressed session ---------------------------
// Before this, a batch that mixed two lanes woke exactly one session and then
// moved a single watermark past both, so the other lane was never delivered.
const sendTo = (body, kind, meta) => fetch('http://127.0.0.1:' + PORT + '/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ from: 'codex', to: 'dsh', kind, body, ...(meta ? { meta } : {}) }),
})
const laneCalls = []
const laneAgent = (id) => ({
  status: 'idle',
  session: { id, header: { cwd: PROJ } },
  options: {},
  followup(message) { laneCalls.push([id, message]) },
  inbox: { inject(message) { laneCalls.push([id, message]) } },
})
extra.push(laneAgent('sess-1b'))
const textOf = (entry) => entry?.[1]?.content?.[0]?.text || ''
const laneTexts = (id) => laneCalls.filter((entry) => entry[0] === id).map(textOf)
const check = (cond, label) => {
  console.log((cond ? 'ok   ' : 'FAIL ') + label)
  if (!cond) process.exit(1)
}

await sendTo('lane B task', 'task', { sessionId: 'sess-1b' })
await sendTo('default lane task', 'task')
await sleep(1500)
check(laneTexts('sess-1b').some((text) => text.includes('target=sess-1b')), 'addressed lane is nudged with its own target')
check(laneTexts('sess-1b').every((text) => !text.includes('default lane task') && !text.includes('seq 5')),
  'the lane nudge does not leak the other lane\'s text')
const defaultAfter = calls.slice(3).map((entry) => textOf(entry))
check(defaultAfter.some((text) => text.includes('seq 5–5')), 'default lane still reports its own range only')
check(defaultAfter.every((text) => !text.includes('target=sess-1b')), 'default lane is not told to read another lane')
check(calls.slice(3).every((entry) => !textOf(entry).includes('lane B task')), 'default nudge carries no lane B text')
check(!laneTexts('sess-1b').some((text) => text.includes('seq 5')), 'a conversation opened later does not steal the default lane')

// --- a lane whose session is not open yet ------------------------------------
const beforeGone = laneCalls.length + calls.length
await sendTo('for a session that is closed', 'task', { sessionId: 'sess-gone' })
await sleep(1200)
check(laneCalls.length + calls.length === beforeGone, 'nothing is woken for a lane with no open session')
check(!calls.slice(3).some((entry) => textOf(entry).includes('for a session that is closed')),
  'an addressed message is never handed to the default lane as a fallback')

extra.push(laneAgent('sess-gone'))
await sleep(1600)
check(laneTexts('sess-gone').some((text) => text.includes('target=sess-gone') && text.includes('seq 6–6')),
  'the retry loop delivers once that session appears')
check(!calls.slice(3).some((entry) => textOf(entry).includes('for a session that is closed')),
  'the retry does not spill into another conversation')

dispose
cleanup?.()
bus.kill()
fs.rmSync(DIR, { recursive: true, force: true })
console.log('logs:', logs.join(' | '))
console.log('PASS')
