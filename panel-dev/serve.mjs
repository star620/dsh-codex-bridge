// Dev-only HTTP server for the bridge panel.
//
// The real host is the DSH window (file:// + IPC) and cannot be driven from the
// outside, so this serves the *unmodified* lib/client.js plus a stand-in for the
// DSH shell (see index.html) and proxies /status + /panel/ping to the bus.
// Never installed into DSH; run it by hand: node panel-dev/serve.mjs
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLIENT = path.join(HERE, '..', 'dsh-bundle', 'lib', 'client.js')
const INDEX = path.join(HERE, 'index.html')
const PORT = Number(process.env.PANEL_DEV_PORT || 8790)
const BUS = new URL(process.env.BRIDGE_URL || 'http://127.0.0.1:8787')

function proxy(req, res, target) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const upstream = new URL(target, BUS)
  upstream.search = url.search
  const request = http.request(upstream, { method: req.method, headers: { host: BUS.host } }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers)
    up.pipe(res)
  })
  request.on('error', (err) => {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('bus unreachable: ' + err.message)
  })
  req.pipe(request)
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  const send = (file, type) => {
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return }
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
      res.end(buf)
    })
  }
  if (url.pathname === '/' || url.pathname === '/index.html') return send(INDEX, 'text/html; charset=utf-8')
  if (url.pathname === '/lib/client.js') return send(CLIENT, 'application/javascript; charset=utf-8')
  if (url.pathname === '/status' || url.pathname === '/panel/ping') return proxy(req, res, url.pathname)
  res.writeHead(404)
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[panel-dev] http://127.0.0.1:' + PORT + '/  (bus ' + BUS.href + ')')
})
