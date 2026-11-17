import { randomUUID } from 'node:crypto'
import type { AnalysisPlan, AnalysisRun, AnalysisSource } from '@shared/analysis'
import {
  METHOD_RULES,
  localized,
  type ChartKind,
  type StudyChart,
  type StudyChartPoint,
  type StudyResult
} from '@shared/analysisStudy'
import { AnalysisError } from './errors'
import {
  cmp,
  correlation,
  minus,
  over,
  plus,
  q,
  quantile,
  ranks,
  renderQ,
  times,
  total,
  type Q
} from './studyMath'
export type StudyInputRow = {
  row: number
  fields: Record<string, string>
  numbers: Record<string, string | null>
  inputs: AnalysisRun['values'][number]['inputs']
  date?: string
}
export type StudyContext = {
  source: AnalysisSource
  plan: AnalysisPlan
  rows: StudyInputRow[]
  headers: Record<string, string>
  scannedRows: number
  emptyRows: number
  warnings: AnalysisRun['warnings']
  started: number
}
const blank = '(空白 / Blank)'
function requireData(condition: unknown): asserts condition {
  if (!condition) throw new AnalysisError('METHOD_REQUIREMENTS')
}
export function calculateStudy(context: StudyContext): AnalysisRun {
  const { source, plan, headers, scannedRows, emptyRows, warnings, started } = context
  const config = plan.study!
  const rule = METHOD_RULES[config.method]
  let rows = context.rows
  if (!rows.length) throw new AnalysisError('NO_ROWS')
  if (rows.length > 2000) throw new AnalysisError('METHOD_DATA_LIMIT')
  const runId = randomUUID()
  const values: AnalysisRun['values'] = []
  const result: StudyResult = {
    version: 'methods/1',
    method: config.method,
    ruleVersion: rule.version,
    requirements: rule.requirements,
    limits: rule.limits,
    checks: [],
    missingRows: 0,
    columns: [],
    rows: [],
    statistics: [],
    charts: []
  }
  const check = (key: string, state: 'pass' | 'fail' | 'unknown', zh: string, en: string) =>
    result.checks.push({ key, state, detail: localized(zh, en) })
  const inputs = (items: StudyInputRow[]) => items.flatMap((row) => row.inputs)
  const fact = (label: string, value: Q, items: StudyInputRow[], formula = '', unit = '') => {
    const rendered = renderQ(value)
    const id = `${runId}:${values.length}`
    values.push({
      id,
      category: label,
      ...rendered,
      numerator: rendered.value,
      denominator: 1,
      included: items.length,
      blank: 0,
      inputs: inputs(items),
      formula: formula || rendered.exact,
      rational: { numerator: value.n.toString(), denominator: value.d.toString() },
      unit
    })
    return id
  }
  const stat = (label: string, value: Q, items: StudyInputRow[], formula = '', unit = '') => {
    const id = fact(label, value, items, formula, unit)
    result.statistics.push(id)
    return id
  }
  const num = (row: StudyInputRow, column = plan.measure) => q(row.numbers[column]!)
  const column = (key: string, label: string, unit = '') => {
    if (!result.columns.some((c) => c.key === key)) result.columns.push({ key, label, unit })
  }
  const chart = (
    kind: ChartKind,
    points: StudyChartPoint[],
    note = localized(
      '图形坐标为近似值，完整精确结果和依据见数值表。',
      'Coordinates are approximate. Complete exact values and evidence are in the table.'
    ),
    extra: Partial<StudyChart> = {}
  ) =>
    result.charts.push({
      kind,
      points,
      xLabel: headers[plan.groupBy] || '',
      yLabel: headers[plan.measure] || '',
      unit: plan.unit,
      note,
      ...extra
    })
  const table = () => chart('table', [])
  const valid = (columns: string[]) => {
    requireData(columns.every((c) => !!c && c in headers))
    const included = rows.filter((row) => columns.every((c) => row.numbers[c] != null))
    result.missingRows = rows.length - included.length
    check(
      'missing',
      result.missingRows ? 'unknown' : 'pass',
      `成对/必需数值缺失 ${result.missingRows} 条，完整记录 ${included.length} 条；缺失不补零。`,
      `Missing required values in ${result.missingRows} records; ${included.length} complete records. Missing values are not zero.`
    )
    return included
  }
  const observed = (items: StudyInputRow[]) => {
    if (!config.observationBy) {
      check(
        'grain',
        'unknown',
        '每行作为一个观测；业务对象独立性和重复对象尚未核实。',
        'Each row is an observation; business-object independence and duplicates are unverified.'
      )
      return
    }
    requireData(config.observationBy in headers)
    const keys = items.map((row) => row.fields[config.observationBy!])
    requireData(keys.every(Boolean) && new Set(keys).size === keys.length)
    check(
      'grain',
      'pass',
      `按 ${headers[config.observationBy]} 检查，观测标识非空且唯一。`,
      `Observation IDs in ${headers[config.observationBy]} are nonempty and unique.`
    )
  }
  const rowLabel = (row: StudyInputRow) =>
    config.observationBy ? row.fields[config.observationBy] : `#${row.row}`
  const group = (items: StudyInputRow[], classify: (row: StudyInputRow) => string) => {
    const groups = new Map<string, StudyInputRow[]>()
    for (const row of items) {
      const key = classify(row)
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
    }
    if (groups.size > 100) throw new AnalysisError('GROUP_LIMIT')
    return groups
  }
  const aggregate = (items: StudyInputRow[]): Q | null => {
    if (plan.operation === 'count') return q(items.length)
    const vs = items.filter((row) => row.numbers[plan.measure] != null).map((row) => num(row))
    if (!vs.length) return null
    if (plan.operation === 'min') return vs.reduce((a, b) => (cmp(a, b) < 0 ? a : b))
    if (plan.operation === 'max') return vs.reduce((a, b) => (cmp(a, b) > 0 ? a : b))
    return plan.operation === 'average' ? over(total(vs), q(vs.length)) : total(vs)
  }
  const valueFor = (id: string) => values.find((value) => value.id === id)!
  const accumulation = (points: StudyChartPoint[], items: StudyInputRow[]) => {
    let running = q(0)
    const plotted: StudyChartPoint[] = points.map((point) => {
      const before = running
      running = plus(running, q(valueFor(point.valueId).value))
      return {
        ...point,
        role: 'change' as const,
        startId: fact(`${point.label} · 起点`, before, items),
        endId: fact(`${point.label} · 终点`, running, items)
      }
    })
    const id = fact('合计 / Total', running, items, 'sum(contributions)', plan.unit)
    plotted.push({
      label: '合计 / Total',
      valueId: id,
      role: 'total',
      startId: fact('起点 / Start', q(0), [], 'defined zero'),
      endId: id
    })
    chart('waterfall', plotted)
  }

  if (config.method === 'cycle-analysis') {
    requireData(plan.groupBy && config.interval)
    const validRows = rows.filter(
      (row) => !!row.date && (plan.operation === 'count' || row.numbers[plan.measure] != null)
    )
    result.missingRows = rows.length - validRows.length
    requireData(validRows.length)
    const datePeriod = (date: string) => {
      const day = new Date(`${date}T00:00:00Z`)
      if (config.interval === 'year') return date.slice(0, 4)
      if (config.interval === 'quarter')
        return `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`
      if (config.interval === 'month') return date.slice(0, 7)
      if (config.interval === 'week') {
        day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7))
        return day.toISOString().slice(0, 10)
      }
      return date
    }
    const periodTime = (period: string) =>
      config.interval === 'quarter'
        ? Date.UTC(Number(period.slice(0, 4)), (Number(period.slice(-1)) - 1) * 3, 1)
        : Date.parse(
            period.length === 4 ? period + '-01-01' : period.length === 7 ? period + '-01' : period
          )
    const nextTime = (period: string) => {
      const d = new Date(periodTime(period))
      if (config.interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1)
      else if (config.interval === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3)
      else if (config.interval === 'month') d.setUTCMonth(d.getUTCMonth() + 1)
      else d.setUTCDate(d.getUTCDate() + (config.interval === 'week' ? 7 : 1))
      return d.getTime()
    }
    const periods = [...group(validRows, (row) => datePeriod(row.date!))].sort(([a], [b]) =>
      a.localeCompare(b)
    )
    column('value', headers[plan.measure] || '记录数 / Count', plan.unit)
    column('difference', '变化量 / Difference', plan.unit)
    column('change', '变化率 / Change', '%')
    const points: StudyChartPoint[] = []
    let previous: { period: string; value: Q; items: StudyInputRow[] } | undefined
    let gaps = 0
    for (const [period, items] of periods) {
      const value = aggregate(items)!
      const id = fact(
        period,
        value,
        items,
        `${plan.operation}(${plan.measure || 'rows'})`,
        plan.unit
      )
      const cells: Record<string, string> = { value: id }
      if (previous) {
        if (nextTime(previous.period) !== periodTime(period)) gaps++
        else {
          const delta = minus(value, previous.value)
          cells.difference = fact(
            `${period} · 变化量`,
            delta,
            [...items, ...previous.items],
            `${renderQ(value).exact} - (${renderQ(previous.value).exact})`,
            plan.unit
          )
          const percentage = over(times(delta, q(100)), previous.value)
          if (percentage)
            cells.change = fact(
              `${period} · 变化率`,
              percentage,
              [...items, ...previous.items],
              `(${renderQ(value).exact} - (${renderQ(previous.value).exact})) / (${renderQ(previous.value).exact}) × 100`,
              '%'
            )
          else
            check(
              `zero-${period}`,
              'unknown',
              `${period} 的基期为零，变化率未定义。`,
              `The baseline for ${period} is zero; percentage change is undefined.`
            )
          if (previous.value.n < 0n)
            check(
              `negative-${period}`,
              'unknown',
              `${period} 的基期为负，变化率需结合差额解释。`,
              `The baseline for ${period} is negative; interpret percentage change with the absolute difference.`
            )
        }
      }
      result.rows.push({ label: period, values: cells })
      points.push({
        label: period,
        valueId: id,
        time: new Date(periodTime(period)).toISOString().slice(0, 10),
        breakBefore: !!previous && nextTime(previous.period) !== periodTime(period)
      })
      previous = { period, value, items }
    }
    check(
      'period-gaps',
      gaps ? 'unknown' : 'pass',
      `发现 ${gaps} 处缺期；不连作相邻比较，也不补零。`,
      `Found ${gaps} period gaps; no adjacent comparison or zero imputation across gaps.`
    )
    check(
      'period-closed',
      config.windowComplete ? 'pass' : 'unknown',
      config.windowComplete
        ? '调用方已声明所选期间完整；该声明保存在计划中。'
        : '期间完整/结账口径未声明，结果仅比较已记录数据。',
      config.windowComplete
        ? 'The caller declares complete periods; this declaration is retained.'
        : 'Closed/complete periods have not been declared. Only recorded values are compared.'
    )
    check(
      'seasonality',
      'unknown',
      '本次输出期间序列与相邻变化，不作季节性或因果判断。',
      'Outputs periods and adjacent changes without seasonality or causal claims.'
    )
    chart('line', points, undefined, {
      xLabel: headers[plan.groupBy],
      note: localized(
        '真实期间按时间间距绘制，缺期处断线，不补零。',
        'Periods use actual time spacing; gaps break the line without zero imputation.'
      )
    })
    chart('bar', points)
  } else if (
    ['structure-analysis', 'label-analysis', 'mece-decomposition'].includes(config.method)
  ) {
    const strictComposition = config.method !== 'label-analysis'
    if (strictComposition) requireData(['sum', 'count'].includes(plan.operation))
    requireData(config.rules?.length || plan.groupBy)
    if (config.rules?.length) {
      requireData(config.ruleBasis)
      for (const rule of config.rules)
        for (const condition of rule.conditions) {
          requireData(
            condition.kind === 'number'
              ? condition.operator !== 'contains'
              : ['eq', 'neq', 'contains'].includes(condition.operator)
          )
          if (condition.kind === 'number')
            try {
              q(condition.value)
            } catch {
              throw new AnalysisError('METHOD_REQUIREMENTS')
            }
        }
    }
    if (config.seriesBy) requireData(config.seriesBy in headers)
    const matches = (row: StudyInputRow, ruleItem: NonNullable<typeof config.rules>[number]) =>
      ruleItem.conditions.every((c) => {
        const value = row.fields[c.column] ?? ''
        if (c.kind === 'number') {
          if (row.numbers[c.column] == null) return false
          const comparison = cmp(q(row.numbers[c.column]!), q(c.value))
          return c.operator === 'eq'
            ? comparison === 0
            : c.operator === 'neq'
              ? comparison !== 0
              : c.operator === 'gt'
                ? comparison > 0
                : c.operator === 'gte'
                  ? comparison >= 0
                  : c.operator === 'lt'
                    ? comparison < 0
                    : c.operator === 'lte'
                      ? comparison <= 0
                      : false
        }
        return c.operator === 'eq'
          ? value === c.value
          : c.operator === 'neq'
            ? value !== c.value
            : c.operator === 'contains'
              ? value.includes(c.value)
              : false
      })
    const groups = new Map<string, StudyInputRow[]>()
    const keyInfo = new Map<string, { label: string; series?: string }>()
    const unmatched: StudyInputRow[] = []
    const overlapping: StudyInputRow[] = []
    const record = (label: string, row: StudyInputRow, bucket = 'value') => {
      const series = config.seriesBy ? row.fields[config.seriesBy] : undefined
      const key = JSON.stringify([bucket, label, series ?? ''])
      const list = groups.get(key) ?? []
      list.push(row)
      groups.set(key, list)
      keyInfo.set(key, {
        label: label || blank,
        series: series === undefined ? undefined : series || blank
      })
    }
    for (const row of rows) {
      const membership = config.rules?.filter((r) => matches(row, r)).map((r) => r.label) ?? [
        row.fields[plan.groupBy]
      ]
      if (!membership.length) {
        unmatched.push(row)
        record('未匹配 / Unmatched', row, 'unmatched')
      } else if (membership.length > 1) {
        overlapping.push(row)
        if (config.method === 'mece-decomposition')
          record('多重归属 / Multiple membership', row, 'overlap')
        else membership.forEach((label) => record(label, row))
      } else {
        if (!config.rules && !row.fields[plan.groupBy]) unmatched.push(row)
        record(membership[0], row)
      }
    }
    if (groups.size > 100) throw new AnalysisError('GROUP_LIMIT')
    // Empty rule groups are retained; no invented mean is generated for an empty group.
    if (config.rules && !config.seriesBy)
      for (const item of config.rules) {
        const key = JSON.stringify(['value', item.label, ''])
        if (!groups.has(key)) {
          groups.set(key, [])
          keyInfo.set(key, { label: item.label })
        }
      }
    const totalMeasure = aggregate(rows)
    const countId = stat(
      '范围记录数 / Population records',
      q(rows.length),
      rows,
      'count(nonempty filtered rows)'
    )
    stat('未匹配记录 / Unmatched records', q(unmatched.length), unmatched, 'count(no rule matched)')
    stat(
      '重叠记录 / Overlap records',
      q(overlapping.length),
      overlapping,
      'count(more than one rule matched)'
    )
    if (totalMeasure)
      stat(
        '总体指标 / Population measure',
        totalMeasure,
        rows,
        `${plan.operation}(${plan.measure || 'rows'})`,
        plan.unit
      )
    column('count', '记录数 / Records')
    column('value', headers[plan.measure] || '记录数 / Records', plan.unit)
    column('recordShare', '记录占比 / Record share', '%')
    if (strictComposition) column('share', '指标构成占比 / Measure share', '%')
    const points: StudyChartPoint[] = []
    for (const [key, items] of groups) {
      const { label, series } = keyInfo.get(key)!
      const full = [label, series].filter(Boolean).join(' · ')
      const count = fact(
        `${full} · 记录数`,
        q(items.length),
        items,
        `count(group) / population=${valueFor(countId).value}`
      )
      const measure = aggregate(items)
      const value = measure
        ? fact(
            `${full} · 指标`,
            measure,
            items,
            `${plan.operation}(${plan.measure || 'rows'})`,
            plan.unit
          )
        : undefined
      const share = fact(
        `${full} · 记录占比`,
        over(times(q(items.length), q(100)), q(rows.length))!,
        rows,
        `${items.length} / ${rows.length} × 100`,
        '%'
      )
      const composition =
        strictComposition &&
        !overlapping.length &&
        measure &&
        totalMeasure &&
        totalMeasure.n > 0n &&
        [...groups.values()].every((groupRows) => (aggregate(groupRows)?.n ?? 0n) >= 0n)
          ? fact(
              `${full} · 指标构成占比`,
              over(times(measure, q(100)), totalMeasure)!,
              rows,
              `${renderQ(measure).exact} / ${renderQ(totalMeasure).exact} × 100`,
              '%'
            )
          : undefined
      result.rows.push({
        label,
        series,
        values: {
          count,
          recordShare: share,
          ...(composition ? { share: composition } : {}),
          ...(value ? { value } : {})
        }
      })
      if (value) points.push({ label, series, valueId: value })
    }
    result.missingRows =
      plan.operation === 'count'
        ? 0
        : rows.filter((row) => row.numbers[plan.measure] == null).length
    check(
      'coverage',
      unmatched.length ? 'unknown' : 'pass',
      `未匹配 ${unmatched.length} 条，空类别保留；总体为本次筛选的 ${rows.length} 条记录。`,
      `${unmatched.length} unmatched records; blank categories retained. Population: ${rows.length} filtered records.`
    )
    check(
      'membership',
      overlapping.length ? 'fail' : 'pass',
      `重叠 ${overlapping.length} 条；标签允许重叠，MECE 不把重叠视为有效分类。`,
      `${overlapping.length} overlapping records. Labels may overlap; MECE does not treat overlap as a valid partition.`
    )
    check(
      'additivity',
      plan.operation === 'count' ? 'pass' : 'unknown',
      strictComposition
        ? '已核对记录级数学加总；指标在业务上是否可加总仍需定义支持，记录不等于去重对象。'
        : '标签指标沿用所选聚合方式，均值和非加总指标不组成总体。',
      strictComposition
        ? 'Mathematical sums are reconciled. Business additivity still needs a metric definition; records are not distinct objects.'
        : 'The selected aggregation is retained. Means and nonadditive measures are not compositions.'
    )
    if (strictComposition && !overlapping.length && totalMeasure) {
      const sum = total([...groups.values()].map((items) => aggregate(items) ?? q(0)))
      check(
        'reconciliation',
        cmp(sum, totalMeasure) === 0 ? 'pass' : 'fail',
        `分组合计 ${renderQ(sum).exact}；总体 ${renderQ(totalMeasure).exact}；残差 ${renderQ(minus(sum, totalMeasure)).exact}。`,
        `Group sum ${renderQ(sum).exact}; population ${renderQ(totalMeasure).exact}; residual ${renderQ(minus(sum, totalMeasure)).exact}.`
      )
    }
    chart('bar', points)
    const distinctDisplayCells =
      new Set(points.map((point) => JSON.stringify([point.label, point.series ?? '']))).size ===
      points.length
    if (!distinctDisplayCells)
      check(
        'display-labels',
        'unknown',
        '显示占位符与原始类别同名，类别未合并；联合堆积和热力图不可用，请使用条形或精确表。',
        'A display placeholder collides with an original label. Categories remain separate; joint stacks and heatmaps are unavailable. Use bars or the exact table.'
      )
    if (config.seriesBy && distinctDisplayCells) {
      if (['sum', 'count'].includes(plan.operation)) chart('stacked', points)
      chart('heatmap', points)
      if (
        points.every((p) => q(valueFor(p.valueId).value).n >= 0n) &&
        ['sum', 'count'].includes(plan.operation) &&
        !overlapping.length
      ) {
        const categories = [...new Set(points.map((p) => p.label))]
        const percentages: StudyChartPoint[] = []
        for (const category of categories) {
          const subset = points.filter((p) => p.label === category)
          const denominator = total(subset.map((p) => q(valueFor(p.valueId).value)))
          if (!denominator.n) continue
          for (const p of subset)
            percentages.push({
              ...p,
              valueId: fact(
                `${p.label} · ${p.series} · 组内占比`,
                over(times(q(valueFor(p.valueId).value), q(100)), denominator)!,
                rows,
                `${valueFor(p.valueId).exact} / ${renderQ(denominator).exact} × 100`,
                '%'
              )
            })
        }
        if (percentages.length)
          chart(
            'percent_stacked',
            percentages,
            localized(
              '每个分类以本分类非负系列合计为分母；零合计时百分比未定义，完整原值保留在结果表。',
              'Each category uses its own nonnegative series total as denominator. Zero totals have undefined percentages; original values remain in the table.'
            ),
            { unit: '%' }
          )
      }
    }
    if (strictComposition && !config.seriesBy) accumulation(points, rows)
    if (
      !overlapping.length &&
      !config.seriesBy &&
      ['sum', 'count'].includes(plan.operation) &&
      points.length &&
      points.every((p) => q(valueFor(p.valueId).value).n >= 0n) &&
      total(points.map((p) => q(valueFor(p.valueId).value))).n > 0n
    ) {
      chart('pie', points)
      chart('donut', points)
    }
  } else if (config.method === 'stratification-analysis') {
    const complete = valid([plan.measure])
    requireData(complete.length)
    observed(complete)
    const ordered = complete.map((row) => num(row)).sort(cmp)
    let bounds = config.boundaries?.map(q) ?? [
      quantile(ordered, 1),
      quantile(ordered, 2),
      quantile(ordered, 3)
    ]
    if (config.boundaries) {
      requireData(config.ruleBasis)
      requireData(bounds.every((v, i) => !i || cmp(bounds[i - 1], v) < 0))
    }
    // Coincident sample quantiles produce fewer distinct bands, without splitting ties.
    bounds = bounds.filter((v, i) => !i || cmp(bounds[i - 1], v) !== 0)
    check(
      'thresholds',
      'pass',
      config.boundaries
        ? `业务阈值来源：${config.ruleBasis}；左闭右开，等于阈值进入较高层。`
        : '探索阈值来自完整样本 Type 7 四分位数；相同阈值合并，不拆分并列观测。',
      config.boundaries
        ? `Business threshold basis: ${config.ruleBasis}. Left-closed/right-open; equality goes to the upper band.`
        : 'Exploratory thresholds use Type 7 quartiles of the complete sample. Tied thresholds are merged.'
    )
    column('count', '记录数 / Records')
    column('value', '合计 / Sum', plan.unit)
    column('mean', '均值 / Mean', plan.unit)
    column('minimum', '最小值 / Minimum', plan.unit)
    column('maximum', '最大值 / Maximum', plan.unit)
    const layerPoints: StudyChartPoint[] = []
    for (let index = 0; index <= bounds.length; index++) {
      const low = bounds[index - 1]
      const high = bounds[index]
      const label = `[${low ? renderQ(low).exact : '-∞'}, ${high ? renderQ(high).exact : '+∞'})`
      const items = complete.filter(
        (row) => (!low || cmp(num(row), low) >= 0) && (!high || cmp(num(row), high) < 0)
      )
      const cells: Record<string, string> = {
        count: fact(`${label} · 记录数`, q(items.length), items, 'count(band members)')
      }
      if (items.length) {
        const xs = items.map((row) => num(row)).sort(cmp)
        cells.value = fact(`${label} · 合计`, total(xs), items, 'sum(band observations)', plan.unit)
        cells.mean = fact(
          `${label} · 均值`,
          over(total(xs), q(xs.length))!,
          items,
          'sum(band observations) / count',
          plan.unit
        )
        cells.minimum = fact(`${label} · 最小值`, xs[0], items, 'min(band observations)', plan.unit)
        cells.maximum = fact(
          `${label} · 最大值`,
          xs.at(-1)!,
          items,
          'max(band observations)',
          plan.unit
        )
      }
      result.rows.push({ label, values: cells })
      layerPoints.push({ label, valueId: cells.count })
    }
    stat(
      '有效观测 / Valid observations',
      q(complete.length),
      complete,
      'count(complete observations)'
    )
    stat(
      '缺失观测 / Missing observations',
      q(result.missingRows),
      rows.filter((row) => row.numbers[plan.measure] == null),
      'count(missing measure)'
    )
    stat(
      '总体均值 / Population mean',
      over(total(ordered), q(ordered.length))!,
      complete,
      'sum / count',
      plan.unit
    )
    const quartiles = [
      ordered[0],
      quantile(ordered, 1),
      quantile(ordered, 2),
      quantile(ordered, 3),
      ordered.at(-1)!
    ]
    const iqr = minus(quartiles[3], quartiles[1])
    const fenceLow = minus(quartiles[1], times(q('1.5'), iqr))
    const fenceHigh = plus(quartiles[3], times(q('1.5'), iqr))
    const inside = ordered.filter((v) => cmp(v, fenceLow) >= 0 && cmp(v, fenceHigh) <= 0)
    const lower = fact(
      '箱线下须 / Lower whisker',
      inside[0],
      complete,
      'min(observation >= Q1 - 1.5 × IQR)',
      plan.unit
    )
    const q1 = fact(
      '第一四分位 / Q1',
      quartiles[1],
      complete,
      'Type 7: h=(n-1)×0.25, linear interpolation',
      plan.unit
    )
    const median = fact(
      '中位数 / Median',
      quartiles[2],
      complete,
      'Type 7: h=(n-1)×0.5, linear interpolation',
      plan.unit
    )
    const q3 = fact(
      '第三四分位 / Q3',
      quartiles[3],
      complete,
      'Type 7: h=(n-1)×0.75, linear interpolation',
      plan.unit
    )
    const upper = fact(
      '箱线上须 / Upper whisker',
      inside.at(-1)!,
      complete,
      'max(observation <= Q3 + 1.5 × IQR)',
      plan.unit
    )
    result.statistics.push(lower, q1, median, q3, upper)
    const outliers = complete
      .filter((row) => cmp(num(row), fenceLow) < 0 || cmp(num(row), fenceHigh) > 0)
      .map((row) =>
        fact(
          `${rowLabel(row)} · 离群观测`,
          num(row),
          [row],
          'observation beyond 1.5 IQR fences',
          plan.unit
        )
      )
    chart(
      'boxplot',
      [
        {
          label: headers[plan.measure],
          valueId: median,
          lowerId: lower,
          q1Id: q1,
          medianId: median,
          q3Id: q3,
          upperId: upper,
          outlierIds: outliers
        }
      ],
      localized(
        'Type 7 分位数，1.5 IQR；须端为范围内实际观测，离群值保留。',
        'Type 7 quantiles, 1.5 IQR. Whiskers are actual in-fence observations; outliers retained.'
      )
    )
    const bins =
      cmp(ordered[0], ordered.at(-1)!) === 0 ? 1 : Math.ceil(Math.log2(ordered.length) + 1)
    const width = over(minus(ordered.at(-1)!, ordered[0]), q(bins))!
    const histogram: StudyChartPoint[] = []
    for (let i = 0; i < bins; i++) {
      const low = plus(ordered[0], times(width, q(i)))
      const high = plus(ordered[0], times(width, q(i + 1)))
      const items = complete.filter(
        (row) =>
          cmp(num(row), low) >= 0 &&
          (i === bins - 1 ? cmp(num(row), high) <= 0 : cmp(num(row), high) < 0)
      )
      const label = `[${renderQ(low).exact}, ${renderQ(high).exact}${i === bins - 1 ? ']' : ')'}`
      const id = fact(
        `${label} · 频数`,
        q(items.length),
        items,
        `Sturges k=${bins}; interval ${label}`
      )
      result.statistics.push(id)
      histogram.push({ label, valueId: id })
    }
    chart(
      'histogram',
      histogram,
      localized(
        'Sturges 等宽分箱；左闭右开，最后一箱包含右边界。',
        'Sturges equal-width bins. Left-closed/right-open, final bin includes its upper bound.'
      ),
      { unit: '记录 / records' }
    )
    chart('bar', layerPoints, undefined, { unit: '记录 / records' })
  } else if (['matrix-analysis', 'correlation-analysis'].includes(config.method)) {
    requireData(config.secondMeasure && config.secondMeasure !== plan.measure)
    const complete = valid([
      plan.measure,
      config.secondMeasure,
      ...(config.sizeMeasure ? [config.sizeMeasure] : [])
    ])
    requireData(complete.length)
    observed(complete)
    const xs = complete.map((row) => num(row))
    const ys = complete.map((row) => num(row, config.secondMeasure!))
    column('x', headers[plan.measure], plan.unit)
    column('y', headers[config.secondMeasure], config.secondUnit ?? '')
    if (config.sizeMeasure) column('size', headers[config.sizeMeasure], config.sizeUnit ?? '')
    let tx: Q | undefined
    let ty: Q | undefined
    let txId: string | undefined
    let tyId: string | undefined
    if (config.method === 'matrix-analysis') {
      if (config.thresholds) requireData(config.ruleBasis)
      tx = config.thresholds ? q(config.thresholds.x) : quantile([...xs].sort(cmp), 2)
      ty = config.thresholds ? q(config.thresholds.y) : quantile([...ys].sort(cmp), 2)
      txId = stat(
        'X 分界 / X threshold',
        tx,
        config.thresholds ? [] : complete,
        config.thresholds ? `Configuration: ${config.ruleBasis}` : 'Type 7 median',
        plan.unit
      )
      tyId = stat(
        'Y 分界 / Y threshold',
        ty,
        config.thresholds ? [] : complete,
        config.thresholds ? `Configuration: ${config.ruleBasis}` : 'Type 7 median',
        config.secondUnit ?? ''
      )
      check(
        'thresholds',
        'pass',
        config.thresholds
          ? `分界来源：${config.ruleBasis}；等号归入高侧。`
          : '使用完整样本中位数作探索分界，等号归入高侧；不视为业务达标线。',
        config.thresholds
          ? `Threshold basis: ${config.ruleBasis}. Equality is on the high side.`
          : 'Full-sample medians are exploratory thresholds, not business targets. Equality is on the high side.'
      )
      check(
        'axis-meaning',
        'unknown',
        '两轴的业务互补性、单位与行动含义需结合字段定义核对；不要求统计独立。',
        'Business complementarity, units and action meaning require field definitions; statistical independence is not required.'
      )
    }
    const points: StudyChartPoint[] = []
    const quadrants = new Map<string, StudyInputRow[]>()
    for (let i = 0; i < complete.length; i++) {
      const row = complete[i]
      const label = rowLabel(row)
      const x = fact(
        `${label} · ${headers[plan.measure]}`,
        xs[i],
        [row],
        `${plan.measure}${row.row}`,
        plan.unit
      )
      const y = fact(
        `${label} · ${headers[config.secondMeasure]}`,
        ys[i],
        [row],
        `${config.secondMeasure}${row.row}`,
        config.secondUnit ?? ''
      )
      const size = config.sizeMeasure
        ? fact(
            `${label} · ${headers[config.sizeMeasure]}`,
            num(row, config.sizeMeasure),
            [row],
            `${config.sizeMeasure}${row.row}`,
            config.sizeUnit ?? ''
          )
        : undefined
      let description = ''
      if (tx && ty) {
        const axisX = cmp(xs[i], tx) >= 0 ? 'X≥阈值 / X high' : 'X<阈值 / X low'
        const axisY = cmp(ys[i], ty) >= 0 ? 'Y≥阈值 / Y high' : 'Y<阈值 / Y low'
        description = `${axisX}; ${axisY}`
        const list = quadrants.get(description) ?? []
        list.push(row)
        quadrants.set(description, list)
      }
      result.rows.push({ label, description, values: { x, y, ...(size ? { size } : {}) } })
      points.push({ label, valueId: y, xId: x, yId: y, ...(size ? { sizeId: size } : {}) })
    }
    chart('scatter', points, undefined, {
      xLabel: headers[plan.measure] + (plan.unit ? ` (${plan.unit})` : ''),
      yLabel: headers[config.secondMeasure] + (config.secondUnit ? ` (${config.secondUnit})` : ''),
      xThresholdId: txId,
      yThresholdId: tyId,
      unit: config.secondUnit ?? ''
    })
    if (config.sizeMeasure && complete.every((row) => num(row, config.sizeMeasure!).n >= 0n))
      chart(
        'bubble',
        points,
        localized(
          '气泡面积与非负规模值成比例；零规模不绘制面积，精确值保留。',
          'Bubble area is proportional to nonnegative size. Zero size has zero area; exact values are retained.'
        ),
        {
          xLabel: headers[plan.measure],
          yLabel: headers[config.secondMeasure],
          xThresholdId: txId,
          yThresholdId: tyId,
          unit: config.secondUnit ?? ''
        }
      )
    if (tx && ty) {
      const heatmap: StudyChartPoint[] = []
      for (const axisX of ['X<阈值 / X low', 'X≥阈值 / X high'])
        for (const axisY of ['Y<阈值 / Y low', 'Y≥阈值 / Y high']) {
          const items = quadrants.get(`${axisX}; ${axisY}`) ?? []
          const id = stat(
            `${axisX}; ${axisY} · 观测数`,
            q(items.length),
            items,
            'count(quadrant members)'
          )
          heatmap.push({ label: axisX, series: axisY, valueId: id })
        }
      chart('heatmap', heatmap, undefined, {
        xLabel: headers[plan.measure],
        yLabel: headers[config.secondMeasure],
        unit: '记录 / records'
      })
    }
    stat('有效配对 / Valid pairs', q(complete.length), complete, 'count(complete pairs)')
    if (config.method === 'correlation-analysis') {
      const method = config.correlation ?? 'pearson'
      const coef = correlation(
        method === 'spearman' ? ranks(xs) : xs,
        method === 'spearman' ? ranks(ys) : ys
      )
      if (coef.value !== null) {
        const id = stat(
          `${method === 'spearman' ? 'Spearman ρ' : 'Pearson r'} (近似 / approximate)`,
          q(coef.value),
          complete,
          `${method === 'spearman' ? 'Average tied ranks; ' : ''}${coef.formula}`
        )
        valueFor(id).exact = coef.formula
        valueFor(id).approximate = true
      }
      check(
        'coefficient',
        coef.value === null ? 'unknown' : 'pass',
        coef.value === null
          ? '样本不足两对或变量恒定，相关系数未定义；不显示为零。'
          : `采用 ${method}，统计量和精确计算表达式已保存，系数近似显示。`,
        coef.value === null
          ? 'Fewer than two pairs or a constant variable: the coefficient is undefined, not zero.'
          : `${method} sufficient statistics and the exact expression are retained; the displayed coefficient is approximate.`
      )
      check(
        'causality',
        'unknown',
        '未检验混杂、时序滞后或独立性；本结果只说明样本关联，不报告因果、显著性或预测。',
        'Confounders, lag and independence were not tested. Results describe sample association, not causation, significance or prediction.'
      )
    }
  } else if (config.method === 'metric-decomposition') {
    requireData(config.factors && config.identity && config.ruleBasis)
    requireData(
      new Set(config.factors).size === config.factors.length &&
        !config.factors.includes(plan.measure)
    )
    if (config.identity === 'ratio') requireData(config.factors.length === 2)
    const complete = valid([plan.measure, ...config.factors])
    requireData(complete.length)
    observed(complete)
    column('observed', headers[plan.measure], plan.unit)
    config.factors.forEach((f, i) => column(`factor${i + 1}`, headers[f]))
    column('computed', '公式计算 / Computed', plan.unit)
    column('residual', '残差 / Residual', plan.unit)
    let mismatches = 0
    let zero = 0
    const factorPoints: StudyChartPoint[] = []
    for (const row of complete) {
      const label = rowLabel(row)
      const factors = config.factors.map((c) => num(row, c))
      const observedValue = num(row)
      const computed =
        config.identity === 'sum'
          ? total(factors)
          : config.identity === 'product'
            ? factors.reduce(times, q(1))
            : over(factors[0], factors[1])
      const formula = factors
        .map((v) => `(${renderQ(v).exact})`)
        .join(config.identity === 'sum' ? ' + ' : config.identity === 'product' ? ' × ' : ' / ')
      const cells: Record<string, string> = {
        observed: fact(
          `${label} · 实际指标`,
          observedValue,
          [row],
          `${plan.measure}${row.row}`,
          plan.unit
        )
      }
      factors.forEach((v, i) => {
        cells[`factor${i + 1}`] = fact(
          `${label} · ${headers[config.factors![i]]}`,
          v,
          [row],
          `${config.factors![i]}${row.row}`
        )
        factorPoints.push({
          label,
          series: headers[config.factors![i]],
          valueId: cells[`factor${i + 1}`]
        })
      })
      if (computed) {
        cells.computed = fact(`${label} · 公式计算`, computed, [row], formula, plan.unit)
        const residual = minus(observedValue, computed)
        cells.residual = fact(
          `${label} · 残差`,
          residual,
          [row],
          `${renderQ(observedValue).exact} - (${formula})`,
          plan.unit
        )
        if (residual.n) mismatches++
      } else zero++
      result.rows.push({ label, values: cells })
    }
    check(
      'identity',
      mismatches ? 'fail' : zero ? 'unknown' : 'pass',
      `恒等关系来源：${config.ruleBasis}；不一致 ${mismatches} 条，零分母 ${zero} 条。`,
      `Identity basis: ${config.ruleBasis}. ${mismatches} mismatches and ${zero} zero denominators.`
    )
    chart(
      'bar',
      result.rows.map((row) => ({ label: row.label, valueId: row.values.observed }))
    )
    if (config.identity === 'sum') {
      chart('stacked', factorPoints)
      const contributions = config.factors.map((factor) => ({
        label: headers[factor],
        valueId: stat(
          `${headers[factor]} · 因素合计`,
          total(complete.map((row) => num(row, factor))),
          complete,
          `sum(${factor})`,
          plan.unit
        )
      }))
      const observedTotal = total(complete.map((row) => num(row)))
      const factorsTotal = total(
        config.factors.map((f) => total(complete.map((row) => num(row, f))))
      )
      contributions.push({
        label: '残差 / Residual',
        valueId: stat(
          '总体残差 / Total residual',
          minus(observedTotal, factorsTotal),
          complete,
          'sum(observed) - sum(factors)',
          plan.unit
        )
      })
      accumulation(contributions, complete)
      if (factorPoints.every((p) => q(valueFor(p.valueId).value).n >= 0n) && !mismatches) {
        const percentages: StudyChartPoint[] = []
        for (const row of result.rows) {
          const denom = q(valueFor(row.values.observed).value)
          if (!denom.n) continue
          for (let i = 0; i < config.factors.length; i++) {
            const id = row.values[`factor${i + 1}`]
            percentages.push({
              label: row.label,
              series: headers[config.factors[i]],
              valueId: fact(
                `${row.label} · ${headers[config.factors[i]]} · 占比`,
                over(times(q(valueFor(id).value), q(100)), denom)!,
                complete,
                `${valueFor(id).exact} / ${renderQ(denom).exact} × 100`,
                '%'
              )
            })
          }
        }
        if (percentages.length)
          chart(
            'percent_stacked',
            percentages,
            localized(
              '每个分类以本分类非负系列合计为分母；零合计时百分比未定义，完整原值保留在结果表。',
              'Each category uses its own nonnegative series total as denominator. Zero totals have undefined percentages; original values remain in the table.'
            ),
            { unit: '%' }
          )
      }
    }
  } else if (config.method === 'funnel-analysis') {
    requireData(config.stages && config.window && config.ruleBasis)
    requireData(new Set(config.stages).size === config.stages.length)
    const complete = valid(config.stages)
    requireData(complete.length)
    observed(complete)
    const duration = config.funnelMode === 'duration'
    if (!duration) requireData(config.observationBy)
    requireData(
      complete.every((row) =>
        config.stages!.every(
          (stage) =>
            num(row, stage).n >= 0n &&
            (duration || ['0', '1'].includes(renderQ(num(row, stage)).value))
        )
      )
    )
    let unordered = 0
    if (!duration)
      for (const row of complete)
        if (
          config.stages.some(
            (stage, i) => i > 0 && cmp(num(row, stage), num(row, config.stages![i - 1])) > 0
          )
        )
          unordered++
    check(
      'ordered',
      unordered ? 'fail' : 'pass',
      `同一对象逐阶段检查，违反嵌套顺序 ${unordered} 条。`,
      `Checked nested stages per object; ${unordered} violations.`
    )
    check(
      'window',
      config.windowComplete ? 'pass' : 'unknown',
      `窗口：${config.window}；来源：${config.ruleBasis}；${config.windowComplete ? '已声明观测成熟。' : '窗口成熟度未声明，转化仅为当前记录值。'}`,
      `Window: ${config.window}; basis: ${config.ruleBasis}; ${config.windowComplete ? 'observation maturity declared.' : 'maturity unknown; conversions describe recorded observations only.'}`
    )
    const stageValues = config.stages.map((stage) =>
      duration
        ? over(total(complete.map((row) => num(row, stage))), q(complete.length))!
        : total(complete.map((row) => num(row, stage)))
    )
    if (!duration && stageValues.some((value) => !value.n))
      check(
        'zero-stage',
        'unknown',
        '存在零阶段总量，对应相邻或总体转化率未定义，原阶段计数保留。',
        'A stage total is zero; corresponding conversion rates are undefined and original counts are retained.'
      )
    const points: StudyChartPoint[] = []
    let cumulative = q(0)
    column(
      'value',
      duration ? '平均步骤时长 / Mean step duration' : '阶段对象数 / Stage objects',
      duration ? plan.unit : ''
    )
    column(
      'loss',
      duration ? '累计平均时长 / Cumulative mean duration' : '相邻流失 / Adjacent loss',
      duration ? plan.unit : ''
    )
    if (!duration) {
      column('conversion', '相邻转化率 / Adjacent conversion', '%')
      column('overall', '总体转化率 / Overall conversion', '%')
    }
    for (let i = 0; i < config.stages.length; i++) {
      const stage = config.stages[i]
      const label = headers[stage]
      const value = stageValues[i]
      const id = fact(
        label,
        value,
        complete,
        `${duration ? 'mean' : 'sum'}(${stage})`,
        duration ? plan.unit : ''
      )
      const cells: Record<string, string> = { value: id }
      cumulative = plus(cumulative, value)
      if (duration)
        cells.loss = fact(
          `${label} · 累计平均时长`,
          cumulative,
          complete,
          `sum(mean(step 1..${i + 1}))`,
          plan.unit
        )
      else if (!unordered) {
        if (i) {
          cells.loss = fact(
            `${label} · 相邻流失`,
            minus(stageValues[i - 1], value),
            complete,
            `${renderQ(stageValues[i - 1]).exact} - ${renderQ(value).exact}`
          )
          const rate = over(times(value, q(100)), stageValues[i - 1])
          if (rate)
            cells.conversion = fact(
              `${label} · 相邻转化率`,
              rate,
              complete,
              `${renderQ(value).exact} / ${renderQ(stageValues[i - 1]).exact} × 100`,
              '%'
            )
        }
        const overall = over(times(value, q(100)), stageValues[0])
        if (overall)
          cells.overall = fact(
            `${label} · 总体转化率`,
            overall,
            complete,
            `${renderQ(value).exact} / ${renderQ(stageValues[0]).exact} × 100`,
            '%'
          )
      }
      result.rows.push({ label, values: cells })
      points.push({ label, valueId: id })
    }
    if (!duration)
      stat(
        '未进入首层 / Outside first stage',
        q(complete.filter((row) => num(row, config.stages![0]).n === 0n).length),
        complete,
        'count(first stage = 0)'
      )
    chart('bar', points, undefined, { unit: duration ? plan.unit : '对象 / objects' })
    if (duration)
      chart(
        'line',
        points,
        localized(
          '无流失流程以时长衡量，不计算人数转化率。',
          'No-attrition flows use duration, without count conversion rates.'
        )
      )
    else if (!unordered)
      chart(
        'funnel',
        points,
        localized(
          '同一批对象按原始阶段顺序绘制；相邻与总体转化率分别保存。',
          'The same cohort is shown in the original stage order; adjacent and overall conversion rates are separate.'
        )
      )
  }
  check(
    'input-missing',
    result.missingRows ? 'unknown' : 'pass',
    `必需数值或时间缺失 ${result.missingRows} 条，未补零；完整输入与原始字段保存在依据中。`,
    `${result.missingRows} records lack required numeric/date values and were not replaced with zero. Original fields are retained as evidence.`
  )
  table()
  if (!result.charts.some((chart) => chart.kind === config.chart))
    throw new AnalysisError('CHART_NOT_APPLICABLE')
  if (!values.length) throw new AnalysisError('NO_ROWS')
  const evidenceId = `excel:${runId}`
  const run: AnalysisRun = {
    id: runId,
    createdAt: new Date().toISOString(),
    source,
    plan,
    measureLabel: headers[plan.measure] || rule.title.zh,
    groupLabel: headers[plan.groupBy] || '',
    evidenceId,
    scannedRows,
    matchedRows: rows.length,
    emptyRows,
    values,
    warnings,
    execution: {
      engine: 'semapath-excel/1',
      durationMs: Math.round((performance.now() - started) * 100) / 100,
      plan: JSON.stringify(plan, null, 2),
      stdout: JSON.stringify({
        method: config.method,
        ruleVersion: rule.version,
        matchedRows: rows.length,
        missingRows: result.missingRows,
        values: values.length,
        inputSha256: source.sha256
      })
    },
    chart: { kind: config.chart, evidenceId },
    study: result,
    answer: { status: 'draft', candidateHash: '', publishedAt: null }
  }
  if (Buffer.byteLength(JSON.stringify(run), 'utf8') > 28 * 1024 * 1024)
    throw new AnalysisError('METHOD_DATA_LIMIT')
  return run
}
