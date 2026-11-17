import type { StudyChart, StudyChartPoint } from './analysisStudy'
export type PlotValue = { id: string; value: string; exact: string }
export const escapeChartText = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (s) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[s]!
  )
const esc = escapeChartText
const colors = [
  '#2364ca',
  '#07847c',
  '#b46213',
  '#9050a4',
  '#ba4851',
  '#567340',
  '#537a9a',
  '#7c6853',
  '#9c5b85',
  '#3b7474',
  '#746fbb',
  '#a76d35'
]
// Choose black or white after compositing the cell on the shipped theme background.
// The better of these two foregrounds has at least 4.5:1 contrast for any sRGB color.
export function heatmapForeground(fill: string, opacity: number, dark: boolean): string {
  const rgb = [1, 3, 5].map((offset) => parseInt(fill.slice(offset, offset + 2), 16))
  const background = dark ? 11 : 255
  const linear = rgb.map((channel) => {
    const v = (channel * opacity + background * (1 - opacity)) / 255
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  const luminance = 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  return 1.05 / (luminance + 0.05) >= (luminance + 0.05) / 0.05 ? '#ffffff' : '#000000'
}
export function renderStudyCharts(
  spec: StudyChart,
  values: PlotValue[],
  options: { reference?: (id: string) => string; dark?: boolean; label?: string } = {}
): string[] {
  if (spec.kind === 'table') return []
  const byId = new Map(values.map((value) => [value.id, value]))
  const value = (id: string | undefined) => (id ? byId.get(id) : undefined)
  const numeric = (id: string | undefined) => Number(value(id)?.value ?? 0)
  const ids = spec.points
    .flatMap((point) => [
      point.valueId,
      point.xId,
      point.yId,
      point.sizeId,
      point.lowerId,
      point.q1Id,
      point.medianId,
      point.q3Id,
      point.upperId,
      point.startId,
      point.endId,
      ...(point.outlierIds ?? [])
    ])
    .filter((id): id is string => !!id)
  if (
    ids.some(
      (id) =>
        !value(id) ||
        !Number.isFinite(numeric(id)) ||
        (numeric(id) === 0 && /[1-9]/.test(value(id)!.value))
    )
  )
    return []
  const palette = options.dark
    ? [
        '#85b4ff',
        '#65cfc2',
        '#f0bb77',
        '#cfaaeb',
        '#f09ba5',
        '#b4cb84',
        '#9dc6e4',
        '#d0b699',
        '#dda3c8',
        '#8fc6c6',
        '#b8b3f1',
        '#dcb47c'
      ]
    : colors
  const ink = options.dark ? '#e8eef7' : '#172638'
  const muted = options.dark ? '#b3c3d7' : '#526277'
  const grid = options.dark ? '#435166' : '#dce3ed'
  const svg = (body: string, height = 330) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 900 ${height}" role="img" aria-label="${esc(options.label ?? spec.kind)}" style="color:${ink};font-family:Arial,'Microsoft YaHei',sans-serif;font-size:12px;fill:${ink}"><title>${esc(options.label ?? spec.kind)}</title>${body}</svg>`
  const displayValue = (v: string) => (v.length > 10 ? '≈ ' + Number(v).toPrecision(4) : v)
  const short = (s: string, n = 14) => {
    const letters = Array.from(s)
    return esc(letters.slice(0, n).join('') + (letters.length > n ? '…' : ''))
  }
  const text = (x: number, y: number, s: string, anchor = 'start', fill = ink) =>
    `<text x="${x}" y="${y}" text-anchor="${anchor}" fill="${fill}">${esc(s)}</text>`
  const line = (x1: number, y1: number, x2: number, y2: number, stroke = grid, dash = false) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${stroke}"${dash ? ' stroke-dasharray="5 4"' : ''}/>`
  const rect = (x: number, y: number, w: number, h: number, fill: string) =>
    `<rect x="${x}" y="${y}" width="${Math.max(0, w)}" height="${Math.max(0, h)}" fill="${fill}"/>`
  const title = (p: StudyChartPoint) =>
    `${p.label}${p.series ? ' · ' + p.series : ''}: ${value(p.valueId)?.exact ?? ''} ${spec.unit}`
  const mark = (id: string, body: string, tooltip: string) =>
    `<a href="#${esc(options.reference?.(id) ?? 'study-evidence')}" data-value-id="${esc(id)}" aria-label="${esc(tooltip)}"><title>${esc(tooltip)}</title>${body}</a>`
  const ticks = (minimum: number, maximum: number) =>
    Array.from({ length: 5 }, (_, i) => minimum * (1 - i / 4) + (maximum * i) / 4)
  const tick = (n: number) =>
    Number(n.toPrecision(4)).toLocaleString('en-US', { maximumSignificantDigits: 4 })
  const scale = (numbers: number[], low: number, high: number, zero = true) => {
    let min = Math.min(...numbers, ...(zero ? [0] : []))
    let max = Math.max(...numbers, ...(zero ? [0] : []))
    if (min === max) {
      const padding = Math.abs(min) * 0.05 || 1
      min -= zero ? 0 : padding
      max += padding
    }
    const magnitude = Math.max(Math.abs(min), Math.abs(max), 1e-300)
    const f = (v: number) =>
      low + ((v / magnitude - min / magnitude) / (max / magnitude - min / magnitude)) * (high - low)
    return { f, min, max }
  }
  const axis = (sx: ReturnType<typeof scale>, sy: ReturnType<typeof scale>) =>
    ticks(sy.min, sy.max)
      .map((n) => line(90, sy.f(n), 825, sy.f(n)) + text(80, sy.f(n) + 4, tick(n), 'end', muted))
      .join('') +
    ticks(sx.min, sx.max)
      .map((n) => line(sx.f(n), 30, sx.f(n), 265) + text(sx.f(n), 286, tick(n), 'middle', muted))
      .join('') +
    text(90, 18, spec.yLabel) +
    text(825, 315, spec.xLabel, 'end')
  const points = spec.points
  if (!points.length) return []
  if (['scatter', 'bubble'].includes(spec.kind)) {
    const sx = scale(
      [
        ...points.map((p) => numeric(p.xId)),
        ...(spec.xThresholdId ? [numeric(spec.xThresholdId)] : [])
      ],
      90,
      825,
      false
    )
    const sy = scale(
      [
        ...points.map((p) => numeric(p.yId ?? p.valueId)),
        ...(spec.yThresholdId ? [numeric(spec.yThresholdId)] : [])
      ],
      265,
      30,
      false
    )
    const largest = Math.max(...points.map((p) => numeric(p.sizeId)), 1)
    let body = axis(sx, sy)
    if (spec.xThresholdId)
      body +=
        line(
          sx.f(numeric(spec.xThresholdId)),
          30,
          sx.f(numeric(spec.xThresholdId)),
          265,
          muted,
          true
        ) +
        mark(
          spec.xThresholdId,
          text(sx.f(numeric(spec.xThresholdId)), 302, tick(numeric(spec.xThresholdId)), 'middle'),
          'X threshold'
        )
    if (spec.yThresholdId)
      body +=
        line(
          90,
          sy.f(numeric(spec.yThresholdId)),
          825,
          sy.f(numeric(spec.yThresholdId)),
          muted,
          true
        ) +
        mark(
          spec.yThresholdId,
          text(832, sy.f(numeric(spec.yThresholdId)) + 4, tick(numeric(spec.yThresholdId))),
          'Y threshold'
        )
    body += points
      .map((p, i) =>
        mark(
          p.valueId,
          `<circle cx="${sx.f(numeric(p.xId))}" cy="${sy.f(numeric(p.yId ?? p.valueId))}" r="${spec.kind === 'bubble' ? Math.sqrt(Math.max(0, numeric(p.sizeId)) / largest) * 20 : 4}" fill="${palette[i % palette.length]}" fill-opacity="0.7" stroke="${ink}" stroke-width="0.4"/>`,
          `${p.label}: X=${value(p.xId)?.exact}, Y=${value(p.yId ?? p.valueId)?.exact}${p.sizeId ? ', size=' + value(p.sizeId)?.exact : ''}`
        )
      )
      .join('')
    return [svg(body)]
  }
  if (['pie', 'donut'].includes(spec.kind)) {
    const numbers = points.map((p) => numeric(p.valueId))
    const magnitude = Math.max(...numbers)
    const sum = numbers.reduce((s, n) => s + n / magnitude, 0)
    if (numbers.some((n) => n < 0) || !(sum > 0)) return []
    let angle = -Math.PI / 2
    const cx = 280,
      cy = 160,
      r = 125
    let body = points
      .map((p, i) => {
        const arc = (numbers[i] / magnitude / sum) * Math.PI * 2
        if (!arc) return ''
        let shape: string
        if (arc >= Math.PI * 2 - 1e-12)
          shape = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${palette[i % palette.length]}"/>`
        else {
          const end = angle + arc
          shape = `<path d="M ${cx} ${cy} L ${cx + r * Math.cos(angle)} ${cy + r * Math.sin(angle)} A ${r} ${r} 0 ${arc > Math.PI ? 1 : 0} 1 ${cx + r * Math.cos(end)} ${cy + r * Math.sin(end)} Z" fill="${palette[i % palette.length]}" stroke="${options.dark ? '#172638' : 'white'}" stroke-width="1"/>`
        }
        angle += arc
        return mark(p.valueId, shape, title(p))
      })
      .join('')
    if (spec.kind === 'donut')
      body += `<circle cx="${cx}" cy="${cy}" r="72" fill="${options.dark ? '#172638' : 'white'}"/>`
    body += points
      .slice(0, 12)
      .map(
        (p, i) =>
          rect(450, 26 + i * 23, 12, 12, palette[i % palette.length]) +
          text(
            474,
            37 + i * 23,
            `${i + 1}. ${Array.from(p.label).slice(0, 19).join('')}  ${value(p.valueId)!.value}`
          )
      )
      .join('')
    if (points.length > 12)
      body += text(
        450,
        320,
        `+ ${points.length - 12}: ${options.label ?? 'Complete values in table'}`
      )
    return [svg(body, 345)]
  }
  if (spec.kind === 'line') {
    const time = points.every((p) => p.time)
    const xValues = points.map((p, i) => (time ? Date.parse(p.time!) : i))
    const sx = scale(xValues, 90, 825, false)
    const sy = scale(
      points.map((p) => numeric(p.valueId)),
      245,
      30
    )
    let body = ticks(sy.min, sy.max)
      .map((n) => line(90, sy.f(n), 825, sy.f(n)) + text(80, sy.f(n) + 4, tick(n), 'end', muted))
      .join('')
    let segment: string[] = []
    const draw = () => {
      if (segment.length > 1)
        body += `<polyline points="${segment.join(' ')}" stroke="${palette[0]}" stroke-width="2.5" fill="none"/>`
      segment = []
    }
    points.forEach((p, i) => {
      if (p.breakBefore) draw()
      segment.push(`${sx.f(xValues[i])},${sy.f(numeric(p.valueId))}`)
    })
    draw()
    points.forEach((p, i) => {
      body += mark(
        p.valueId,
        `<circle cx="${sx.f(xValues[i])}" cy="${sy.f(numeric(p.valueId))}" r="4" fill="${palette[0]}"/>`,
        title(p)
      )
      if (points.length <= 8 || i === 0 || i === points.length - 1)
        body += text(
          sx.f(xValues[i]),
          271,
          Array.from(p.label).slice(0, 14).join(''),
          'middle',
          muted
        )
    })
    return [svg(body + text(90, 18, spec.yLabel) + text(825, 311, spec.xLabel, 'end'))]
  }
  if (spec.kind === 'heatmap') {
    const categories = [...new Set(points.map((p) => p.label))]
    const groups = [...new Set(points.map((p) => p.series ?? ''))]
    const min = Math.min(...points.map((p) => numeric(p.valueId)))
    const max = Math.max(...points.map((p) => numeric(p.valueId)))
    const magnitude = Math.max(Math.abs(min), Math.abs(max), 1e-300)
    const plots: string[] = []
    for (let row = 0; row < groups.length; row += 8)
      for (let start = 0; start < categories.length; start += 8) {
        const gs = groups.slice(row, row + 8),
          cs = categories.slice(start, start + 8)
        const w = 650 / cs.length,
          h = 200 / gs.length
        let body = text(180, 20, `${tick(min)} … ${tick(max)} ${spec.unit}`)
        gs.forEach((g, gi) => {
          body += text(170, 40 + gi * h + h / 2, Array.from(g).slice(0, 18).join(''), 'end')
          cs.forEach((c, ci) => {
            const p = points.find((p) => p.label === c && (p.series ?? '') === g)
            if (!p) return
            const intensity = 0.15 + (0.85 * Math.abs(numeric(p.valueId))) / magnitude
            body += mark(
              p.valueId,
              `<rect x="${180 + ci * w}" y="${30 + gi * h}" width="${w - 2}" height="${h - 2}" fill="${numeric(p.valueId) < 0 ? '#ba4851' : palette[0]}" fill-opacity="${intensity}"/>` +
                text(
                  180 + ci * w + w / 2,
                  30 + gi * h + h / 2 + 4,
                  displayValue(value(p.valueId)!.value),
                  'middle',
                  heatmapForeground(
                    numeric(p.valueId) < 0 ? '#ba4851' : palette[0],
                    intensity,
                    !!options.dark
                  )
                ),
              title(p)
            )
          })
        })
        cs.forEach((c, ci) => {
          body += text(180 + ci * w + w / 2, 250, Array.from(c).slice(0, 12).join(''), 'middle')
        })
        plots.push(
          svg(
            body +
              text(180, 285, spec.xLabel) +
              text(
                180,
                309,
                `${row + 1}-${row + gs.length}/${groups.length}; ${start + 1}-${start + cs.length}/${categories.length}`
              )
          )
        )
      }
    return plots
  }
  if (spec.kind === 'funnel') {
    const maximum = Math.max(...points.map((p) => numeric(p.valueId)), 1)
    const h = 240 / points.length
    return [
      svg(
        points
          .map((p, i) => {
            const w = (numeric(p.valueId) / maximum) * 500
            return (
              mark(
                p.valueId,
                rect(450 - w / 2, 25 + i * h, w, h - 3, palette[i % palette.length]),
                title(p)
              ) +
              text(180, 25 + i * h + h / 2 + 4, Array.from(p.label).slice(0, 18).join(''), 'end') +
              text(720, 25 + i * h + h / 2 + 4, displayValue(value(p.valueId)!.value))
            )
          })
          .join('') + text(200, 310, spec.yLabel + ' ' + spec.unit)
      )
    ]
  }
  if (['stacked', 'percent_stacked'].includes(spec.kind)) {
    const groups = [...new Set(points.map((p) => p.series ?? ''))]
    const categories = [...new Set(points.map((p) => p.label))]
    const totals = categories
      .map((label) => {
        const ns = points.filter((p) => p.label === label).map((p) => numeric(p.valueId))
        return [
          ns.filter((n) => n >= 0).reduce((a, b) => a + b, 0),
          ns.filter((n) => n < 0).reduce((a, b) => a + b, 0)
        ]
      })
      .flat()
    const sx = scale(totals, 220, 810)
    const plots: string[] = []
    for (let start = 0; start < categories.length; start += 8) {
      const cs = categories.slice(start, start + 8)
      const height = cs.length * 27 + 100
      let body = ticks(sx.min, sx.max)
        .map(
          (n) =>
            line(sx.f(n), 15, sx.f(n), height - 64) +
            text(sx.f(n), height - 42, tick(n), 'middle', muted)
        )
        .join('')
      cs.forEach((label, i) => {
        let pos = 0,
          neg = 0
        body += text(205, 34 + i * 27, Array.from(label).slice(0, 20).join(''), 'end')
        for (const p of points.filter((p) => p.label === label)) {
          const n = numeric(p.valueId)
          const from = n >= 0 ? pos : neg
          const end = from + n
          if (n >= 0) pos = end
          else neg = end
          body += mark(
            p.valueId,
            rect(
              Math.min(sx.f(from), sx.f(end)),
              17 + i * 27,
              Math.abs(sx.f(end) - sx.f(from)),
              22,
              palette[groups.indexOf(p.series ?? '') % palette.length]
            ),
            title(p)
          )
        }
      })
      body += groups
        .slice(0, 12)
        .map(
          (g, i) =>
            rect(
              30 + (i % 4) * 215,
              height - 30 + Math.floor(i / 4) * 19,
              10,
              10,
              palette[i % palette.length]
            ) +
            text(
              45 + (i % 4) * 215,
              height - 21 + Math.floor(i / 4) * 19,
              Array.from(g).slice(0, 22).join('')
            )
        )
        .join('')
      plots.push(
        svg(body, height + Math.max(0, Math.ceil(Math.min(groups.length, 12) / 4) - 1) * 19)
      )
    }
    return plots
  }
  if (spec.kind === 'boxplot') {
    const all = points.flatMap((p) => [
      numeric(p.lowerId),
      numeric(p.upperId),
      ...(p.outlierIds ?? []).map(numeric)
    ])
    const sx = scale(all, 220, 820, false)
    const plots: string[] = []
    for (let start = 0; start < points.length; start += 8) {
      const ps = points.slice(start, start + 8)
      const height = ps.length * 38 + 70
      let body = ticks(sx.min, sx.max)
        .map(
          (n) =>
            line(sx.f(n), 15, sx.f(n), height - 35) +
            text(sx.f(n), height - 12, tick(n), 'middle', muted)
        )
        .join('')
      ps.forEach((p, i) => {
        const cy = 32 + i * 38
        body +=
          text(205, cy + 4, Array.from(p.label).slice(0, 20).join(''), 'end') +
          line(sx.f(numeric(p.lowerId)), cy, sx.f(numeric(p.upperId)), cy, ink)
        for (const id of [p.lowerId, p.upperId])
          if (id)
            body += mark(
              id,
              rect(sx.f(numeric(id)) - 5, cy - 14, 10, 28, 'transparent') +
                line(sx.f(numeric(id)), cy - 10, sx.f(numeric(id)), cy + 10, ink),
              value(id)!.exact
            )
        body +=
          mark(
            p.q1Id!,
            rect(
              sx.f(numeric(p.q1Id)),
              cy - 12,
              sx.f(numeric(p.q3Id)) - sx.f(numeric(p.q1Id)),
              24,
              palette[0]
            ),
            `Q1=${value(p.q1Id)?.exact}; Q3=${value(p.q3Id)?.exact}`
          ) +
          mark(
            p.medianId!,
            rect(sx.f(numeric(p.medianId)) - 5, cy - 14, 10, 28, 'transparent') +
              line(
                sx.f(numeric(p.medianId)),
                cy - 12,
                sx.f(numeric(p.medianId)),
                cy + 12,
                options.dark ? '#172638' : '#ffffff'
              ),
            `Median=${value(p.medianId)?.exact}`
          )
        for (const id of p.outlierIds ?? [])
          body += mark(
            id,
            `<circle cx="${sx.f(numeric(id))}" cy="${cy}" r="3" fill="#ba4851"/>`,
            value(id)!.exact
          )
      })
      plots.push(svg(body, height))
    }
    return plots
  }
  const plots: string[] = []
  const waterfall = spec.kind === 'waterfall'
  const histogram = spec.kind === 'histogram'
  const sx = scale(
    points.flatMap((p) =>
      waterfall ? [numeric(p.startId), numeric(p.endId)] : [numeric(p.valueId)]
    ),
    waterfall ? 230 : 260,
    810
  )
  for (let start = 0; start < points.length; start += 10) {
    const ps = points.slice(start, start + 10)
    const height = ps.length * 26 + 48
    let body =
      ticks(sx.min, sx.max)
        .map(
          (n) =>
            line(sx.f(n), 8, sx.f(n), height - 30) +
            text(sx.f(n), height - 9, tick(n), 'middle', muted)
        )
        .join('') + line(sx.f(0), 8, sx.f(0), height - 30, muted)
    ps.forEach((p, i) => {
      const from = waterfall ? numeric(p.startId) : 0,
        end = waterfall ? numeric(p.endId) : numeric(p.valueId)
      const y = 10 + i * 26
      const color =
        waterfall && p.role !== 'total' && numeric(p.valueId) < 0 ? '#ba4851' : palette[0]
      body +=
        `<text x="${waterfall ? 215 : 245}" y="${y + 16}" text-anchor="end">${short(p.label, waterfall ? 21 : 25)}</text>` +
        mark(
          p.valueId,
          rect(
            Math.min(sx.f(from), sx.f(end)),
            y,
            Math.abs(sx.f(end) - sx.f(from)),
            histogram ? 25 : 20,
            color
          ),
          title(p)
        ) +
        text(825, y + 16, displayValue(value(p.valueId)!.value))
      if (waterfall && i < ps.length - 1 && ps[i + 1].role !== 'total')
        body += line(sx.f(end), y + 20, sx.f(end), y + 26, muted, true)
    })
    plots.push(svg(body, height))
  }
  return plots
}
