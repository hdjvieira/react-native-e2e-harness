// The e2e dashboard's shell: plain JS modules, no build. It polls the local
// server (dashboard/server.ts), which reads the run folders, and routes by
// the address's hash to one page at a time:
//   #overview (default)  overview.js  how the app is doing, the run going on
//   #live                run.js       the run going on (Run tests, live)
//   #launch              launch.js    pick a device and tests, start or queue a run
//   #history             history.js   every past run, newest first
//   #run=<stamp>         run.js       one past run (the live one is #live)
//   #flaky               flaky.js     tests that pass and fail by turns
//   #matrix              matrix.js    spec files by device
// The shell itself keeps the top bar's status pills and the sidebar's live
// badge up to date, follows new runs, and announces the end of each run.

import * as flaky from './flaky.js'
import * as history from './history.js'
import * as launch from './launch.js'
import * as matrix from './matrix.js'
import * as overview from './overview.js'
import * as run from './run.js'
import { api, esc, load, post, RUN, save, setAppTags } from './util.js'

const PAGES = { overview, launch, history, run, flaky, matrix }

const main = document.getElementById('main')
const followBox = document.getElementById('follow')
const notifyButton = document.getElementById('notify')

/** what the shell knows, shared with the pages */
const shell = {
  /** /api/current: the run going on, else the newest ({ run, live }) */
  current: undefined,
  /** /api/status: Appium and Metro */
  status: undefined,
  /** the server answered the last look */
  online: undefined,
  /** live runs already seen, so only a new one takes the page to it */
  seenLive: undefined,
  /** the run that was live at the last look, to announce its end */
  lastLive: undefined,
}

/** the page in the address */
function route() {
  const hash = location.hash.slice(1)
  if (hash === 'live') return { page: 'run', live: true }
  if (hash.startsWith('run=')) {
    const stamp = new URLSearchParams(hash).get('run')
    // the run going on lives under Run tests, not in the history
    if (stamp && isLive(stamp)) return { page: 'run', live: true }
    if (stamp && RUN.test(stamp)) return { page: 'run', run: stamp }
    return { page: 'overview' }
  }
  // the old Tests view's address
  if (hash === 'tests') return { page: 'launch', mode: 'pick' }
  // own names only: #constructor or #toString would find Object.prototype's
  return {
    page: Object.hasOwn(PAGES, hash) && hash !== 'run' ? hash : 'overview',
  }
}

// The page is not drawn again while the mouse button is down on it (the
// click would land on a node that is gone) or while text in it is selected
let pressing = false
main.addEventListener('pointerdown', () => (pressing = true))
for (const type of ['pointerup', 'pointercancel']) {
  // after the click event has gone out
  addEventListener(type, () => setTimeout(() => (pressing = false)))
}
const selecting = () => {
  const s = getSelection()
  return !!s && !s.isCollapsed && main.contains(s.anchorNode)
}

/** the run going on, as far as the shell's last look knows */
const isLive = stamp => !!shell.current?.live && shell.current.run === stamp

const ctx = {
  main,
  shell,
  /** the dev's hand is on the page: leave its drawing alone for now */
  busy: () => pressing || selecting(),
  go: hash => {
    if (location.hash === `#${hash}`) navigate()
    else location.hash = hash
  },
  /** a look at the server now, not at the next tick */
  refreshSoon: () => schedulePage(0),
}

// --- the page --------------------------------------------------------------------

let page
let nav = 0 // bumped by every navigation: a late answer for an older page is dropped

function navigate() {
  const r = route()
  // an address of the live run (an old link, a notification) shows as #live
  if (r.live && location.hash !== '#live')
    history.replaceState(null, '', '#live')
  nav++
  page = PAGES[r.page]
  // the live run is under Run tests; a past run under Run history
  const section = r.page === 'run' ? (r.live ? 'launch' : 'history') : r.page
  for (const link of document.querySelectorAll('.nav a[data-page]')) {
    const on = link.dataset.page === section
    link.classList.toggle('active', on)
    if (on) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  }
  document.title = `${document.documentElement.dataset.title} e2e`
  scrollTo(0, 0)
  try {
    page.show(ctx, r)
  } catch (e) {
    main.innerHTML = `<p class="muted center">This page failed to draw: ${esc(e.message)}</p>`
  }
  schedulePage(0)
}

// One chain of looks at the server for the page: a look asked for while one
// is on its way waits for it, and is then made at once (never two at a time)
let timer
let busy = false
let again = false
function schedulePage(ms) {
  if (busy) {
    again = true
    return
  }
  clearTimeout(timer)
  timer = setTimeout(pollPage, ms)
}
async function pollPage() {
  clearTimeout(timer)
  busy = true
  let next = 5000
  const mine = nav
  try {
    next = (await page.refresh(ctx, () => mine === nav)) ?? 5000
  } catch (e) {
    // a page answers its own errors; this keeps the chain going regardless
    console.error(e)
  } finally {
    busy = false
    const soon = again || mine !== nav
    again = false
    schedulePage(soon ? 0 : next)
  }
}

addEventListener('hashchange', navigate)

// --- the shell: status, live badge, follow, end of a run -------------------------

const pillsEl = document.getElementById('status')
const badge = document.getElementById('live-badge')
const runLink = document.querySelector('.nav a[data-page="launch"]')
const topRun = document.getElementById('top-run')

function renderShell() {
  const s = shell.status
  const server = shell.online
    ? `<span class="spill up" title="${esc(`The dashboard server answers: port ${location.port || 80}, reading ${s?.server?.dir ?? 'this checkout'}'s out/ folder`)}"><i></i>Dashboard</span>`
    : `<span class="spill down" title="The dashboard server isn't answering: start it with npx e2e-harness dashboard"><i></i>Dashboard</span>`
  // down: a button that starts it (in a Terminal window on macOS)
  const one = (name, x, what) => {
    const key = name.toLowerCase()
    if (starting.has(key))
      return `<span class="spill starting" title="${esc(`Starting ${name}: it opens in a window of its own, and turns green once it listens`)}"><span class="spinner" aria-hidden="true"></span>${esc(name)}</span>`
    if (!x)
      return `<span class="spill unknown" title="${esc(`${name}: not checked yet (or this server is older than the page)`)}"><i></i>${esc(name)}</span>`
    if (x.up)
      return `<span class="spill up" title="${esc(`${name} is listening on port ${x.port}. ${what}`)}"><i></i>${esc(name)}</span>`
    return `<button class="spill down" data-start="${esc(key)}" title="${esc(`${name} is not listening on port ${x.port}. ${what} Click to start it in a window of its own.`)}"><i></i>${esc(name)} <span class="spill-action">Start</span></button>`
  }
  pillsEl.innerHTML =
    server +
    one(
      'Appium',
      s?.appium,
      'A run starts it when it needs it; device checks (e2e-harness device) need it up.',
    ) +
    // an app without Metro has no pill for it
    (s?.server && !s.metro
      ? ''
      : one(
          'Metro',
          s?.metro,
          'A debug build loads its JS from Metro: with Metro down, the app on the device shows a red screen.',
        ))
  const live = shell.current?.live
  const waiting = shell.current?.queued ?? 0
  // the badge: the run going on plus the runs queued behind it
  badge.hidden = !live && !waiting
  badge.textContent = `${(live ? 1 : 0) + waiting}`
  badge.title = [
    live ? `1 run going on: ${shell.current.run}` : '',
    waiting ? `${waiting} queued` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  // while a run goes on, Run tests opens it; its page has a tab to set up
  // (and queue) the next one
  runLink.href = live ? '#live' : '#launch'
  runLink.title = live
    ? `A run is going on (${shell.current.run}): watch it, or set up the next one (it waits in the queue)`
    : 'Pick a device and the tests, and start a run'
  // the top bar's button: start a run, or, while one goes on, go to it
  const html = live
    ? '<span class="spinner" aria-hidden="true"></span>Running now'
    : 'Run tests'
  if (topRun.innerHTML !== html) topRun.innerHTML = html
  topRun.href = live ? '#live' : '#launch'
  topRun.classList.toggle('live', !!live)
  topRun.title = live
    ? `A run is going on (${shell.current.run}): open it`
    : 'Pick a device and the tests, and start a run'
}

// pills being started: Appium or Metro, until the server says it listens
const starting = new Set()
pillsEl.addEventListener('click', async e => {
  const pill = e.target.closest('[data-start]')
  if (!pill) return
  const what = pill.dataset.start
  starting.add(what)
  renderShell()
  try {
    shell.status = await post('status/start', { what })
  } catch (err) {
    alert(`It did not start: ${err.message}`)
  }
  starting.delete(what)
  renderShell()
})

let statusAt = 0
async function pollShell() {
  try {
    const current = await api('current')
    // the run that was going on has ended: say so (sound, notification)
    if (shell.lastLive && (!current.live || current.run !== shell.lastLive)) {
      announceEnd(shell.lastLive)
    }
    shell.lastLive = current.live ? current.run : undefined
    // the first look only notes the run going on: opening or reloading a
    // page during a run must not take the page away at once
    if (!shell.seenLive) {
      shell.seenLive = new Set(current.live ? [current.run] : [])
    } else if (current.live && !shell.seenLive.has(current.run)) {
      shell.seenLive.add(current.run)
      // #live switches to the new run by itself
      if (followBox.checked && location.hash !== '#live') {
        location.hash = 'live'
      }
    }
    const changed =
      shell.current?.run !== current.run ||
      shell.current?.live !== current.live ||
      shell.current?.queued !== current.queued
    shell.current = current
    shell.online = true
    if (changed) {
      // a past-run address that turns out to be the live run moves to #live
      const r = route()
      if (r.live && location.hash !== '#live') navigate()
      else page?.onLive?.(ctx)
    }
  } catch {
    shell.online = false
  }
  if (Date.now() - statusAt > 10000) {
    statusAt = Date.now()
    api('status')
      .then(status => {
        shell.status = status
        setAppTags(status.tags)
        renderShell()
      })
      .catch(() => {})
  }
  renderShell()
  setTimeout(pollShell, 2000)
}

function beep() {
  try {
    const audio = new AudioContext()
    for (const [i, freq] of [880, 660, 990].entries()) {
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.frequency.value = freq
      gain.gain.value = 0.08
      osc.connect(gain).connect(audio.destination)
      osc.start(audio.currentTime + i * 0.18)
      osc.stop(audio.currentTime + i * 0.18 + 0.15)
    }
  } catch {
    // no audio until the page has been clicked once
  }
}

async function announceEnd(stamp) {
  beep()
  try {
    const d = await api(`runs/${stamp}`)
    const [, text] = run.runStatus(d)
    const c = run.counts(d)
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification(`e2e: ${text}`, {
        body: `${c.passed} passed, ${c.failed} failed${c.skipped ? `, ${c.skipped} skipped` : ''}`,
      })
      n.onclick = () => {
        focus()
        location.hash = `run=${stamp}`
      }
    }
  } catch {
    // the sound is enough
  }
}

// follow new runs: on unless switched off here (kept per browser)
followBox.checked = load('e2e-follow', true)
followBox.addEventListener('change', () =>
  save('e2e-follow', followBox.checked),
)

if ('Notification' in window && Notification.permission === 'default') {
  notifyButton.hidden = false
  notifyButton.addEventListener('click', async () => {
    await Notification.requestPermission()
    notifyButton.hidden = true
  })
}

// --- hover balloons ---------------------------------------------------------------
// Every `title` in the pages shows in a balloon of ours, not the browser's:
// the title moves to data-tip the first time the pointer reaches it, so the
// native one never shows. In the collapsed sidebar an icon's balloon leads
// with its name (data-label).

const tip = document.createElement('div')
tip.className = 'tip'
tip.setAttribute('role', 'tooltip')
document.body.append(tip)
let tipTarget
let tipTimer

/** the title moves to data-tip: the browser's own balloon then never shows */
function untitle(el) {
  if (!el.hasAttribute('title')) return
  const text = el.getAttribute('title')
  el.removeAttribute('title')
  if (text) el.dataset.tip = text
}

function tipOf(el) {
  untitle(el)
  const label =
    document.documentElement.dataset.nav === 'collapsed' &&
    el.closest('.nav') &&
    el.dataset.label
  const text = el.dataset.tip ?? ''
  if (!label && !text) return ''
  return (
    (label ? `<b>${esc(label)}</b>` : '') +
    (text && text !== label ? `<span>${esc(text)}</span>` : '')
  )
}

function showTip(el) {
  const html = tipOf(el)
  if (!html) return hideTip()
  tip.innerHTML = html
  tip.classList.add('on')
  const r = el.getBoundingClientRect()
  const t = tip.getBoundingClientRect()
  const gap = 8
  const inNav = !!el.closest('.nav')
  let left, top
  if (inNav) {
    // beside the sidebar, not over the next icon
    left = r.right + gap
    top = r.top + r.height / 2 - t.height / 2
  } else {
    left = r.left + r.width / 2 - t.width / 2
    top = r.bottom + gap
    if (top + t.height > innerHeight - 4) top = r.top - gap - t.height
  }
  left = Math.max(6, Math.min(left, innerWidth - t.width - 6))
  top = Math.max(6, top)
  tip.style.left = `${left}px`
  tip.style.top = `${top}px`
}

function hideTip() {
  clearTimeout(tipTimer)
  tipTarget = undefined
  tip.classList.remove('on')
}

const tipped = el => el?.closest?.('[title], [data-tip], .nav [data-label]')
document.addEventListener('mouseover', e => {
  const el = tipped(e.target)
  // at once, not after the pause below: the browser's balloon would beat ours
  if (el) untitle(el)
  if (el === tipTarget) return
  hideTip()
  if (!el) return
  tipTarget = el
  // a moment's pause, so sweeping across the page doesn't flash balloons
  tipTimer = setTimeout(() => tipTarget === el && showTip(el), 250)
})
document.addEventListener('focusin', e => {
  const el = tipped(e.target)
  if (!el || !e.target.matches(':focus-visible')) return
  tipTarget = el
  showTip(el)
})
document.addEventListener('focusout', hideTip)
document.addEventListener('mousedown', hideTip)
addEventListener('scroll', hideTip, true)
// a page redrawn under a still pointer takes the hovered element away
setInterval(() => tipTarget && !tipTarget.isConnected && hideTip(), 500)

// the sidebar: full, or icons only (each shows its label on hover). On a
// wide window it stays as last chosen (kept per browser); a window narrower
// than NARROW collapses it, and opening it there lays it over the page until
// a page is picked or the window changes width class
const NARROW = matchMedia('(max-width: 1100px)')
const navToggle = document.getElementById('nav-toggle')
let openWhileNarrow = false
function showNav() {
  const collapsed = NARROW.matches
    ? !openWhileNarrow
    : load('e2e-nav-collapsed', false)
  document.documentElement.dataset.nav = collapsed ? 'collapsed' : 'open'
  document.documentElement.classList.toggle(
    'nav-over',
    NARROW.matches && !collapsed,
  )
  const label = collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'
  navToggle.dataset.label = label
  navToggle.title = label
  navToggle.querySelector('span').textContent = collapsed
    ? 'Expand'
    : 'Collapse'
}
navToggle.addEventListener('click', () => {
  if (NARROW.matches) openWhileNarrow = !openWhileNarrow
  else save('e2e-nav-collapsed', !load('e2e-nav-collapsed', false))
  showNav()
})
NARROW.addEventListener('change', () => {
  openWhileNarrow = false
  showNav()
})
// a page picked from the sidebar laid over the page closes it
for (const link of document.querySelectorAll('.nav a[data-page]')) {
  link.addEventListener('click', () => {
    if (!openWhileNarrow) return
    openWhileNarrow = false
    showNav()
  })
}
showNav()

// dark unless switched to light; the choice stays with this browser
const themeButton = document.getElementById('theme')
function showTheme() {
  const light = document.documentElement.dataset.theme === 'light'
  themeButton.textContent = light ? '☾' : '☀'
  themeButton.title = light
    ? 'Switch to the dark theme'
    : 'Switch to the light theme'
}
themeButton.addEventListener('click', () => {
  const light = document.documentElement.dataset.theme !== 'light'
  if (light) document.documentElement.dataset.theme = 'light'
  else delete document.documentElement.dataset.theme
  try {
    localStorage.setItem('e2e-theme', light ? 'light' : 'dark')
  } catch {}
  showTheme()
})
showTheme()

renderShell()
pollShell()
navigate()
