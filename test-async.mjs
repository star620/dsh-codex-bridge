// Async --new delivery: the poll loop must not block on a four-minute Codex turn.
// Run: $env:ROOT=(Get-Location).Path; node test-async.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ROOT || path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(os.tmpdir(), 'bridge-async-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })
const PORT = 9000 + Math.floor(Math.random() * 90)
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT), STUB_MARKER: path.join(DIR, 'stub.log') }
const assert = (cond, label) => { if (!cond) { console.error('FAIL: ' + label); process.exitCode = 1 } else console.log('ok: ' + label) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

const bus = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let busErr = ''
bus.stderr.on('data', d => { busErr += String(d) })
// Poll /health instead of listening for the startup line: a port clash or a slow start used
// to surface as "Unexpected end of JSON input" from the first /send instead of saying so.
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(BASE + '/health')
    if (r.ok) break
  } catch {}
  if (i === 59) throw new Error('bus did not come up: ' + (busErr || '(no stderr)'))
  await new Promise(r => setTimeout(r, 100))
}

const post = async (p, b) => (await (await fetch(BASE + p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
})).json())

const first = (await post('/send', { from: 'dsh', to: 'codex', body: 'fresh conversation please', kind: 'task', meta: { new: true, cwd: DIR } })).message
const second = (await post('/send', { from: 'dsh', to: 'codex', body: 'second one', kind: 'task', meta: { thread: 'existing-thread' } })).message

const pushArgs = (extra = []) => [
  path.join(ROOT, 'codex-push.mjs'), '--send', '--once', '--new', '--yes',
  // This test is about delivery timing, not routing: it pushes messages from two
  // different folders, so it has to opt out of the per-project inbox filter.
  '--all-projects',
  '--port', String(PORT), '--peer', 'codex', '--cwd', DIR,
  '--codex-js', path.join(ROOT, 'test-stub-codex.mjs'),
  // extra comes before the default so a case can override --queue-verify (first occurrence wins).
  ...extra,
  // The stub writes no rollout, so the queue's rollout proof would burn 20s and fail the
  // plumbing cases; the case that wants that proof passes its own value.
  '--queue-verify', '0',
]
const runPush = () => new Promise(resolve => {
  const child = spawn(process.execPath, pushArgs(), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  const t0 = Date.now()
  child.on('exit', code => resolve({ code, out, ms: Date.now() - t0 }))
})

const firstRun = await runPush()
assert(firstRun.code === 0, 'first pass exits clean (' + firstRun.ms + 'ms)')
assert(firstRun.ms < 4000, 'first pass does not wait for the fresh conversation (' + firstRun.ms + 'ms)')
assert(/queued seq 1 -> \(new\)/.test(firstRun.out), 'message 1 reported as a new conversation')
assert(/detached worker pid \d+/.test(firstRun.out), 'a detached worker was started for it')
assert(/queued seq 2 -> existing-thread/.test(firstRun.out), 'message 2 still went to its thread in the same pass')

// Wait for the worker to finish and record the real thread id.
let deliveries = {}
for (let i = 0; i < 40; i++) {
  await sleep(250)
  try { deliveries = JSON.parse(fs.readFileSync(path.join(DIR, 'deliveries.json'), 'utf8')) } catch { continue }
  if (deliveries[String(first.seq)]?.target === 'stub-thread-1') break
}
assert(deliveries[String(first.seq)]?.target === 'stub-thread-1', 'worker replaced the placeholder claim with the real thread id')
assert(fs.existsSync(path.join(DIR, 'stub.log')), 'the stub codex was actually invoked')

const inbox = await (await fetch(BASE + '/inbox?peer=codex')).json()
assert(inbox.messages.length >= 1, 'messages stay visible until the next pass acks them')

// The worker must have released its claim (todo removed) before the catch-up pass, or that
// pass would still hold the ack back and nothing would be skipped.
// The outbox is per bus port / peer / project; --all-projects here means "all".
const todo = path.join(os.tmpdir(), 'codex-bridge-outbox', 'p' + PORT, 'codex', 'all', 'seq-' + first.seq + '.todo')
for (let i = 0; i < 40 && fs.existsSync(todo); i++) await sleep(250)
assert(!fs.existsSync(todo), 'worker cleaned up its placeholder claim')

const secondRun = await runPush()
if (!/skip seq 1/.test(secondRun.out)) console.log('--- second run output ---\n' + secondRun.out)
assert(secondRun.code === 0, 'second pass exits clean')
assert(/skip seq 1/.test(secondRun.out) && /skip seq 2/.test(secondRun.out), 'second pass skips what is already delivered')
const after = await (await fetch(BASE + '/inbox?peer=codex')).json()
assert(after.messages.length === 0, 'nothing left unread after the catch-up pass (' + second.seq + ')')


// --via exec: deliver into an existing thread by running it. 'codex queue' only writes into
// queue_1.sqlite; a failed resume still exits 0, so the message would look delivered forever.
const third = (await post('/send', { from: 'dsh', to: 'codex', body: 'resume this thread', kind: 'task', meta: { thread: 'exec-thread-9' } })).message
const execRun = await new Promise(resolve => {
  const child = spawn(process.execPath, pushArgs(['--via', 'exec']), { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('exit', code => resolve({ code, out }))
})
if (!/queued seq 3/.test(execRun.out)) console.log('--- exec run output ---\n' + execRun.out)
assert(execRun.code === 0, 'exec pass exits clean')
assert(/queued seq 3 -> exec-thread-9/.test(execRun.out), 'exec pass hands the message to a resume worker')
assert(/detached resume worker pid \d+/.test(execRun.out), 'the worker is detached, so the loop keeps polling')
let deliveredExec = null
for (let i = 0; i < 60; i++) {
  await sleep(250)
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DIR, 'deliveries.json'), 'utf8'))
    deliveredExec = d[String(third.seq)] || null
  } catch {}
  if (deliveredExec && deliveredExec.state === 'delivered') break
}
assert(!!deliveredExec && deliveredExec.state === 'delivered' && deliveredExec.target === 'exec-thread-9',
  'the claim turns into a delivery only after the resume turn ran')
const marker = fs.existsSync(env.STUB_MARKER) ? fs.readFileSync(env.STUB_MARKER, 'utf8') : ''
assert(/"args":\["exec","resume","exec-thread-9"/.test(marker), 'the worker called codex exec resume <thread>')
assert(!/"args":\["queue"/.test(marker.slice(marker.lastIndexOf('resume') - 200)), 'exec mode never falls back to queueing')

// Growth is not delivery (Codex review, seq 19): a rollout that moved because of an unrelated
// turn must not confirm the queued message, and one that really carries this message's bridge
// marker must. The stub writes into $CODEX_HOME/sessions, which is where rolloutMark looks.
const runPushEnv = (environment, extra) => new Promise(resolve => {
  const child = spawn(process.execPath, pushArgs(extra), { env: environment, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('exit', code => resolve({ code, out }))
})
const codexHome = path.join(DIR, 'codexhome')
const rolloutEnv = (line) => ({ ...env, CODEX_HOME: codexHome, STUB_ROLLOUT_DIR: path.join(codexHome, 'sessions', '2026', '11', '18'), STUB_ROLLOUT_LINE: line })
const deliveryOf = async (seqNo) => (await (await fetch(BASE + '/delivery?seq=' + seqNo)).json()).delivery

const realThread = (await post('/send', { from: 'dsh', to: 'codex', body: 'a message that really lands', kind: 'task', meta: { thread: 'rollout-thread-a' } })).message
const realRun = await runPushEnv(rolloutEnv(''), ['--via', 'queue', '--queue-verify', '3000'])
if (!/rollout-thread-a/.test(realRun.out)) console.log('--- rollout run output ---\n' + realRun.out)
assert(!/never received/.test(realRun.out), 'a rollout carrying the message marker counts as delivered')
const realDelivery = await deliveryOf(realThread.seq)
assert(realDelivery && realDelivery.state === 'delivered', 'the marker-confirmed message became delivered')

const noisy = (await post('/send', { from: 'dsh', to: 'codex', body: 'a message that only sees noise', kind: 'task', meta: { thread: 'rollout-thread-b' } })).message
const noiseRun = await runPushEnv(rolloutEnv('noise'), ['--via', 'queue', '--queue-verify', '2500'])
if (!/never received/.test(noiseRun.out)) console.log('--- noisy rollout output ---\n' + noiseRun.out)
assert(new RegExp('never received seq ' + noisy.seq).test(noiseRun.out), 'a rollout that only grew by an unrelated turn is not a delivery')
const noiseDelivery = await deliveryOf(noisy.seq)
assert(!noiseDelivery || noiseDelivery.state !== 'delivered', 'the noisy message stayed undelivered')

// The pusher refuses to ack an undelivered message, so a test that wants to move past one has to
// do it explicitly (this is the operator giving up on it, not the bridge claiming delivery).
await post('/ack', { peer: 'codex', upTo: noisy.seq, all: true })

// Raw byte matching also said "delivered" when only the assistant or a tool echoed the marker
// (Codex review, seq 21, P1).
const decoy = (await post('/send', { from: 'dsh', to: 'codex', body: 'a message nobody actually received', kind: 'task', meta: { thread: 'rollout-thread-c' } })).message
const decoyRun = await runPushEnv(rolloutEnv('decoy'), ['--via', 'queue', '--queue-verify', '2500'])
if (!/never received/.test(decoyRun.out)) console.log('--- decoy rollout output ---\n' + decoyRun.out)
assert(new RegExp('never received seq ' + decoy.seq).test(decoyRun.out), 'a marker only in assistant text or tool output is not a delivery')
const decoyDelivery = await deliveryOf(decoy.seq)
assert(!decoyDelivery || decoyDelivery.state !== 'delivered', 'the decoy message stayed undelivered')

await post('/ack', { peer: 'codex', upTo: decoy.seq, all: true })

await post('/ack', { peer: 'codex', upTo: decoy.seq, all: true })

// The target record itself can be bigger than one read window (seq 23, P2). A 1MiB cap on the
// unterminated tail used to throw the half-read user line away and report a false timeout.
const tall = (await post('/send', { from: 'dsh', to: 'codex', body: 'a long one', kind: 'task', meta: { thread: 'rollout-thread-e' } })).message
const tallRun = await runPushEnv(rolloutEnv('tall'), ['--via', 'queue', '--queue-verify', '20000'])
if (!/queued seq/.test(tallRun.out)) console.log('--- tall rollout output ---\n' + tallRun.out)
assert(!/never received/.test(tallRun.out), 'a user line that straddles a chunk boundary is still recognised')
const tallDelivery = await deliveryOf(tall.seq)
assert(tallDelivery && tallDelivery.state === 'delivered', 'the straddling message became delivered')
await post('/ack', { peer: 'codex', upTo: tall.seq, all: true })

// The marker can sit behind more than one read window of unrelated output (seq 21, P2).
const flooded = (await post('/send', { from: 'dsh', to: 'codex', body: 'buried behind nine megabytes', kind: 'task', meta: { thread: 'rollout-thread-d' } })).message
const floodRun = await runPushEnv(rolloutEnv('flood'), ['--via', 'queue', '--queue-verify', '20000'])
if (!/queued seq/.test(floodRun.out)) console.log('--- flooded rollout output ---\n' + floodRun.out)
assert(!/never received/.test(floodRun.out), 'a marker behind 9 MiB of output is still found (the reader walks forward)')
const floodDelivery = await deliveryOf(flooded.seq)
assert(floodDelivery && floodDelivery.state === 'delivered', 'the buried message became delivered')

// queue mode must not trust exit 0: the stub never writes a rollout, which is exactly what a
// stranded 'codex queue' looks like from the outside (measured 2026-11-18).
const fourth = (await post('/send', { from: 'dsh', to: 'codex', body: 'queue into nowhere', kind: 'task', meta: { thread: 'frozen-thread-z' } })).message
const queueRun = await new Promise(resolve => {
  // CODEX_HOME points at a directory with no sessions, so this thread really has no rollout.
  const child = spawn(process.execPath, pushArgs(['--via', 'queue', '--queue-verify', '2000']), { env: { ...env, CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let out = ''
  child.stdout.on('data', d => { out += d })
  child.stderr.on('data', d => { out += d })
  child.on('exit', code => resolve({ code, out }))
})
if (!/never received seq/.test(queueRun.out)) console.log('--- queue run output ---\n' + queueRun.out)
assert(/never received seq/.test(queueRun.out), 'queue mode reports a frozen thread instead of calling it delivered')
// The pass stops at the FIRST unverified message, which here is the noisy one sent above; the
// frozen thread after it must therefore stay unread instead of being acked past.
assert(/stop at seq \d+ ->/.test(queueRun.out), 'the pass stops at the first unverified message')
const afterQueue = await (await fetch(BASE + '/inbox?peer=codex')).json()
assert(afterQueue.messages.some(m => m.seq === fourth.seq), 'the unverified message is released, not acked')

bus.kill()
console.log(process.exitCode ? 'ASYNC TEST FAILED' : 'ASYNC TEST PASSED')