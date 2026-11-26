import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { adbCli } from './adb-session.js'

// A slow or dead network for chosen hosts on the connected Android device, no
// root needed: a tiny HTTPS (CONNECT) proxy on this machine, reached through
// `adb reverse`, holds every tunnel to a matching host for --delay ms before
// opening it (or refuses it with --fail). Everything else passes straight
// through, Metro's plain-HTTP traffic included.
//
// It points the device's GLOBAL proxy at itself while running and restores
// it on exit or Ctrl+C. Killed hard, it leaves the device with a dead proxy
// and no internet until `--restore` runs. The delay is per connection: it
// models latency to a host, not low bandwidth, and only for HTTPS.
export const SLOW_NET_USAGE = `e2e-harness slow-net --hosts <regex> [options]
  --delay <ms>    hold each matching connection this long (default 0)
  --fail          refuse matching connections instead
  --for <ms>      stop by itself after this long (use it in the background)
  --port <n>      the proxy's port (default 8899)
  --restore       put the device's proxy back (after a crash)`

export function slowNet(argv: string[]) {
  const opt = (name: string) => {
    const i = argv.indexOf(`--${name}`)
    return i > -1 ? argv[i + 1] : undefined
  }
  const port = Number(opt('port') ?? 8899)

  const restore = () => {
    for (const key of [
      'global_http_proxy_host',
      'global_http_proxy_port',
      'global_http_proxy_exclusion_list',
    ]) {
      try {
        adbCli(['shell', 'settings', 'delete', 'global', key])
      } catch {
        // not set
      }
    }
    try {
      adbCli(['shell', 'settings', 'put', 'global', 'http_proxy', ':0'])
      adbCli(['reverse', '--remove', `tcp:${port}`])
    } catch {
      // already gone
    }
    console.log('device proxy restored (none)')
  }

  if (argv.includes('--restore')) {
    restore()
    return
  }
  const hostsSource = opt('hosts')
  if (!hostsSource) {
    console.log(SLOW_NET_USAGE)
    process.exitCode = 2
    return
  }
  const hosts = new RegExp(hostsSource, 'i')
  const delay = Number(opt('delay') ?? 0)
  const fail = argv.includes('--fail')

  // Plain HTTP and websockets go through untouched. Android does not honour
  // the exclusion list for a debug app's Metro traffic, so localhost (bundle,
  // HMR) comes through here too, and "localhost" here is where Metro is.
  const target = (raw = '') => {
    try {
      const u = new URL(raw)
      return {
        host: u.hostname,
        port: Number(u.port || 80),
        path: u.pathname + u.search,
      }
    } catch {
      return null
    }
  }
  const server = createServer((req, res) => {
    const t = target(req.url)
    if (!t) return res.writeHead(400).end('slow-net: expected a proxy request')
    const up = request(
      { ...t, method: req.method, headers: req.headers },
      r => {
        res.writeHead(r.statusCode ?? 502, r.headers)
        r.pipe(res)
      },
    )
    up.on('error', () => res.writeHead(502).end())
    req.pipe(up)
  })
  server.on('upgrade', (req, client, head) => {
    const t = target(req.url)
    if (!t) return client.destroy()
    const up = connect(t.port, t.host, () => {
      let raw = `${req.method} ${t.path} HTTP/${req.httpVersion}\r\n`
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`
      up.write(raw + '\r\n')
      if (head?.length) up.write(head)
      up.pipe(client)
      client.pipe(up)
    })
    up.on('error', () => client.destroy())
    client.on('error', () => up.destroy())
  })
  server.on('connect', (req, client, head) => {
    const [host, hostPort = '443'] = (req.url ?? '').split(':')
    const hit = hosts.test(host)
    const t0 = Date.now()
    const open = () => {
      if (hit && fail) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        console.log(`refused  ${host}`)
        return
      }
      const upstream = connect(Number(hostPort), host, () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        if (head?.length) upstream.write(head)
        upstream.pipe(client)
        client.pipe(upstream)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
      // epoch ms, to line up with the device commands' timestamps
      if (hit)
        console.log(
          `held     ${host} ${Date.now() - t0}ms (opened at ${Date.now()})`,
        )
    }
    if (hit && delay) setTimeout(open, delay)
    else open()
  })

  server.listen(port, '127.0.0.1', () => {
    adbCli(['reverse', `tcp:${port}`, `tcp:${port}`])
    const put = (key: string, value: string) =>
      adbCli(['shell', 'settings', 'put', 'global', key, value])
    put('global_http_proxy_host', '127.0.0.1')
    put('global_http_proxy_port', String(port))
    put('global_http_proxy_exclusion_list', 'localhost,127.0.0.1')
    put('http_proxy', `127.0.0.1:${port}`)
    console.log(
      `slow-net on :${port}: ${fail ? 'refusing' : `holding ${delay}ms`} hosts matching ${hosts}`,
    )
  })

  let done = false
  const shutdown = () => {
    if (done) return
    done = true
    restore()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('exit', () => {
    if (!done) restore()
  })
  // killing a process from outside (Windows has no SIGINT for that) skips the
  // restore: --for stops it from inside
  const stopAfter = opt('for')
  if (stopAfter) setTimeout(shutdown, Number(stopAfter))
}
