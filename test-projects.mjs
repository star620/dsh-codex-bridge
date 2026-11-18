// Project routing tests: two projects on one bus must not read each other's mail.
// Run: $env:ROOT=(Get-Location).Path; node test-projects.mjs
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeCwd, projectIdOf, projectKeyOf } from './lib/project.mjs'

const ROOT = process.env.ROOT || path.dirname(fileURLToPath(import.meta.url))
const DIR = path.join(os.tmpdir(), 'bridge-projects-' + Date.now())
fs.mkdirSync(DIR, { recursive: true })
const PORT = 9000 + Math.floor(Math.random() * 90)
const BASE = 'http://127.0.0.1:' + PORT
const env = { ...process.env, BRIDGE_DIR: DIR, BRIDGE_PORT: String(PORT) }
const assert = (cond, label) => {
  if (!cond) { console.error('FAIL: ' + label); process.exitCode = 1 }
  else console.log('ok: ' + label)
}

const PROJ_A = path.join(DIR, 'alpha')
const PROJ_B = path.join(DIR, 'beta')
fs.mkdirSync(PROJ_A, { recursive: true })
fs.mkdirSync(PROJ_B, { recursive: true })

// --- pure functions -------------------------------------------------------------------
const spellings = [PROJ_A, PROJ_A.toUpperCase(), PROJ_A.replace(/\\/g, '/'), PROJ_A.replace(/\\/g, '/') + '/']
assert(new Set(spellings.map(normalizeCwd)).size === 1, 'four spellings of one folder normalize to one string')
assert(projectIdOf(PROJ_A) === projectIdOf(PROJ_A.toUpperCase()), 'case does not change the project id')
assert(projectIdOf(PROJ_A) !== projectIdOf(PROJ_B), 'different folders get different project ids')
assert(/^[0-9a-f]{8}$/.test(projectIdOf(PROJ_A)), 'project id is 8 hex chars')
assert(projectIdOf('') === '' && projectIdOf('   ') === '', 'no cwd means no project id')
const pidA = projectIdOf(PROJ_A)
const pidB = projectIdOf(PROJ_B)

// Abnormal stored ids (Codex review, seq 21, P3): only an explicit '' means "public". A junk
// string used to be broadcast to every project, while null/42 silently fell back to meta.cwd.
assert(projectKeyOf({ meta: { cwd: PROJ_A } }) === pidA, 'a message without the field derives its project from cwd')
assert(projectKeyOf({ projectId: '', meta: { cwd: PROJ_A } }) === '', 'an explicit empty id stays public')
assert(projectKeyOf({ projectId: pidA.toUpperCase(), meta: {} }) === pidA, 'a stored id is lowercased')
assert(projectKeyOf({ projectId: 'junk', meta: { cwd: PROJ_A } }) === pidA, 'a junk id falls back to the cwd instead of going public')
assert(projectKeyOf({ projectId: null, meta: { cwd: PROJ_A } }) === pidA, 'a null id falls back to the cwd')
assert(projectKeyOf({ projectId: 42, meta: { cwd: PROJ_A } }) === pidA, 'a numeric id falls back to the cwd')
assert(projectKeyOf({ projectId: 'junk', meta: {} }) === '', 'a junk id with no other metadata is public')

// --- bus --------------------------------------------------------------------------------
function startBus() {
  const child = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stderr.on('data', d => process.stderr.write('bus err: ' + d))
  return new Promise(resolve => {
    child.stdout.on('data', d => { if (String(d).includes('listening')) resolve(child) })
    setTimeout(() => resolve(child), 5000)
  })
}
const bus = await startBus()

const call = async (p, b, method = 'POST') => {
  const init = { method, headers: {} }
  if (b !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(b) }
  const res = await fetch(BASE + p, init)
  return { status: res.status, body: await res.json() }
}
const send = async (extra) => (await call('/send', { from: 'codex', to: 'dsh', body: 'x', kind: 'task', ...extra })).body.message
const inbox = async (q = '', peer = 'dsh') => (await call('/inbox?peer=' + peer + q, undefined, 'GET')).body

const aTask = await send({ body: 'alpha task', meta: { cwd: PROJ_A, sessionId: 'session-alpha' } })
const bTask = await send({ body: 'beta task', meta: { cwd: PROJ_B, sessionId: 'session-beta' } })
const globalNote = await send({ body: 'everywhere note' })
const aReply = await send({ body: 'alpha reply', meta: null, replyTo: aTask.seq })

assert(aTask.projectId === pidA, 'a send carrying a cwd is filed under that project')
assert(bTask.projectId === pidB, 'a send from another folder is filed under its own project')
assert(globalNote.projectId === '', 'a send without a cwd stays project-less')
assert(aReply.projectId === pidA, 'a reply inherits the project of the message it answers')

const viewA = await inbox('&project=' + pidA)
const viewB = await inbox('&project=' + pidB)
const seqsA = viewA.messages.map(m => m.seq)
const seqsB = viewB.messages.map(m => m.seq)
assert(seqsA.includes(aTask.seq) && seqsA.includes(aReply.seq), 'project A sees its own tasks and replies')
assert(!seqsA.includes(bTask.seq), 'project A does not see project B')
assert(seqsB.includes(bTask.seq) && !seqsB.includes(aTask.seq), 'project B sees only its own')
assert(seqsA.includes(globalNote.seq) && seqsB.includes(globalNote.seq), 'a project-less message is visible everywhere')
const viewAll = await inbox()
assert([aTask, bTask, globalNote, aReply].every(m => viewAll.messages.some(x => x.seq === m.seq)),
  'no project filter returns everything (old behaviour)')
assert(viewA.project === pidA, 'the inbox echoes the project it filtered on')

// --- the bus derives the registry's project id, publishers cannot set it --------------
await call('/registry', {
  peer: 'dsh', kind: 'session',
  items: [
    { id: 'session-alpha', label: 'alpha', cwd: PROJ_A, status: 'idle' },
    { id: 'session-beta', label: 'beta', cwd: PROJ_B, status: 'idle', projectId: 'deadbeef' },
  ],
})
const reg = (await call('/registry?peer=dsh&kind=session', undefined, 'GET')).body.registry.items
assert(reg[0].projectId === pidA, 'registry item gets the project id derived from its cwd')
assert(reg[1].projectId === pidB, 'a publisher-supplied project id is overwritten by the derived one')

// --- /status groups unread by project --------------------------------------------------
const status = (await call('/status', undefined, 'GET')).body
const entryA = (status.projects || []).find(p => p.id === pidA)
const entryB = (status.projects || []).find(p => p.id === pidB)
assert(!!entryA && entryA.unread === 2, 'status counts project A unread (task + reply)')
assert(!!entryB && entryB.unread === 1, 'status counts project B unread')
assert(!!entryA && entryA.sessions === 1, 'status counts the sessions registered for a project')
assert(entryA.cwd && normalizeCwd(entryA.cwd) === normalizeCwd(PROJ_A), 'status reports the project cwd for display')

// --- /wait honours the project filter --------------------------------------------------
await call('/ack', { peer: 'dsh', upTo: Math.max(aTask.seq, bTask.seq, globalNote.seq, aReply.seq), all: true })
const onlyB = await send({ body: 'beta only', meta: { cwd: PROJ_B, sessionId: 'session-beta' } })
const waitedA = await call('/wait?peer=dsh&timeout=1&project=' + pidA, undefined, 'GET')
assert(waitedA.body.ok && waitedA.body.messages.length === 0, 'wait for project A ignores a project B message')
const waitedB = await call('/wait?peer=dsh&timeout=1&project=' + pidB, undefined, 'GET')
assert(waitedB.body.messages.some(m => m.seq === onlyB.seq), 'wait for project B returns it')

// --- codex-push only pushes its own project -------------------------------------------
const pA = await send({ from: 'dsh', to: 'codex', body: 'push alpha', meta: { cwd: PROJ_A, thread: 'thread-alpha' } })
const pB = await send({ from: 'dsh', to: 'codex', body: 'push beta', meta: { cwd: PROJ_B, thread: 'thread-beta' } })
const pN = await send({ from: 'dsh', to: 'codex', body: 'push anywhere', meta: { thread: 'thread-any' } })
const push = (extra, cwd) => spawnSync(process.execPath, [path.join(ROOT, 'codex-push.mjs'), '--once', '--port', String(PORT), ...extra],
  { encoding: 'utf8', cwd: cwd || ROOT, windowsHide: true })

const runA = push(['--project', pidA])
const outA = String(runA.stdout || '')
assert(outA.includes('seq ' + pA.seq), 'push for project A queues its own message')
assert(!outA.includes('seq ' + pB.seq), 'push for project A skips project B')
assert(outA.includes('seq ' + pN.seq), 'push for project A still sees a project-less message')

const runAuto = push([], PROJ_B)
assert(String(runAuto.stdout || '').includes('project ' + pidB), '--project defaults to auto (this folder)')
assert(String(runAuto.stdout || '').includes('seq ' + pB.seq), 'auto mode picks up the folder it runs in')

const runAll = push(['--all-projects'])
const outAll = String(runAll.stdout || '')
assert(outAll.includes('project (all)'), '--all-projects is visible in the banner')
assert([pA.seq, pB.seq, pN.seq].every(seq => outAll.includes('seq ' + seq)), '--all-projects restores the global view')

// --- a send aimed at a registered DSH lane inherits that session's project --------------
// Runs last: these land in Codex's inbox and would otherwise show up in the push counts above.
const laneSend = await send({ from: 'dsh', to: 'codex', body: 'from beta lane', meta: { sessionId: 'session-beta' } })
assert(laneSend.projectId === pidB, 'a send aimed at a registered session inherits that session project')
const unknownLane = await send({ from: 'dsh', to: 'codex', body: 'unknown lane', meta: { sessionId: 'nobody-home' } })
assert(unknownLane.projectId === '', 'an unregistered session falls through to project-less')

// --- one project's ack must not swallow another project's mail -------------------------
// Reproduction that used to pass silently: B's task sits at a lower seq than A's, A's pusher
// reads only its own project and acks up to its own newest seq with all:true. A peer-wide
// ack used to move the shared watermark past B's undelivered task, which then never showed up
// anywhere. The pusher now sends its project with the ack, and the bus walks a contiguous
// prefix instead of trusting the number.
const xB = await send({ from: 'dsh', to: 'codex', body: 'X-BETA first', meta: { cwd: PROJ_B } })
const xA = await send({ from: 'dsh', to: 'codex', body: 'X-ALPHA second', meta: { cwd: PROJ_A } })
const xaView = await call('/inbox?peer=codex&project=' + pidA)
assert(!xaView.body.messages.some(m => m.seq === xB.seq), 'X: project A cannot see the beta task in front of it')
const xaAck = await call('/ack', { peer: 'codex', upTo: xA.seq, all: true, project: pidA })
assert(xaAck.body.ok && xaAck.body.scope === 'project', 'X: a project ack is recorded as project scope')
assert(xaAck.body.peerCursor === undefined || xaAck.body.peerCursor <= xB.seq - 1,
  'X: the shared watermark stops before the other project\u2019s undelivered task')
const xbStill = await call('/inbox?peer=codex&project=' + pidB)
assert(xbStill.body.messages.some(m => m.seq === xB.seq), 'X: beta still sees its task after alpha acked')
const xbDelivery = await call('/delivery?seq=' + xB.seq)
assert(!xbDelivery.body.delivery, 'X: beta task is still undelivered (not silently confirmed)')
const xaAgain = await call('/inbox?peer=codex&project=' + pidA)
assert(!xaAgain.body.messages.some(m => m.seq === xA.seq), 'X: project A does not see its own acked task again')
const peerView = await call('/inbox?peer=codex')
assert(peerView.body.messages.some(m => m.seq === xB.seq), 'X: the peer view still shows beta (nobody handled it)')
// Once beta's own pusher acks its project, the shared watermark may follow over the prefix.
const xbAck = await call('/ack', { peer: 'codex', upTo: xB.seq, all: true, project: pidB })
assert(xbAck.body.ok && xbAck.body.peerCursor >= xB.seq, 'X: beta ack lets the shared watermark catch up')
assert(!(await call('/inbox?peer=codex')).body.messages.some(m => m.seq === xA.seq || m.seq === xB.seq),
  'X: both projects are read in the peer view after each confirmed its own')

// --- a lane ack inside a project must not walk the shared watermark over other lanes ----
// (Codex review, P1: project + target used to be enough to pass every message of the project.)
const yL1 = await send({ from: 'dsh', to: 'codex', body: 'Y lane L2', meta: { cwd: PROJ_A, thread: 'L2' } })
const yL2 = await send({ from: 'dsh', to: 'codex', body: 'Y lane L1', meta: { cwd: PROJ_A, thread: 'L1' } })
const yAck = await call('/ack', { peer: 'codex', upTo: yL2.seq, target: 'L1', project: pidA })
assert(yAck.body.ok && yAck.body.scope === 'lane', 'Y: a project+lane ack is recorded as a lane ack')
const yOpen = await call('/inbox?peer=codex&project=' + pidA + '&target=L2')
assert(yOpen.body.messages.some(m => m.seq === yL1.seq), 'Y: the other lane is still unread after a lane ack')
assert((await call('/inbox?peer=codex')).body.messages.some(m => m.seq === yL1.seq),
  'Y: the peer view still shows the unread lane (no silent drop)')

// --- a peer-wide ack that would span two projects is refused -------------------------------
const zA = await send({ from: 'dsh', to: 'codex', body: 'Z alpha', meta: { cwd: PROJ_A } })
const zB = await send({ from: 'dsh', to: 'codex', body: 'Z beta', meta: { cwd: PROJ_B } })
const zAck = await call('/ack', { peer: 'codex', upTo: Math.max(zA.seq, zB.seq) })
assert(!zAck.body.ok && /projects at once/.test(zAck.body.error || ''), 'Z: a peer-wide ack across projects is refused')
assert(Array.isArray(zAck.body.projects) && zAck.body.projects.length >= 2, 'Z: the refusal names the projects')
const zAckAll = await call('/ack', { peer: 'codex', upTo: Math.max(zA.seq, zB.seq), all: true })
assert(zAckAll.body.ok && zAckAll.body.scope === 'peer', 'Z: all:true still confirms the whole peer (explicit router)')

// --- declared ids are normalised, junk ids and relative paths are ignored -----------------
const upper = await send({ from: 'dsh', to: 'codex', body: 'upper declared', meta: { projectId: ' ' + pidA.toUpperCase() + ' ' } })
assert(upper.projectId === pidA, 'a declared project id is lowercased and trimmed')
const junk = await send({ from: 'dsh', to: 'codex', body: 'junk declared', meta: { projectId: 'zzz-not-an-id' } })
assert(junk.projectId === '', 'a declared project id that is not 8 hex chars is ignored')
const relative = await send({ from: 'dsh', to: 'codex', body: 'relative cwd', meta: { cwd: 'relative/folder' } })
assert(relative.projectId === '', 'a relative cwd counts as no project instead of guessing the sender folder')

// --- a reply inherits the project it answers, even from another folder --------------------
const origin = await send({ from: 'dsh', to: 'codex', body: 'origin task', meta: { cwd: PROJ_A } })
const crossed = await send({ from: 'codex', to: 'dsh', body: 'reply from B shell', replyTo: origin.seq, meta: { cwd: PROJ_B } })
assert(crossed.projectId === pidA, 'a reply keeps the original project even when the replier runs in B')

// --- a real push (not a dry run) only takes its own project and only acks its own ---------
// Codex review, P2: every push assertion used to be a dry run, so deleting the project
// argument from the pusher kept the suite green. This one delivers for real with a stub codex.
// Clear the earlier hand-made backlog first: the pusher stops at the first message it has no
// thread for, which is correct behaviour but would hide what this block is testing.
await call('/ack', { peer: 'codex', upTo: (await call('/status', undefined, 'GET')).body.seq, all: true })
const pushA = await send({ from: 'dsh', to: 'codex', body: 'REAL-A', meta: { cwd: PROJ_A, thread: 'thread-real-a' } })
const pushB = await send({ from: 'dsh', to: 'codex', body: 'REAL-B', meta: { cwd: PROJ_B, thread: 'thread-real-b' } })
const realEnv = { ...env, STUB_MARKER: path.join(DIR, 'stub.log') }
const realPush = spawnSync(process.execPath, [
  path.join(ROOT, 'codex-push.mjs'), '--send', '--once', '--yes', '--project', pidA,
  // queue is synchronous and this block is about project scoping, not about the delivery
  // mechanism; --queue-verify 0 keeps the stub (which writes no rollout) from failing it.
  '--via', 'queue', '--queue-verify', '0',
  '--port', String(PORT), '--peer', 'codex', '--codex-js', path.join(ROOT, 'test-stub-codex.mjs'),
], { encoding: 'utf8', cwd: ROOT, windowsHide: true, env: realEnv })
const realOut = String(realPush.stdout || '') + String(realPush.stderr || '')
assert(realPush.status === 0, 'a real push pass exits clean')
assert(realOut.includes('project ' + pidA), 'the real push names the project it serves')
assert(realOut.includes('seq ' + pushA.seq) && !realOut.includes('seq ' + pushB.seq),
  'the real push only delivers its own project')
const afterA = await call('/inbox?peer=codex&project=' + pidA)
assert(!afterA.body.messages.some(m => m.seq === pushA.seq), 'its ack covers its own project')
const afterB = await call('/inbox?peer=codex&project=' + pidB)
assert(afterB.body.messages.some(m => m.seq === pushB.seq), 'the other project is still waiting after that ack')
assert((await call('/inbox?peer=codex')).body.messages.some(m => m.seq === pushB.seq),
  'the peer view still shows the other project (nothing was swallowed)')

// --- a filtered wait must not end early because somebody else's mail arrived --------------
// Codex review, P3: waiters are woken per peer, so a project-A watcher used to return an
// empty batch the moment project B got a message, burning a poll each time.
// A project with no mail of its own: its inbox is empty even though other projects have some.
const quietProject = projectIdOf(path.join(DIR, 'gamma'))
const waitStart = Date.now()
const waiting = call('/wait?peer=codex&timeout=1&project=' + quietProject, undefined, 'GET')
await new Promise(r => setTimeout(r, 200))
await send({ from: 'dsh', to: 'codex', body: 'wake for project B only', meta: { cwd: PROJ_B } })
const waited = await waiting
const waitedMs = Date.now() - waitStart
assert(waited.body.ok && waited.body.messages.length === 0, 'the filtered wait returns nothing for a quiet project')
assert(waitedMs >= 900, 'it kept waiting to its deadline instead of ending on a B message (' + waitedMs + 'ms)')

// --- lane ids are shared across projects: a lane ack must not hide the other project -----
// Codex review seq 17 (P1): seq1=B/L1, seq2=A/L1, ack {project:A, target:L1, upTo:2} used to
// push the single shared lane watermark to 2 and make B's message disappear.
const lane = 'shared-lane'
const bLane = await send({ body: 'B in a shared lane', meta: { cwd: PROJ_B, sessionId: lane } })
const aLane = await send({ body: 'A in a shared lane', meta: { cwd: PROJ_A, sessionId: lane } })
const laneAck = await call('/ack', { peer: 'dsh', project: pidA, target: lane, upTo: aLane.seq })
assert(laneAck.body.ok, 'a project can ack its own share of a lane id another project also uses')
const afterLane = (await inbox('&target=' + lane)).messages.map(m => m.seq)
assert(afterLane.includes(bLane.seq), 'project B still sees its message in that lane after A acked it')
assert(!afterLane.includes(aLane.seq), 'project A does not see the share it just acked')
assert((await inbox('&project=' + pidB)).messages.some(m => m.seq === bLane.seq), 'project B mail survives another project acking the same lane')
await call('/ack', { peer: 'dsh', project: pidB, target: lane, upTo: bLane.seq })
assert(!(await inbox('&target=' + lane)).messages.some(m => m.seq === bLane.seq), 'B ack clears B share once B acks it')

// --- project ids are canonicalised on every entry point ---------------------------------
const normTask = await send({ body: 'normalise me', meta: { cwd: PROJ_A } })
const upperAck = await call('/ack', { peer: 'dsh', project: pidA.toUpperCase(), upTo: normTask.seq })
assert(upperAck.body.ok && upperAck.body.scope === 'project', 'an upper-case project id is accepted')
assert(!(await inbox('&project=' + pidA)).messages.some(m => m.seq === normTask.seq), 'the upper-case ack moved the lower-case cursor')
const bad = await call('/ack', { peer: 'dsh', project: 'not-a-project', upTo: normTask.seq })
assert(bad.status === 400, 'a junk project id is refused instead of writing a second cursor')
const badRead = await call('/inbox?peer=dsh&project=not-a-project', undefined, 'GET')
assert(badRead.status === 400, 'the same canonicalisation guards /inbox')

// --- a reply to public mail stays public ------------------------------------------------
const note = await send({ body: 'public note' })
const publicReply = await send({ body: 'answer to everyone', meta: { cwd: PROJ_A }, replyTo: note.seq })
assert(publicReply.projectId === '', 'a reply to project-less mail stays project-less (visible everywhere)')
// Stored field alone was a false green (Codex review, seq 19): projectKeyOf used to re-derive the
// project from meta.cwd when the stored id was empty, so each project's inbox lost this reply.
assert((await inbox('&project=' + pidA)).messages.some(m => m.seq === publicReply.seq),
  'project A can read the reply to public mail')
assert((await inbox('&project=' + pidB)).messages.some(m => m.seq === publicReply.seq),
  'project B can read it too')

// --- acking a public message through a lane actually clears it for that reader ------------
// Codex review, seq 19: "ack project=A target=L upTo=2" returned success while the same read
// handed the public message back forever.
const pubLane = 'public-lane'
const pubMsg = await send({ body: 'public message inside a lane', meta: { sessionId: pubLane } })
assert(pubMsg.projectId === '', 'a message in an unregistered lane is public')
const pubRead = await call('/inbox?peer=dsh&project=' + pidA + '&target=' + pubLane)
assert(pubRead.body.messages.some(m => m.seq === pubMsg.seq), 'project A reads the public message through its lane')
const pubAck = await call('/ack', { peer: 'dsh', project: pidA, target: pubLane, upTo: pubMsg.seq })
assert(pubAck.body.ok, 'acking that public message through the lane is accepted')
const pubAgain = await call('/inbox?peer=dsh&project=' + pidA + '&target=' + pubLane)
assert(!pubAgain.body.messages.some(m => m.seq === pubMsg.seq), 'the same read no longer returns the public message')

// --- a project-owned message on the DEFAULT lane is cleared by the reader's lane ack ------
// Codex review, seq 21, P2: the public-message guard was too narrow, so project mail with no
// target of its own came back on every identical read.
const defLane = 'reader-default-lane'
const defMsg = await send({ body: 'project mail with no lane of its own', meta: { cwd: PROJ_A } })
const defRead = await call('/inbox?peer=dsh&project=' + pidA + '&target=' + defLane)
assert(defRead.body.messages.some(m => m.seq === defMsg.seq), 'the default-lane message shows up in a lane read')
const defAck = await call('/ack', { peer: 'dsh', project: pidA, target: defLane, upTo: defMsg.seq })
assert(defAck.body.ok, 'the default-lane message can be acked through that lane')
const defAgain = await call('/inbox?peer=dsh&project=' + pidA + '&target=' + defLane)
assert(!defAgain.body.messages.some(m => m.seq === defMsg.seq), 'the same read does not hand the default-lane message back')

// --- upgrading an old bus: an ambiguous legacy lane watermark must not hide a project -----
// Old format had one watermark per lane with no project dimension. If the log shows that lane
// shared by two projects, honouring it would hide one of them for good (Codex review, seq 19).
const legacyLane = 'legacy-lane'
const legacyB = await send({ body: 'B before the upgrade', meta: { cwd: PROJ_B, sessionId: legacyLane } })
const legacyA = await send({ body: 'A before the upgrade', meta: { cwd: PROJ_A, sessionId: legacyLane } })
const cursorsFile = path.join(DIR, 'cursors.json')
await new Promise(resolve => { bus.on('exit', resolve); bus.kill() })
const before = JSON.parse(fs.readFileSync(cursorsFile, 'utf8'))
for (const k of Object.keys(before)) if (k.includes(legacyLane)) delete before[k]
before['dsh'] = legacyB.seq - 1
before['dsh|' + legacyLane] = legacyA.seq // the old, project-less watermark that covers both
fs.writeFileSync(cursorsFile, JSON.stringify(before), 'utf8')
let upgradeErr = ''
const bus2 = spawn(process.execPath, [path.join(ROOT, 'bus.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
bus2.stdout.on('data', d => { upgradeErr += String(d) })
bus2.stderr.on('data', d => { upgradeErr += String(d) })
await new Promise(resolve => {
  const t0 = Date.now()
  bus2.stdout.on('data', d => { if (String(d).includes('listening')) resolve() })
  const tick = setInterval(() => { if (Date.now() - t0 > 5000) { clearInterval(tick); resolve() } }, 100)
})
assert(/parked its old watermark/.test(upgradeErr), 'an ambiguous legacy lane watermark is parked, not honoured')
const afterUpgrade = await call('/inbox?peer=dsh&project=' + pidB + '&target=' + legacyLane)
assert(afterUpgrade.body.messages.some(m => m.seq === legacyB.seq),
  'project B is visible again after the upgrade instead of hidden by the old key')
const parkedAlso = await call('/inbox?peer=dsh&target=' + legacyLane)
assert(parkedAlso.body.messages.some(m => m.seq === legacyB.seq), 'the lane view shows the re-queued message too')

bus2.kill()
console.log(process.exitCode ? 'PROJECTS TEST FAILED' : 'PROJECTS TEST PASSED')
