// Module matrix (#matrix): spec files ("modules") by device. Each cell is
// that spec's newest run on that device: how many of its tests passed. A
// cell opens that run.

import {
  api,
  deviceName,
  esc,
  exact,
  oldServer,
  plain,
  platformName,
  when,
} from './util.js'

const view = { data: undefined, key: undefined, query: '' }

export function show(ctx) {
  view.key = undefined
  ctx.main.innerHTML = `
    <div class="page-head"><h1>Module matrix</h1></div>
    <p class="muted page-note">One row per spec file, one column per device. Each cell is that spec's newest run on that device where at least one of its tests passed or failed (a run stopped before the spec began doesn't count). Click a cell for the run.</p>
    <input id="m-q" class="search" type="search" placeholder="Search spec files" value="${esc(view.query)}" title="Type part of a spec file's path to show only the matching rows">
    <section class="card" id="m-table"><p class="muted center">Reading the runs…</p></section>`
  // filtering only redraws the table, so the field keeps its focus
  ctx.main.querySelector('#m-q').addEventListener('input', e => {
    view.query = e.target.value
    view.key = undefined
    draw(ctx)
  })
  if (view.data) draw(ctx)
}

export async function refresh(ctx, still) {
  try {
    const data = await api('matrix')
    if (!still()) return 0
    view.data = data
    draw(ctx)
    return 20000
  } catch (e) {
    if (!still()) return 0
    const el = ctx.main.querySelector('#m-table')
    if (el) el.innerHTML = oldServer(e)
    view.key = undefined
    return 10000
  }
}

function draw(ctx) {
  const el = ctx.main.querySelector('#m-table')
  if (!el || ctx.busy()) return
  const key = JSON.stringify([view.data, view.query])
  if (key === view.key) return
  view.key = key
  const { devices, cells, known } = view.data
  const q = view.query.trim().toLowerCase()
  const specs = view.data.specs.filter(
    s => !q || s.spec.toLowerCase().includes(q),
  )
  if (!devices.length) {
    el.innerHTML =
      '<p class="muted center">No run has recorded its device yet.</p>'
    return
  }
  const legend = `<div class="legend">
    <span title="Every test of the spec that ran passed (skips allowed)"><i class="sw cell-pass"></i>all passed</span>
    <span title="At least one of its tests failed"><i class="sw cell-fail"></i>some failed</span>
    <span title="The spec never ran on this device (or only skipped)"><i class="sw cell-none"></i>not run</span>
    <span class="muted" title="A stopped or lost run may end before some of the spec's tests: those count in the total but never ran">numbers: passed/total in that run (tests the run never reached count in the total) · hover a cell for its date and failures</span>
  </div>`
  el.innerHTML = `${legend}<div class="table-wrap"><table class="table matrix stack">
    <thead><tr>
      <th title="The spec file, under the e2e folder, and how many tests it has now">Spec file</th>
      ${devices
        .map(
          d =>
            `<th class="center-cell" title="${esc(`${d.id} · ${platformName(d.platform)}`)}">${esc(deviceName(d.id, known))}<div class="muted small">${esc(platformName(d.platform))}</div></th>`,
        )
        .join('')}
    </tr></thead>
    <tbody>${
      specs.length
        ? ''
        : `<tr><td colspan="${devices.length + 1}" class="muted">No spec file matches "${esc(view.query)}".</td></tr>`
    }${specs
      .map(
        s => `<tr>
        <td class="lead"><code>${esc(s.spec.replace(/^specs\//, ''))}</code><div class="muted small">${s.gone ? '<span title="No longer in the specs: renamed or removed">gone</span>' : `${s.tests} test${s.tests === 1 ? '' : 's'}`}</div></td>
        ${devices.map(d => cell(cells[s.spec]?.[d.id], s.spec, d, known)).join('')}
      </tr>`,
      )
      .join('')}</tbody>
  </table></div>`
  for (const td of el.querySelectorAll('[data-run]')) {
    td.addEventListener('click', () => ctx.go(`run=${td.dataset.run}`))
  }
}

function cell(c, spec, device, known) {
  if (!c)
    return `<td class="center-cell" data-label="${esc(deviceName(device.id, known))}"><span class="mcell none" title="${esc(`${spec} has not run on ${deviceName(device.id, known)}`)}">–</span></td>`
  const title = [
    `${spec} on ${deviceName(device.id, known)}`,
    `run ${c.run}, ${exact(c.started)}`,
    `${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped${c.open ? `, ${c.open} not run (the run ended first)` : ''}, of ${c.total}`,
    ...c.failures.map(
      f =>
        `✗ ${plain(f.key.split(' > ').slice(1).join(' > ') || f.key)}${f.error ? `: ${f.error}` : ''}`,
    ),
  ].join('\n')
  return `<td class="center-cell clickable" data-run="${esc(c.run)}" data-label="${esc(deviceName(device.id, known))}">
    <span class="mcell ${c.failed ? 'fail' : 'pass'}" title="${esc(title)}">${c.passed}/${c.total}</span>
    <div class="muted small">${when(c.started)}</div>
  </td>`
}
