// Read the Codex side's own session log so the bridge can name a conversation
// instead of guessing "the most recent one". Codex keeps one append-only JSONL
// rollout per thread under $CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/, named
// rollout-<ISO>-<uuid>.jsonl; the uuid is the thread id `codex queue --thread` accepts,
// and the first user message is the closest thing to a title on disk.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { projectIdOf } from './project.mjs'

/** Directory Codex stores its rollouts in. */
export function sessionsRoot() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
  return path.join(home, 'sessions')
}

/** Every rollout file, newest first. */
function rolloutFiles(root) {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue
      try { out.push({ file: full, mtime: fs.statSync(full).mtime }) } catch {}
    }
  }
  walk(root)
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** Thread id encoded in a rollout filename, or '' when it does not match. */
function idFromName(file) {
  const match = /rollout-[^-]+-[^-]+-[^-]+-[^-]+-(.+?)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path.basename(file))
  if (match) return match[2]
  const loose = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path.basename(file))
  return loose ? loose[1] : ''
}

// Codex replays the workspace's AGENTS.md and its environment probe as ordinary
// user messages before the human's turn. They are not what the thread is about.
const INJECTED = /^(# AGENTS\.md instructions|<[a-z_]+>|\s*#\s*AGENTS\.md)/i
const isInjected = (text) => INJECTED.test(text) || text.slice(0, 200).includes('<INSTRUCTIONS>')

const clip = (text, max) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

/** Read only the head of a rollout: metadata plus the first user turn. */
function head(file, maxBytes = 262144) {
  let text = ''
  let fd
  try {
    fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(maxBytes)
    const read = fs.readSync(fd, buf, 0, maxBytes, 0)
    text = buf.subarray(0, read).toString('utf8')
  } catch { return { id: '', cwd: '', title: '', source: '' } } finally {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
  }
  const lines = text.split('\n')
  if (lines.length > 1 && !text.endsWith('\n')) lines.pop() // drop the truncated tail line
  let id = ''
  let cwd = ''
  let title = ''
  // session_meta.source separates app-created threads (vscode / Codex Desktop, visible in the
  // app's history list) from headless `codex exec` runs, which never show up there.
  let source = ''
  for (const line of lines) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    const payload = obj && typeof obj.payload === 'object' && obj.payload !== null ? obj.payload : obj
    if (!id && payload && typeof payload.id === 'string' && obj.type === 'session_meta') id = payload.id
    if (!source && payload && typeof payload.source === 'string') source = payload.source
    if (!cwd && payload && typeof payload.cwd === 'string') cwd = payload.cwd
    if (!title) {
      if (payload && payload.type === 'message' && payload.role === 'user' && Array.isArray(payload.content)) {
        const part = payload.content.find(c => c && (c.type === 'input_text' || c.type === 'text') && typeof c.text === 'string')
        if (part && part.text.trim() && !isInjected(part.text)) title = part.text
      } else if (payload && payload.type === 'user_message' && typeof payload.message === 'string') {
        if (payload.message.trim() && !isInjected(payload.message)) title = payload.message
      }
    }
    if (id && cwd && title) break
  }
  return { id: id || idFromName(file), cwd, title: clip(title, 160), source }
}

/**
 * What Codex is doing right now, per thread, read straight off the rollout files.
 * A rollout is appended while the turn runs, so file mtime is a truthful heartbeat: fresh
 * mtime means the thread is working, stale means it is waiting for the next task.
 * @param {{ minutes?: number, limit?: number }} options
 * @returns {Array<{id:string,cwd:string,updatedAt:string,ageSeconds:number,active:boolean,lastEvent:string,lastUser:string,lastAssistant:string}>}
 */
export function activity(options = {}) {
  const minutes = Math.max(1, Number(options.minutes) || 30)
  const limit = Math.max(1, Math.min(50, Number(options.limit) || 6))
  const now = Date.now()
  const cutoff = now - minutes * 60000
  return rolloutFiles(sessionsRoot())
    .filter(entry => entry.mtime.getTime() >= cutoff)
    .slice(0, limit)
    .map(entry => summarise(entry, now))
}

/** Parse the tail of one rollout into a one-line "what happened last" record. */
function summarise(entry, now) {
  const file = entry.file
  const id = idFromName(file)
  let text = ''
  try {
    const size = fs.statSync(file).size
    const window = 131072
    const start = Math.max(0, size - window)
    const buf = Buffer.alloc(Math.min(window, size))
    const fd = fs.openSync(file, 'r')
    try { fs.readSync(fd, buf, 0, buf.length, start) } finally { fs.closeSync(fd) }
    text = buf.toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1) // drop the partial first line
  } catch { /* unreadable tail: still report the heartbeat */ }
  let cwd = ''
  let lastUser = ''
  let lastAssistant = ''
  let lastEvent = ''
  let events = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let obj
    try { obj = JSON.parse(line) } catch { continue }
    events++
    const payload = obj && typeof obj.payload === 'object' && obj.payload ? obj.payload : {}
    if (!cwd && typeof payload.cwd === 'string') cwd = payload.cwd
    if (payload.type === 'message' && Array.isArray(payload.content)) {
      const part = payload.content.find(c => c && typeof c.text === 'string' && c.text.trim())
      if (part) {
        if (payload.role === 'assistant') { lastAssistant = clip(part.text, 240); lastEvent = 'message' }
        else if (payload.role === 'user' && !isInjected(part.text)) { lastUser = clip(part.text, 240); lastEvent = 'prompt' }
      }
      continue
    }
    if (payload.type) lastEvent = payload.type
    else if (obj.type && obj.type !== 'turn_context') lastEvent = obj.type
  }
  const ageSeconds = Math.max(0, Math.round((now - entry.mtime.getTime()) / 1000))
  return {
    id, cwd, projectId: projectIdOf(cwd), updatedAt: entry.mtime.toISOString(), ageSeconds,
    active: ageSeconds < 45, lastEvent, lastUser, lastAssistant, events,
  }
}

/** Recent Codex threads, newest first.
 * @param {{ limit?: number, cwd?: string }} options - How many, and an optional
 *   working-directory filter (compared case-insensitively).
 */
export function listThreads(options = {}) {
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 20))
  const wantCwd = typeof options.cwd === 'string' && options.cwd !== ''
    ? options.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    : ''
  const items = []
  for (const entry of rolloutFiles(sessionsRoot())) {
    if (items.length >= limit) break
    const meta = head(entry.file)
    if (!meta.id) continue
    if (wantCwd && meta.cwd.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !== wantCwd) continue
    items.push({
      id: meta.id, label: meta.title, cwd: meta.cwd, projectId: projectIdOf(meta.cwd),
      source: meta.source, status: '', updated: entry.mtime.toISOString(),
    })
  }
  return items
}