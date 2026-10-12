/*
 * Dashboard of @viveka10/cap-ai-token-optimizer. Plain browser script, no dependencies:
 * reads the admin service (data-service on <body>) and draws the charts as SVG.
 * All values from the service are inserted with textContent, never as HTML.
 */
'use strict'
;(function () {
  const SVC = document.body.dataset.service
  const HAS_LOG = document.body.dataset.usageLog === 'true'
  const HOUR = 3600 * 1000
  const DAY = 24 * HOUR
  const SLOTS = 8
  const RANGES = { '24h': { hours: 24, interval: 'hour' }, '7d': { days: 7, interval: 'day' }, '30d': { days: 30, interval: 'day' }, '90d': { days: 90, interval: 'day' } }
  const NS = 'http://www.w3.org/2000/svg'

  const $ = (id) => document.getElementById(id)
  const store = {
    get (k, d) { try { const v = localStorage.getItem('cap-ai-token-optimizer.' + k); return v == null ? d : JSON.parse(v) } catch { return d } },
    set (k, v) { try { localStorage.setItem('cap-ai-token-optimizer.' + k, JSON.stringify(v)) } catch { /* not available */ } }
  }
  const state = {
    range: RANGES[store.get('range')] ? store.get('range') : '7d',
    groupBy: ['model', 'useCase', 'cdsService'].includes(store.get('groupBy')) ? store.get('groupBy') : 'model',
    views: {}, // card id -> 'table' when the table view is shown
    log: null,
    instance: null
  }

  // ---------- formatting ----------
  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
  const cf = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
  const pf = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 1 })
  const int = (n) => n == null ? '–' : nf.format(n)
  const compact = (n) => n == null ? '–' : Math.abs(n) < 1000 ? nf.format(n) : cf.format(n)
  const pct = (a, b) => b ? pf.format(a / b) : '–'
  const cost = (n) => n == null ? '–' : new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(n) < 1 ? 4 : 2 }).format(n)
  const ms = (n) => n == null ? '–' : n < 1000 ? `${nf.format(n)} ms` : `${(n / 1000).toFixed(1)} s`
  const dayFmt = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' })
  const dayLong = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' })
  const timeFmt = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
  const stampFmt = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
  const keyName = (k) => k == null || k === '' ? '(none)' : String(k)

  // ---------- DOM helpers ----------
  function h (tag, attrs, ...children) {
    const e = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue
      if (k === 'class') e.className = v
      else if (k === 'style') Object.assign(e.style, v)
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
      else e.setAttribute(k, v === true ? '' : v)
    }
    for (const c of children.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)))
    return e
  }
  function s (tag, attrs) {
    const e = document.createElementNS(NS, tag)
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(k, v)
    return e
  }

  // ---------- data ----------
  async function get (path) {
    const res = await fetch(SVC + path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    if (!res.ok) {
      const err = new Error(res.status === 401 ? 'Sign-in required.' : res.status === 403 ? 'You are not authorized to read the token optimizer statistics.' : `The admin service answered ${res.status}.`)
      err.status = res.status
      throw err
    }
    const json = await res.json()
    return Array.isArray(json.value) ? json.value : json
  }
  const iso = (d) => d.toISOString().replace('.000Z', 'Z')
  const lit = (v) => v == null ? 'null' : `'${String(v).replace(/'/g, "''")}'`
  const usage = (w, interval, groupBy) => get(`/usage(from=${iso(w.from)},to=${iso(w.to)},interval=${lit(interval)},groupBy=${lit(groupBy)})`)

  /** Time window and its buckets for a range preset; buckets are UTC hours or days. */
  function windowFor (range) {
    const r = RANGES[range]
    const now = Date.now()
    const unit = r.interval === 'hour' ? HOUR : DAY
    const to = new Date(Math.floor(now / unit) * unit + unit)
    const from = new Date(to - (r.hours ? r.hours * HOUR : r.days * DAY))
    const buckets = []
    for (let t = +from; t < +to; t += unit) buckets.push(iso(new Date(t)))
    return { from, to, interval: r.interval, buckets }
  }

  // Colors follow the entity: a model keeps its slot while it is shown, whatever its rank.
  const colorMaps = store.get('colors', {})
  function palette (dim, keys) {
    const map = colorMaps[dim] = colorMaps[dim] || {}
    const shown = keys.length > SLOTS ? keys.slice(0, SLOTS - 1) : keys.slice()
    const taken = new Set(shown.map(k => map[k]).filter(v => v != null))
    for (const k of shown) {
      if (map[k] != null) continue
      const all = new Set(Object.values(map))
      let slot = [...Array(SLOTS).keys()].find(i => !taken.has(i) && !all.has(i))
      if (slot == null) {
        slot = [...Array(SLOTS).keys()].find(i => !taken.has(i))
        for (const [old, v] of Object.entries(map)) if (v === slot) delete map[old]
      }
      map[k] = slot
      taken.add(slot)
    }
    store.set('colors', colorMaps)
    return { shown, rest: keys.slice(shown.length), color: (k) => `var(--s${map[k] + 1})` }
  }

  // ---------- tooltip ----------
  const tip = $('tip')
  function showTip (target, evt, head, rows) {
    tip.replaceChildren(h('div', { class: 't-head' }, head), ...rows.map(r => h('div', { class: 't-row' },
      h('span', { class: 't-key', style: { background: r.color || 'transparent' } }),
      h('span', { class: 't-val' }, r.value),
      h('span', { class: 't-name' }, r.name)
    )))
    tip.hidden = false
    const box = tip.getBoundingClientRect()
    let x, y
    if (evt && evt.clientX != null) { x = evt.clientX + 14; y = evt.clientY + 14 } else {
      const r = target.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top - box.height - 8
    }
    if (x + box.width > innerWidth - 8) x = Math.max(8, (evt && evt.clientX != null ? evt.clientX - 14 : x) - box.width)
    if (y + box.height > innerHeight - 8) y = Math.max(8, innerHeight - box.height - 8)
    if (y < 8) y = 8
    tip.style.left = x + 'px'
    tip.style.top = y + 'px'
  }
  const hideTip = () => { tip.hidden = true }
  function hover (el, content) {
    el.addEventListener('pointermove', (e) => { const c = content(); showTip(el, e, c.head, c.rows) })
    el.addEventListener('focus', () => { const c = content(); showTip(el, null, c.head, c.rows) })
    el.addEventListener('pointerleave', hideTip)
    el.addEventListener('blur', hideTip)
  }

  // ---------- cards ----------
  const renders = {}
  /** Fills card `id` with a header and the chart or table body; `table` enables the toggle. */
  function card (id, title, note, body, table) {
    const el = $(id)
    if (!el) return
    const view = table && state.views[id] === 'table' ? 'table' : 'chart'
    const toggle = table ? h('button', {
      type: 'button',
      class: 'toggle',
      'aria-pressed': view === 'table' ? 'true' : 'false',
      onclick: () => { state.views[id] = view === 'table' ? 'chart' : 'table'; renders[id]() }
    }, view === 'table' ? 'Show chart' : 'Show table') : null
    el.replaceChildren(h('div', { class: 'card-head' }, h('div', {}, h('h3', {}, title), note ? h('p', { class: 'note' }, note) : null), toggle))
    el.append(view === 'table' ? table() : body())
  }
  function define (id, render) { renders[id] = render; render() }
  const empty = (text) => h('p', { class: 'empty' }, text)

  function table (cols, rows) {
    return h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, cols.map(c => h('th', { class: c.num ? 'num' : null, scope: 'col' }, c.label)))),
      h('tbody', {}, rows.map(r => h('tr', {}, cols.map(c => {
        const v = c.get(r)
        return h('td', { class: c.num ? 'num' : c.wrap ? 'wrap' : null }, v instanceof Node ? v : c.fmt ? c.fmt(v) : (v ?? '–'))
      }))))
    ))
  }
  const legend = (series) => series.length < 2 ? null : h('ul', { class: 'legend' }, series.map(x => h('li', {}, h('span', { class: 'swatch', style: { background: x.color } }), x.name)))

  // ---------- charts ----------
  function niceStep (max, count) {
    const raw = max / count
    const p = Math.pow(10, Math.floor(Math.log10(raw)))
    const f = raw / p
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
  }
  function topRounded (x, y, w, hgt, r) {
    r = Math.min(r, hgt, w / 2)
    return `M${x},${y + hgt}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + hgt}Z`
  }

  /**
   * Stacked columns over time. series: [{ name, color, values[] }] in stacking order (bottom first).
   * opts: { buckets, interval, fmt, tickFmt }
   */
  function columns (series, opts) {
    const wrap = h('div', { class: 'chart' })
    const { buckets, interval, fmt, tickFmt = fmt } = opts
    const totals = buckets.map((_, i) => series.reduce((a, x) => a + (x.values[i] || 0), 0))
    const max = Math.max(0, ...totals)
    if (!max) return empty('No calls in this range.')
    requestAnimationFrame(() => draw())
    return h('div', {}, legend(series), wrap)

    function draw () {
      const W = Math.max(280, wrap.clientWidth)
      const H = 220
      const step = niceStep(max, 4)
      const yMax = Math.ceil(max / step) * step
      const ticks = []
      for (let v = 0; v <= yMax + step / 2; v += step) ticks.push(v)
      const left = Math.max(...ticks.map(t => tickFmt(t).length)) * 6.5 + 10
      const top = 16
      const plotW = W - left - 4
      const plotH = H - top
      const xBand = plotW / buckets.length
      const barW = Math.max(1, Math.min(24, xBand - 2, xBand * 0.72))
      const y = (v) => top + plotH - (v / yMax) * plotH
      const svg = s('svg', { viewBox: `0 0 ${W} ${H + 26}`, height: H + 26, role: 'img', 'aria-label': `Column chart, ${buckets.length} ${interval === 'hour' ? 'hours' : 'days'}. Use "Show table" for the values.` })
      for (const t of ticks) {
        svg.append(s('line', { class: t === 0 ? 'baseline' : 'gridline', x1: left, x2: W - 4, y1: Math.round(y(t)) + 0.5, y2: Math.round(y(t)) + 0.5 }))
        const label = s('text', { x: left - 8, y: y(t) + 4, 'text-anchor': 'end' })
        label.textContent = tickFmt(t)
        svg.append(label)
      }
      // x labels: as many as fit without colliding
      const every = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 64))))
      buckets.forEach((b, i) => {
        if ((buckets.length - 1 - i) % every) return
        const t = s('text', { x: left + xBand * (i + 0.5), y: H + 18, 'text-anchor': 'middle' })
        t.textContent = interval === 'hour' ? timeFmt.format(new Date(b)) : dayFmt.format(new Date(b))
        svg.append(t)
      })
      // stacked segments, 2px surface gap between them, rounded data end on the top segment
      let maxIdx = 0
      buckets.forEach((b, i) => {
        if (totals[i] > totals[maxIdx]) maxIdx = i
        const x = left + xBand * i + (xBand - barW) / 2
        let base = top + plotH
        const segs = series.map(x => x.values[i] || 0)
        const lastIdx = segs.reduce((a, v, k) => v > 0 ? k : a, -1)
        segs.forEach((v, k) => {
          if (v <= 0) return
          const hgt = (v / yMax) * plotH
          const gap = base < top + plotH ? 2 : 0
          const hh = Math.max(1, hgt - gap)
          const yy = base - gap - hh
          svg.append(k === lastIdx ? s('path', { d: topRounded(x, yy, barW, hh, 4), fill: series[k].color }) : s('rect', { x, y: yy, width: barW, height: hh, fill: series[k].color }))
          base -= hgt
        })
      })
      // one direct label: the highest column
      const peak = s('text', { class: 'bar-label', x: left + xBand * (maxIdx + 0.5), y: y(totals[maxIdx]) - 6, 'text-anchor': 'middle' })
      peak.textContent = fmt(totals[maxIdx])
      svg.append(peak)
      // hit targets: the whole band, with every series in the tooltip
      buckets.forEach((b, i) => {
        const hit = s('rect', { class: 'hit', x: left + xBand * i, y: top, width: xBand, height: plotH, tabindex: 0, 'aria-label': `${bucketLabel(b, interval)}: ${fmt(totals[i])}` })
        hover(hit, () => ({
          head: bucketLabel(b, interval),
          rows: [
            ...series.slice().reverse().map(x => ({ color: x.color, value: fmt(x.values[i] || 0), name: x.name })),
            ...(series.length > 1 ? [{ value: fmt(totals[i]), name: 'Total' }] : [])
          ]
        }))
        svg.append(hit)
      })
      wrap.replaceChildren(svg)
    }
  }
  const bucketLabel = (b, interval) => {
    const d = new Date(b)
    return interval === 'hour' ? `${dayFmt.format(d)}, ${timeFmt.format(d)}–${timeFmt.format(new Date(+d + HOUR))} UTC` : `${dayLong.format(d)} (UTC)`
  }
  function seriesTable (series, opts) {
    const cols = [{ label: opts.interval === 'hour' ? 'Hour (UTC)' : 'Day (UTC)', get: r => r.label }]
      .concat(series.map((x, k) => ({ label: x.name, num: true, get: r => r.values[k], fmt: opts.fmt })))
    if (series.length > 1) cols.push({ label: 'Total', num: true, get: r => r.total, fmt: opts.fmt })
    return table(cols, opts.buckets.map((b, i) => {
      const values = series.map(x => x.values[i] || 0)
      const d = new Date(b)
      return { label: opts.interval === 'hour' ? `${dayFmt.format(d)} ${timeFmt.format(d)}` : dayFmt.format(d), values, total: values.reduce((a, v) => a + v, 0) }
    }))
  }

  /** Horizontal bars of one measure, one color. rows: [{ name, value, details: [[label, text]] }] */
  function bars (rows, fmt, color) {
    if (!rows.length) return empty('Nothing recorded.')
    const max = Math.max(...rows.map(r => r.value), 0) || 1
    return h('div', { class: 'bars' }, rows.map(r => {
      const row = h('div', { class: 'bar-row', tabindex: 0, 'aria-label': `${r.name}: ${fmt(r.value)}` },
        h('span', { class: 'name' }, r.name),
        h('span', { class: 'val' }, fmt(r.value)),
        h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(r.value / max) * 100}%`, background: color || 'var(--s1)' } })))
      if (r.details) hover(row, () => ({ head: r.name, rows: r.details.map(([name, value]) => ({ name, value })) }))
      return row
    }))
  }
  const barTable = (rows, label, valueLabel, fmt) => table([
    { label, get: r => r.name },
    { label: valueLabel, num: true, get: r => r.value, fmt },
    ...((rows[0]?.details || []).map(([name], k) => ({ label: name, num: true, get: r => r.details[k][1] })))
  ], rows)

  // ---------- usage log section ----------
  async function loadLog () {
    const w = windowFor(state.range)
    const [split, overall, byModel, byUseCase, byError, totals, largest, failed] = await Promise.all([
      usage(w, w.interval, state.groupBy),
      usage(w, w.interval, null),
      usage(w, 'none', 'model'),
      usage(w, 'none', 'useCase'),
      usage(w, 'none', 'errorCategory'),
      usage(w, 'none', null),
      get(`/UsageLog?$select=timestamp,useCase,model,status,totalTokens,costEstimate,latencyMs,cacheHit&$filter=timestamp ge ${iso(w.from)} and timestamp lt ${iso(w.to)}&$orderby=totalTokens desc&$top=10`),
      get(`/UsageLog?$select=timestamp,useCase,model,errorCategory,errorHttpStatus,errorCode,errorMessage&$filter=status eq 'error' and timestamp ge ${iso(w.from)} and timestamp lt ${iso(w.to)}&$orderby=timestamp desc&$top=10`)
    ])
    state.log = { w, groupBy: state.groupBy, split, overall, byModel, byUseCase, byError, totals: totals[0] || null, largest, failed }
    renderLog()
  }

  const breakdown = (rows) => rows.slice().sort((a, b) => b.totalTokens - a.totalTokens || b.calls - a.calls).map(r => ({
    name: keyName(r.name),
    value: r.totalTokens,
    details: [['Calls', int(r.calls)], ['Failed', int(r.errors)], ['Cost', cost(r.costEstimate)], ['Saved', compact(r.savedTokensEstimate)], ['Avg latency', ms(r.latencyAvg)]]
  }))

  function renderLog () {
    const L = state.log
    const t = L.totals || { calls: 0, errors: 0, cacheHits: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, savedTokensEstimate: 0, costEstimate: null }
    const tile = (label, value, detail, cls) => h('div', { class: 'tile' + (cls ? ' ' + cls : '') }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), detail ? h('div', { class: 'detail' + (detail.warn ? ' warn' : '') }, detail.text) : null)
    $('tiles').replaceChildren(
      tile('Total tokens', compact(t.totalTokens), { text: `${compact(t.promptTokens)} prompt · ${compact(t.completionTokens)} completion` }, 'hero'),
      tile('Cost (estimate)', cost(t.costEstimate), { text: t.costEstimate == null ? 'No prices configured' : 'In the currency of pricing' }),
      tile('Calls', int(t.calls), { text: `${int(t.errors)} failed (${pct(t.errors, t.calls)})`, warn: t.errors > 0 }),
      tile('Tokens saved (estimate)', compact(t.savedTokensEstimate), { text: `${pct(t.savedTokensEstimate, t.promptTokens + t.savedTokensEstimate)} of prompt tokens` }),
      tile('Cache hits', int(t.cacheHits), { text: `${pct(t.cacheHits, t.calls)} of calls` }),
      tile('Average latency', ms(t.latencyAvg), { text: `max ${ms(t.latencyMax)}` })
    )

    const { w } = L
    const idx = new Map(w.buckets.map((b, i) => [b, i]))
    const valuesOf = (rows, pick) => { const v = new Array(w.buckets.length).fill(0); for (const r of rows) { const i = idx.get(r.bucket); if (i != null) v[i] += pick(r) || 0 } return v }
    const opts = { buckets: w.buckets, interval: w.interval, fmt: compact }

    // tokens over time, split by the selected dimension (largest at the bottom, the rest as "Other")
    const dimLabel = { model: 'model', useCase: 'use case', cdsService: 'CDS service' }[L.groupBy]
    const byKey = new Map()
    for (const r of L.split) byKey.set(keyName(r.name), (byKey.get(keyName(r.name)) || 0) + r.totalTokens)
    const keys = [...byKey.keys()].sort((a, b) => byKey.get(b) - byKey.get(a))
    const pal = palette(L.groupBy, keys)
    const restSet = new Set(pal.rest)
    const tokenSeries = pal.shown.map(k => ({ name: k, color: pal.color(k), values: valuesOf(L.split.filter(r => keyName(r.name) === k), r => r.totalTokens) }))
    if (pal.rest.length) tokenSeries.push({ name: `Other (${pal.rest.length})`, color: 'var(--other)', values: valuesOf(L.split.filter(r => restSet.has(keyName(r.name))), r => r.totalTokens) })
    define('c-tokens', () => card('c-tokens', 'Tokens over time', `Total tokens per ${w.interval} by ${dimLabel}`, () => columns(tokenSeries, opts), () => seriesTable(tokenSeries, opts)))

    const callSeries = [
      { name: 'Successful', color: 'var(--s1)', values: valuesOf(L.overall, r => r.calls - r.errors) },
      { name: 'Failed', color: 'var(--critical)', values: valuesOf(L.overall, r => r.errors) }
    ]
    define('c-calls', () => card('c-calls', 'Calls', `AI calls per ${w.interval}`, () => columns(callSeries, { ...opts, fmt: int, tickFmt: compact }), () => seriesTable(callSeries, { ...opts, fmt: int })))

    const hasCost = L.overall.some(r => r.costEstimate != null)
    const costSeries = [{ name: 'Cost', color: 'var(--s1)', values: valuesOf(L.overall, r => r.costEstimate) }]
    define('c-cost', () => card('c-cost', 'Cost (estimate)', `Per ${w.interval}, from the configured prices per 1k tokens`,
      () => hasCost ? columns(costSeries, { ...opts, fmt: cost }) : empty('No prices configured. Set pricing per model to estimate cost.'),
      hasCost ? () => seriesTable(costSeries, { ...opts, fmt: cost }) : null))

    const models = breakdown(L.byModel)
    define('c-model', () => card('c-model', 'Tokens by model', null, () => bars(models, compact), () => barTable(models, 'Model', 'Tokens', compact)))
    const useCases = breakdown(L.byUseCase)
    define('c-usecase', () => card('c-usecase', 'Tokens by use case', null, () => bars(useCases, compact), () => barTable(useCases, 'Use case', 'Tokens', compact)))
    const errors = L.byError.filter(r => r.name != null && r.errors > 0).sort((a, b) => b.errors - a.errors).map(r => ({ name: r.name, value: r.errors }))
    define('c-errors', () => card('c-errors', 'Failures by category', null,
      () => errors.length ? bars(errors, int, 'var(--critical)') : empty('No failed calls in this range.'),
      errors.length ? () => barTable(errors, 'Category', 'Failed calls', int) : null))

    const status = (r) => h('span', { class: 'pill' + (r.status === 'error' ? ' error' : '') }, r.status === 'error' ? 'Failed' : r.cacheHit ? 'Cache hit' : 'Success')
    const when = (r) => stampFmt.format(new Date(r.timestamp))
    define('c-largest', () => card('c-largest', 'Largest calls', 'The 10 calls with the most tokens in this range', () => L.largest.length
      ? table([
        { label: 'Time (UTC)', get: when },
        { label: 'Use case', get: r => keyName(r.useCase) },
        { label: 'Model', get: r => keyName(r.model) },
        { label: 'Tokens', num: true, get: r => r.totalTokens, fmt: int },
        { label: 'Cost', num: true, get: r => r.costEstimate, fmt: (v) => cost(v == null ? null : Number(v)) },
        { label: 'Latency', num: true, get: r => r.latencyMs, fmt: ms },
        { label: 'Status', get: status }
      ], L.largest)
      : empty('No calls in this range.')))
    define('c-failed', () => card('c-failed', 'Latest failures', 'The 10 most recent failed calls in this range', () => L.failed.length
      ? table([
        { label: 'Time (UTC)', get: when },
        { label: 'Use case', get: r => keyName(r.useCase) },
        { label: 'Model', get: r => keyName(r.model) },
        { label: 'Category', get: r => r.errorCategory },
        { label: 'HTTP', num: true, get: r => r.errorHttpStatus },
        { label: 'Code', get: r => r.errorCode },
        { label: 'Message', wrap: true, get: r => r.errorMessage }
      ], L.failed)
      : empty('No failed calls in this range.')))
  }

  // ---------- instance section (in-memory stats of the answering app instance) ----------
  async function loadInstance () {
    const [summary, steps, prefix, exporters, models, useCases] = await Promise.all([
      get('/summary()'),
      get('/StepSavings'),
      get('/PromptPrefixChanges'),
      get('/Exporters'),
      HAS_LOG ? [] : get('/Models'),
      HAS_LOG ? [] : get('/UseCases')
    ])
    state.instance = { summary, steps, prefix, exporters, models, useCases }
    renderInstance()
  }

  function renderInstance () {
    const { summary: S, steps, prefix, exporters, models, useCases } = state.instance
    const tokens = (r) => r.tokens?.total ?? r.tokens_total ?? 0
    $('since').textContent = `In-memory statistics since ${stampFmt.format(new Date(S.since))} UTC · mode ${S.mode}. With several instances, each one answers for itself.`
    const tile = (label, value, detail) => h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), detail ? h('div', { class: 'detail' }, detail) : null)
    $('itiles').replaceChildren(
      tile('Calls', int(S.calls), `${int(S.errors)} failed · ${int(S.cacheHits)} cache hits`),
      tile('Total tokens', compact(tokens(S)), `${compact(S.savedTokensEstimate)} saved (estimate)`),
      tile('Latency p50', ms(S.latencyMs?.p50), `average ${ms(S.latencyMs?.avg)}`),
      tile('Latency p95', ms(S.latencyMs?.p95), `max ${ms(S.latencyMs?.max)}`)
    )

    if (!HAS_LOG) {
      const rows = (list) => list.map(r => ({ name: keyName(r.name), value: tokens(r), details: [['Calls', int(r.calls)], ['Failed', int(r.errors)], ['Cost', cost(r.costEstimate == null ? null : Number(r.costEstimate))]] })).sort((a, b) => b.value - a.value)
      const m = rows(models)
      const u = rows(useCases)
      $('c-imodel').hidden = false
      $('c-iusecase').hidden = false
      define('c-imodel', () => card('c-imodel', 'Tokens by model', null, () => bars(m, compact), () => barTable(m, 'Model', 'Tokens', compact)))
      define('c-iusecase', () => card('c-iusecase', 'Tokens by use case', null, () => bars(u, compact), () => barTable(u, 'Use case', 'Tokens', compact)))
    }

    const st = steps.map(r => ({ name: r.step, value: Number(r.tokens) || 0 })).filter(r => r.value > 0).sort((a, b) => b.value - a.value)
    define('c-steps', () => card('c-steps', 'Tokens saved per step', 'Estimated prompt tokens removed by each optimization step',
      () => st.length ? bars(st, compact) : empty('No savings yet.'), st.length ? () => barTable(st, 'Step', 'Tokens saved', compact) : null))
    const px = prefix.filter(r => Number(r.count) > 0).sort((a, b) => b.count - a.count)
    define('c-prefix', () => card('c-prefix', 'Prompt-caching advisories', 'Calls whose system prompt or tools changed, which defeats provider prompt caching',
      () => px.length ? table([{ label: 'Use case', get: r => keyName(r.useCase) }, { label: 'Changed prefixes', num: true, get: r => r.count, fmt: int }], px) : empty('None. Prompt prefixes are stable.')))
    define('c-exporters', () => card('c-exporters', 'Exporters', 'Where call metrics are sent', () => exporters.length
      ? table([
        { label: 'Exporter', get: r => r.name },
        { label: 'Errors', num: true, get: r => r.errors, fmt: int },
        { label: 'Details', wrap: true, get: r => { try { return Object.entries(JSON.parse(r.stats || '{}')).map(([k, v]) => `${k} ${v}`).join(' · ') || '–' } catch { return '–' } } }
      ], exporters)
      : empty('No exporters configured.')))
  }

  // ---------- wiring ----------
  const status = $('status')
  async function refresh () {
    document.querySelectorAll('.card').forEach(c => c.classList.add('loading'))
    status.classList.remove('error')
    status.textContent = 'Loading…'
    try {
      await Promise.all([HAS_LOG ? loadLog() : null, loadInstance()])
      status.textContent = `Updated ${timeFmt.format(new Date())} UTC`
    } catch (e) {
      status.classList.add('error')
      status.textContent = e.message || 'Could not load the statistics.'
    } finally {
      document.querySelectorAll('.card').forEach(c => c.classList.remove('loading'))
    }
  }

  /** After a filter change: keep the current charts, dimmed, until the new data is drawn. */
  async function reloadLog () {
    const cards = document.querySelectorAll('#log .card')
    cards.forEach(c => c.classList.add('loading'))
    try {
      await loadLog()
      status.classList.remove('error')
      status.textContent = `Updated ${timeFmt.format(new Date())} UTC`
    } catch (e) {
      status.classList.add('error')
      status.textContent = e.message || 'Could not load the statistics.'
    } finally {
      cards.forEach(c => c.classList.remove('loading'))
    }
  }

  function syncRange () {
    document.querySelectorAll('#range button').forEach(b => {
      const on = b.dataset.range === state.range
      b.setAttribute('aria-checked', on ? 'true' : 'false')
      b.tabIndex = on ? 0 : -1
    })
  }

  $('log').hidden = !HAS_LOG
  $('nolog').hidden = HAS_LOG
  $('groupBy').value = state.groupBy
  syncRange()
  $('range').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-range]')
    if (!b || b.dataset.range === state.range) return
    state.range = b.dataset.range
    store.set('range', state.range)
    syncRange()
    reloadLog()
  })
  $('range').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    const keys = Object.keys(RANGES)
    const next = keys[(keys.indexOf(state.range) + (e.key === 'ArrowRight' ? 1 : keys.length - 1)) % keys.length]
    document.querySelector(`#range button[data-range="${next}"]`).click()
    document.querySelector(`#range button[data-range="${next}"]`).focus()
  })
  $('groupBy').addEventListener('change', (e) => {
    state.groupBy = e.target.value
    store.set('groupBy', state.groupBy)
    reloadLog()
  })
  $('refresh').addEventListener('click', refresh)

  let resizeTimer
  let lastWidth = innerWidth
  addEventListener('resize', () => {
    if (innerWidth === lastWidth) return
    lastWidth = innerWidth
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => ['c-tokens', 'c-calls', 'c-cost'].forEach(id => renders[id]?.()), 150)
  })

  refresh()
})()
