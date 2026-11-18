#!/usr/bin/env node
// DSH <-> Codex bridge bus. Zero dependencies. Single owner of on-disk state.
// State dir: %BRIDGE_DIR% (default ~/.dsh-codex-bridge)
//   messages.jsonl : append-only log, one JSON message per line
//   cursors.json   : { "<peer>": <last acked seq> }
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { activity as codexActivity } from './lib/threads.mjs'
import { projectIdOf, projectIdOfDeclared, projectKeyOf, projectCwdOf } from './lib/project.mjs'

const PORT = Number(process.env.BRIDGE_PORT || 8787)
const HOST = '127.0.0.1'
const DIR = process.env.BRIDGE_DIR || path.join(os.homedir(), '.dsh-codex-bridge')
const LOG = path.join(DIR, 'messages.jsonl')
const CUR = path.join(DIR, 'cursors.json')
const REG = path.join(DIR, 'registry.json')
// Delivery records: which endpoint actually took a message, so a second consumer
// (another Codex thread, another DSH session) can tell it was already handled.
// Shape: { "<seq>": { target, ts, peer, state: 'claimed'|'delivered', leaseUntil, attempts, instance } }
// "claimed" means somebody is about to hand it over and holds a lease; it is NOT
// delivery. Only /confirm (or an old record without a state) means delivered. The
// difference is the whole point: a pusher that claims and then dies must not make
// the message look handled, or the next pass skips it and nobody ever sees it.
const DEL = path.join(DIR, 'deliveries.json')
// Attempts must not restart at 1 after release or an expired lease.
const ATT = path.join(DIR, 'delivery-attempts.json')
// Idempotency index for /send: clientMsgId -> { seq, hash, at }. A retried send
// returns the original message instead of appending a duplicate.
const SENT = path.join(DIR, 'sent.json')
fs.mkdirSync(DIR, { recursive: true })

let seq = 0
const messages = []
if (fs.existsSync(LOG)) {
  for (const line of fs.readFileSync(LOG, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try { const m = JSON.parse(line); messages.push(m); if (m.seq > seq) seq = m.seq } catch {}
  }
}
// The log can be rotated away, so the highest seq ever issued lives in cursors.json
// under "_seq". Without it a restart after rotation would hand out seq 1 again while
// every cursor still says 100 — i.e. every new message invisible to everybody.
{
  const stored = Number(readCursors()._seq) || 0
  if (stored > seq) seq = stored
}

// Idempotency index for /send, rebuilt from the log on every start: the message and its
// clientMsgId land in the same append, so a crash between the append and the sent.json
// write cannot turn a retried send into a second task. sent.json is only a cache.
const sendIndex = new Map()
function indexMessage(m) {
  const id = typeof m.clientMsgId === 'string' ? m.clientMsgId : ''
  if (!id) return
  const prev = sendIndex.get(id)
  if (prev) return
  sendIndex.set(id, { seq: Number(m.seq) || 0, hash: typeof m.hash === 'string' ? m.hash : '', inLog: true })
}
for (const m of messages) indexMessage(m)
{
  const sent = readJson(SENT, {})
  for (const [id, rec] of Object.entries(sent)) {
    if (sendIndex.has(id) || !rec || typeof rec !== 'object') continue
    sendIndex.set(id, { seq: Number(rec.seq) || 0, hash: String(rec.hash || ''), inLog: false })
  }
}

// Keep the log bounded: on startup, archive the whole file and rewind it to only
// what somebody has not read yet. Startup-only, so no concurrent appends race it.
function rotateIfHuge() {
  let size = 0
  try { size = fs.statSync(LOG).size } catch { return }
  if (size < 8 * 1024 * 1024) return
  const floor = recipientFloor(messages)
  if (floor <= 0) {
    console.log('[bus] log is large but somebody has never acked; skipping rotation')
    return
  }
  const keep = messages.filter(m => m.seq > floor)
  const archive = path.join(DIR, 'messages.archive-' + Date.now() + '.jsonl')
  try { fs.renameSync(LOG, archive) } catch { /* keep going: worst case we append */ }
  fs.writeFileSync(LOG, keep.map(m => JSON.stringify(m)).join('\n') + (keep.length ? '\n' : ''))
  console.log('[bus] rotated ' + size + ' bytes, kept ' + keep.length + ' unread message(s) -> ' + archive)
}

/**
 * Parse a JSON state file, tolerating the UTF-8 BOM that Windows editors (and PowerShell's
 * `Set-Content -Encoding utf8`) like to add. Without this a hand-edited cursors.json parses as
 * {} and every watermark silently resets to 0 — the whole mailbox becomes unread again.
 */
function readJson(file, fallback) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return fallback }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
  try { return JSON.parse(raw) } catch (err) {
    console.log('[bus] ' + path.basename(file) + ' is not valid JSON (' + err.message + '); using fallback')
    try { fs.copyFileSync(file, file + '.corrupt-' + Date.now()) } catch { /* best effort */ }
    return fallback
  }
}

function readCursors() {
  return readJson(CUR, {})
}
function writeCursors(c) {
  const tmp = CUR + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2))
  fs.renameSync(tmp, CUR)
}
/** How far a peer (optionally within one lane) has read. Lanes never move backwards past the peer watermark. */
function cursorFor(peer, target = '') {
  const c = readCursors()
  const base = Number(c[peer]) || 0
  if (!target) return base
  return Math.max(base, Number(c[peer + '|' + target]) || 0)
}
/**
 * Key for one lane's watermark *inside one project*.
 * A lane id is not unique across projects: the same thread id can be used from two folders,
 * and a plain "peer|lane" watermark then hides the other project's mail (Codex review, seq 17,
 * P1: seq1=B/L1, seq2=A/L1, ack project=A target=L1 upTo=2 made B's message disappear).
 * Project-less lanes keep the legacy "<peer>|<target>" key.
 * @param {string} peer
 * @param {string} target
 * @param {string} project
 * @returns {string}
 */
function laneKey(peer, target, project = '') {
  return peer + '|lane:' + target + (project ? '|project:' + project : '')
}
/**
 * Lane watermark as seen from one project (peer watermark included: it is a floor).
 * Three keys can hold a claim about the same lane, and all three are honoured:
 *   "<peer>|<target>"                 pre-project lane ack (2026-11-17 and earlier)
 *   "<peer>|lane:<target>"            a lane ack that did not name a project: means the whole lane
 *   "<peer>|lane:<target>|project:<p>" an ack scoped to one project (keeps other projects' mail visible)
 */
function laneCursorIn(cursors, peer, target, project = '') {
  return Math.max(
    Number(cursors[peer]) || 0,
    Number(cursors[peer + '|' + target]) || 0,
    Number(cursors[laneKey(peer, target, '')]) || 0,
    Number(cursors[laneKey(peer, target, project)]) || 0,
  )
}
function laneCursorFor(peer, target, project = '') {
  return laneCursorIn(readCursors(), peer, target, project)
}
/**
 * Pre-project lane watermarks ("peer|target") cannot say which project they belong to.
 * Move each one to the only project that ever used that lane; when the lane really spans
 * several projects, keep the old key (it is still a claim by *someone*) and say so in the log.
 */
function migrateLaneCursors() {
  const c = readCursors()
  let moved = 0
  for (const key of Object.keys(c)) {
    if (key === '_seq' || key.includes('|lane:') || key.includes('|project:')) continue
    const bar = key.indexOf('|')
    if (bar <= 0) continue
    const peer = key.slice(0, bar)
    const target = key.slice(bar + 1)
    const projects = new Set(messages
      .filter(m => targetOf(m) === target && (m.to === peer || m.to === '*'))
      .map(m => projectKeyOf(m))
      .filter(Boolean))
    if (projects.size !== 1) {
      if (projects.size > 1) {
        // Honouring this key would hide one project's mail behind the other's ack, and the old
        // format simply cannot say which project read it. Park it where nothing reads from, so
        // the worst case is a re-delivered message instead of a silently swallowed one
        // (Codex review, seq 19, migration risk).
        const parked = peer + '|legacy:' + target
        c[parked] = Math.max(Number(c[parked]) || 0, Number(c[key]) || 0)
        delete c[key]
        moved += 1
        console.log('[bus] lane ' + target + ' spans ' + projects.size + ' projects; parked its old watermark as ' + parked + ' (a project-less lane ack cannot say which project it read)')
      }
      continue
    }
    const project = [...projects][0]
    const next = laneKey(peer, target, project)
    c[next] = Math.max(Number(c[next]) || 0, Number(c[key]) || 0)
    delete c[key]
    moved += 1
  }
  if (moved > 0) {
    writeCursors(c)
    console.log('[bus] moved ' + moved + ' lane watermark(s) into their project')
  }
}
/**
 * Lowest acked seq over *every* recipient, used as the rotation watermark.
 * Recipients that never acked count as 0, so their unread mail is never archived;
 * a peer with several lanes is held back by its slowest lane. Keys in cursors.json:
 * "<peer>" (whole peer), "<peer>|<target>" (one lane) and "_seq" (bookkeeping).
 */
function recipientFloor(list) {
  const c = readCursors()
  const peers = new Set()
  for (const key of Object.keys(c)) {
    if (key === '_seq') continue
    peers.add(key.split('|')[0])
  }
  for (const m of list) if (m.to && m.to !== '*') peers.add(m.to)
  if (peers.size === 0) return 0
  let floor = Infinity
  for (const peer of peers) {
    let watermark = Number(c[peer]) || 0
    for (const key of Object.keys(c)) {
      if (key.startsWith(peer + '|')) watermark = Math.min(watermark, Number(c[key]) || 0)
    }
    floor = Math.min(floor, watermark)
  }
  return Number.isFinite(floor) ? floor : 0
}
// Registry: which addressable endpoints each peer currently offers, so one side
// can name a conversation on the other side instead of talking to "whatever".
// Shape: { "<peer>": { "<kind>": { updatedAt, items: [...] } } }
function readRegistry() {
  const parsed = readJson(REG, {})
  return parsed && typeof parsed === 'object' ? parsed : {}
}
function writeRegistry(reg) {
  const tmp = REG + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2))
  fs.renameSync(tmp, REG)
}
function registryView(peer, kind) {
  const reg = readRegistry()
  if (!peer) return reg
  const byKind = reg[peer] || {}
  if (!kind) return byKind
  return byKind[kind] || { updatedAt: null, items: [] }
}

function readDeliveries() {
  return readJson(DEL, {})
}
function writeDeliveries(d) {
  const tmp = DEL + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2))
  fs.renameSync(tmp, DEL)
}
/** How long a claim protects a message from another consumer, in ms. */
const CLAIM_TTL_MS = 120000
/** Cap on the idempotency index, so sent.json cannot grow without bound. */
const SENT_MAX = 2000

/**
 * Normalize a delivery record, including the pre-state records written before the
 * claim protocol existed (no `state`: they were treated as delivered, so they stay
 * delivered — silently demoting them would redeliver history).
 * @param rec - Raw record from deliveries.json.
 * @returns A normalized record, or null.
 */
function normDelivery(rec) {
  if (!rec || typeof rec !== 'object') return null
  const ts = typeof rec.ts === 'string' ? rec.ts : ''
  return {
    target: typeof rec.target === 'string' ? rec.target : '',
    peer: typeof rec.peer === 'string' ? rec.peer : '',
    state: rec.state === 'claimed' ? 'claimed' : 'delivered',
    at: Number(rec.at) || Date.parse(ts) || 0,
    leaseUntil: Number(rec.leaseUntil) || 0,
    attempts: Number(rec.attempts) || 0,
    instance: typeof rec.instance === 'string' ? rec.instance : '',
    turn: rec.turn && ['running', 'completed', 'failed'].includes(rec.turn.state) ? rec.turn : null,
  }
}

/** Is this record a claim that its holder still owns? */
function claimInFlight(rec, peer = '', now = Date.now()) {
  const d = normDelivery(rec)
  if (!d || d.state !== 'claimed') return false
  if (d.leaseUntil <= now) return false
  return peer === '' || d.peer === peer
}

function deliveryOf(seqNo) {
  const rec = normDelivery(readDeliveries()[String(seqNo)])
  return rec ? rec.target : ''
}

/** Delivery detail for a message, as the inbox/panel can show it. */
function deliveryView(seqNo) {
  const d = normDelivery(readDeliveries()[String(seqNo)])
  if (!d) return null
  const now = Date.now()
  return {
    target: d.target, peer: d.peer, state: d.state, attempts: d.attempts,
    instance: d.instance, turn: d.turn,
    expiresIn: d.state === 'claimed' ? Math.max(0, Math.round((d.leaseUntil - now) / 1000)) : 0,
  }
}
/** Which endpoint a message is *for*: its explicit thread/session id, or "" for the default lane. */
function targetOf(message) {
  const meta = message && typeof message.meta === 'object' && message.meta ? message.meta : {}
  const thread = typeof meta.thread === 'string' ? meta.thread.trim() : ''
  const session = typeof meta.sessionId === 'string' ? meta.sessionId.trim() : ''
  return thread || session || ''
}

/**
 * Project id of a DSH session, from the cwd the wake plugin published. Empty when the
 * session is unknown — callers then fall back to the other hints.
 * @param {any} sessionId
 * @returns {string}
 */
function projectOfSession(sessionId) {
  const id = String(sessionId || '').trim()
  if (!id) return ''
  const items = registryView('dsh', 'session').items || []
  const hit = items.find(it => it && String(it.id) === id)
  return hit ? projectIdOf(hit.cwd) : ''
}

/**
 * Which project a send belongs to.
 *
 * Order matters: a cwd is turned into an id HERE, so a client cannot invent an id that
 * points at another project. A reply inherits the project of the message it answers even
 * when its sender only knows the seq number.
 * @param {any} b
 * @returns {string}
 */
function projectOfSend(b) {
  const meta = b && typeof b.meta === 'object' && b.meta ? b.meta : null
  // A reply belongs to the project it answers, even when the process writing it happens to
  // run in another folder: the work was handed to that project, and routing the result
  // back into the replier's folder would strand it there. Only a reply whose original has
  // no project (public mail) falls through to the other hints.
  if (b && b.replyTo) {
    const original = messages.find(m => m.seq === Number(b.replyTo))
    // Found the original? Its project wins even when it is empty: a reply to public mail is
    // public mail. Only a dangling replyTo falls through to the sender's own hints.
    if (original) return projectKeyOf(original)
  }
  const fromCwd = meta ? projectIdOf(meta.cwd) : ''
  if (fromCwd) return fromCwd
  const declared = meta ? projectIdOfDeclared(meta.projectId) : ''
  if (declared) return declared
  // A message aimed at a DSH lane belongs where that session lives: the registry already
  // published the session's cwd, so the agent does not have to remember to pass a project.
  return projectOfSession(meta ? meta.sessionId : '')
}

/**
 * Drop claims whose lease ran out while nobody was watching (the holder crashed, or the
 * bus was down longer than the lease). Run at startup and before every claim, so the
 * first /inbox after a crash shows the message again instead of a phantom claim.
 * @returns How many claims were dropped.
 */
function releaseDeadClaims() {
  const deliveries = readDeliveries()
  const now = Date.now()
  let dropped = 0
  for (const [key, rec] of Object.entries(deliveries)) {
    const d = normDelivery(rec)
    if (d && d.state === 'claimed' && d.leaseUntil <= now) {
      delete deliveries[key]
      dropped += 1
      console.log('[bus] released dead claim on seq ' + key + ' (peer ' + (d.peer || '?') + ', lease expired)')
    }
  }
  if (dropped > 0) writeDeliveries(deliveries)
  return dropped
}

/** Stable fingerprint of a send, for clientMsgId idempotency. */
function hashOf(b) {
  return crypto.createHash('sha1')
    .update(JSON.stringify([b.from, b.to, b.kind || 'note', b.body, b.replyTo ?? null, b.meta ?? null]))
    .digest('hex')
}

/** Persist the idempotency index, keeping only the newest SENT_MAX entries. */
function writeSent(sent) {
  const keys = Object.keys(sent)
  if (keys.length > SENT_MAX) {
    keys.sort((a, b) => String(sent[a].at).localeCompare(String(sent[b].at)))
    for (const key of keys.slice(0, keys.length - SENT_MAX)) delete sent[key]
  }
  const tmp = SENT + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(sent))
  fs.renameSync(tmp, SENT)
}

rotateIfHuge()
releaseDeadClaims()
migrateLaneCursors()

const waiters = new Map()
// Panels ping when they mount. It is the only honest proof that the browser half of
// the plugin really loaded inside the app: the desktop window runs over file:// + IPC,
// so there is no page to open and no DOM to inspect from the outside.
const panels = new Map()
// A ping is unauthenticated by design (the panel lives on file://), so the map needs a
// ceiling and a TTL: otherwise any page that can reach the loopback port can grow it
// without bound and make every /status response bigger.
const PANELS_MAX = 16
const PANELS_TTL = 10 * 60 * 1000
function prunePanels(now = Date.now()) {
  for (const [key, value] of panels) if (now - Number(value.at || 0) > PANELS_TTL) panels.delete(key)
}

function pending(peer, { limit = 100, target = '', after = 0, project = '' } = {}) {
  const floor = Number(after) || 0
  // A project is a reader in its own right. Its pusher acks \`<peer>|project:<id>\`, so
  //   - the peer view must not keep offering what that project already confirmed, and
  //   - one project's cursor must never clear another project's mail (that is the whole
  //     point of the split, and the reason the term is per message, not per request).
  // Public messages (no cwd) belong to no project, so a project reader advances over them
  // through its own cursor, while other projects keep seeing them until the base moves.
  const peerFloor = cursorFor(peer, target)
  const asked = project ? cursorFor(peer, 'project:' + project) : 0
  // A lane-less (public / default) message is handed to a lane like any other, so the reader's
  // own lane ack has to confirm it for that reader. Without this, "ack project=A target=L upTo=2"
  // returned success and the same public message came back on the next identical read
  // (Codex review, seq 19, P2). Other lanes still see it: the term is scoped to the reader.
  const readerLane = target ? laneCursorFor(peer, target, project) : 0
  return messages
    // A message counts as read once either the peer or its own lane has confirmed it, so a
    // session that acked its lane does not see the same messages again through the peer view.
    .filter(m => {
      const proj = projectKeyOf(m)
      const projectFloor = proj ? cursorFor(peer, 'project:' + proj) : asked
      const lane = targetOf(m)
      // The lane watermark is scoped by the message's own project, never by the reader's:
      // project A acking lane L must not hide project B's mail that shares that lane id.
      // A project-less message is confirmed for this reader by whatever lane it is reading,
      // including a lane ack recorded together with a project id.
      // Public mail, and mail on the default lane, is confirmed by whatever lane this reader
      // actually read it through — its own project id is not part of the question
      // (Codex review, seq 21, P2: the proj === '' guard left project-owned default-lane mail
      // coming back forever).
      const readerConfirmed = (proj === '' || !lane) && target ? readerLane : 0
      return m.seq > Math.max(floor, peerFloor, laneCursorFor(peer, lane, proj), readerConfirmed, projectFloor)
    })
    .filter(m => (m.to === peer || m.to === '*') && m.from !== peer)
    // A consumer that knows who it is (a Codex thread, a DSH session) only sees the
    // default lane plus its own; a bare peer sees everything.
    .filter(m => !target || targetOf(m) === '' || targetOf(m) === target)
    // Project filter is a union on purpose: messages with no project stay visible
    // everywhere, so an old log (or a cross-project note) never looks lost.
    .filter(m => !project || projectKeyOf(m) === project || projectKeyOf(m) === '')
    .slice(0, limit)
    .map(m => ({ ...m, target: targetOf(m), deliveredBy: deliveryOf(m.seq), delivery: deliveryView(m.seq) }))
}
function wake(peer) {
  const list = waiters.get(peer) || []
  waiters.set(peer, [])
  for (const resolve of list) resolve()
}
function append(msg) {
  seq += 1
  const rec = { seq, ts: new Date().toISOString(), ...msg }
  messages.push(rec)
  fs.appendFileSync(LOG, JSON.stringify(rec) + '\n')
  // Persisted high-water mark; survives log rotation and restarts.
  try {
    const c = readCursors()
    if ((Number(c._seq) || 0) < seq) { c._seq = seq; writeCursors(c) }
  } catch {}
  wake(rec.to)
  return rec
}

// The panel runs inside the app (file:// => Origin: null) and the dev harness runs on
// 127.0.0.1, so those two are the only browser origins that get an answer. A random web
// page that guesses the port can still send a request, but it gets no CORS grant and no
// write: loopback binding is not an origin boundary, the Origin header is.
function originAllowed(origin) {
  if (!origin) return true // not a browser (node clients, curl) or same-origin
  // "null" is deliberately *not* allowed: a web page can mint it with a sandboxed iframe,
  // which would hand any site a way to POST tasks onto the bus. The app window sends
  // dsh-app://app and the dev harness is http on loopback, so nothing legitimate needs it.
  if (origin === 'null') return false
  try {
    const u = new URL(origin)
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1'
    }
    // Everything else is a custom scheme the desktop shell registered for itself
    // (dsh-app://app is the one DSH's Electron window actually sends) or file://.
    // A web page cannot claim such an origin, so this does not widen the hole.
    return true
  } catch { return false }
}
function json(res, code, body) {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  })
  res.end(buf)
}
function body(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', c => { data += c; if (data.length > 4_000_000) reject(new Error('payload too large')) })
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}

const reqLog = []
function recordReq(req, url) {
  reqLog.push({
    at: new Date().toISOString(),
    method: req.method,
    path: url.pathname,
    origin: String(req.headers.origin || '(none)'),
    ua: String(req.headers['user-agent'] || '').slice(0, 60),
  })
  if (reqLog.length > 40) reqLog.shift()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST)
  const origin = String(req.headers.origin || '')
  recordReq(req, url)
  if (url.pathname === '/debug/log') return json(res, 200, { ok: true, requests: reqLog })
  const corsOk = originAllowed(origin)
  if (corsOk) {
    res.setHeader('access-control-allow-origin', origin || '*')
    res.setHeader('vary', 'origin')
  }
  if (req.method === 'OPTIONS') {
    if (!corsOk) return json(res, 403, { ok: false, error: 'origin not allowed' })
    res.writeHead(204, {
      'access-control-allow-origin': origin || '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-private-network': 'true',
      'vary': 'origin',
    })
    return res.end()
  }
  // Writes are the part that matters: an untrusted page must not be able to forge a task
  // or move a cursor just because the port is reachable.
  if (req.method !== 'GET' && req.method !== 'HEAD' && !corsOk) {
    return json(res, 403, { ok: false, error: 'origin not allowed' })
  }
  try {
    if (url.pathname === '/health') {
      const reg = readRegistry()
      const registered = Object.fromEntries(Object.entries(reg).map(([p, kinds]) =>
        [p, Object.fromEntries(Object.entries(kinds).map(([k, v]) => [k, Array.isArray(v.items) ? v.items.length : 0]))]))
      return json(res, 200, { ok: true, port: PORT, dir: DIR, seq, registered, peers: [...new Set(messages.flatMap(m => [m.from, m.to]))].filter(p => p !== '*') })
    }
    if (url.pathname === '/message' && req.method === 'GET') {
      if (!corsOk) return json(res, 403, { ok: false, error: 'origin not allowed' })
      const m = messages.find(m => m.seq === Number(url.searchParams.get('seq')))
      if (!m) return json(res, 404, { ok: false, error: 'no such message' })
      return json(res, 200, { ok: true, message: {
        seq: m.seq, ts: m.ts, from: m.from, to: m.to, kind: m.kind,
        body: m.body, meta: m.meta ?? null, replyTo: m.replyTo ?? null, delivery: deliveryView(m.seq),
      } })
    }
    if (url.pathname === '/status') {
      // A dashboard refresh is also a good moment to clear leases whose holder died: otherwise
      // the panel and the pusher keep seeing a claim that no longer protects anything.
      releaseDeadClaims()
      // One aggregate for dashboards: who is where, what is waiting, and what Codex is
      // actually doing right now (read off its own rollout files, so it is not a guess).
      const cursors = readCursors()
      const peers = new Set([...Object.keys(cursors).filter(k => k !== '_seq').map(k => k.split('|')[0])])
      for (const m of messages) { if (m.to && m.to !== '*') peers.add(m.to); if (m.from) peers.add(m.from) }
      const codexNow = (() => {
        try { return codexActivity({ minutes: 240, limit: 8 }) } catch (err) {
          console.log('[bus] could not read codex activity: ' + err.message)
          return []
        }
      })()
      const recent = messages.slice(-8).reverse().map(m => ({
        seq: m.seq, ts: m.ts, from: m.from, to: m.to, kind: m.kind,
        target: targetOf(m), project: projectKeyOf(m),
        deliveredBy: deliveryOf(m.seq), delivery: deliveryView(m.seq),
        body: String(m.body || '').slice(0, 240),
      }))
      // Unread per addressed lane: the sidebar badge needs "how many are waiting for
      // THIS session", which the per-peer number cannot answer once sessions are addressed.
      const unreadLanes = (() => {
        const out = {}
        try {
          for (const m of pending('dsh', { limit: 500 })) {
            const lane = targetOf(m)
            if (!lane) continue
            out[lane] = (out[lane] || 0) + 1
          }
        } catch (err) {
          console.log('[bus] could not count unread lanes: ' + err.message)
        }
        return out
      })()
      // Which projects share this bus, and how much of each is waiting. Grouping only:
      // routing goes through the same ids with /inbox?project=. A session, a thread and
      // a message all claim membership through their cwd, so no client can register
      // itself into somebody else's project.
      const projects = (() => {
        const entries = new Map()
        const touch = (id, cwd) => {
          if (!id) return null
          let entry = entries.get(id)
          if (!entry) { entry = { id, cwd: '', sessions: 0, threads: 0, unread: 0, codexUnread: 0 }; entries.set(id, entry) }
          if (!entry.cwd && cwd) entry.cwd = cwd
          return entry
        }
        try {
          const registry = readRegistry()
          for (const item of (registry?.dsh?.session?.items || [])) {
            const entry = touch(item.projectId || projectIdOf(item.cwd), item.cwd)
            if (entry) entry.sessions += 1
          }
          const seen = new Set()
          for (const item of (registry?.codex?.thread?.items || [])) {
            const entry = touch(item.projectId || projectIdOf(item.cwd), item.cwd)
            if (entry && !seen.has(item.id)) { seen.add(item.id); entry.threads += 1 }
          }
          for (const thread of codexNow) {
            const entry = touch(projectIdOf(thread.cwd), thread.cwd)
            if (entry && !seen.has(thread.id)) { seen.add(thread.id); entry.threads += 1 }
          }
        } catch (err) {
          console.log('[bus] could not group registry by project: ' + err.message)
        }
        // Count the whole unread set, not the first page: a project past the 500th waiting
        // message used to show 0. unreadByPeer keeps the per-recipient split visible, since
        // "unread" alone made people read a Codex backlog as their own.
        const all = pending('dsh', { limit: Number.MAX_SAFE_INTEGER })
        for (const m of all) {
          const entry = touch(projectKeyOf(m), projectCwdOf(m))
          if (entry) entry.unread += 1
        }
        try {
          const codexWaiting = pending('codex', { limit: Number.MAX_SAFE_INTEGER })
          for (const m of codexWaiting) {
            const entry = touch(projectKeyOf(m), projectCwdOf(m))
            if (entry) entry.codexUnread = (entry.codexUnread || 0) + 1
          }
        } catch (err) {
          console.log('[bus] could not count unread for codex: ' + err.message)
        }
        // Show projects that only exist as history too (nothing unread, no live session):
        // otherwise a project disappears from the panel the moment it is caught up.
        for (const m of messages.slice(-200)) {
          touch(projectKeyOf(m), projectCwdOf(m))
        }
        return [...entries.values()].sort((a, b) => b.unread - a.unread || a.id.localeCompare(b.id))
      })()
      const now = Date.now()
      const claims = Object.entries(readDeliveries())
        .map(([key, rec]) => ({ seq: Number(key), ...normDelivery(rec) }))
        .filter(rec => rec.state === 'claimed' && rec.leaseUntil > now)
        .map(rec => ({ seq: rec.seq, peer: rec.peer, target: rec.target, expiresIn: Math.round((rec.leaseUntil - now) / 1000), attempts: rec.attempts }))
      return json(res, 200, {
        ok: true, generatedAt: new Date().toISOString(), seq, dir: DIR,
        peers: [...peers].map(peer => ({
          peer,
          cursor: Number(cursors[peer]) || 0,
          unread: pending(peer, { limit: 500 }).length,
        })),
        lanes: Object.fromEntries(Object.keys(cursors).filter(k => k.includes('|')).map(k => [k, cursors[k]])),
        unreadLanes,
        projects,
        registered: readRegistry(),
        codex: codexNow,
        recent,
        claims,
        panels: [...panels].map(([session, v]) => ({ session, at: new Date(Number(v.at) || 0).toISOString(), ua: v.ua })),
      })
    }
    if (url.pathname === '/panel/ping' && req.method === 'GET') {
      const session = String(url.searchParams.get('session') || '').slice(0, 200) || '(unknown)'
      prunePanels()
      if (!panels.has(session) && panels.size >= PANELS_MAX) {
        // Drop the oldest so an unknown caller cannot grow the map without bound.
        let oldest = null
        for (const [key, value] of panels) {
          if (oldest === null || Number(value.at) < Number(panels.get(oldest).at)) oldest = key
        }
        if (oldest !== null) panels.delete(oldest)
      }
      panels.set(session, { at: Date.now(), ua: String(req.headers['user-agent'] || '').slice(0, 140) })
      return json(res, 200, { ok: true })
    }
    if (url.pathname === '/send' && req.method === 'POST') {
      const b = await body(req)
      if (!b.from || !b.to || typeof b.body !== 'string' || !b.body.trim()) {
        return json(res, 400, { ok: false, error: 'from, to, body are required' })
      }
      // Idempotent send: a caller that retries after a timeout must not create a second
      // task. Same clientMsgId + same payload returns the original message; same id with
      // a different payload is a caller bug and is refused rather than guessed at.
      const clientMsgId = typeof b.clientMsgId === 'string' ? b.clientMsgId.trim().slice(0, 200) : ''
      const hash = hashOf(b)
      if (clientMsgId) {
        const prev = sendIndex.get(clientMsgId)
        if (prev && prev.hash && prev.hash !== hash) {
          return json(res, 409, { ok: false, error: 'clientMsgId reused with different content', seq: prev.seq })
        }
        if (prev && prev.hash === hash) {
          const original = messages.find(m => m.seq === Number(prev.seq))
          if (original) return json(res, 200, { ok: true, message: original, deduplicated: true })
          // The message was rotated out of the log but the send did happen. Report a receipt
          // instead of appending a second copy of a task somebody may already be running.
          return json(res, 200, { ok: true, deduplicated: true, archived: true, seq: prev.seq, hash })
        }
        const rec = append({
          from: String(b.from),
          to: String(b.to),
          kind: b.kind || 'note',
          body: b.body,
          replyTo: b.replyTo ?? null,
          meta: b.meta ?? null,
          projectId: projectOfSend(b),
          clientMsgId,
          hash,
        })
        sendIndex.set(clientMsgId, { seq: rec.seq, hash, inLog: true })
        // Best effort: the index above (and the log) already makes the retry idempotent, so a
        // failed cache write must not fail a send that already happened.
        try {
          const sent = readJson(SENT, {})
          sent[clientMsgId] = { seq: rec.seq, hash, at: new Date().toISOString() }
          writeSent(sent)
        } catch (err) {
          console.log('[bus] could not update sent.json (' + err.message + '); the log still carries the id')
        }
        return json(res, 200, { ok: true, message: rec })
      }
      const rec = append({
        from: String(b.from),
        to: String(b.to),
        kind: b.kind || 'note',
        body: b.body,
        replyTo: b.replyTo ?? null,
        meta: b.meta ?? null,
        projectId: projectOfSend(b),
      })
      return json(res, 200, { ok: true, message: rec })
    }
    if (url.pathname === '/inbox') {
      // Expired leases must not look like live ones here: the pusher trusts "claimed" and stops
      // at it, so a stale record would park that message forever.
      releaseDeadClaims()
      const peer = url.searchParams.get('peer')
      if (!peer) return json(res, 400, { ok: false, error: 'peer required' })
      const target = (url.searchParams.get('target') || '').trim()
      const projectParam = (url.searchParams.get('project') || '').trim()
      // Same canonicalisation as /send: "AAAAAAAA" must read the same cursor that "aaaaaaaa"
      // writes, or an ack and a read land in two different watermarks (Codex review seq 17, P2).
      const project = projectParam ? projectIdOfDeclared(projectParam) : ''
      if (projectParam && !project) {
        return json(res, 400, { ok: false, error: 'project must be an 8-hex id (or a cwd at /send)', got: projectParam })
      }
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit') || 100)))
      return json(res, 200, { ok: true, peer, target, project, cursor: cursorFor(peer, target), messages: pending(peer, { limit, target, project }) })
    }
    if (url.pathname === '/wait') {
      releaseDeadClaims()
      const peer = url.searchParams.get('peer')
      if (!peer) return json(res, 400, { ok: false, error: 'peer required' })
      const timeout = Math.min(Number(url.searchParams.get('timeout') || 60), 600) * 1000
      const target = (url.searchParams.get('target') || '').trim()
      // after: "do not wake me for anything at or below this seq". Lane-scoped acks leave the
      // peer watermark behind, so a watcher that only cares about new arrivals must say so,
      // otherwise the already-nudged batch makes every poll return instantly.
      const after = Number(url.searchParams.get('after') || 0)
      const projectParam = (url.searchParams.get('project') || '').trim()
      const project = projectParam ? projectIdOfDeclared(projectParam) : ''
      if (projectParam && !project) {
        return json(res, 400, { ok: false, error: 'project must be an 8-hex id', got: projectParam })
      }
      // Waiters are woken per peer, not per filter. A message for another project (or another
      // lane) used to end the wait early and return an empty batch, so a filtered watcher
      // burned a poll every time somebody else's mail arrived. Re-check inside one deadline.
      const deadline = Date.now() + timeout
      while (pending(peer, { target, after, project }).length === 0) {
        const left = deadline - Date.now()
        if (left <= 0) break
        await new Promise(resolve => {
          const arr = waiters.get(peer) || []
          const done = () => { clearTimeout(timer); resolve() }
          const timer = setTimeout(() => {
            waiters.set(peer, (waiters.get(peer) || []).filter(f => f !== done))
            resolve()
          }, left)
          arr.push(done)
          waiters.set(peer, arr)
        })
      }
      return json(res, 200, { ok: true, peer, target, after, project, cursor: cursorFor(peer, target), messages: pending(peer, { target, after, project }) })
    }
    if (url.pathname === '/deliver' && req.method === 'POST') {
      const b = await body(req)
      if (!b.peer || !Number(b.seq)) return json(res, 400, { ok: false, error: 'peer and seq are required' })
      const rec = messages.find(m => m.seq === Number(b.seq))
      if (!rec) return json(res, 404, { ok: false, error: 'no such seq' })
      releaseDeadClaims()
      const deliveries = readDeliveries()
      const prev = normDelivery(deliveries[String(rec.seq)])
      const wanted = String(b.target || '').trim() || '(unspecified)'
      const peer = String(b.peer)
      const now = Date.now()
      const ttl = Math.max(5000, Math.min(3600000, Number(b.ttl) || CLAIM_TTL_MS))
      const instance = String(b.instance || '').slice(0, 80)
      if (prev && prev.state === 'delivered') {
        return json(res, 200, { ok: true, seq: rec.seq, target: prev.target, state: 'delivered', already: true })
      }
      // First claim wins, and a claim is exclusive even for the same peer: two of its own
      // workers/threads executing one task is the same bug as two peers doing it. The one
      // legitimate retarget (a --new thread turning into a real thread id) goes through
      // /confirm, which can rewrite the target while still holding the claim.
      if (prev && prev.peer !== peer) {
        return json(res, 409, { ok: false, conflict: true, seq: rec.seq, held: prev.target, heldBy: prev.peer })
      }
      if (prev && prev.target !== wanted) {
        return json(res, 409, {
          ok: false, conflict: true, seq: rec.seq, held: prev.target, heldBy: prev.peer,
          hint: 'confirm with target= to retarget, or release first',
        })
      }
      // Two workers of the same peer racing the same lane: the second /deliver used to win
      // silently (it overwrote the instance), so both ran the task and the first one's confirm
      // was then refused. A held claim can only be renewed by the same instance.
      if (prev && prev.state === 'claimed' && prev.instance && prev.instance !== instance) {
        return json(res, 409, {
          ok: false, conflict: true, seq: rec.seq, held: prev.target, heldBy: prev.peer,
          error: instance
            ? 'claim held by another instance of ' + prev.peer
            : 'claim renewal requires instance=',
        })
      }
      const attemptHistory = readJson(ATT, {})
      const attempts = Math.max(prev ? prev.attempts : 0, Number(attemptHistory[rec.seq]) || 0) + 1
      attemptHistory[rec.seq] = attempts
      fs.writeFileSync(ATT + '.tmp', JSON.stringify(attemptHistory))
      fs.renameSync(ATT + '.tmp', ATT)
      deliveries[String(rec.seq)] = {
        target: wanted, peer, ts: new Date().toISOString(), at: now,
        state: 'claimed', leaseUntil: now + ttl,
        attempts,
        ...(instance ? { instance } : {}),
      }
      writeDeliveries(deliveries)
      return json(res, 200, {
        ok: true, seq: rec.seq, target: wanted, state: 'claimed',
        claimed: !prev, attempts, expiresIn: Math.round(ttl / 1000),
      })
    }
    if (url.pathname === '/confirm' && req.method === 'POST') {
      const b = await body(req)
      if (!b.peer || !Number(b.seq)) return json(res, 400, { ok: false, error: 'peer and seq are required' })
      const deliveries = readDeliveries()
      const key = String(Number(b.seq))
      const prev = normDelivery(deliveries[key])
      if (!prev) return json(res, 409, { ok: false, error: 'nothing claimed for seq ' + key + '; claim it first' })
      if (prev.peer !== String(b.peer)) {
        return json(res, 409, { ok: false, conflict: true, seq: Number(b.seq), held: prev.target, heldBy: prev.peer })
      }
      const instance = String(b.instance || '')
      // Once a claim carries an instance, that instance is the only one allowed to confirm it.
      // A missing instance is not "trusted": with two workers of one peer that is exactly how
      // a message gets confirmed by a process that never delivered it.
      if (prev.instance && prev.instance !== instance) {
        return json(res, 409, {
          ok: false, conflict: true, seq: Number(b.seq), heldBy: prev.peer,
          error: instance
            ? 'claim held by another instance of ' + prev.peer
            : 'claim requires instance= to confirm',
        })
      }
      const target = String(b.target || '').trim() || prev.target
      deliveries[key] = {
        target, peer: prev.peer, ts: new Date().toISOString(), at: Date.now(),
        state: 'delivered', leaseUntil: 0, attempts: prev.attempts,
        turn: prev.turn,
        ...(prev.instance ? { instance: prev.instance } : {}),
      }
      writeDeliveries(deliveries)
      return json(res, 200, { ok: true, seq: Number(b.seq), target, state: 'delivered' })
    }
    if (url.pathname === '/turn' && req.method === 'POST') {
      const b = await body(req)
      if (!b.peer || !Number.isInteger(b.seq) || b.seq <= 0 ||
          !['running', 'completed', 'failed'].includes(b.state) ||
          typeof b.instance !== 'string' || !b.instance ||
          !Number.isInteger(b.attempt) || b.attempt <= 0) {
        return json(res, 400, { ok: false, error: 'peer, seq, instance, positive attempt and valid turn state required' })
      }
      const deliveries = readDeliveries()
      const prev = normDelivery(deliveries[String(b.seq)])
      if (!prev || prev.state !== 'delivered' || prev.peer !== b.peer ||
          prev.instance !== b.instance || prev.attempts !== b.attempt) {
        return json(res, 409, { ok: false, error: 'turn requires a delivered record with matching peer, instance and attempt' })
      }
      if (prev.turn && prev.turn.state !== 'running') {
        if (prev.turn.state === b.state) return json(res, 200, { ok: true, delivery: deliveryView(b.seq) })
        return json(res, 409, { ok: false, error: 'terminal turn state cannot be overwritten' })
      }
      const at = typeof b.at === 'string' && Number.isFinite(Date.parse(b.at)) ? b.at : new Date().toISOString()
      const turn = { state: b.state, instance: b.instance, attempt: b.attempt, at }
      if (b.state !== 'running' && prev.turn && prev.turn.state === 'running') turn.startedAt = prev.turn.at
      if (Number.isInteger(b.exitCode)) turn.exitCode = b.exitCode
      if (b.usage && typeof b.usage === 'object' && !Array.isArray(b.usage)) {
        turn.usage = Object.fromEntries(Object.entries(b.usage).filter(([, v]) => Number.isFinite(v) && v >= 0))
      }
      if (typeof b.note === 'string') turn.note = b.note.slice(0, 1000)
      deliveries[String(b.seq)] = { ...deliveries[String(b.seq)], turn }
      writeDeliveries(deliveries)
      return json(res, 200, { ok: true, delivery: deliveryView(b.seq) })
    }
    if (url.pathname === '/delivery') {
      // One message's delivery state. The pusher uses it to drop .todo markers left behind by
      // a worker that confirmed and then died before cleaning up.
      const one = Number(url.searchParams.get('seq') || 0)
      if (!one) return json(res, 400, { ok: false, error: 'seq required' })
      return json(res, 200, { ok: true, seq: one, delivery: deliveryView(one) })
    }
    if (url.pathname === '/claims') {
      releaseDeadClaims()
      const now = Date.now()
      const claims = Object.entries(readDeliveries())
        .map(([key, rec]) => ({ seq: Number(key), ...normDelivery(rec) }))
        .filter(rec => rec.state === 'claimed')
        .map(rec => ({
          seq: rec.seq, peer: rec.peer, target: rec.target, instance: rec.instance,
          attempts: rec.attempts, expiresIn: Math.round((rec.leaseUntil - now) / 1000),
          inFlight: rec.leaseUntil > now,
        }))
      return json(res, 200, { ok: true, now: new Date(now).toISOString(), claims })
    }
    if (url.pathname === '/release' && req.method === 'POST') {
      const b = await body(req)
      if (!b.peer || !Number(b.seq)) return json(res, 400, { ok: false, error: 'peer and seq are required' })
      const deliveries = readDeliveries()
      const prevRec = normDelivery(deliveries[String(b.seq)])
      if (prevRec && prevRec.state === 'delivered') {
        return json(res, 409, { ok: false, error: 'seq ' + Number(b.seq) + ' is already delivered; release would allow a duplicate' })
      }
      const prev = prevRec
      const relInstance = String(b.instance || '')
      if (prev && prev.peer === String(b.peer) && prev.instance && prev.instance !== relInstance) {
        return json(res, 409, {
          ok: false, conflict: true, seq: Number(b.seq), heldBy: prev.peer,
          error: relInstance ? 'claim held by another instance of ' + prev.peer : 'release requires instance=',
        })
      }
      if (prev && prev.peer === String(b.peer)) {
        delete deliveries[String(b.seq)]
        writeDeliveries(deliveries)
        return json(res, 200, { ok: true, seq: Number(b.seq), released: prev.target })
      }
      return json(res, 200, { ok: true, seq: Number(b.seq), released: null })
    }
    if (url.pathname === '/ack' && req.method === 'POST') {
      const b = await body(req)
      if (!b.peer) return json(res, 400, { ok: false, error: 'peer required' })
      const target = String(b.target || '').trim()
      // A project-scoped ack says "I am the reader for this project, and I handled everything
      // below upTo that belongs to it (plus the public mail)". Without it a pusher that only
      // looks at its own project would advance the shared peer watermark past another
      // project's undelivered message and silently drop it.
      const projectParam = b.project === undefined || b.project === null ? '' : String(b.project).trim()
      const project = projectParam ? projectIdOfDeclared(projectParam) : ''
      if (projectParam && !project) {
        // A rejected spelling is better than an ack that silently writes a second cursor.
        return json(res, 400, { ok: false, error: 'project must be an 8-hex id', got: b.project })
      }
      // Refuse a missing/zero upTo instead of treating it as a no-op. A client that forgets
      // the argument (or sends up_to with the wrong key) used to write a 0 watermark; if the
      // old value was also lost that resurfaces the whole mailbox. A 400 names the mistake.
      const raw = Number(b.upTo)
      if (!Number.isInteger(raw) || raw <= 0) {
        return json(res, 400, { ok: false, error: 'ack needs upTo as a positive integer seq (1-based)', got: b.upTo })
      }
      // Never move the watermark past the newest message: a typo'd 9999 would hide every
      // future message until seq 9999.
      const upTo = Math.min(raw, seq)
      // Same sledgehammer problem one level up: a peer-wide ack crosses projects. The pusher
      // for project A only read A's mail, so acking up to its newest seq would confirm B's
      // undelivered task on the way. Refuse when the range really spans projects that have
      // something unread, unless the caller passes project (the normal path) or all:true
      // (an explicit "I am the router for everything").
      if (!target && !project && !b.all) {
        const projects = new Set(messages
          .filter(m => m.seq <= upTo && (m.to === b.peer || m.to === '*') && m.from !== b.peer)
          .filter(m => {
            const proj = projectKeyOf(m)
            if (!proj) return false
            return m.seq > Math.max(cursorFor(b.peer, ''), cursorFor(b.peer, 'project:' + proj), laneCursorFor(b.peer, targetOf(m), proj))
          })
          .map(m => projectKeyOf(m)))
        if (projects.size > 1) {
          return json(res, 409, {
            ok: false, error: 'ack would confirm ' + projects.size + ' projects at once',
            projects: [...projects], hint: 'pass project to ack your own project, or all:true if you really routed all of them',
          })
        }
      }
      // A peer-level ack is a sledgehammer: it also confirms messages addressed to other
      // lanes. Refuse when the range really does span lanes, unless the caller says so.
      if (!target && !b.all && !project) {
        // Count lanes that still hold something unconfirmed below upTo. A peer-wide ack would
        // confirm those on behalf of a session/thread that never saw them, so refuse while any
        // remain; once every lane confirmed its own share the cleanup ack goes through.
        const lanes = new Set(messages
          .filter(m => m.seq <= upTo && (m.to === b.peer || m.to === '*') && m.from !== b.peer)
          .filter(m => targetOf(m) && m.seq > laneCursorFor(b.peer, targetOf(m), projectKeyOf(m)))
          .map(m => targetOf(m)))
        if (lanes.size > 0) {
          return json(res, 409, {
            ok: false, error: 'ack would confirm ' + lanes.size + ' lanes at once',
            lanes: [...lanes], hint: 'pass target to ack one lane, or all:true to confirm the whole peer',
          })
        }
      }
      // A claim is not delivery. If a pusher claimed this message and died before handing it
      // over, acking here would mark it read and nobody would ever see it — 'all:true' is the
      // exact shape of that bug, so this guard ignores 'all'. Confirm after delivering, or
      // release the claim if the attempt failed.
      {
        const deliveries = readDeliveries()
        const now = Date.now()
        // Only what this ack would newly confirm: an in-flight message below the watermark is
        // already accounted for, and (for a lane ack) another lane's claim must not block this
        // one — the lanes are independent or the whole addressing scheme is pointless.
        const baseline = Math.max(cursorFor(b.peer, ''), target ? laneCursorFor(b.peer, target, project) : 0)
        const inFlight = messages
          .filter(m => m.seq > baseline && m.seq <= upTo && (m.to === b.peer || m.to === '*') && m.from !== b.peer)
          .filter(m => !target || targetOf(m) === target || targetOf(m) === '')
          // Another project's claim is not this project's business: its pusher owns it.
          .filter(m => !project || projectKeyOf(m) === project || projectKeyOf(m) === '')
          .filter(m => claimInFlight(deliveries[String(m.seq)], String(b.peer), now))
          .map(m => m.seq)
        if (inFlight.length > 0) {
          return json(res, 409, {
            ok: false, error: 'ack would confirm ' + inFlight.length + ' message(s) still in flight',
            seqs: inFlight, hint: 'confirm them after delivery, or release the claim first',
          })
        }
      }
      const cursors = readCursors()
      const key = target
        ? laneKey(b.peer, target, project)
        : (project ? b.peer + '|project:' + project : b.peer)
      cursors[key] = Math.max(Number(cursors[key]) || 0, upTo)
      // One-way migration: a pre-project lane watermark cannot say whose mail it covered, so
      // hand it to the project that is acking that lane now and drop the shared key. Hiding a
      // message is worse than showing it twice.
      if (target && project) {
        const legacyKey = b.peer + '|' + target
        if (cursors[legacyKey] !== undefined) {
          cursors[key] = Math.max(Number(cursors[key]) || 0, Number(cursors[legacyKey]) || 0)
          delete cursors[legacyKey]
        }
      }
      // The shared watermark may follow a project ack, but only over a contiguous prefix:
      // a message belongs to another project and is still unread -> stop right before it.
      // Everything the prefix passes is this project's, public, written by the peer itself,
      // already read through its lane, or sent to somebody else entirely.
      if (project) {
        const base = Number(cursors[b.peer]) || 0
        let prefix = base
        for (const m of messages) {
          if (m.seq <= prefix) continue
          if (m.seq > upTo) break
          if (m.to !== b.peer && m.to !== '*') { prefix = m.seq; continue }
          if (m.from === b.peer) { prefix = m.seq; continue }
          const lane = targetOf(m)
          const proj = projectKeyOf(m)
          // What actually confirms THIS message: its own lane, its own project (written just
          // above when the ack was project-wide), or - for public mail this reader saw - the
          // project ack itself. A lane-scoped ack inside a project must not walk the shared
          // watermark over another lane nobody read; that was a second silent drop.
          const seen = !target || lane === '' || lane === target
          const readBy = Math.max(
            laneCursorIn(cursors, b.peer, lane, proj),
            proj ? Number(cursors[b.peer + '|project:' + proj]) || 0 : 0,
            // A public message handed to a lane is confirmed by that reader's lane ack, exactly
            // as in pending(); otherwise the prefix stops at it and the shared watermark never
            // follows (Codex review, seq 19, P2, ack side).
            (proj === '' || !lane) && target ? laneCursorFor(b.peer, target, project) : 0,
            proj === '' && seen ? upTo : 0,
          )
          if (m.seq <= readBy) { prefix = m.seq; continue }
          break
        }
        if (prefix > base) cursors[b.peer] = prefix
      }
      writeCursors(cursors)
      return json(res, 200, {
        ok: true, peer: b.peer, target, project,
        cursor: target ? laneCursorFor(b.peer, target, project) : (project ? Number(cursors[key]) || 0 : cursorFor(b.peer, '')),
        peerCursor: Number(cursors[b.peer]) || 0,
        scope: target ? 'lane' : (project ? 'project' : 'peer'),
      })
    }
    if (url.pathname === '/registry' && req.method === 'POST') {
      const b = await body(req)
      const peer = String(b.peer || '')
      const kind = String(b.kind || 'session')
      if (!peer) return json(res, 400, { ok: false, error: 'peer required' })
      if (!Array.isArray(b.items)) return json(res, 400, { ok: false, error: 'items must be an array' })
      const items = b.items
        .filter(item => item && typeof item === 'object' && String(item.id || '').trim() !== '')
        .map(item => ({
          id: String(item.id),
          label: typeof item.label === 'string' ? item.label : '',
          cwd: typeof item.cwd === 'string' ? item.cwd : '',
          // Derived by the bus, never trusted from the publisher: two sessions in the
          // same folder must land in the same project even if one of them lies.
          projectId: projectIdOf(typeof item.cwd === 'string' ? item.cwd : ''),
          status: typeof item.status === 'string' ? item.status : '',
          updated: typeof item.updated === 'string' ? item.updated : new Date().toISOString(),
        }))
      const reg = readRegistry()
      reg[peer] = reg[peer] || {}
      reg[peer][kind] = { updatedAt: new Date().toISOString(), items }
      writeRegistry(reg)
      return json(res, 200, { ok: true, peer, kind, count: items.length })
    }
    if (url.pathname === '/registry') {
      const peer = url.searchParams.get('peer') || ''
      const kind = url.searchParams.get('kind') || ''
      return json(res, 200, { ok: true, peer, kind, registry: registryView(peer, kind) })
    }
    if (url.pathname === '/peers') {
      const cursors = readCursors()
      const peers = [...new Set(messages.flatMap(m => [m.from, m.to]))].filter(p => p !== '*')
      const lanes = Object.fromEntries(Object.keys(cursors).filter(k => k.includes('|')).map(k => [k, cursors[k]]))
      return json(res, 200, { ok: true, peers: peers.map(p => ({ peer: p, cursor: Number(cursors[p]) || 0 })), lanes })
    }
    return json(res, 404, { ok: false, error: 'not found: ' + url.pathname })
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err && err.message || err) })
  }
})
server.listen(PORT, HOST, () => {
  console.log('bridge bus listening on http://' + HOST + ':' + PORT + '  dir=' + DIR + '  seq=' + seq + '  msgs=' + messages.length)
})
