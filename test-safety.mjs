// Safety tests for the bus: seq high-water, lane ack, claim conflicts.
// Run: $env:ROOT=(Get-Location).Path; node test-safety.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ROOT || path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(os.tmpdir(), 'bridge-safety-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })
const PORT = 8900 + Math.floor(Math.random() * 90)
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT) }
const assert = (cond, label) => { if (!cond) { console.error('FAIL: ' + label); process.exitCode = 1 } else console.log('ok: ' + label) }

function startBus() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', d => process.stderr.write('bus err: ' + d))
  return new Promise(resolve => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve(child) })
    setTimeout(() => resolve(child), 5000)
  })
}
let bus = await startBus()

const call = async (p, b, method = 'POST') => {
  const init = { method, headers: {} }
  if (b !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(b) }
  const res = await fetch(BASE + p, init)
  return { status: res.status, body: await res.json() }
}
const send = async (extra = {}) => (await call('/send', { from: 'dsh', to: 'codex', body: 'x', kind: 'task', ...extra })).body.message
const inbox = async (q = '') => (await call('/inbox?peer=codex' + q, undefined, 'GET')).body

// --- lane ack does not confirm another lane ------------------------------------------
const A = 'thread-aaa', B = 'thread-bbb'
const a = await send({ meta: { thread: A } })
const b = await send({ meta: { thread: B } })
const acked = await call('/ack', { peer: 'codex', upTo: b.seq, target: B })
assert(acked.body.ok && acked.body.scope === 'lane', 'ack with target is lane scoped')
const laneA = await inbox('&target=' + A)
assert(laneA.messages.some(m => m.seq === a.seq), 'acking lane B leaves lane A unread')
const laneB = await inbox('&target=' + B)
assert(!laneB.messages.some(m => m.seq === b.seq), 'acking lane B clears lane B')
const peerView = await inbox()
assert(!peerView.messages.some(m => m.seq === b.seq), 'peer view drops a message its lane already confirmed')
assert(peerView.messages.some(m => m.seq === a.seq), 'peer view still shows the lane nobody confirmed')

// --- /status counts unread per addressed lane (the sidebar badge's only source) -----
const badgeMsg = await send({ from: 'codex', to: 'dsh', meta: { sessionId: 'session-badge' } })
const beforeAck = (await call('/status', undefined, 'GET')).body
assert(beforeAck.unreadLanes && beforeAck.unreadLanes['session-badge'] === 1,
  'status reports the unread count of an addressed lane')
await call('/ack', { peer: 'dsh', upTo: badgeMsg.seq, target: 'session-badge' })
const afterAck = (await call('/status', undefined, 'GET')).body
assert(!afterAck.unreadLanes || !afterAck.unreadLanes['session-badge'],
  'status drops a lane once that lane acks')
const defaultOnly = await send({ from: 'codex', to: 'dsh' })
const statusDefault = (await call('/status', undefined, 'GET')).body
assert(Object.keys(statusDefault.unreadLanes || {}).indexOf('') === -1,
  'the default lane is not a badge candidate')
await call('/ack', { peer: 'dsh', upTo: defaultOnly.seq })

// --- a peer-wide ack spanning lanes is refused unless all:true ----------------------
const wide = await call('/ack', { peer: 'codex', upTo: b.seq })
assert(wide.status === 409 && /lanes/.test(wide.body.error), 'peer-wide ack across lanes is refused')
const forced = await call('/ack', { peer: 'codex', upTo: b.seq, all: true })
assert(forced.body.ok && forced.body.scope === 'peer', 'all:true forces the peer-wide ack')

// --- a peer-wide ack is allowed once every lane confirmed its own share ------------
const d1 = await send({ meta: { thread: 'L1' } })
const d2 = await send({ meta: { thread: 'L2' } })
await call('/ack', { peer: 'codex', upTo: d2.seq, target: 'L1' })
await call('/ack', { peer: 'codex', upTo: d2.seq, target: 'L2' })
const clean = await call('/ack', { peer: 'codex', upTo: d2.seq })
assert(clean.body.ok && clean.body.scope === 'peer', 'peer-wide ack goes through once every lane confirmed (' + d1.seq + '–' + d2.seq + ')')

// --- claim: first wins, release frees it -------------------------------------------
const c = await send()
const first = await call('/deliver', { peer: 'codex', seq: c.seq, target: 'T1' })
const second = await call('/deliver', { peer: 'other', seq: c.seq, target: 'T2' })
assert(first.body.ok && first.body.claimed === true, 'first claim is accepted')
assert(second.status === 409 && second.body.held === 'T1', 'second claimant is rejected with the holder')
const again = await call('/deliver', { peer: 'other', seq: c.seq, target: 'T2' })
assert(again.status === 409, 'the rejection is stable (no silent overwrite)')
const released = await call('/release', { peer: 'codex', seq: c.seq })
assert(released.body.released === 'T1', 'release frees the claim')
const retaken = await call('/deliver', { peer: 'other', seq: c.seq, target: 'T2' })
assert(retaken.body.ok, 'another peer can claim after release')

// --- seq high-water survives a restart and log rotation ----------------------------
const before = await send()
bus.kill()
await new Promise(r => setTimeout(r, 400))
const cursorsFile = path.join(DIR, 'cursors.json')
const cursors = JSON.parse(fs.readFileSync(cursorsFile, 'utf8'))
cursors._seq = before.seq + 100
fs.writeFileSync(cursorsFile, JSON.stringify(cursors))
bus = await startBus()
const after = await send()
assert(after.seq === before.seq + 101, 'seq continues from the persisted high-water mark (' + after.seq + ')')

// --- a hand-edited state file with a BOM must not reset the watermarks ------------
// Windows editors and PowerShell's Set-Content -Encoding utf8 love to add a BOM; if the bus
// parses that as invalid JSON and falls back to {}, every cursor silently returns to 0 and
// the whole mailbox becomes unread again (it happened once, to the live bus).
const seen = await send()
await call('/ack', { peer: 'codex', upTo: seen.seq })
bus.kill()
await new Promise(r => setTimeout(r, 400))
const withBom = path.join(DIR, 'cursors.json')
const state = JSON.parse(fs.readFileSync(withBom, 'utf8'))
fs.writeFileSync(withBom, '\ufeff' + JSON.stringify(state))
bus = await startBus()
const afterBom = await inbox()
assert(!afterBom.messages.some(m => m.seq === seen.seq), 'a BOM in cursors.json does not resurrect acked messages')
// A zero ack (what a client sends when it forgets the up_to argument) must never move a
// watermark backwards, or every processed message would come back as unread.
const zero = await call('/ack', { peer: 'codex', upTo: 0, target: 'lane-with-bom' })
assert(zero.status === 400 && zero.body.ok === false, 'an ack with upTo 0 is refused with a 400')
const missing = await call('/ack', { peer: 'codex', target: 'lane-with-bom' })
assert(missing.status === 400, 'an ack with no upTo is refused too')
const afterZero = await inbox()
assert(afterZero.messages.length === 0, 'a refused ack does not reopen the mailbox')
// A watermark past the newest message would hide everything sent afterwards.
const high = (await call('/status', undefined, 'GET')).body.seq
const clampedAck = await call('/ack', { peer: 'codex', upTo: 9999, target: 'lane-with-bom' })
assert(clampedAck.body.cursor === high, 'an ack past the newest seq is clamped to it (' + clampedAck.body.cursor + ' vs ' + high + ')')
const sentLater = await call('/send', { from: 'dsh', to: 'codex', body: 'after the clamp', kind: 'note', meta: { thread: 'lane-with-bom' } })
const laneRead = await call('/inbox?peer=codex&target=lane-with-bom', undefined, 'GET')
assert(laneRead.body.messages.some(m => m.seq === sentLater.body.message.seq),
  'the next message on the clamped lane is still visible')

// --- an untrusted page cannot write, and gets no CORS grant ------------------------
// Binding to 127.0.0.1 is not an origin boundary: any page the user has open can send a
// request to this port. The Origin header is the boundary that actually holds.
const evil = { from: 'dsh', to: 'codex', body: 'forged', kind: 'task' }
const forged = await fetch(BASE + '/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify(evil),
})
assert(forged.status === 403, 'a cross-origin POST is refused (' + forged.status + ')')
const read = await fetch(BASE + '/status', { headers: { origin: 'https://evil.example' } })
assert(!read.headers.get('access-control-allow-origin'), 'a cross-origin read gets no CORS grant')
const opaqueRead = await fetch(BASE + '/status', { headers: { origin: 'null' } })
assert(!opaqueRead.headers.get('access-control-allow-origin'), 'an opaque origin (sandboxed iframe) gets no CORS grant')
const opaqueWrite = await fetch(BASE + '/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'null' },
  body: JSON.stringify({ from: 'dsh', to: 'codex', body: 'forged by an iframe', kind: 'task' }),
})
assert(opaqueWrite.status === 403, 'an opaque origin cannot forge a message (' + opaqueWrite.status + ')')
const appRead = await fetch(BASE + '/status', { headers: { origin: 'dsh-app://app' } })
assert(appRead.status === 200 && appRead.headers.get('access-control-allow-origin') === 'dsh-app://app',
  'the desktop shell custom scheme (dsh-app://app) is allowed')
const nodeWrite = await fetch(BASE + '/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(evil),
})
assert(nodeWrite.status === 200, 'a header-less local client (the MCP server) can still write')

// --- /panel/ping cannot grow the map without bound ---------------------------------
const panelsOf = async () => (await (await fetch(BASE + '/status')).json()).panels
for (let i = 0; i < 40; i++) await fetch(BASE + '/panel/ping?session=probe-' + i)
const panelList = await panelsOf()
assert(panelList.length <= 16, 'panels map is capped (' + panelList.length + ')')
assert(panelList.some(p => p.session === 'probe-39'), 'the newest ping is kept')

bus.kill()
console.log(process.exitCode ? 'SAFETY TEST FAILED' : 'SAFETY TEST PASSED')