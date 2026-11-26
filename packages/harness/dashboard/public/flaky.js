// Flaky tests (#flaky): the tests that can't be trusted either way. Their
// recent runs mix passes and failures, or they passed only on their retry.
// A test that fails every time is broken, not flaky, and isn't listed here.

import {
  api,
  duration,
  esc,
  oldServer,
  plain,
  strip,
  stripLegend,
  stampTime,
  tagChip,
  tagsOf,
  when,
} from './util.js'

const view = { data: undefined, key: undefined }

export function show(ctx) {
  view.key = undefined
  ctx.main.innerHTML = `
    <div class="page-head"><h1>Flaky tests</h1></div>
    <p class="muted page-note" id="f-note"></p>
    <section class="card" id="f-table"><p class="muted center">Reading the history…</p></section>`
  if (view.data) draw(ctx)
}

export async function refresh(ctx, still) {
  try {
    const data = await api('flaky')
    if (!still()) return 0
    view.data = data
    draw(ctx)
    return 30000
  } catch (e) {
    if (!still()) return 0
    const el = ctx.main.querySelector('#f-table')
    if (el) el.innerHTML = oldServer(e)
    view.key = undefined
    return 10000
  }
}

function draw(ctx) {
  const el = ctx.main.querySelector('#f-table')
  const note = ctx.main.querySelector('#f-note')
  if (!el || ctx.busy()) return
  const key = JSON.stringify(view.data)
  if (key === view.key) return
  view.key = key
  const { tests, window } = view.data
  note.innerHTML = `A test is flaky when, in its last ${window} runs (skips left out), it both passed and failed, or it passed only on its retry. Most often unstable first. A test that failed every time is broken rather than flaky: find it on Run history or the Module matrix.`
  if (!tests.length) {
    el.innerHTML = `<p class="muted center">No flaky test: in their last ${window} runs, every test either passed each time on its first attempt or failed each time.</p>`
    return
  }
  el.innerHTML = `${stripLegend({ skips: false })}
  <div class="table-wrap"><table class="table stack">
    <thead><tr>
      <th title="The test (its describe above it) and its spec file">Test</th>
      <th title="${esc(`In how many of its last runs (up to ${window}, skips left out) it failed or needed its retry to pass`)}">Flaky in</th>
      <th title="${esc(`The same runs 'Flaky in' counts (up to ${window}, skips left out), one square each: oldest left, newest right`)}">Last runs</th>
      <th title="The newest run where it failed or passed only on its retry, and the error">Last failure</th>
    </tr></thead>
    <tbody>${tests.map(row).join('')}</tbody>
  </table></div>`
}

function row(t) {
  const [describe, ...rest] = t.key.split(' > ')
  const title = rest.join(' > ') || describe
  const tags = tagsOf(t.key)
  const hook = /^(before|after)(Each)?$/.test(title)
  const f = t.lastFailure
  const why = `${t.failed} failed${t.retried ? `, ${t.retried} passed only on retry` : ''}, of its last ${t.of} runs`
  return `<tr>
    <td class="lead"><div class="muted small">${esc(plain(describe))}</div><b>${esc(plain(title))}</b>${hook ? ' <span class="tag" title="A before/after hook, not a test: its failure ended the tests under it">hook</span>' : ''}${tags.map(tagChip).join('')}
      <div class="muted small">${t.spec ? `<code title="The spec file">${esc(t.spec)}</code>` : '<span title="Its describe is no longer in the specs (renamed or removed)">spec unknown</span>'}</div></td>
    <td data-label="Flaky in"><span class="flaky-n" title="${esc(why)}"><b>${t.unstable}</b> of ${t.of}</span><div class="muted small">${esc(why)}</div></td>
    <td data-label="Last runs">${strip(t.recent, duration)}</td>
    <td class="wide" data-label="Last failure">${
      f
        ? `<a href="#run=${esc(f.run)}" title="${esc(`Open run ${f.run}`)}">${when(stampTime(f.run))}</a>${f.retried ? ' <span class="tag flaky" title="It failed first, then passed on its retry">passed on retry</span>' : ''}
        ${f.error ? `<div class="pick-error" title="${esc(f.error)}">${esc(f.error)}</div>` : ''}`
        : '–'
    }</td>
  </tr>`
}
