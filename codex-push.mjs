#!/usr/bin/env node
// Push pending bus messages into a specific Codex conversation, so a DSH task
// lands in the thread it was meant for instead of whatever Codex opened last.
//
// Codex has no way to be woken from outside except `codex queue`, which appends a message to
// an existing thread and (with --resume) asks the local daemon to run it. This
// process is the Codex-side counterpart of wake-bundle: same bus, other end.
//
//   node codex-push.mjs                # dry run: print the commands, change nothing
//   node codex-push.mjs --send         # actually queue the messages
//   node codex-push.mjs --send --once  # one pass, then exit
//   node codex-push.mjs --new          # force every message into a brand new Codex conversation
//
// Options: --project <id|auto> (default auto = this folder's project; --all-projects for
// the old global behaviour), --thread <id> (default thread), --no-resume (append without waking Codex),
// --sandbox read-only|workspace-write|danger-full-access, --cwd <dir> (where a new
// conversation starts), --timeout <ms> (how long a new conversation may run), --port, --peer.
// Safety: a stale peer cursor looks like a huge backlog, so --send refuses to push more than
// 3 messages at once unless you add --yes. Ack the backlog first when that happens.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { listThreads, sessionsRoot } from './lib/threads.mjs'
import { projectIdOf, projectIdOfDeclared } from './lib/project.mjs'

const args = process.argv.slice(2)
const flag = name => args.includes('--' + name)
const value = (name, fallback) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const PORT = Number(value('port', 8787))
const BASE = 'http://127.0.0.1:' + PORT
const PEER = value('peer', 'codex')
const SEND = flag('send')
const ONCE = flag('once')
const EVERY = Math.max(2000, Number(value('every', 15000)))
const DEFAULT_THREAD = value('thread', '')
const RESUME = !flag('no-resume')
// New-conversation delivery: instead of queueing into an existing thread, spawn a fresh
// `codex exec` in the target cwd. Codex derives a new thread id on its own and we report it.
const FORCE_NEW = flag('new')
const SANDBOX = value('sandbox', 'workspace-write')
const EXEC_CWD = value('cwd', process.cwd())
// Delivery scope for messages that carry no meta.cwd; empty means "refuse rather than guess".
const SCOPE_CWD = value('scope', '')
// 1s, not 1ms: tests pass small values, but a typo must not kill a turn instantly.
const EXEC_TIMEOUT = Math.max(1000, Number(value('timeout', 900000)))
// --gui prefers a thread the Codex desktop app created (session_meta.source=vscode),
// because exec threads never show up in its "recent" list.
const GUI = flag('gui')
// A fresh conversation runs a full Codex turn (minutes). Blocking the whole poll loop on it
// stalled every other message, so --new hands the turn to a detached worker by default;
// --wait keeps the old blocking behaviour (useful when you want the thread id immediately).
const ASYNC = !flag('wait')
const WORKER = flag('worker')
// How a message reaches an existing thread.
//   queue: write into Codex's queue_1.sqlite and ask the daemon to resume. Measured 2026-11-18:
//          for a thread created by 'codex exec' the daemon has nothing to resume, so the command
//          exits 0, the rollout never grows and the message just sits in the queue file.
//          "queue exited 0" is NOT "Codex saw it".
//   exec:  spawn 'codex exec resume <thread>' ourselves - always runs a turn, always costs one.
// Default is exec: a queue that exits 0 without a turn is silent loss, and silent loss is the
// only failure mode this bridge cannot recover from on its own.
const VIA = String(value('via', 'exec')).toLowerCase()
const VIA_EXEC = VIA === 'exec'
const WORKER_RESUME = flag('worker-resume')
// Test seam: --codex-js <file> runs that script with node instead of the real codex.exe, so the
// delivery path can be exercised end to end without burning a paid turn.
const CODEX_JS = value('codex-js', '')
// A claim is a lease, not a delivery. It has to outlive one full Codex turn (minutes), or the
// lease expires while the turn is still running and a second pusher picks the message up.
// --claim-ttl is in ms; the bus clamps it to [5s, 1h].
const CLAIM_TTL = Math.max(5000, Number(value('claim-ttl', 900000)))
// Identifies this process as the owner of its claims, so a restarted pusher does not fight
// itself over a lease it no longer remembers holding.
// The detached worker is a second process, so it gets this through --instance: otherwise its
// /confirm would be refused as "another instance of codex".
const INSTANCE = value('instance', os.hostname() + ':' + process.pid + ':' + Math.random().toString(36).slice(2, 8))
// Which project's mail this pusher is allowed to see. Default "auto" = the folder it was
// started in, so two projects on one bus stop handing each other's tasks to the wrong
// Codex thread. --all-projects restores the old global behaviour (explicit, like --yes).
const PROJECT_FLAG = value('project', 'auto')
const ALL_PROJECTS = flag('all-projects')
const PROJECT = ALL_PROJECTS
  ? ''
  : (PROJECT_FLAG === 'auto' ? projectIdOf(process.cwd()) : projectIdOfDeclared(PROJECT_FLAG) || String(PROJECT_FLAG || '').trim().slice(0, 64))
// Where the detached worker picks up its prompt and leaves its result. Kept out of the bus
// directory on purpose: it is per-machine scratch, not shared state. It is per PROJECT too:
// a worker left behind by another project's crash must not hold this project's ack ceiling
// forever (pruneTodos only clears markers it can see, and only when the bus says delivered).
// Path also carries the bus port and peer: two buses on one machine reuse seq numbers, and a
// marker for seq 12 on one bus must never hold the ack ceiling of the other.
const OUTBOX = value('outbox', '')
  ? path.resolve(value('outbox', ''))
  : path.join(os.tmpdir(), 'codex-bridge-outbox', 'p' + PORT, PEER, PROJECT || 'all')
// How long a `codex queue` is given to make the thread's rollout file move before its exit 0 is
// treated as "went nowhere". 0 disables the check (and trusts the exit code again).
const QUEUE_VERIFY_MS = Math.max(0, Number(value('queue-verify', 20000)))
// Upper bound for one unterminated rollout line held in memory while verifying a queue delivery.
const PENDING_MAX = 64 * 1024 * 1024

/** Locate codex.exe; the .ps1 shim is blocked by the execution policy. */
function codexExe() {
  const explicit = value('codex', '')
  if (explicit) return explicit
  const root = path.join(os.homedir(), 'AppData', 'Local', 'OpenAI', 'Codex', 'bin')
  try {
    for (const dir of fs.readdirSync(root)) {
      const candidate = path.join(root, dir, 'codex.exe')
      if (fs.existsSync(candidate)) return candidate
    }
  } catch {}
  return 'codex'
}

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Size+mtime of a thread's rollout file — the only evidence that Codex actually ran a turn.
 * '' means no file found, which must never be read as "delivered".
 */
function rolloutPath(thread) {
  if (!thread) return ''
  const stack = [sessionsRoot()]
  while (stack.length) {
    const dir = stack.pop()
    let entries = []
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) { stack.push(full); continue }
      if (!ent.name.includes(thread)) continue
      return full
    }
  }
  return ''
}

function rolloutMark(thread) {
  const file = rolloutPath(thread)
  if (!file) return ''
  try { const st = fs.statSync(file); return st.size + ':' + Math.round(st.mtimeMs) } catch { return '' }
}

/** Bytes the rollout gained after `fromOffset`, or null when it has not grown. */
function appended(file, fromOffset, cap = 4 * 1024 * 1024) {
  let st
  try { st = fs.statSync(file) } catch { return null }
  if (!(st.size > fromOffset)) return null
  const len = Math.min(st.size - fromOffset, cap)
  const buf = Buffer.alloc(len)
  let fd = -1
  try {
    fd = fs.openSync(file, 'r')
    fs.readSync(fd, buf, 0, len, fromOffset)
  } catch { return null } finally { if (fd >= 0) { try { fs.closeSync(fd) } catch {} } }
  return buf
}

/**
 * Is this rollout line the USER INPUT that carries `needle`?
 * Raw byte matching was a false-positive machine (Codex review, seq 21, P1): the marker also
 * appears in the assistant's own text ("re: bridge seq 20 from dsh"), in tool arguments and in
 * tool output, so a thread that merely mentioned the message looked delivered. Only a parsed
 * response_item / message / role=user whose content really contains the marker counts.
 */
function isUserInput(line, needle) {
  if (!line.includes(needle)) return false
  let o
  try { o = JSON.parse(line) } catch { return false }
  if (!o || o.type !== 'response_item' || !o.payload) return false
  const p = o.payload
  if (p.type !== 'message' || p.role !== 'user') return false
  const parts = Array.isArray(p.content) ? p.content : []
  return parts.some(part => part && typeof part.text === 'string' && part.text.includes(needle))
}

/**
 * Wait until the rollout *contains this message*, not merely until it grows.
 * Growth alone proves nothing: the thread may be running an unrelated turn, or the user typed
 * something, which moves the file while the queued message stays in queue_1.sqlite and would
 * then be confirmed and acked (Codex review, seq 19, P1 — its counterexample was a rollout that
 * grew 100:199 -> 101:200 with none of the message in it).
 */
async function waitForRollout(thread, fromSize, marker, ms) {
  if (ms <= 0) return true
  const deadline = Date.now() + ms
  const needle = String(marker)
  let offset = fromSize
  let pending = Buffer.alloc(0)
  for (;;) {
    const file = rolloutPath(thread)
    if (file) {
      // Walk forward in chunks instead of re-reading one fixed window: a big unrelated turn
      // (or 8MiB of tool output) used to push the marker out of the window for good, and every
      // poll read the same bytes again (Codex review, seq 21, P2).
      for (;;) {
        const chunk = appended(file, offset)
        if (!chunk) break
        offset += chunk.length
        pending = Buffer.concat([pending, chunk])
        for (;;) {
          const nl = pending.indexOf(10)
          if (nl < 0) break
          const line = pending.subarray(0, nl).toString('utf8')
          pending = pending.subarray(nl + 1)
          if (isUserInput(line, needle)) return true
        }
        // Keep the partial line: the target user record itself can be megabytes (bus bodies go
        // up to 4,000,000 chars and JSON escaping inflates them), and a 1MiB cap used to drop a
        // legitimate long input that straddled a chunk boundary -> timeout, release, requeue
        // (Codex review, seq 23, P2).
        if (pending.length > PENDING_MAX) {
          console.error('[codex-push] rollout buffer exceeded ' + PENDING_MAX + ' bytes; dropping it')
          pending = Buffer.alloc(0)
        }
        if (chunk.length < 4 * 1024 * 1024) break
      }
    }
    if (Date.now() >= deadline) return false
    await pause(1000)
  }
}

/** Command + argv for one codex call, honouring the --codex-js test seam. */
function codexCommand(argv) {
  if (CODEX_JS) return { cmd: process.execPath, argv: [CODEX_JS, ...argv] }
  return { cmd: codexExe(), argv }
}

const api = async (method, p, payload, signal) => {
  const init = { method, headers: {}, ...(signal ? { signal } : {}) }
  if (payload !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(payload) }
  const res = await fetch(BASE + p, init)
  return res.json()
}

/**
 * Thread id a message belongs in. Explicit routing wins; otherwise the newest thread in the
 * message's cwd. A missing cwd is NOT a wildcard any more: "newest thread anywhere" happily
 * dropped tasks into unrelated projects, so the caller must scope itself or opt out with --new.
 */
/**
 * Newest thread in a directory, optionally restricted to ones the desktop app owns.
 * Returns { id, source } or { id: '', reason }. With --gui we refuse to fall back: silently
 * queueing into an exec thread would defeat the whole point of asking for a visible one.
 */
function pickThread(hint, preferGui) {
  const rows = listThreads({ limit: 100, cwd: hint })
  if (rows.length === 0) return { id: '', reason: 'no thread found under ' + hint }
  if (preferGui) {
    const gui = rows.find(t => t.source === 'vscode')
    if (gui) return { id: gui.id, source: gui.source }
    return {
      id: '',
      reason: '--gui wants a thread the desktop app owns, but every thread under ' + hint +
        ' came from codex exec (source=exec). Drop --gui to use the newest one, or use --new.',
    }
  }
  return { id: rows[0].id, source: rows[0].source }
}

function resolveThread(message) {
  const explicit = message?.meta?.thread
  if (typeof explicit === 'string' && explicit.trim()) return { id: explicit.trim(), source: 'meta' }
  if (DEFAULT_THREAD && DEFAULT_THREAD !== 'gui') return { id: DEFAULT_THREAD, source: 'flag' }
  const hint = (typeof message?.meta?.cwd === 'string' && message.meta.cwd) || SCOPE_CWD || EXEC_CWD
  if (!hint) return { id: '', reason: 'message has no meta.cwd and no --thread/--cwd was given' }
  // --gui, or --thread gui, means "a conversation I can actually see in the app".
  return pickThread(hint, GUI || DEFAULT_THREAD === 'gui')
}

function promptFor(message, lane) {
  const t = lane && !lane.startsWith('(') ? ' target=' + lane : ''
  return message.body + '\n\n[bridge seq ' + message.seq + ' from ' + message.from +
    ' — 处理完请调用 bridge_inbox' + t + ' 并用 bridge_ack up_to=' + message.seq + t + ' 回执]'
}

/**
 * Claim a message before touching Codex, so two pushers cannot both queue it.
 * The claim is a lease: if this process dies mid-turn the bus releases it after the TTL and the
 * message shows up unread again instead of looking delivered.
 */
async function claim(seqNo, target) {
  // Three outcomes, not two. "already" means somebody else delivered it — skip, do not run it
  // again. "conflict"/"unknown" means we do not hold a lease and must not touch Codex: the old
  // version returned true for both, so a second process (or a failed request) re-queued the task.
  let r
  try {
    r = await api('POST', '/deliver', { peer: PEER, seq: seqNo, target, ttl: CLAIM_TTL, instance: INSTANCE })
  } catch (err) {
    return { ok: false, reason: 'bus refused the claim: ' + String((err && err.message) || err) }
  }
  if (r && r.state === 'delivered') return { ok: false, already: true }
  if (!r || r.ok === false) return { ok: false, reason: 'claim refused: ' + (r && (r.error || r.hint)) || 'no answer' }
  return { ok: true, attempt: r.attempts }
}

/**
 * Turn our claim into a delivery, optionally rewriting the target (the '(new)' placeholder
 * becomes the real thread id once Codex reports it). /deliver would refuse the retarget —
 * that refusal is what keeps two consumers off one message.
 */
async function confirm(seqNo, target, signal) {
  try {
    const r = await api('POST', '/confirm', { peer: PEER, seq: seqNo, target, instance: INSTANCE }, signal)
    if (r && r.ok === false) console.error('[codex-push] confirm failed for seq ' + seqNo + ': ' + (r.error || 'unknown'))
    return r
  } catch (err) {
    console.error('[codex-push] confirm failed for seq ' + seqNo + ': ' + (err && err.message || err))
    return null
  }
}

async function release(seqNo) {
  try { await api('POST', '/release', { peer: PEER, seq: seqNo, instance: INSTANCE }) } catch {}
}

/** Optional turn metadata never changes delivery or ack eligibility. */
async function writeTurn(seq, attempt, state, at, details = {}) {
  try {
    const r = await api('POST', '/turn', { peer: PEER, seq, instance: INSTANCE, attempt, state, at, ...details }, AbortSignal.timeout(5000))
    if (!r || !r.ok) console.error('[codex-push] turn write failed for seq ' + seq + ': ' + (r && r.error || 'no response'))
  } catch (err) { console.error('[codex-push] turn write failed for seq ' + seq + ': ' + String(err.message || err)) }
}

/** One child and one stdout stream identify this attempt; JSON records may span chunks. */
async function runExec(seq, initialThread, argv, prompt, cwd, attempt) {
  const call = codexCommand(argv)
  let thread = initialThread, completed = null, started = false, startedAt = null
  let confirmed = false, runningQueued = false, pending = Buffer.alloc(0), stderr = Buffer.alloc(0)
  let writes = Promise.resolve(), timedOut = false, processError = null
  const ensureConfirmed = async () => {
    if (!confirmed && thread) {
      const r = await confirm(seq, thread, AbortSignal.timeout(5000))
      confirmed = !!(r && r.ok)
    }
    return confirmed
  }
  const maybeRunning = () => {
    if (!started || !thread || runningQueued) return
    runningQueued = true
    writes = writes.then(async () => {
      if (await ensureConfirmed()) await writeTurn(seq, attempt, 'running', startedAt)
    })
  }
  const record = line => {
    let e; try { e = JSON.parse(line.toString('utf8')) } catch { return }
    if (!e || typeof e !== 'object') return
    if (e.type === 'thread.started' && typeof e.thread_id === 'string' && !thread) thread = e.thread_id
    if (e.type === 'turn.started' && !started) { started = true; startedAt = new Date().toISOString() }
    if (e.type === 'turn.completed') completed = e
    maybeRunning()
  }
  const child = spawn(call.cmd, call.argv, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const result = await new Promise(resolve => {
    let killTimer
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
    }, EXEC_TIMEOUT)
    const onOut = data => {
      pending = Buffer.concat([pending, data])
      let nl
      while ((nl = pending.indexOf(10)) >= 0) { record(pending.subarray(0, nl)); pending = pending.subarray(nl + 1) }
    }
    const onErr = data => { stderr = Buffer.concat([stderr, data]).subarray(-1604) }
    const onError = err => { processError = err }
    const onInputError = () => {} // a child may close stdin before the prompt is fully written
    child.stdout.on('data', onOut)
    child.stderr.on('data', onErr)
    child.on('error', onError)
    child.stdin.on('error', onInputError)
    child.once('close', (status, signal) => {
      clearTimeout(timer); clearTimeout(killTimer)
      if (pending.length) record(pending)
      pending = Buffer.alloc(0)
      child.stdout.off('data', onOut); child.stderr.off('data', onErr)
      child.off('error', onError); child.stdin.off('error', onInputError)
      resolve({ status, signal })
    })
    child.stdin.end(prompt)
  })
  await writes
  const received = started || !!completed || result.status === 0
  if (!received || !thread) {
    await release(seq)
    return { ...result, ok: false, queued: false, thread: thread || '(unknown)', stderr: stderr.toString('utf8').slice(-400) }
  }
  if (!(await ensureConfirmed())) return { ...result, ok: false, queued: false, thread, stderr: 'delivery confirmation failed' }
  const state = !timedOut && result.status === 0 && completed ? 'completed' : 'failed'
  await writeTurn(seq, attempt, state, new Date().toISOString(), {
    ...(Number.isInteger(result.status) ? { exitCode: result.status } : {}),
    ...(completed && completed.usage ? { usage: completed.usage } : {}),
    ...(state === 'failed' ? { note: timedOut ? 'timeout' : processError ? String(processError.message) :
      result.status === 0 ? 'process exited without turn.completed' : 'process exited nonzero' } : {}),
  })
  return { ...result, ok: true, queued: true, thread, stderr: stderr.toString('utf8').slice(-400) }
}

/** --wait still awaits the same streaming runner used by detached workers. */
async function startConversation(message, attempt) {
  const cwd = (typeof message?.meta?.cwd === 'string' && message.meta.cwd) || EXEC_CWD
  const argv = ['exec', '--skip-git-repo-check', '-s', SANDBOX, '-C', cwd, '--json', '-']
  const command = 'codex exec --json -'
  if (!SEND) return { ok: true, thread: '(new)', command, queued: false }
  if (message?.meta?.thread) return { ok: false, reason: 'meta.thread and meta.new conflict' }
  return { ...await runExec(message.seq, '', argv, promptFor(message), cwd, attempt), command }
}

/** Marker files let the parent tell "a fresh conversation is still running" from "done". */
function todoPath(seqNo) { return path.join(OUTBOX, 'seq-' + seqNo + '.todo') }
function donePath(seqNo) { return path.join(OUTBOX, 'seq-' + seqNo + '.done') }
function todoSeqs() {
  try {
    return fs.readdirSync(OUTBOX)
      .filter(f => f.endsWith('.todo'))
      .map(f => Number(f.slice(4, -5)))
      .filter(n => Number.isFinite(n) && n > 0)
  } catch { return [] }
}

/**
 * .todo markers whose worker confirmed the delivery and then died before deleting the file
 * would otherwise hold the ack ceiling forever (the message is skipped as delivered, but the
 * marker still says "running"). Ask the bus, which is the only authority on delivery state.
 */
async function pruneTodos() {
  const stay = []
  for (const seqNo of todoSeqs()) {
    let delivery = null
    try {
      const r = await api('GET', '/delivery?seq=' + seqNo)
      delivery = r && r.delivery
    } catch { /* bus unreachable: keep the marker and retry next pass */ }
    if (delivery && delivery.state === 'delivered') {
      try { fs.unlinkSync(todoPath(seqNo)) } catch {}
      try { fs.unlinkSync(path.join(OUTBOX, 'seq-' + seqNo + '.prompt')) } catch {}
      console.log('[codex-push] dropped stale .todo for seq ' + seqNo + ' (already delivered to ' + delivery.target + ')')
      continue
    }
    stay.push(seqNo)
  }
  return stay
}

/**
 * Hand a fresh-conversation turn to a detached worker. The worker runs "codex exec", then
 * replaces our placeholder claim with the real thread id; the poll loop keeps running instead
 * of sitting inside a four-minute turn.
 */
function startConversationAsync(message, attempt) {
  fs.mkdirSync(OUTBOX, { recursive: true })
  const promptFile = path.join(OUTBOX, 'seq-' + message.seq + '.prompt')
  fs.writeFileSync(promptFile, promptFor(message, ''), 'utf8')
  fs.writeFileSync(todoPath(message.seq), String(Date.now()))
  const logFile = path.join(OUTBOX, 'seq-' + message.seq + '.log')
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '--worker', '--seq', String(message.seq),
    '--prompt', promptFile,
    '--cwd', (typeof message?.meta?.cwd === 'string' && message.meta.cwd) || EXEC_CWD,
    '--sandbox', SANDBOX, '--port', String(PORT), '--peer', PEER, '--timeout', String(EXEC_TIMEOUT),
    '--instance', INSTANCE, '--attempt', String(attempt), '--outbox', OUTBOX,
    // The worker must inherit the test seam; otherwise a stubbed run would launch the real
    // codex.exe in the background (it did once, during testing, and burned a paid turn).
    ...(CODEX_JS ? ['--codex-js', CODEX_JS] : []),
  ], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true })
  child.unref()
  fs.closeSync(logFd)
  return {
    ok: true, thread: '(new)', queued: true, async: true,
    command: 'detached worker pid ' + child.pid + ' (log: ' + logFile + ')',
  }
}

/** Detached fresh conversation: use the same stdin and streaming evidence path. */
async function workerMain() {
  const seq = Number(value('seq', 0)), cwd = value('cwd', process.cwd())
  const prompt = fs.readFileSync(value('prompt', ''), 'utf8')
  const argv = ['exec', '--skip-git-repo-check', '-s', SANDBOX, '-C', cwd, '--json', '-']
  const run = await runExec(seq, '', argv, prompt, cwd, Number(value('attempt', 0)))
  try { fs.unlinkSync(todoPath(seq)) } catch {}
  fs.writeFileSync(donePath(seq), JSON.stringify({ seq, thread: run.thread, ok: run.ok }), 'utf8')
}

/**
 * Deliver into an existing thread by RUNNING it, not by queueing into a store nobody reads.
 * 'codex queue --resume' looks like the same thing, but a thread that came from 'codex exec' has
 * no live session for the daemon to resume: exit 0, rollout untouched, message stranded. This
 * worker runs one turn itself and confirms the claim only if that turn really started.
 */
function startResumeAsync(message, thread, text, attempt) {
  fs.mkdirSync(OUTBOX, { recursive: true })
  const promptFile = path.join(OUTBOX, 'seq-' + message.seq + '.prompt')
  fs.writeFileSync(promptFile, text, 'utf8')
  fs.writeFileSync(todoPath(message.seq), String(Date.now()))
  const logFile = path.join(OUTBOX, 'seq-' + message.seq + '.log')
  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [
    fileURLToPath(import.meta.url), '--worker-resume', '--seq', String(message.seq),
    '--thread', thread, '--prompt', promptFile,
    '--cwd', (typeof message?.meta?.cwd === 'string' && message.meta.cwd) || EXEC_CWD,
    '--timeout', String(EXEC_TIMEOUT), '--port', String(PORT), '--peer', PEER, '--instance', INSTANCE,
    '--outbox', OUTBOX, '--attempt', String(attempt),
    ...(CODEX_JS ? ['--codex-js', CODEX_JS] : []),
  ], { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true })
  child.unref()
  fs.closeSync(logFd)
  return {
    ok: true, thread, queued: true, async: true,
    command: 'detached resume worker pid ' + child.pid + ' (log: ' + logFile + ')',
  }
}

/** Existing-thread worker, with the same lifecycle as --new and --wait. */
async function resumeWorkerMain() {
  const seq = Number(value('seq', 0)), thread = value('thread', '')
  const prompt = fs.readFileSync(value('prompt', ''), 'utf8')
  const argv = ['exec', 'resume', thread, '--skip-git-repo-check', '--json', '-o', path.join(OUTBOX, 'seq-' + seq + '.last.md'), '-']
  const run = await runExec(seq, thread, argv, prompt, value('cwd', process.cwd()), Number(value('attempt', 0)))
  try { fs.unlinkSync(todoPath(seq)) } catch {}
  fs.writeFileSync(donePath(seq), JSON.stringify({ seq, thread, ok: run.ok, via: 'exec' }), 'utf8')
}

async function deliver(message) {
  const wantsNew = message?.meta?.new === true || (FORCE_NEW && !message?.meta?.thread)
  if (wantsNew) {
    if (!SEND) return startConversation(message)
    const took = await claim(message.seq, '(new)')
    if (!took.ok) {
      if (took.already) return { ok: true, skipped: 'already delivered elsewhere', thread: '(new)' }
      // Not "skipped": a skipped message advances the ack watermark, and this one was never
      // handed to Codex. Stop the pass and let the next one retry.
      return { ok: false, reason: took.reason }
    }
    if (ASYNC) return startConversationAsync(message, took.attempt)
    const created = await startConversation(message, took.attempt)
    if (!created.ok) await release(message.seq)
    return created
  }
  const picked = resolveThread(message)
  if (!picked.id) {
    return { ok: false, reason: 'no thread to deliver into: ' + picked.reason + ' (use --new for a fresh conversation)' }
  }
  const thread = picked.id
  const text = promptFor(message, thread)
  if (VIA_EXEC) {
    // Run the thread instead of queueing into it. Costs a turn, but "exit 0" here means a turn
    // really ran; with 'queue' it only means the text reached a sqlite file.
    const line = '"' + codexExe() + '" exec resume "' + thread + '" --skip-git-repo-check --json -o <out> -'
    if (!SEND) return { ok: true, thread, command: line, queued: false }
    const took = await claim(message.seq, thread)
    if (!took.ok) {
      if (took.already) return { ok: true, skipped: 'already delivered elsewhere', thread }
      return { ok: false, reason: took.reason }
    }
    if (!ASYNC) {
      const argv = ['exec', 'resume', thread, '--skip-git-repo-check', '--json', '-']
      const cwd = (typeof message?.meta?.cwd === 'string' && message.meta.cwd) || EXEC_CWD
      return { ...await runExec(message.seq, thread, argv, text, cwd, took.attempt), command: line }
    }
    return startResumeAsync(message, thread, text, took.attempt)
  }
  const argv = ['queue', '--thread', thread, '--message', text]
  if (RESUME) argv.push('--resume')
  const line = '"' + codexExe() + '" ' + argv.map(a => '"' + a.replace(/"/g, '\\"') + '"').join(' ')
  if (!SEND) return { ok: true, thread, command: line, queued: false }
  const took = await claim(message.seq, thread)
  if (!took.ok) {
    if (took.already) return { ok: true, skipped: 'already delivered elsewhere', thread }
    return { ok: false, reason: took.reason }
  }
  const call = codexCommand(argv)
  const before = rolloutMark(thread)
  const fromSize = Number((before || '0').split(':')[0]) || 0
  const run = spawnSync(call.cmd, call.argv, { encoding: 'utf8', windowsHide: true, timeout: 120000 })
  let ok = run.status === 0
  let stderr = (run.stderr || '').slice(0, 400)
  if (ok) {
    // Exit 0 is not delivery. Even a growing rollout is not delivery — only the message's own
    // bridge marker showing up in the newly appended bytes is.
    const marker = 'bridge seq ' + message.seq + ' from ' + message.from
    const seen = await waitForRollout(thread, fromSize, marker, QUEUE_VERIFY_MS)
    if (!seen) {
      ok = false
      stderr = 'queue exited 0 but thread ' + thread + ' never received seq ' + message.seq +
        ' (' + (before ? 'rollout was ' + before : 'no rollout file') +
        '); it is sitting in queue_1.sqlite — use --via exec'
    }
  }
  // Confirming is what lets the bus ack this message, so it may only happen once the message
  // really reached the thread — not when the queue command merely said yes.
  if (ok) await confirm(message.seq, thread)
  else await release(message.seq)
  return { ok, thread, queued: ok, command: line, status: run.status, stderr, ...(ok ? {} : { reason: stderr || 'delivery failed' }) }
}

async function pass() {
  // Fresh conversations running in the background: never ack past the oldest one, or a
  // worker that later fails would find its message already confirmed.
  // Conversations queued during this very pass count too: their todo file only appears after
  // the spawn, so a snapshot taken at the top would let the ack race past them.
  const busy = await pruneTodos()
  const inbox = await api('GET', '/inbox?peer=' + encodeURIComponent(PEER) +
    (PROJECT ? '&project=' + encodeURIComponent(PROJECT) : ''))
  const messages = Array.isArray(inbox.messages) ? inbox.messages : []
  if (messages.length === 0) return 0
  const range = 'seq ' + messages[0].seq + '\u2013' + messages[messages.length - 1].seq
  console.log('[codex-push] ' + messages.length + ' pending (' + range + ')')
  // Guard against a stale cursor replaying the whole history into a real thread.
  if (SEND && messages.length > 3 && !flag('yes')) {
    console.log('[codex-push] refusing to push ' + messages.length + ' messages at once;')
    console.log('[codex-push] a stale cursor looks exactly like this. Ack the backlog first (POST /ack), or pass --yes.')
    return 0
  }
  let newestAcked = 0
  for (const message of messages) {
    const delivery = message.delivery
    // Somebody else already took this one (another thread's push got there first).
    // Re-queueing would duplicate the task, so treat it as handled.
    if (delivery && delivery.state === 'delivered') {
      console.log('skip seq ' + message.seq + ' (already delivered to ' + (delivery.target || message.deliveredBy) + ')')
      newestAcked = Math.max(newestAcked, message.seq)
      continue
    }
    // A live claim belongs to someone who may be mid-turn. Delivering again would run the task
    // twice; acking would drop it if that someone never finishes. Stop here and let the lease
    // expire (or the bus release it at startup) instead of guessing.
    if (delivery && delivery.state === 'claimed') {
      console.log('held at seq ' + message.seq + ' (claimed by ' + (delivery.peer || '?') + ' -> ' +
        (delivery.target || '?') + ', lease ' + (delivery.expiresIn || 0) + 's)')
      break
    }
    const result = await deliver(message)
    if (result.skipped) {
      console.log('skip seq ' + message.seq + ' (' + result.skipped + ')')
      newestAcked = Math.max(newestAcked, message.seq)
      continue
    }
    const label = 'seq ' + message.seq + ' -> ' + (result.thread || '(no thread)')
    // Stop at the first failure: a later success would raise the ack watermark past it and
    // silently drop the failed message.
    if (!result.ok) { console.log('stop at ' + label + ': ' + result.reason); break }
    console.log((SEND ? 'queued ' : 'dry-run ') + label)
    if (!SEND) { console.log('  ' + result.command); newestAcked = Math.max(newestAcked, message.seq); continue }
    if (result.queued) {
      if (result.command) console.log('  ' + result.command)
      // Only a detached worker outlives this pass. A synchronous 'queue' is already in Codex
      // by the time spawnSync returns, so parking it in 'busy' held the ack forever and the
      // task was delivered again on every pass.
      if (result.async) busy.push(message.seq)
      newestAcked = Math.max(newestAcked, message.seq)
      continue
    }
    console.log('  codex exited ' + result.status + ': ' + (result.stderr || '').trim())
  }
  // Only ack what was actually handed to Codex, so a failed push retries itself.
  // all:true because the pusher is the router: it saw (and skipped or delivered) every
  // message up to this seq. A failure above breaks the loop, so nothing is confirmed past it.
  const ceiling = busy.length > 0 ? Math.min(...busy) - 1 : Infinity
  if (newestAcked > ceiling) {
    newestAcked = ceiling
    console.log('[codex-push] holding the ack at ' + newestAcked + ': seq ' + Math.min(...busy) + ' is still running in a worker')
  }
  if (SEND && newestAcked > 0) {
    // When this pusher only looks at one project, the ack must say so: a peer-wide ack would
    // confirm another project's undelivered mail along the way (see bus.mjs /ack).
    const acked = await api('POST', '/ack', { peer: PEER, upTo: newestAcked, all: true, ...(PROJECT ? { project: PROJECT } : {}) })
    if (acked && acked.ok === false) {
      // The bus refuses to ack over a live claim. Nothing is lost: the next pass re-reads them.
      console.log('[codex-push] ack refused up to ' + newestAcked + ': ' + (acked.error || 'unknown') +
        (Array.isArray(acked.seqs) ? ' (seq ' + acked.seqs.join(', ') + ')' : ''))
    }
  }
  return messages.length
}

if (WORKER) {
  // Detached worker for one fresh conversation; the parent's poll loop keeps running.
  await workerMain()
  process.exit(0)
}

if (WORKER_RESUME) {
  // Detached worker for one existing thread (--via exec).
  await resumeWorkerMain()
  process.exit(0)
}

if (VIA !== 'queue' && VIA !== 'exec') {
  console.error('[codex-push] unknown --via ' + VIA + ' (use queue or exec)')
  process.exit(2)
}

console.log('[codex-push] bus ' + BASE + ' peer ' + PEER +
  ' project ' + (PROJECT || '(all)') +
  ' via ' + VIA +
  (SEND ? '' : ' (dry run; add --send to deliver)'))
if (!PROJECT && !ALL_PROJECTS) {
  console.log('[codex-push] no project id for ' + process.cwd() + '; use --project <id> or --all-projects')
}
do {
  try {
    const seen = await pass()
    if (seen === 0 && ONCE) console.log('[codex-push] nothing pending')
  } catch (error) {
    console.log('[codex-push] bus unreachable: ' + String(error.message || error))
  }
  if (ONCE) break
  await new Promise(r => setTimeout(r, EVERY))
} while (true)
