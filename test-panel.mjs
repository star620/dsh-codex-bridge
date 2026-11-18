// Static contract test for the browser half: load lib/client.js the way the DSH
// module loader does (register a factory, then materialize it with a stubbed
// React) and assert the conversation.view registration it produces.
// The visual side is checked separately in panel-dev/ (real Chrome + bus data).
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, 'dsh-bundle', 'lib', 'client.js')
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, 'dsh-bundle', 'package.json'), 'utf8'))

let pass = 0
let fail = 0
function ok(name, condition, detail) {
  if (condition) { pass++; console.log('PASS ' + name) } else { fail++; console.log('FAIL ' + name + (detail ? ' — ' + detail : '')) }
}

// 1. manifest contract: the host composes browser bundles from exports["./client"] + dsh.client
ok('exports["./client"] points at the bundle', PKG.exports?.['./client'] === './lib/client.js')
ok('dsh.manifestVersion is declared', PKG.dsh?.manifestVersion === 1)
ok('dsh.client.platform is web', PKG.dsh?.client?.platform === 'web')
ok('dsh.client.inject lists the shells it needs',
  Array.isArray(PKG.dsh?.client?.inject) &&
  PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-slots') &&
  PKG.dsh.client.inject.includes('@deepseek-ai/dsh-client-locale'),
  JSON.stringify(PKG.dsh?.client?.inject))
ok('main entry exists', fs.existsSync(path.join(HERE, 'dsh-bundle', PKG.main)))
ok('client bundle exists', fs.existsSync(path.join(HERE, 'dsh-bundle', PKG.exports['./client'])))
ok('files[] ships the browser half', Array.isArray(PKG.files) && PKG.files.includes('lib/client.js'))

// The panel only appears if the package is also a live Loader entry: dsh.client alone
// gets scanned only for entries that exist in the roster, so the patch must insert it.
const patch = fs.readFileSync(path.join(HERE, 'dsh-bundle', 'cordis.patch.yml'), 'utf8')
ok('patch inserts the panel Loader entry', /-\s*id:\s*codex-bridge-panel[\s\S]{0,120}name:\s*'?@local\/codex-bridge'?/.test(patch))
ok('patch keeps the MCP client entry', /-\s*id:\s*codex-bridge-mcp[\s\S]{0,120}name:\s*'?@deepseek-ai\/dsh-mcp-client'?/.test(patch))

// 2. module contract: idempotent registration, exports.apply / exports.inject
const source = fs.readFileSync(CLIENT, 'utf8')
const registrations = []
let loaded = null
const reactStub = {
  // A real element shape: the badge assertions below render through this stub.
  createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
  Fragment: Symbol('Fragment'),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}
const sandbox = {
  window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
  console: { warn: () => {}, log: () => {} },
  fetch: () => Promise.reject(new Error('no network in unit test')),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  clearTimeout: () => {},
  AbortController: class { constructor() { this.signal = null } abort() {} },
  document: { hidden: true },
  URLSearchParams,
  encodeURIComponent,
  JSON, Math, Date, String, Number, Object, Array, Error,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

ok('bundle calls __ModuleLoader__.load', !!loaded)
ok('bundle id equals the package name', loaded?.id === PKG.name, loaded?.id)

const requireStub = (name) => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return { jsx: reactStub.createElement, jsxs: reactStub.createElement, Fragment: reactStub.Fragment }
  throw new Error('unexpected require: ' + name)
}
const mods = loaded.factory(requireStub)
ok('exports.apply is a function', typeof mods.apply === 'function')
ok('exports.inject requests slots + locale',
  Array.isArray(mods.inject) && mods.inject.includes('slots') && mods.inject.includes('locale'), JSON.stringify(mods.inject))

const injected = []
let effectsRun = 0
const ctx = {
  slots: {
    inject: (name, factory) => { injected.push(name); factory() },
    register: (spec, Component) => { registrations.push({ spec, Component }); return () => {} },
  },
  locale: { getLocale: () => ({ active: 'zh-CN' }), register: () => {} },
  effect: (fn) => { effectsRun++; return fn() },
  get: () => undefined,
}
mods.apply(ctx)

const views = registrations.filter((r) => r.spec?.name === 'conversation.view')
const badges = registrations.filter((r) => r.spec?.name === 'sidebar.session.row.trailing')
ok('slots.inject covers both seats', injected.includes('conversation.view') && injected.includes('sidebar.session.row.trailing'), JSON.stringify(injected))
ok('registers exactly one view', views.length === 1, String(views.length))
ok('the badge poller is installed as a disposable effect', effectsRun === 1, String(effectsRun))
const spec = views[0]?.spec
ok('view name is conversation.view', spec?.name === 'conversation.view')
ok('view id is codex-bridge', spec?.id === 'codex-bridge')
ok('view order is a number', typeof spec?.order === 'number')
ok('label is a function returning 桥 (zh)', typeof spec?.label === 'function' && spec.label() === '桥', String(spec?.label?.()))
ok('inject() maps a session id to props',
  typeof spec?.inject === 'function' && spec.inject('session-abc').sessionId === 'session-abc',
  JSON.stringify(spec?.inject?.('session-abc')))
ok('component is a function component', typeof views[0]?.Component === 'function')

// The count lives in the sidebar row: conversation.view can only carry { id, label }.
const badgeSpec = badges[0]?.spec
ok('registers one sidebar badge', badges.length === 1, String(badges.length))
ok('badge id is codex-bridge-unread', badgeSpec?.id === 'codex-bridge-unread', badgeSpec?.id)
ok('badge sits after the shipped row icons', badgeSpec?.order === 50, String(badgeSpec?.order))
const badgeInject = badgeSpec?.inject?.()
ok('badge injects a subscribable store',
  typeof badgeInject?.hooks?.bridgeUnread?.getSnapshot === 'function' &&
  typeof badgeInject?.hooks?.bridgeUnread?.subscribe === 'function',
  JSON.stringify(Object.keys(badgeInject?.hooks || {})))
{
  const badge = badges[0].Component
  const lit = flatten(badge({ sessionId: 'session-abc', bridgeUnread: { 'session-abc': 3 } })).join(' ')
  const dark = badge({ sessionId: 'session-abc', bridgeUnread: { 'session-xyz': 3 } })
  const idle = badge({ sessionId: 'session-abc', bridgeUnread: {} })
  ok('badge shows this session count', lit === '3', JSON.stringify(lit))
  ok('badge ignores other lanes', dark === null, JSON.stringify(dark))
  ok('badge renders nothing at zero', idle === null, JSON.stringify(idle))
  ok('badge caps the number', flatten(badge({ sessionId: 's', bridgeUnread: { s: 120 } })).join(' ') === '99+')
}

// 3. behaviour: run the real component against a snapshot with a minimal hook runner.
// The static half above only proves the registration; this proves the panel renders the
// bus answer, that a bad answer lands in the error state, and that the snapshot wins.
function makeHooks() {
  const slots = new Map()
  let index = 0
  let effects = []
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat() }),
    Fragment: 'Fragment',
    useState(init) {
      const i = index++
      if (!slots.has(i)) slots.set(i, typeof init === 'function' ? init() : init)
      return [slots.get(i), (next) => {
        slots.set(i, typeof next === 'function' ? next(slots.get(i)) : next)
      }]
    },
    useRef(init) {
      const i = index++
      if (!slots.has(i)) slots.set(i, { current: init })
      return slots.get(i)
    },
    useCallback(fn) { index++; return fn },
    useEffect(fn) { const i = index++; effects.push(fn) },
  }
  return {
    React,
    begin() { index = 0 },
    runEffects() { const list = effects; effects = []; for (const fn of list) fn() },
  }
}

function flatten(node, out = []) {
  if (node == null || node === false || node === true) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) flatten(child, out); return out }
  // Function components are rendered here too, otherwise a PeerCard/MessageRow would
  // "pass" as a missing string and the assertions below would prove nothing.
  if (typeof node.type === 'function') return flatten(node.type(node.props), out)
  if (node.children) flatten(node.children, out)
  return out
}

async function renderPanel({ fetchImpl }) {
  const hooks = makeHooks()
  let loaded = null
  const requests = []
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
    console: { warn: () => {}, log: () => {} },
    fetch: (url, init) => { requests.push({ url, init }); return fetchImpl(url, init) },
    setInterval: () => 0, clearInterval: () => {},
    setTimeout: () => 0, clearTimeout: () => {},
    AbortController: class { constructor() { this.signal = { aborted: false } } abort() { this.signal.aborted = true } },
    document: { hidden: true },
    URLSearchParams, encodeURIComponent,
    JSON, Math, Date, String, Number, Object, Array, Error,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'client.js' })
  const requireStub = (name) => {
    if (name === 'react') return hooks.React
    if (name === 'react/jsx-runtime') return { jsx: hooks.React.createElement, jsxs: hooks.React.createElement, Fragment: 'Fragment' }
    throw new Error('unexpected require: ' + name)
  }
  const mods = loaded.factory(requireStub)
  let captured = null
  mods.apply({
    slots: {
      inject: (name, factory) => factory(),
      register: (spec, Component) => {
        if (spec?.name === 'conversation.view') captured = Component
        return () => {}
      },
    },
    locale: { getLocale: () => ({ active: 'zh-CN' }), register: () => {} },
  })
  hooks.begin()
  captured({ sessionId: 'session-abc' })
  hooks.runEffects()
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0))
  hooks.begin()
  const tree = captured({ sessionId: 'session-abc' })
  return { text: flatten(tree).join(' '), requests }
}

const snapshot = {
  ok: true, seq: 7, generatedAt: new Date().toISOString(), dir: 'D:\\tmp\\state',
  peers: [{ peer: 'dsh', cursor: 7, unread: 0 }, { peer: 'codex', cursor: 5, unread: 1 }, { junk: 1 }],
  recent: [
    { seq: 7, ts: new Date().toISOString(), from: 'dsh', to: 'codex', kind: 'task', body: 'do the thing', delivery: { state: 'delivered', target: 'thread-1', expiresIn: 0 } },
    { seq: 6, ts: new Date().toISOString(), from: 'dsh', to: 'codex', kind: 'task', body: 'still in flight', delivery: { state: 'claimed', peer: 'codex', target: 'thread-1', expiresIn: 42 } },
    null,
  ],
  codex: [{ id: 'thread-1', lastUser: 'fix the bus', cwd: 'C:\\work\\proj', ageSeconds: 30, status: 'active', source: 'vscode' }, null],
  lanes: { 'codex|thread-1': 7 },
  unreadLanes: { 'session-abc': 2 },
  // Grouped by the bus from the cwds it saw. Two projects, one with mail waiting.
  projects: [
    { id: 'abc12345', cwd: 'C:\\work\\proj', sessions: 1, threads: 2, unread: 3 },
    { id: 'def67890', cwd: 'C:\\work\\other', sessions: 1, threads: 1, unread: 0 },
    { junk: true },
  ],
}
const online = await renderPanel({ fetchImpl: async (url) => {
  if (String(url).includes('/status')) return { ok: true, json: async () => snapshot }
  return { ok: true, json: async () => ({ ok: true }) }
} })
ok('renders the online state', online.text.includes('总线在线'), online.text.slice(0, 80))
ok('renders peer cursors', online.text.includes('dsh') && online.text.includes('读至 seq 7'))
ok('renders the unread pill', online.text.includes('1 未读'))
ok('renders a message body', online.text.includes('do the thing'))
// A lease and a delivery are different promises; the panel must not print one word for both.
ok('shows a delivery as 已投', online.text.includes('已投 thread-1'))
ok('shows a live claim as 在途 with its remaining lease', online.text.includes('在途 codex · 租约剩 42s'))
ok('renders a codex thread', online.text.includes('fix the bus'))
ok('renders the lane', online.text.includes('codex @ thread-1'))
ok('renders the project folder name', online.text.includes('按项目') && online.text.includes('proj'))
ok('shows a project id and its unread count', online.text.includes('#abc12345') && online.text.includes('3 未读'))
ok('hides the unread pill for a caught-up project', online.text.includes('#def67890') && !online.text.includes('0 未读'))
ok('filters malformed array members', !online.text.includes('undefined'), online.text.slice(0, 160))
ok('pings the bus on mount', online.requests.some((r) => String(r.url).includes('/panel/ping?session=session-abc')))

const failed = await renderPanel({ fetchImpl: async (url) => {
  if (String(url).includes('/status')) return { ok: true, json: async () => ({ ok: false, error: 'boom' }) }
  return { ok: true, json: async () => ({ ok: true }) }
} })
ok('shows ok:false as an error, not as online', failed.text.includes('总线未响应') && failed.text.includes('boom'))

const offline = await renderPanel({ fetchImpl: async () => { throw new Error('Failed to fetch') } })
ok('shows a transport failure', offline.text.includes('总线未响应') && offline.text.includes('Failed to fetch'))

console.log('')
console.log(pass + ' passed, ' + fail + ' failed')
process.exit(fail === 0 ? 0 : 1)
