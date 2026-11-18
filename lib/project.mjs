// Project identity: which working directory a message, session or thread belongs to.
//
// One bus, several projects. The lane (meta.sessionId / meta.thread) answers "which
// conversation"; this module answers "which project", so a pusher started in project A
// does not hand project B's tasks to A's Codex thread.
//
// The id is DERIVED ON THE BUS from a cwd. Clients only ever send a path, never an id,
// so a typo cannot silently route a task into another project's inbox.
import crypto from 'node:crypto'
import path from 'node:path'

/**
 * Canonical form of a working directory, or '' when there is none.
 * Windows-style paths are case-insensitive and accept either slash, so C:\X\proj,
 * c:/x/proj/ and C:/X/proj must all collapse to the same string.
 * @param {unknown} cwd
 * @returns {string}
 */
export function normalizeCwd(cwd) {
  const raw = typeof cwd === 'string' ? cwd.trim() : ''
  if (!raw) return ''
  // A relative path means whatever directory the SENDER happened to run in, and the bus
  // resolves in its own process. ".\\proj" from two shells would become two ids for one
  // folder, so a non-absolute path counts as "no project" instead of a guess. "C:" (drive
  // relative, no slash) lands here too; "C:\\" and "C:/" stay absolute.
  if (!path.isAbsolute(raw)) return ''
  let resolved
  try { resolved = path.resolve(raw) } catch { return '' }
  const slashed = resolved.replace(/\\/g, '/').toLowerCase()
  const trimmed = slashed.replace(/\/+$/, '')
  // Keep a bare drive/root addressable: "c:/" would otherwise become "c:".
  return trimmed || slashed
}

/**
 * Stable 8-hex project id for a directory. '' when the path is unusable, which every
 * caller must treat as "no project" (visible everywhere) rather than "some project".
 * @param {unknown} cwd
 * @returns {string}
 */
export function projectIdOf(cwd) {
  const key = normalizeCwd(cwd)
  if (!key) return ''
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)
}

/**
 * A project id that arrived as a string (meta.projectId, or a stored field).
 * Only the canonical shape is accepted: 8 lowercase hex chars. Anything else is ignored
 * rather than trusted, because ids are compared with === and are used as cursor keys.
 * @param {unknown} value
 * @returns {string}
 */
export function projectIdOfDeclared(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  return /^[0-9a-f]{8}$/.test(raw) ? raw : ''
}

/**
 * Which project a stored message belongs to.
 * The bus fills message.projectId at /send time; messages written before this existed
 * (and messages whose sender only knew a cwd) fall back to deriving it from meta.
 * @param {any} message
 * @returns {string}
 */
export function projectKeyOf(message) {
  if (!message || typeof message !== 'object') return ''
  const meta = typeof message.meta === 'object' && message.meta ? message.meta : {}
  const fromMeta = () => projectIdOf(meta.cwd) || projectIdOfDeclared(meta.projectId)
  if (!Object.prototype.hasOwnProperty.call(message, 'projectId')) return fromMeta()
  const raw = message.projectId
  // A stored id is authoritative even when it is EMPTY: '' means "deliberately public" (that is
  // what the bus writes for a reply to a public message). Re-deriving it from meta.cwd filed that
  // reply into the replier's project and hid it from everyone else (Codex review, seq 19, P2).
  if (typeof raw === 'string') {
    const id = projectIdOfDeclared(raw)
    if (id) return id
    if (raw.trim() === '') return ''
    // A malformed declaration ("junk", a 9-char typo, ...) is NOT public: broadcasting it to
    // every project is the worst reading. Trust the old metadata if it says something, and only
    // fall back to public when there is nothing else (Codex review, seq 21, P3).
    return fromMeta()
  }
  // null / number / object: no usable declaration either, same rule.
  return fromMeta()
}

/** The cwd a message carries, for display next to its project id. */
export function projectCwdOf(message) {
  if (!message || typeof message !== 'object') return ''
  const meta = typeof message.meta === 'object' && message.meta ? message.meta : {}
  return typeof meta.cwd === 'string' ? meta.cwd : ''
}
