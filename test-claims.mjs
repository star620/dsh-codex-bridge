// Claim protocol tests: a claim is a lease, a delivery is a promise, and an ack may not
// confirm something still in flight.
// Run: $env:ROOT=(Get-Location).Path; node test-claims.mjs
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = process.env.ROOT || path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(os.tmpdir(), 'bridge-claims-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })
const PORT = 9000 + Math.floor(Math.random() * 90)
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT) }
const assert = (cond, label) => { if (!cond) { console.error('FAIL: ' + label); process.exitCode = 1 } else console.log('ok: ' + label) }

function startBus() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', d => { out += String(d) })
  child.stderr.on('data', d => process.stderr.write('bus err: ' + d))
  return new Promise(resolve => {
    const done = () => resolve({ child, out: () => out })
    child.stdout.on('data', d => { if (String(d).includes('listening')) done() })
    setTimeout(done, 5000)
  })
}
let bus = (await startBus()).child

const call = async (p, b, method = 'POST') => {
  const init = { method, headers: {} }
  if (b !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(b) }
  const res = await fetch(BASE + p, init)
  return { status: res.status, body: await res.json() }
}
const send = async (extra = {}) => (await call('/send', { from: 'dsh', to: 'codex', body: 'task ' + Math.random(), kind: 'task', ...extra })).body.message
const inbox = async (q = '') => (await call('/inbox?peer=codex' + q, undefined, 'GET')).body
const claims = async () => (await call('/claims', undefined, 'GET')).body.claims
const writeDeliveries = obj => fs.writeFileSync(path.join(DIR, 'deliveries.json'), JSON.stringify(obj))

// --- a claim is not a delivery: the ack is refused while the lease is live ----------
const m1 = await send()
const claimed = await call('/deliver', { peer: 'codex', seq: m1.seq, target: 'thread-1', ttl: 60000, instance: 'p1' })
assert(claimed.body.ok && claimed.body.state === 'claimed', 'claim reports state=claimed')
assert(claimed.body.expiresIn === 60, 'claim honours the requested lease (' + claimed.body.expiresIn + 's)')
const refused = await call('/ack', { peer: 'codex', upTo: m1.seq })
assert(refused.status === 409 && /in flight/.test(refused.body.error), 'ack over a live claim is refused')
assert(Array.isArray(refused.body.seqs) && refused.body.seqs.includes(m1.seq), 'the refusal names the in-flight seq')
const refusedAll = await call('/ack', { peer: 'codex', upTo: m1.seq, all: true })
assert(refusedAll.status === 409, 'all:true does not bypass the in-flight guard')
const shown = await inbox()
const shownOne = shown.messages.find(m => m.seq === m1.seq)
assert(shownOne && shownOne.delivery.state === 'claimed' && shownOne.delivery.expiresIn > 0,
  'inbox shows the claim and its remaining lease')
const listed = await claims()
assert(listed.some(c => c.seq === m1.seq && c.inFlight === true && c.peer === 'codex'), '/claims lists the live claim')

// --- claim is exclusive even for the same peer, unless it is the same target --------
const otherPeer = await call('/deliver', { peer: 'other', seq: m1.seq, target: 'thread-2' })
assert(otherPeer.status === 409 && otherPeer.body.heldBy === 'codex', 'another peer cannot steal a live claim')
const otherTarget = await call('/deliver', { peer: 'codex', seq: m1.seq, target: 'thread-9' })
assert(otherTarget.status === 409 && /retarget/.test(otherTarget.body.hint || ''),
  'the same peer cannot silently retarget a live claim')
const wrongInstance = await call('/deliver', { peer: 'codex', seq: m1.seq, target: 'thread-1', ttl: 30000, instance: 'p2' })
assert(wrongInstance.status === 409 && /another instance/.test(wrongInstance.body.error),
  'a second worker of the same peer cannot take over the same lane')
const noInstance = await call('/deliver', { peer: 'codex', seq: m1.seq, target: 'thread-1', ttl: 30000 })
assert(noInstance.status === 409 && /requires instance/.test(noInstance.body.error),
  'renewing a claimed lease without an instance is refused')
const sameTarget = await call('/deliver', { peer: 'codex', seq: m1.seq, target: 'thread-1', ttl: 30000, instance: 'p1' })
assert(sameTarget.body.ok && sameTarget.body.expiresIn === 30, 'the holder may renew its own claim')
assert(sameTarget.body.attempts === 2, 'renewal counts as another attempt (' + sameTarget.body.attempts + ')')

// --- confirm turns the claim into a delivery and may rewrite the target ------------
const stolen = await call('/confirm', { peer: 'other', seq: m1.seq })
assert(stolen.status === 409, 'a non-holder cannot confirm')
const anonConfirm = await call('/confirm', { peer: 'codex', seq: m1.seq })
assert(anonConfirm.status === 409 && /requires instance/.test(anonConfirm.body.error),
  'confirm without the instance of the claim is refused')
const anonRelease = await call('/release', { peer: 'codex', seq: m1.seq })
assert(anonRelease.status === 409 && /requires instance/.test(anonRelease.body.error),
  'release without the instance of the claim is refused')
const confirmed = await call('/confirm', { peer: 'codex', seq: m1.seq, target: 'thread-real', instance: 'p1' })
assert(confirmed.body.ok && confirmed.body.target === 'thread-real' && confirmed.body.state === 'delivered',
  'confirm rewrites the target and marks it delivered')
const statusNow = (await call('/status', undefined, 'GET')).body
const recent = statusNow.recent.find(r => r.seq === m1.seq)
assert(recent.delivery.state === 'delivered' && recent.delivery.expiresIn === 0, '/status shows it as delivered, no lease')
assert(!(await claims()).some(c => c.seq === m1.seq), 'a delivered message is no longer a claim')
const again = await call('/deliver', { peer: 'codex', seq: m1.seq, target: 'thread-real' })
assert(again.body.already === true && again.body.state === 'delivered', 're-claiming a delivered message is a no-op')
const releaseAfter = await call('/release', { peer: 'codex', seq: m1.seq })
assert(releaseAfter.status === 409, 'releasing a delivery is refused (it would allow a duplicate)')
const acked = await call('/ack', { peer: 'codex', upTo: m1.seq })
assert(acked.body.ok, 'ack goes through once the message is delivered (' + (acked.body.error || 'ok') + ')')

// --- lanes are independent: one lane's live claim must not freeze another ----------
const laneA = await send({ meta: { thread: 'lane-a' } })
const laneB = await send({ meta: { thread: 'lane-b' } })
await call('/deliver', { peer: 'codex', seq: laneA.seq, target: 'lane-a', ttl: 60000, instance: 'p1' })
const laneBAck = await call('/ack', { peer: 'codex', upTo: laneB.seq, target: 'lane-b' })
assert(laneBAck.body.ok && laneBAck.body.scope === 'lane', 'a lane ack is not blocked by another lane\'s live claim')
const laneAAck = await call('/ack', { peer: 'codex', upTo: laneA.seq, target: 'lane-a' })
assert(laneAAck.status === 409 && /in flight/.test(laneAAck.body.error), 'the lane that holds a claim is still protected')

// --- an expired lease is unread again without waiting for a restart ---------------
const stale = await send({ meta: { thread: 'lane-c' } })
await call('/deliver', { peer: 'codex', seq: stale.seq, target: 'lane-c', ttl: 60000, instance: 'p1' })
const staleFile = JSON.parse(fs.readFileSync(path.join(DIR, 'deliveries.json'), 'utf8'))
staleFile[String(stale.seq)].leaseUntil = Date.now() - 1000
fs.writeFileSync(path.join(DIR, 'deliveries.json'), JSON.stringify(staleFile))
const staleInbox = await inbox('&target=lane-c')
const staleOne = staleInbox.messages.find(m => m.seq === stale.seq)
assert(staleOne && !staleOne.delivery, 'an expired claim reads as unclaimed, not as a live hold')
const staleClaim = await call('/deliver', { peer: 'codex', seq: stale.seq, target: 'lane-c', ttl: 60000, instance: 'p9' })
assert(staleClaim.body.ok && staleClaim.body.state === 'claimed', 'and the lane can be claimed again right away')

// --- a foreign release does nothing, and an expired lease frees the message --------
const m2 = await send()
await call('/deliver', { peer: 'codex', seq: m2.seq, target: 'thread-3', ttl: 60000 })
const foreign = await call('/release', { peer: 'other', seq: m2.seq })
assert(foreign.body.ok && foreign.body.released === null, 'a foreign release is a no-op')
assert((await claims()).some(c => c.seq === m2.seq), 'the holder still owns the claim after a foreign release')
const deliveries = JSON.parse(fs.readFileSync(path.join(DIR, 'deliveries.json'), 'utf8'))
deliveries[String(m2.seq)] = { ...deliveries[String(m2.seq)], leaseUntil: Date.now() - 1000 }
writeDeliveries(deliveries)
const takeover = await call('/deliver', { peer: 'other', seq: m2.seq, target: 'thread-4' })
assert(takeover.body.ok && takeover.body.claimed === true, 'an expired lease can be claimed by someone else')
const m2Again = (await inbox()).messages.find(m => m.seq === m2.seq)
assert(m2Again && m2Again.delivery.peer === 'other', 'the message is unread again, now held by the new owner')
const shortTtl = await call('/deliver', { peer: 'other', seq: m2.seq, target: 'thread-4', ttl: 1 })
assert(shortTtl.body.expiresIn === 5, 'a too-short lease is clamped to 5s (' + shortTtl.body.expiresIn + ')')

// --- a crash mid-claim must not swallow the message -------------------------------
const m3 = await send()
await call('/deliver', { peer: 'codex', seq: m3.seq, target: 'thread-5', ttl: 60000 })
await call('/ack', { peer: 'codex', upTo: m3.seq }) // refused, as asserted above
const beforeRestart = JSON.parse(fs.readFileSync(path.join(DIR, 'deliveries.json'), 'utf8'))
beforeRestart[String(m3.seq)].leaseUntil = Date.now() - 5000
fs.writeFileSync(path.join(DIR, 'deliveries.json'), JSON.stringify(beforeRestart))
bus.kill()
await new Promise(r => setTimeout(r, 400))
const restarted = await startBus()
bus = restarted.child
assert(/released dead claim on seq \d+/.test(restarted.out()), 'startup reconciliation logs the released claim')
const afterRestart = JSON.parse(fs.readFileSync(path.join(DIR, 'deliveries.json'), 'utf8'))
assert(!afterRestart[String(m3.seq)], 'the dead claim is gone from deliveries.json')
const backInInbox = (await inbox()).messages.some(m => m.seq === m3.seq)
assert(backInInbox, 'the message shows up unread again after the restart')

// --- clientMsgId makes a retried send idempotent ----------------------------------
const id = 'task-abc-1'
const first = await send({ body: 'do the thing', kind: 'task', clientMsgId: id })
// Raw call, not send(): the helper drops the response flags.
const second = (await call('/send', { from: 'dsh', to: 'codex', body: 'do the thing', kind: 'task', clientMsgId: id })).body
assert(second.message.seq === first.seq && second.deduplicated === true,
  'same clientMsgId + payload returns the original seq (' + second.message.seq + ' vs ' + first.seq + ')')
const seqHigh = (await call('/status', undefined, 'GET')).body.seq
const countOfThing = (await call('/status', undefined, 'GET')).body.recent.filter(r => r.body === 'do the thing').length
assert(countOfThing === 1, 'the retry did not append a second message (' + countOfThing + ' with seq high ' + seqHigh + ')')
const clashing = await call('/send', { from: 'dsh', to: 'codex', body: 'something else', kind: 'task', clientMsgId: id })
assert(clashing.status === 409 && /different content/.test(clashing.body.error), 'reusing an id with new content is refused')
const noId = await send({ body: 'do the thing', kind: 'task' })
const noId2 = await send({ body: 'do the thing', kind: 'task' })
assert(noId2.seq > noId.seq, 'sends without a clientMsgId are never deduplicated')

// --- the idempotency index is rebuilt from the log, not from sent.json ------------
// The old code appended the message first and wrote sent.json afterwards. A crash in that
// window left a message nobody's index knew about, and the retry created a second task.
const crypto = await import('node:crypto')
const hashOfSend = b => crypto.createHash('sha1')
  .update(JSON.stringify([b.from, b.to, b.kind || 'note', b.body, b.replyTo ?? null, b.meta ?? null]))
  .digest('hex')
const logPath = path.join(DIR, 'messages.jsonl')
const crashId = 'log-only-1'
const crashBody = 'appended but never indexed'
const crashHash = hashOfSend({ from: 'dsh', to: 'codex', kind: 'task', body: crashBody })
const crashSeq = (await call('/status', undefined, 'GET')).body.seq + 1
bus.kill()
await new Promise(r => setTimeout(r, 300))
fs.appendFileSync(logPath, JSON.stringify({
  seq: crashSeq, ts: new Date().toISOString(), from: 'dsh', to: 'codex', kind: 'task',
  body: crashBody, replyTo: null, meta: null, clientMsgId: crashId, hash: crashHash,
}) + '\n')
bus = (await startBus()).child
const retried = (await call('/send', { from: 'dsh', to: 'codex', kind: 'task', body: crashBody, clientMsgId: crashId })).body
assert(retried.deduplicated === true && retried.message.seq === crashSeq,
  'a message appended without its index entry is still deduplicated after a restart')
const crashCopies = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.includes(crashBody)).length
assert(crashCopies === 1, 'the retry did not append a second copy (' + crashCopies + ')')

// --- an id whose message was rotated away must not be sent again ------------------
const archivedId = 'rotated-away-1'
const archivedBody = 'rotated away but already ran'
const archivedHash = hashOfSend({ from: 'dsh', to: 'codex', kind: 'task', body: archivedBody })
bus.kill()
await new Promise(r => setTimeout(r, 300))
const sentFile = path.join(DIR, 'sent.json')
const sentState = JSON.parse(fs.existsSync(sentFile) ? fs.readFileSync(sentFile, 'utf8') : '{}')
sentState[archivedId] = { seq: 424242, hash: archivedHash, at: new Date().toISOString() }
fs.writeFileSync(sentFile, JSON.stringify(sentState))
bus = (await startBus()).child
const archived = (await call('/send', { from: 'dsh', to: 'codex', kind: 'task', body: archivedBody, clientMsgId: archivedId })).body
assert(archived.deduplicated === true && archived.archived === true && archived.seq === 424242,
  'an id whose message is gone from the log returns a receipt instead of a new task')
const archivedCopies = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.includes(archivedBody)).length
assert(archivedCopies === 0, 'the archived retry appended nothing (' + archivedCopies + ')')

bus.kill()
console.log(process.exitCode ? 'CLAIMS TEST FAILED' : 'CLAIMS TEST PASSED')
