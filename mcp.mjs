#!/usr/bin/env node
// MCP stdio server that exposes the bridge bus as tools.
// Peer identity comes from $BRIDGE_PEER (default "codex").
// Starts the bus on demand if it is not running.
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import os from 'node:os'
import fs from 'node:fs'

const PEER = process.env.BRIDGE_PEER || 'codex'
const PORT = Number(process.env.BRIDGE_PORT || 8787)
const BASE = 'http://127.0.0.1:' + PORT
const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = process.env.BRIDGE_DIR || path.join(os.homedir(), '.dsh-codex-bridge')
const THREADS = path.join(HERE, 'lib', 'threads.mjs')
const PROJECT = path.join(HERE, 'lib', 'project.mjs')
// Older messages predate meta.projectId: they carry only meta.cwd, so the tag has to be
// derived the same way the bus derives it, or the transcript looks shuffled between projects.
const { projectKeyOf, projectIdOf } = await import(pathToFileURL(PROJECT).href)

async function api(method, p, payload) {
  const init = { method, headers: {} }
  if (payload !== undefined) {
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(payload)
  }
  const res = await fetch(BASE + p, init)
  const json = await res.json()
  if (!json.ok) {
    // 409s carry the useful part in sibling fields (which seqs are in flight, which lanes
    // would be confirmed). Fold them into the message: the tool result is all a model sees.
    const extra = [
      json.hint,
      Array.isArray(json.seqs) ? 'seqs ' + json.seqs.join(',') : '',
      Array.isArray(json.lanes) ? 'lanes ' + json.lanes.join(',') : '',
    ].filter(Boolean).join('; ')
    throw new Error((json.error || 'bus error') + (extra ? ' (' + extra + ')' : ''))
  }
  return json
}

let starting = null

/** Health probe that always settles: a hung socket must not stall the tool call. */
async function ping(timeoutMs = 1500) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(BASE + '/health', { signal: ctl.signal })
    const json = await res.json()
    if (!json.ok) throw new Error('bus unhealthy')
    return json
  } finally {
    clearTimeout(timer)
  }
}

async function ensureBus() {
  try { return await ping() } catch {
    // Only coalesce a launch that is still in flight; a failed or stale one must be retryable.
    if (!starting) {
      starting = (async () => {
        fs.mkdirSync(DIR, { recursive: true })
        const log = path.join(DIR, 'bus.log')
        const out = fs.openSync(log, 'a')
        const child = spawn(process.execPath, [path.join(HERE, 'bus.mjs')], {
          detached: true,
          stdio: ['ignore', out, out],
          env: { ...process.env, BRIDGE_PORT: String(PORT) },
        })
        child.on('error', () => {})
        child.unref()
        fs.closeSync(out)
        for (let i = 0; i < 50; i++) {
          await new Promise(r => setTimeout(r, 150))
          try { return await ping() } catch {}
        }
        throw new Error('bus did not start; check ' + log)
      })()
      starting.catch(() => {})
      starting.finally(() => { starting = null }).catch(() => {})
    }
    return await starting
  }
}

const turnText = d => {
  const t = d && d.turn
  if (!t) return 'turn=-'
  if (t.state === 'completed') return 'turn=completed(本轮结束)'
  if (t.state === 'failed') return 'turn=failed(' + (Number.isInteger(t.exitCode) ? 'exit ' + t.exitCode : '执行失败') + ')'
  const at = new Date(t.at)
  const since = Number.isFinite(at.getTime()) ? String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0') : '--:--'
  return 'turn=running(since ' + since + ')'
}
const fmt = (m) => {
  const route = m.target ? '  @' + m.target : ''
  const d = m.delivery
  // "held" and "taken" are different promises: a claim can still expire and come back,
  // a delivery cannot. Showing them as one word taught us to ack messages nobody had seen.
  const state = d && d.state === 'claimed'
    ? '  held:' + (d.peer || '?') + '->' + (d.target || '?') + ' (' + (d.expiresIn || 0) + 's lease)'
    : (d && d.target) || m.deliveredBy
      ? '  taken:' + ((d && d.target) || m.deliveredBy)
      : ''
  // A project tag, when the message carries one, is how two projects sharing a bus
  // stay readable in one transcript.
  const tag = m.projectId || projectKeyOf(m)
  const project = tag ? '  #' + tag : ''
  return '[' + m.seq + '] ' + m.ts + '  ' + m.from + ' -> ' + m.to + route + project + '  (' + m.kind + ')' +
    (m.replyTo ? '  re:' + m.replyTo : '') + state + '  ' + turnText(d) + '\n' + m.body
}

const tools = [
  {
    name: 'bridge_send',
    description: 'Send a message to the other agent (dsh or codex) through the local bridge bus. Returns the assigned seq number to quote in reply_to.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient peer: "dsh" or "codex". Use "*" to broadcast. "dsh:<sessionId>" also routes.' },
        body: { type: 'string', description: 'Message text. Markdown is fine; keep it self-contained.' },
        kind: { type: 'string', enum: ['task', 'result', 'question', 'note'], description: 'Message kind. Default "note".' },
        reply_to: { type: 'integer', description: 'seq of the message being answered, if any.' },
        session: { type: 'string', description: 'DSH session id to deliver this to (see bridge_sessions). Omit to let the DSH side pick its project session.' },
        thread: { type: 'string', description: 'Codex thread id to deliver this to (see bridge_threads). Omit to let the Codex side pick its current thread. Pass "new" to open a brand new Codex conversation for this message.' },
        client_msg_id: { type: 'string', description: 'Optional idempotency key (max 200 chars). Retry with the same id and payload and you get the original seq back instead of a duplicate message; the same id with different content is refused.' },
        project: { type: 'string', description: 'Project id (8 hex chars, from bridge_inbox output or /status) this task belongs to. Omit to inherit the project of reply_to, or to leave the message visible in every project.' },
      },
      required: ['to', 'body'],
    },
  },
  {
    name: 'bridge_inbox',
    description: 'Read unread messages addressed to you. Does not mark them read; call bridge_ack when done.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max messages to return. Default 50.' },
        target: { type: 'string', description: 'Only show messages routed to this thread/session id (unrouted messages are always included).' },
        project: { type: 'string', description: 'Only show messages for this project id (plus messages that belong to no project). Omit to see everything.' },
      },
    },
  },
  {
    name: 'bridge_wait',
    description: 'Block until a message arrives for you or the timeout expires, then return the unread messages.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_s: { type: 'integer', description: 'Seconds to wait, max 600. Default 60.' },
        target: { type: 'string', description: 'Only wake for messages routed to this thread/session id.' },
        project: { type: 'string', description: 'Only wake for messages in this project (plus project-less ones).' },
      },
    },
  },
  {
    name: 'bridge_ack',
    description: 'Mark messages read up to a seq number, so they are not returned again. Pass target to confirm only your own lane; without it the whole peer is confirmed.',
    inputSchema: {
      type: 'object',
      properties: {
        up_to: { type: 'integer', description: 'Highest seq you have processed.' },
        target: { type: 'string', description: 'Your thread/session id. Confirms only that lane instead of the whole peer.' },
        all: { type: 'boolean', description: 'Allow a peer-wide ack even when it spans several lanes.' },
        project: { type: 'string', description: 'Only speak for this project id (8 hex chars). Required when you read with project=; the shared watermark then advances over a contiguous prefix only, so another project’s undelivered mail is never confirmed by you.' },
      },
      required: ['up_to'],
    },
  },
  {
    name: 'bridge_peers',
    description: 'List known peers and how far each has read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bridge_sessions',
    description: 'List the DSH sessions the bridge can deliver to. Pass an id as session= on bridge_send to aim a task at one conversation instead of letting DSH pick.',
    inputSchema: {
      type: 'object',
      properties: { cwd: { type: 'string', description: 'Only sessions whose working directory matches this path.' } },
    },
  },
  {
    name: 'bridge_threads',
    description: 'List recent Codex threads (read from the local session log). Pass an id as thread= on bridge_send so the message lands in that conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max threads to return. Default 20.' },
        cwd: { type: 'string', description: 'Only threads whose working directory matches this path.' },
      },
    },
  },
]

const samePath = (a, b) => String(a || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() ===
  String(b || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

function describe(items) {
  if (!items.length) return 'no addressable targets yet'
  return items.map(item =>
    item.id + '  [' + (item.status || '?') + ']  ' + (item.label || '(untitled)') +
    ((item.projectId || projectIdOf(item.cwd)) ? '  #' + (item.projectId || projectIdOf(item.cwd)) : '') +
    (item.source ? '  src:' + item.source : '') +
    (item.cwd ? '\n    cwd: ' + item.cwd : '')).join('\n')
}

async function call(name, args) {
  await ensureBus()
  if (name === 'bridge_send') {
    const meta = {}
    if (typeof args.session === 'string' && args.session.trim()) meta.sessionId = args.session.trim()
    const project = typeof args.project === 'string' ? args.project.trim() : ''
    if (project) meta.projectId = project
    else if (process.env.BRIDGE_CWD) meta.cwd = process.env.BRIDGE_CWD
    const thread = typeof args.thread === 'string' ? args.thread.trim() : ''
    if (thread === 'new') meta.new = true
    else if (thread) meta.thread = thread
    let to = String(args.to || '')
    const prefixed = /^(dsh|codex):(.+)$/.exec(to.trim())
    if (prefixed) {
      to = prefixed[1]
      if (to === 'dsh' && !meta.sessionId) meta.sessionId = prefixed[2].trim()
      const tail = prefixed[2].trim()
      if (to === 'codex' && tail === 'new') meta.new = true
      else if (to === 'codex' && !meta.thread) meta.thread = tail
    }
    const r = await api('POST', '/send', {
      from: PEER, to, body: args.body, kind: args.kind || 'note', replyTo: args.reply_to ?? null,
      meta: Object.keys(meta).length ? meta : null,
      ...(typeof args.client_msg_id === 'string' && args.client_msg_id.trim()
        ? { clientMsgId: args.client_msg_id.trim() }
        : {}),
    })
    return 'sent as seq ' + r.message.seq + ' to ' + to +
      (r.deduplicated ? ' (duplicate of an earlier send with the same client_msg_id)' : '') +
      (project ? ' (project ' + project + ')' : '') +
      (meta.sessionId ? ' (session ' + meta.sessionId + ')' : '') +
      (meta.thread ? ' (thread ' + meta.thread + ')' : '') +
      (meta.new ? ' (new thread)' : '')
  }
  if (name === 'bridge_inbox') {
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    const project = typeof args.project === 'string' ? args.project.trim() : ''
    const r = await api('GET', '/inbox?peer=' + encodeURIComponent(PEER) +
      (target ? '&target=' + encodeURIComponent(target) : '') +
      (project ? '&project=' + encodeURIComponent(project) : ''))
    const msgs = r.messages.slice(0, args.limit || 50)
    if (!msgs.length) return 'no unread messages for ' + PEER
    const text = msgs.map(fmt).join('\n\n')
    const lanes = [...new Set(msgs.map(m => m.target).filter(Boolean))]
    // Without a target the reader sees every lane; say so instead of pretending isolation.
    if (!target && lanes.length > 1) {
      return text + '\n\n[' + lanes.length + ' lanes are mixed here: ' + lanes.join(', ') +
        '. Pass target=<yours> to read only your lane, and ack with the same target so you do not confirm theirs.]'
    }
    return text
  }
  if (name === 'bridge_wait') {
    const t = Math.min(args.timeout_s || 60, 600)
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    const project = typeof args.project === 'string' ? args.project.trim() : ''
    const r = await api('GET', '/wait?peer=' + encodeURIComponent(PEER) + '&timeout=' + t +
      (target ? '&target=' + encodeURIComponent(target) : '') +
      (project ? '&project=' + encodeURIComponent(project) : ''))
    if (!r.messages.length) return 'no messages for ' + PEER + ' within ' + t + 's'
    return r.messages.map(fmt).join('\n\n')
  }
  if (name === 'bridge_ack') {
    const target = typeof args.target === 'string' ? args.target.trim() : ''
    const project = typeof args.project === 'string' ? args.project.trim() : ''
    const r = await api('POST', '/ack', {
      peer: PEER, upTo: args.up_to,
      ...(target ? { target } : {}), ...(args.all ? { all: true } : {}),
      ...(project ? { project } : {}),
    })
    const last = await api('GET', '/delivery?seq=' + encodeURIComponent(args.up_to)).catch(() => ({}))
    return 'cursor for ' + PEER + (target ? ' lane ' + target : (project ? ' project ' + project : '')) +
      ' is now ' + r.cursor + ' [' + (r.scope || 'peer') + ' scope' +
      (project && !target ? ', peer still at ' + (r.peerCursor ?? 0) : '') + '] ' + turnText(last.delivery)
  }
  if (name === 'bridge_peers') {
    const r = await api('GET', '/peers')
    return r.peers.map(p => p.peer + ' (read up to ' + p.cursor + ')').join('\n') || 'no peers yet'
  }
  if (name === 'bridge_sessions') {
    const r = await api('GET', '/registry?peer=dsh&kind=session')
    const view = r.registry || {}
    let items = Array.isArray(view.items) ? view.items : []
    if (typeof args.cwd === 'string' && args.cwd) items = items.filter(item => samePath(item.cwd, args.cwd))
    if (items.length === 0) return 'DSH has not published any session yet (the wake plugin republishes every few seconds)'
    return describe(items) + '\n\npass one id as session= on bridge_send'
  }
  if (name === 'bridge_threads') {
    let items = []
    try {
      const { listThreads } = await import(pathToFileURL(THREADS).href)
      items = listThreads({ limit: args.limit, cwd: args.cwd })
    } catch { items = [] }
    if (items.length === 0) {
      const r = await api('GET', '/registry?peer=codex&kind=thread')
      const view = r.registry || {}
      items = Array.isArray(view.items) ? view.items : []
      if (typeof args.cwd === 'string' && args.cwd) items = items.filter(item => samePath(item.cwd, args.cwd))
    }
    if (items.length === 0) return 'no Codex thread found in ' + DIR + ' or on disk'
    return describe(items) + '\n\npass one id as thread= on bridge_send'
  }
  throw new Error('unknown tool ' + name)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
const send = obj => process.stdout.write(JSON.stringify(obj) + '\n')

rl.on('line', async line => {
  if (!line.trim()) return
  let req
  try { req = JSON.parse(line) } catch { return }
  const isNotification = req.id === undefined || req.id === null
  try {
    if (req.method === 'initialize') {
      const info = await ensureBus().catch(e => ({ ok: false, error: String(e.message || e) }))
      send({
        jsonrpc: '2.0', id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'dsh-codex-bridge', version: '0.1.0' },
          instructions: 'Bridge peer "' + PEER + '". Bus: ' + (info.ok ? 'running' : 'not running: ' + info.error),
        },
      })
      return
    }
    if (req.method === 'notifications/initialized' || req.method === 'initialized') return
    if (req.method === 'ping') return send({ jsonrpc: '2.0', id: req.id, result: {} })
    if (req.method === 'tools/list') return send({ jsonrpc: '2.0', id: req.id, result: { tools } })
    if (req.method === 'tools/call') {
      const name = req.params?.name
      const args = req.params?.arguments || {}
      try {
        const text = await call(name, args)
        send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text }] } })
      } catch (err) {
        send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: 'error: ' + (err.message || err) }], isError: true } })
      }
      return
    }
    if (!isNotification) send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found: ' + req.method } })
  } catch (err) {
    if (!isNotification) send({ jsonrpc: '2.0', id: req.id, error: { code: -32603, message: String(err.message || err) } })
  }
})
