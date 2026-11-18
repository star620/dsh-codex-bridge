#!/usr/bin/env node
// Layer test for mcp.mjs: the tools a model actually calls, not the bus underneath.
// Covers the pieces test-claims.mjs cannot see — client_msg_id arriving through a tool
// call, the "held:" line in bridge_inbox, and a 409 surfacing as an MCP error whose text
// names the in-flight seqs (a model only ever sees the tool result).
// Run: node test-mcp.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(os.tmpdir(), 'mcp-smoke-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })
const PORT = 9100 + Math.floor(Math.random() * 80)
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT), BRIDGE_PEER: 'dsh' }
let bad = 0
const ok = (c, label, extra = '') => { console.log((c ? 'ok: ' : 'FAIL: ') + label + (c ? '' : '  ' + extra)); if (!c) bad++ }

const bus = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: 'ignore' })
await new Promise(r => setTimeout(r, 1200))
const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
let buf = ''
const pending = new Map()
mcp.stdout.on('data', d => {
  buf += String(d)
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    const p = pending.get(msg.id); if (p) { pending.delete(msg.id); p(msg) }
  }
})
const rpc = (method, params) => new Promise(resolve => {
  const id = Math.floor(Math.random() * 1e9)
  pending.set(id, resolve)
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const tool = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args })
  return r.result ? (r.result.content ? r.result.content[0].text : JSON.stringify(r.result)) : 'ERROR ' + (r.error && r.error.message)
}
await rpc('initialize', { protocolVersion: '2024-11-05' })
const list = await rpc('tools/list')
ok(list.result.tools.length === 7, 'tools/list has 7 tools', String(list.result.tools.length))

const a = await tool('bridge_send', { to: 'codex', body: 'same payload', kind: 'task', client_msg_id: 'smoke-1' })
const b = await tool('bridge_send', { to: 'codex', body: 'same payload', kind: 'task', client_msg_id: 'smoke-1' })
ok(/seq 1\b/.test(a) && /seq 1\b/.test(b), 'same client_msg_id returns the same seq', a + ' | ' + b)
ok(/duplicate/.test(b), 'the duplicate is called out', b)
const clash = await tool('bridge_send', { to: 'codex', body: 'other payload', kind: 'task', client_msg_id: 'smoke-1' })
ok(/different content/.test(clash), 'a reused id with new content is refused', clash)

const post = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
const sent = await post('/send', { from: 'codex', to: 'dsh', body: 'in flight task', kind: 'task', meta: { sessionId: 'lane-x' } })
const claimed = await post('/deliver', { peer: 'dsh', seq: sent.message.seq, target: 'lane-x', ttl: 60000 })
ok(claimed.state === 'claimed', 'claim accepted', JSON.stringify(claimed))
const inbox = await tool('bridge_inbox')
ok(/held:dsh->lane-x \(\d+s lease\)/.test(inbox), 'inbox shows the live claim as held', inbox)
ok(inbox.includes('turn=-'), 'inbox distinguishes unknown turn evidence')
const ack = await tool('bridge_ack', { up_to: sent.message.seq, target: 'lane-x' })
ok(/in flight/.test(ack) && new RegExp('seqs ' + sent.message.seq).test(ack), 'ack is refused with the in-flight seqs', ack)
const confirmed = await post('/confirm', { peer: 'dsh', seq: sent.message.seq })
ok(confirmed.state === 'delivered', 'confirm marks it delivered')
const ack2 = await tool('bridge_ack', { up_to: sent.message.seq, target: 'lane-x' })
ok(/cursor for dsh lane lane-x is now/.test(ack2), 'ack goes through after the confirm', ack2)
ok(ack2.includes('turn=-'), 'ack includes unknown turn evidence')
const turnMsg = (await post('/send', { from: 'codex', to: 'dsh', body: 'turn ended', meta: { sessionId: 'turn-lane' } })).message
const turnClaim = await post('/deliver', { peer: 'dsh', seq: turnMsg.seq, target: 'turn-lane', instance: 'mcp-turn' })
await post('/confirm', { peer: 'dsh', seq: turnMsg.seq, instance: 'mcp-turn' })
await post('/turn', { peer: 'dsh', seq: turnMsg.seq, instance: 'mcp-turn', attempt: turnClaim.attempts, state: 'running', at: new Date().toISOString() })
ok(/turn=running\(since \d{2}:\d{2}\)/.test(await tool('bridge_inbox', { target: 'turn-lane' })), 'inbox shows the observed running time')
await post('/turn', { peer: 'dsh', seq: turnMsg.seq, instance: 'mcp-turn', attempt: turnClaim.attempts, state: 'completed' })
ok((await tool('bridge_inbox', { target: 'turn-lane' })).includes('turn=completed(本轮结束)'), 'inbox describes completed as this turn ended')
ok((await tool('bridge_ack', { up_to: turnMsg.seq, target: 'turn-lane' })).includes('turn=completed(本轮结束)'), 'ack includes the completed turn')

mcp.kill(); bus.kill()
try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
console.log('')
console.log(bad ? bad + ' failed' : 'MCP TEST PASSED')
process.exit(bad ? 1 : 0)
