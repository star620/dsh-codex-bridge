// Independent worker stdout -> delivery.turn, including identity and retry guards.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-turn-'))
const PORT = 10400 + Math.floor(Math.random() * 100)
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT), CODEX_HOME: path.join(DIR, 'codex') }
let assertions = 0
const check = (value, label) => { assertions++; if (!value) throw new Error(label); console.log('ok: ' + label) }
const pause = ms => new Promise(r => setTimeout(r, ms))
const bus = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: 'ignore', windowsHide: true })
const request = async (route, body) => {
  const r = await fetch(BASE + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: r.status, ...await r.json() }
}
const delivery = async seq => (await request('/delivery?seq=' + seq)).delivery
const waitFor = async fn => {
  for (let i = 0; i < 150; i++) { const v = await fn(); if (v) return v; await pause(100) }
  throw new Error('timed out waiting for worker')
}
const send = async () => (await request('/send', { from: 'dsh', to: 'codex', body: 'turn test', meta: { thread: 'test-thread', cwd: DIR } })).message.seq
const push = (mode, port = PORT) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [path.join(ROOT, 'codex-push.mjs'), '--send', '--once', '--yes', '--all-projects',
    '--port', String(port), '--via', 'exec', '--cwd', DIR, '--codex-js', path.join(ROOT, 'test-stub-codex.mjs')],
  { env: { ...env, STUB_TURN_MODE: mode }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', b => { out += b })
  child.stderr.on('data', b => { out += b })
  child.on('error', reject)
  child.on('exit', code => resolve({ code, out }))
})
let proxy
try {
  await waitFor(async () => { try { return (await request('/health')).ok } catch { return false } })
  for (const [mode, state, exitCode] of [['completed', 'completed', 0], ['exit3', 'failed', 3], ['missing', 'failed', 0]]) {
    const seq = await send()
    check((await delivery(seq)) === null, 'no execution evidence starts unknown: ' + mode)
    check((await push(mode)).code === 0, 'push exits cleanly: ' + mode)
    const d = await waitFor(async () => { const x = await delivery(seq); return x && x.turn ? x : null })
    check(d.state === 'delivered', 'execution outcome retains delivered: ' + mode)
    check(d.turn.state === state && d.turn.exitCode === exitCode, 'terminal evidence: ' + mode)
    check(d.turn.instance === d.instance && d.turn.attempt === d.attempts, 'worker identity is bound: ' + mode)
    if (state === 'completed') check(d.turn.usage.input_tokens === 10, 'completion usage survives reconnect error noise')
    check((await request('/status')).recent.find(m => m.seq === seq).delivery.turn.state === state, 'status carries turn: ' + mode)
    check((await request('/inbox?peer=codex')).messages.find(m => m.seq === seq).delivery.turn.state === state, 'inbox carries turn: ' + mode)
    await request('/ack', { peer: 'codex', upTo: seq, all: true })
    check(!(await request('/inbox?peer=codex')).messages.some(m => m.seq === seq), 'failed or completed turns can be acked: ' + mode)
    check((await request('/turn', { peer: 'codex', seq, instance: d.instance, attempt: d.attempts, state: state === 'completed' ? 'failed' : 'completed' })).status === 409, 'terminal outcome cannot be overwritten: ' + mode)
  }
  const seq = await send()
  const instance = 'identity-test'
  const first = await request('/deliver', { peer: 'codex', seq, target: 'T', instance })
  check((await request('/turn', { peer: 'codex', seq, instance, attempt: first.attempts, state: 'running' })).status === 409, 'claimed is not eligible for turn writes')
  await request('/release', { peer: 'codex', seq, instance })
  const next = await request('/deliver', { peer: 'codex', seq, target: 'T', instance })
  check(next.attempts > first.attempts, 'attempt does not reset after release')
  await request('/confirm', { peer: 'codex', seq, instance })
  const payload = { peer: 'codex', seq, instance, attempt: next.attempts, state: 'running' }
  check((await request('/turn', { ...payload, instance: undefined })).status === 400, 'missing instance is rejected')
  check((await request('/turn', { ...payload, instance: 'other' })).status === 409, 'another worker is rejected')
  check((await request('/turn', { ...payload, attempt: first.attempts })).status === 409, 'old attempt cannot overwrite this attempt')
  check((await request('/turn', { ...payload, state: 'done' })).status === 400, 'invalid state is rejected')
  check((await request('/turn', payload)).delivery.turn.state === 'running', 'running evidence can be recorded')
  check((await request('/turn', { ...payload, state: 'completed' })).delivery.turn.state === 'completed', 'running can become terminal')
  await request('/confirm', { peer: 'codex', seq, instance })
  check((await delivery(seq)).turn.state === 'completed', 'idempotent confirm preserves turn')
  await request('/ack', { peer: 'codex', upTo: seq, all: true })

  // A failed /turn write must never undo confirmation or block the next cleanup ack.
  proxy = http.createServer(async (req, res) => {
    if (req.url === '/turn') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{"ok":false,"error":"test unavailable"}'); return }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const r = await fetch(BASE + req.url, { method: req.method, ...(req.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: Buffer.concat(chunks) } : {}) })
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text())
    } catch { res.writeHead(502); res.end('{}') }
  })
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
  const unavailableSeq = await send()
  await push('completed', proxy.address().port)
  await waitFor(async () => (await delivery(unavailableSeq))?.state === 'delivered')
  // Wait for the detached worker to finish the failed metadata write.
  await waitFor(async () => fs.existsSync(path.join(os.tmpdir(), 'codex-bridge-outbox', 'p' + proxy.address().port, 'codex', 'all', 'seq-' + unavailableSeq + '.done')))
  check((await delivery(unavailableSeq)).turn === null, 'unavailable turn endpoint leaves unknown, not failed')
  await push('completed', proxy.address().port)
  check(!(await request('/inbox?peer=codex')).messages.some(m => m.seq === unavailableSeq), 'metadata failure does not block delivered cleanup ack')
  console.log('TURN TEST PASSED: ' + assertions + ' assertions')
} finally {
  if (proxy) await new Promise(resolve => proxy.close(resolve))
  bus.kill()
}
