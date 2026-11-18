/**
 * Wake a DSH agent when Codex posts to the bridge bus.
 *
 * The bus and the MCP tools live in ../bus.mjs and ../mcp.mjs. They can move a
 * message across the two processes, but nothing on the Codex side can start a
 * turn in DSH: a message that arrives while every DSH agent is idle stays
 * unread until a human types something. This plugin closes that gap by holding
 * a long poll against the bus and enqueuing an ordinary user message into the
 * idle agent's inbox, which is the same delivery path the Schedule service
 * uses for a reminder.
 *
 * Two rules keep it from fighting the agent:
 *   - It never acknowledges anything. The agent reads the messages with
 *     bridge_inbox and acks them itself, so a nudge can never swallow a task.
 *   - It nudges once per unacknowledged batch. Until the bus cursor advances,
 *     the same messages do not produce more turns.
 */

import { randomUUID } from 'node:crypto'
import http from 'node:http'
import { projectIdOf } from '../lib/project.mjs'
import path from 'node:path'

/** Loader plugin name. */
export const name = 'codex-bridge-wake'

/** Host services this plugin needs: the live agents it wakes and the Session
 * flush that makes a queued message durable before the agent picks it up. */
export const inject = ['agents', 'sessions']

/** Defaults; every field is overridable from the bundle's patch config. */
const DEFAULTS = {
  port: 8787,
  peer: 'dsh',
  /** Seconds per long poll; the bus caps this at 600. */
  waitSeconds: 25,
  /** Delay before re-polling after the bus is unreachable. */
  retryMs: 3000,
  /** Wake delegated child sessions too; off, because a child is another
   * session's errand and starting a turn there helps nobody. */
  includeSubagents: false,
  /** Only wake a session whose working directory matches this one. The bridge
   * belongs to a project, not to the whole application. */
  cwd: '',
  /** Explicit allowlist of session ids; wins over cwd when non-empty. */
  sessionIds: [],
  /** How often to republish the live sessions to the bus registry, which is
   * what lets the Codex side name a conversation (bridge_sessions). */
  publishMs: 15000,
  /** How often to retry a lane whose session was not open when its message
   * arrived. The long poll has already moved past it, so this is the only path
   * that can still deliver it. */
  retryPendingMs: 20000,
}

/** Deep-freeze a message the way @deepseek-ai/dsh-llm's createMessage does. */
function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFreeze(value[key])
  }
  return value
}

/**
 * Build the identified user message a nudge consists of.
 *
 * Mirrors createUserMessage from @deepseek-ai/dsh-llm, which this bundle cannot
 * import: a plugin loaded from a linked directory resolves bare specifiers
 * against the profile, not the application. The shape is the contract — role,
 * exact content blocks, a producer source, and a stable id — and the source
 * declares form 'relay' ("a message another agent addressed to this one").
 * @param text - Model-facing nudge text.
 * @param detail - Sequence range carried through to the transcript.
 * @returns A frozen user message.
 */
function nudgeMessage(text, detail) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'codex-bridge', form: 'relay' },
  })
}

/**
 * Delegation depth of a live agent, read the way @deepseek-ai/dsh-subagent
 * reads it: the persisted session header is the floor and a runtime option can
 * only deepen it. Zero means a top-level session.
 * @param agent - Agent to classify.
 * @returns Its non-negative depth, or 0 when unreadable.
 */
function delegationDepth(agent) {
  const header = agent?.session?.header?.delegationDepth
  const runtime = agent?.options?.subagentDepth
  const persisted = Number.isSafeInteger(header) && header > 0 ? header : 0
  const declared = Number.isSafeInteger(runtime) && runtime > 0 ? runtime : 0
  return Math.max(persisted, declared)
}

/** Normalize a directory for comparison: separators, case, trailing slash. */
function sameDir(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false
  const norm = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** Working directory a live agent's session was created in, if any. */
function sessionCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' ? cwd : ''
}

/**
 * Choose the single session a nudge belongs to.
 *
 * Waking every live agent is wrong: a message for this project must not start
 * a turn in the six unrelated sessions the window happens to have open. The
 * order is specific-to-general — the message's own target, then an explicit
 * allowlist, then the workspace the bridge serves, then (only as a last
 * resort) whichever live session was opened most recently.
 * @param agents - Live agents from the registry.
 * @param messages - The unread batch being delivered.
 * @param options - Resolved plugin config.
 * @returns Zero or one agents to wake.
 */
function pickTargets(agents, messages, options) {
  const live = Array.isArray(agents) ? agents : []
  const scoped = options.includeSubagents ? live : live.filter((agent) => delegationDepth(agent) === 0)
  if (scoped.length === 0) return []

  const addressed = messages
    .map((message) => message?.meta?.sessionId)
    .find((id) => typeof id === 'string' && id !== '')
  if (addressed) {
    const hit = scoped.filter((agent) => String(agent.session?.id) === addressed)
    if (hit.length > 0) return hit.slice(-1)
  }

  const allow = Array.isArray(options.sessionIds) ? options.sessionIds.map(String).filter(Boolean) : []
  if (allow.length > 0) {
    const hit = scoped.filter((agent) => allow.includes(String(agent.session?.id)))
    if (hit.length > 0) return hit.slice(-1)
  }

  if (options.cwd) {
    const hit = scoped.filter((agent) => sameDir(sessionCwd(agent), options.cwd))
    if (hit.length > 0) return hit.slice(-1)
  }

  const idle = scoped.filter((agent) => agent.status === 'idle')
  const pool = idle.length > 0 ? idle : scoped
  return pool.slice(-1)
}

/** The DSH session a message is addressed to, or "" for the default lane. */
function laneOf(message) {
  const meta = message && typeof message.meta === 'object' && message.meta ? message.meta : {}
  const session = typeof meta.sessionId === 'string' ? meta.sessionId.trim() : ''
  return session
}

/**
 * Resolve one lane to the session that should receive it.
 *
 * An addressed lane is exact: if that session is gone, the answer is "nobody",
 * never "some other conversation". The default lane (a message with no session
 * id) is pinned to the first session that served it, so a conversation opened
 * later cannot silently steal traffic that belongs to an older one — that is
 * exactly how an earlier version ended up waking the wrong window.
 * @param agents - Live agents from the registry.
 * @param lane - Session id, or "" for the default lane.
 * @param options - Resolved plugin config.
 * @param owner - Mutable holder of the default lane's session id.
 * @returns Zero or one agents to wake.
 */
function agentsForLane(agents, lane, options, owner) {
  const live = Array.isArray(agents) ? agents : []
  const scoped = options.includeSubagents ? live : live.filter((agent) => delegationDepth(agent) === 0)
  if (scoped.length === 0) return []
  if (lane) return scoped.filter((agent) => String(agent?.session?.id) === lane).slice(-1)
  if (owner?.id) {
    const held = scoped.filter((agent) => String(agent?.session?.id) === owner.id)
    if (held.length > 0) return held.slice(-1)
    owner.id = '' // the owning session was closed; fall through and pick again
  }
  const picked = pickTargets(scoped, [], options)
  if (picked.length > 0 && owner) owner.id = String(picked[0]?.session?.id ?? '')
  return picked
}

/** Title a human would recognize for a session, if the host exposes one. */
function sessionTitle(agent) {
  const header = agent?.session?.header
  for (const key of ['title', 'name', 'summary']) {
    const value = header?.[key]
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, 160)
  }
  return ''
}

/**
 * Never publish an empty label: an id with no title is unusable in bridge_sessions,
 * so fall back to "<project folder> · <short id>", which a human can still pick.
 */
function sessionLabel(agent) {
  const title = sessionTitle(agent)
  if (title) return title
  const cwd = sessionCwd(agent)
  const folder = cwd ? path.basename(cwd) : ''
  const id = String(agent?.session?.id ?? '')
  const tail = id.length > 8 ? id.slice(-8) : id
  return [folder, tail].filter(Boolean).join(' · ') || tail
}

/** POST JSON to the bus; rejects on transport failure or a non-object reply. */
function postJson(port, path, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(payload))
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': data.length } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => { text += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error('bus returned HTTP ' + res.statusCode)); return }
          try { resolve(JSON.parse(text)) } catch (error) { reject(error) }
        })
      })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('bus request timed out')))
    req.on('error', reject)
    req.end(data)
  })
}

/** One JSON GET against the bus; rejects on transport failure. */
function getJson(port, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('bus returned HTTP ' + res.statusCode))
          return
        }
        try { resolve(JSON.parse(data)) } catch (error) { reject(error) }
      })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('bus request timed out')))
    req.on('error', reject)
  })
}

/** Sleep that a disposed plugin can cut short. */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

/**
 * Mount the wake loop.
 * @param ctx - Plugin context.
 * @param config - Bundle config: overrides for {@link DEFAULTS}.
 */
export function apply(ctx, config) {
  const options = { ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) }
  const port = Number(options.port)
  const peer = String(options.peer)
  const waitSeconds = Math.max(1, Math.min(600, Number(options.waitSeconds)))
  const retryMs = Math.max(250, Number(options.retryMs))

  /** Highest sequence the long poll has already looked at. It only guards the
   * poll itself (so an unacked batch does not return again immediately); whether
   * a lane may be nudged again is tracked per lane below. */
  let notified = 0
  /** Per-lane high-water mark. One conversation being nudged must not silence
   * another lane that arrived in the same batch. */
  const nudgedByLane = new Map()
  /** Lanes that had no session when their messages arrived, still to be retried. */
  const pendingLanes = new Set()
  /** The session that owns the default lane (messages sent without a session id). */
  const defaultOwner = { id: '' }
  let degraded = false

  const log = (level, message) => {
    try { ctx.logger?.[level]?.('[codex-bridge-wake] ' + message) } catch {}
  }

  /**
   * Nudge the session that owns one lane.
   *
   * An idle agent gets an ordinary follow-up turn, which is the only way to
   * start work without a human. A busy agent gets the same text as injected
   * context, so it reads the notice at its next step boundary without opening
   * a second turn behind the one already running.
   * @param lane - Session id, or "" for the default lane.
   * @param batch - The unread messages that belong to that lane.
   * @returns true when at least one agent was nudged.
   */
  async function wakeLane(lane, batch) {
    const seqs = batch.map((message) => Number(message.seq)).filter((seq) => Number.isFinite(seq))
    if (seqs.length === 0) return false
    const first = Math.min(...seqs)
    const last = Math.max(...seqs)
    if (last <= (nudgedByLane.get(lane) || 0)) return false

    let agents = []
    try { agents = ctx.agents.list() } catch (error) { log('warn', 'could not list agents: ' + String(error)) }

    const targets = agentsForLane(agents, lane, options, defaultOwner)
    if (targets.length === 0) {
      // Hold it: the session may simply not be open yet. Never hand an addressed
      // message to a different conversation to keep the queue moving.
      pendingLanes.add(lane)
      log('warn', 'no session for lane ' + (lane || '(default)') + '; holding seq ' + first + '–' + last + ' for a retry')
      return false
    }

    const senders = [...new Set(batch.map((message) => message.from))].join(', ')
    const head = '【Codex 桥】有 ' + batch.length + ' 条未读消息（来自 ' + senders + '，seq ' + first + '–' + last + '）。'
    let delivered = 0
    for (const agent of targets) {
      try {
        // Name the lane, so this session's ack only confirms its own messages.
        const text = head + (lane
          ? '请调用 bridge_inbox（target=' + lane + '）读取并处理，处理完用 bridge_ack up_to=' + last + ' target=' + lane + ' 回执；'
          : '请调用 bridge_inbox 读取并处理，处理完用 bridge_ack up_to=' + last + ' 回执；')
          + '如果这次不需要处理，也请 ack 掉，免得重复叫醒。'
        const message = nudgeMessage(text, last)
        if (agent.status === 'idle') agent.followup(message)
        else agent.inbox.inject(message)
        await ctx.sessions.flush(agent.session)
        delivered += 1
        log('info', 'woke session ' + String(agent?.session?.id ?? '?') + ' (' + String(agent.status) + ') for seq ' + first + '–' + last)
      } catch (error) {
        log('warn', 'could not nudge agent ' + String(agent?.session?.id ?? '?') + ': ' + String(error))
      }
    }
    if (delivered === 0) { pendingLanes.add(lane); return false }
    nudgedByLane.set(lane, last)
    pendingLanes.delete(lane)
    return true
  }

  /**
   * Split an unread batch by lane and let each lane nudge its own session.
   *
   * The previous version woke one session for the whole batch and then moved a
   * single watermark past the largest seq in it, so a second lane arriving in
   * the same batch was never woken and `/wait?after=` never returned it again.
   * @param messages - Unread bus messages.
   */
  async function notify(messages) {
    const seqs = messages.map((message) => Number(message.seq)).filter((seq) => Number.isFinite(seq))
    if (seqs.length === 0) return
    const last = Math.max(...seqs)
    if (last <= notified) return

    const byLane = new Map()
    for (const message of messages) {
      const lane = laneOf(message)
      if (!byLane.has(lane)) byLane.set(lane, [])
      byLane.get(lane).push(message)
    }
    let woke = 0
    for (const [lane, batch] of byLane) if (await wakeLane(lane, batch)) woke += 1
    // Move the floor even when a lane had nobody to wake: retryLoop owns those,
    // otherwise the same undeliverable batch would return from every poll at once.
    notified = last
    log('info', woke + '/' + byLane.size + ' lane(s) nudged, seq ' + Math.min(...seqs) + '–' + last)
  }

  /**
   * Retry lanes that had no session when their messages arrived.
   *
   * The poll floor has already moved past them, so the long poll will not offer
   * them again. Asking the bus for that lane's inbox directly keeps the promise
   * that an addressed message is delivered once its session shows up.
   * @param signal - Aborted when the plugin unmounts.
   */
  async function retryLoop(signal) {
    const every = Math.max(500, Number(options.retryPendingMs) || 0)
    while (!signal.aborted) {
      await sleep(every, signal)
      if (signal.aborted || pendingLanes.size === 0) continue
      for (const lane of [...pendingLanes]) {
        if (signal.aborted) return
        let reply
        try {
          reply = await getJson(
            port,
            '/inbox?peer=' + encodeURIComponent(peer) + '&limit=200' + (lane ? '&target=' + encodeURIComponent(lane) : ''),
            5000,
          )
        } catch { continue }
        const batch = (Array.isArray(reply?.messages) ? reply.messages : []).filter((message) => laneOf(message) === lane)
        if (batch.length === 0) { pendingLanes.delete(lane); continue }
        await wakeLane(lane, batch)
      }
    }
  }

  /**
   * Publish which sessions a peer could address.
   *
   * Without this the Codex side can only say "to dsh" and the wake plugin has to
   * guess from cwd or recency. With it, Codex reads bridge_sessions, picks an id
   * and the nudge is aimed at exactly that conversation.
   */
  async function publish() {
    let agents = []
    try { agents = ctx.agents.list() } catch (error) { log('warn', 'could not list agents: ' + String(error)) }
    const scoped = options.includeSubagents ? agents : agents.filter((agent) => delegationDepth(agent) === 0)
    const items = scoped
      .map((agent) => ({
        id: String(agent?.session?.id ?? ''),
        label: sessionLabel(agent),
        cwd: sessionCwd(agent),
        projectId: projectIdOf(sessionCwd(agent)),
        status: String(agent?.status ?? ''),
        default: String(agent?.session?.id ?? '') === defaultOwner.id || undefined,
        updated: new Date().toISOString(),
      }))
      .filter((item) => item.id !== '')
    try {
      await postJson(port, '/registry', { peer, kind: 'session', items }, 5000)
    } catch (error) {
      log('warn', 'could not publish sessions: ' + String(error))
    }
  }

  /** Republish on a timer so the registry follows sessions opening and closing. */
  async function publishLoop(signal) {
    const every = Math.max(1000, Number(options.publishMs))
    while (!signal.aborted) {
      await publish()
      await sleep(every, signal)
    }
  }

  /** Hold a long poll against the bus for as long as the plugin is mounted. */
  async function run(signal) {
    log('info', 'watching bus at 127.0.0.1:' + port + ' as peer "' + peer + '"')
    // One line that identifies this build: after an upgrade the log is the only way
    // to tell "the new file is loaded" from "the old process is still running".
    log('info', 'lane routing v2: one nudge per lane, default lane pinned, retry every '
      + Math.max(500, Number(options.retryPendingMs) || 0) + 'ms')
    while (!signal.aborted) {
      let reply
      try {
        // after=notified: an ack that only confirms one lane leaves the peer watermark behind,
        // so without this the already-nudged batch would make every poll return at once.
        reply = await getJson(port, '/wait?peer=' + encodeURIComponent(peer) + '&timeout=' + waitSeconds + '&after=' + notified, (waitSeconds + 15) * 1000)
        if (degraded) { degraded = false; log('info', 'bus reachable again') }
      } catch (error) {
        if (signal.aborted) return
        if (!degraded) { degraded = true; log('warn', 'bus unreachable, retrying: ' + String(error)) }
        await sleep(retryMs, signal)
        continue
      }
      if (signal.aborted) return
      const messages = Array.isArray(reply?.messages) ? reply.messages : []
      if (messages.length > 0) await notify(messages)
    }
  }

  ctx.effect(() => {
    const controller = new AbortController()
    void run(controller.signal)
    void publishLoop(controller.signal)
    void retryLoop(controller.signal)
    return () => controller.abort()
  })
}
