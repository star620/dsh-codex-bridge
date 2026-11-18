import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const DIR = path.join(os.tmpdir(), 'bridge-test-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })
const PORT = 8799
const ROOT = process.env.ROOT || path.dirname(fileURLToPath(import.meta.url))
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT) }

const bus = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
await new Promise((resolve, reject) => {
  bus.stdout.on('data', d => { process.stdout.write('bus: ' + d); if (String(d).includes('listening')) resolve() })
  bus.stderr.on('data', d => process.stderr.write('bus err: ' + d))
  setTimeout(() => reject(new Error('bus start timeout')), 8000)
})

const post = async (p, b) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json()
const get = async p => (await fetch(BASE + p)).json()

const sent = await post('/send', { from: 'dsh', to: 'codex', kind: 'task', body: '实现登录页\n要求：只用 CSS。' })
console.log('send ->', JSON.stringify(sent.message))

const mcp = spawn(process.execPath, [path.join(ROOT, 'mcp.mjs')], { env: { ...env, BRIDGE_PEER: 'codex' }, stdio: ['pipe', 'pipe', 'inherit'] })
const rl = readline.createInterface({ input: mcp.stdout })
let pending = new Map()
rl.on('line', l => {
  const msg = JSON.parse(l)
  if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  else console.log('<<', l)
})
let id = 0
const rpc = (method, params) => new Promise(resolve => {
  const myId = ++id
  pending.set(myId, resolve)
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: myId, method, params }) + '\n')
})

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
console.log('initialize ->', JSON.stringify(init.result))
const list = await rpc('tools/list', {})
console.log('tools ->', list.result.tools.map(t => t.name).join(','))
const inbox = await rpc('tools/call', { name: 'bridge_inbox', arguments: {} })
console.log('inbox ->', inbox.result.content[0].text)
const reply = await rpc('tools/call', { name: 'bridge_send', arguments: { to: 'dsh', body: '已收到，开始实现。', kind: 'result', reply_to: 1 } })
console.log('reply ->', reply.result.content[0].text)
const ack = await rpc('tools/call', { name: 'bridge_ack', arguments: { up_to: 1 } })
console.log('ack ->', ack.result.content[0].text)
const inbox2 = await rpc('tools/call', { name: 'bridge_inbox', arguments: {} })
console.log('inbox after ack ->', inbox2.result.content[0].text)
const peers = await rpc('tools/call', { name: 'bridge_peers', arguments: {} })
console.log('peers ->', peers.result.content[0].text)
const dshInbox = await get('/inbox?peer=dsh')
console.log('dsh inbox ->', JSON.stringify(dshInbox.messages))

mcp.kill(); bus.kill()
console.log('files:', fs.readdirSync(DIR).join(','))
