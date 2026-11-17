import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as XLSX from 'xlsx'
import {
  AnalysisPlanSchema,
  AnalysisRunSchema,
  type AnalysisPlan,
  type AnalysisRun,
  type AnalysisTask
} from '@shared/analysis'
import { ANALYSIS_CHARTS, type StudyPlan, type ChartKind } from '@shared/analysisStudy'
import { heatmapForeground, renderStudyCharts } from '@shared/analysisChartSvg'
import { calculateWorkbook, loadWorkbook, type LoadedWorkbook } from '@/analysis/workbook'
import { candidateHash } from '@/analysis/service'
import { planningPrompt, reviewPrompt } from '@/analysis/naturalPrompts'
import { describeWorkbook } from '@/analysis/workbook'
import { freezeReportAnswer, validateReportSnapshot } from '@/analysis/reports/snapshot'
import { buildReportDocument, reportExpectedTokens } from '@/analysis/reports/document'
let directory: string
let loaded: LoadedWorkbook
const rows: unknown[][] = [
  [
    '对象',
    '日期',
    '区域',
    '系列',
    '金额',
    'Y指标',
    '规模',
    '因素一',
    '因素二',
    '实际指标',
    '访问',
    '注册',
    '支付',
    '时长一',
    '时长二'
  ],
  ['甲', '2026-01-01', '东', '线上', 0.1, 2, 10, 0.1, 0.2, 0.3, 1, 1, 1, 2, 3],
  ['乙', '2026-02-01', '东', '线下', 0.2, 4, 20, 2, 3, 5, 1, 1, 0, 4, 5],
  ['丙', '2026-04-01', '南', '线上', 10, 20, 0, -2, 3, 1, 1, 0, 0, 6, 7],
  ['丁', '2026-05-01', '南', '线下', null, 99, 5, 1, 1, 2, 0, 0, 0, 8, 9]
]
async function fixture(data: unknown[][] = rows) {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(data), '明细')
  const file = path.join(directory, 'synthetic-methods.xlsx')
  await writeFile(file, XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }))
  return loadWorkbook(file)
}
function run(study: StudyPlan, overrides: Partial<AnalysisPlan> = {}): AnalysisRun {
  return AnalysisRunSchema.parse(
    calculateWorkbook(
      loaded,
      loaded.source,
      AnalysisPlanSchema.parse({
        sourceId: loaded.source.id,
        sheet: '明细',
        headerRow: 1,
        operation: 'sum',
        measure: 'E',
        groupBy: 'C',
        unit: '元',
        question: '合成方法验收',
        period: '2026',
        filters: [],
        study,
        ...overrides
      })
    )
  )
}
const metric = (result: AnalysisRun, id: string) => result.values.find((v) => v.id === id)!
const cell = (result: AnalysisRun, row: number, column: string) =>
  metric(result, result.study!.rows[row].values[column])
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'semapath-methods-'))
  loaded = await fixture()
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})
describe('Nine methods: full-data calculations and provenance', () => {
  it('compares adjacent real periods, breaks gaps and retains missing / closed-period uncertainty', () => {
    const result = run(
      { method: 'cycle-analysis', chart: 'line', interval: 'month' },
      { groupBy: 'B' }
    )
    expect(result.study!.rows.map((r) => r.label)).toEqual(['2026-01', '2026-02', '2026-04'])
    expect(cell(result, 1, 'difference').value).toBe('0.1')
    expect(cell(result, 1, 'change').value).toBe('100')
    expect(result.study!.rows[2].values.difference).toBeUndefined()
    expect(result.study!.charts[0].points[2].breakBefore).toBe(true)
    expect(result.study!.checks.find((c) => c.key === 'period-closed')?.state).toBe('unknown')
    expect(result.study!.missingRows).toBe(1)
    expect(cell(result, 1, 'difference').inputs).toEqual(
      expect.arrayContaining([
        { row: 2, cell: 'E2', value: '0.1' },
        { row: 3, cell: 'E3', value: '0.2' },
        { row: 2, cell: 'B2', value: '2026-01-01' }
      ])
    )
  })
  it('reconciles exact additive structure and measure shares rather than record shares', () => {
    const result = run({ method: 'structure-analysis', chart: 'pie' })
    expect(cell(result, 0, 'value').value).toBe('0.3')
    expect(cell(result, 0, 'share').value).toBe('2.912621359223')
    expect(cell(result, 0, 'recordShare').value).toBe('50')
    expect(cell(result, 0, 'share').rational).toEqual({ numerator: '300', denominator: '103' })
    expect(result.study!.checks.find((c) => c.key === 'reconciliation')?.state).toBe('pass')
    expect(() =>
      run({ method: 'structure-analysis', chart: 'bar' }, { operation: 'average' })
    ).toThrow('METHOD_REQUIREMENTS')
  })
  it('retains signed contributions and rejects misleading composition charts', async () => {
    loaded = await fixture([
      rows[0],
      ['甲', '2026-01-01', '东', '线上', -2],
      ['乙', '2026-01-02', '南', '线下', 3]
    ])
    const result = run({ method: 'structure-analysis', chart: 'waterfall' })
    expect(cell(result, 0, 'value').value).toBe('-2')
    expect(result.study!.rows[0].values.share).toBeUndefined()
    expect(() => run({ method: 'structure-analysis', chart: 'pie' })).toThrow(
      'CHART_NOT_APPLICABLE'
    )
    const final = result.study!.charts.find((c) => c.kind === 'waterfall')!.points.at(-1)!
    expect(metric(result, final.valueId).value).toBe('1')
  })
  it('retains real joint categories and exact within-category percentage denominators', () => {
    const result = run({ method: 'structure-analysis', chart: 'percent_stacked', seriesBy: 'D' })
    const plotted = result.study!.charts.find((c) => c.kind === 'percent_stacked')!.points
    expect(metric(result, plotted[0].valueId).value).toBe('33.333333333333')
    expect(metric(result, plotted[0].valueId).rational).toEqual({
      numerator: '100',
      denominator: '3'
    })
    expect(result.study!.charts.some((c) => c.kind === 'heatmap')).toBe(true)
  })
  it('uses Type 7 quartiles, actual Tukey whiskers, complete histogram counts and retained outliers', async () => {
    loaded = await fixture([
      ['对象', '值'],
      ['a', 1],
      ['b', 1],
      ['c', 1],
      ['d', 1],
      ['e', 96],
      ['f', null]
    ])
    const result = run(
      { method: 'stratification-analysis', chart: 'boxplot', observationBy: 'A' },
      { measure: 'B', groupBy: '' }
    )
    const box = result.study!.charts.find((c) => c.kind === 'boxplot')!.points[0]
    expect(
      [box.q1Id, box.medianId, box.q3Id, box.lowerId, box.upperId].map(
        (id) => metric(result, id!).value
      )
    ).toEqual(['1', '1', '1', '1', '1'])
    expect(box.outlierIds!.map((id) => metric(result, id).value)).toEqual(['96'])
    expect(result.study!.missingRows).toBe(1)
    const bins = result.study!.charts.find((c) => c.kind === 'histogram')!.points
    expect(bins.reduce((n, p) => n + Number(metric(result, p.valueId).value), 0)).toBe(5)
  })
  it('respects explicit layer equality, negative values, rule basis and unsorted-threshold rejection', async () => {
    loaded = await fixture([
      ['对象', '值'],
      ['a', -1],
      ['b', 0],
      ['c', 20]
    ])
    const result = run(
      {
        method: 'stratification-analysis',
        chart: 'bar',
        boundaries: ['0', '20'],
        ruleBasis: '业务标准'
      },
      { measure: 'B', groupBy: '' }
    )
    expect(result.study!.rows.map((_, i) => cell(result, i, 'count').value)).toEqual([
      '1',
      '1',
      '1'
    ])
    expect(() =>
      run(
        {
          method: 'stratification-analysis',
          chart: 'bar',
          boundaries: ['20', '0'],
          ruleBasis: '业务标准'
        },
        { measure: 'B', groupBy: '' }
      )
    ).toThrow('METHOD_REQUIREMENTS')
    expect(() =>
      run(
        { method: 'stratification-analysis', chart: 'bar', boundaries: ['20'] },
        { measure: 'B', groupBy: '' }
      )
    ).toThrow('METHOD_REQUIREMENTS')
  })
  it('assigns matrix equality to high sides and links thresholds and both axes to evidence', () => {
    const result = run({
      method: 'matrix-analysis',
      chart: 'bubble',
      secondMeasure: 'F',
      sizeMeasure: 'G',
      observationBy: 'A',
      thresholds: { x: '0.2', y: '4' },
      ruleBasis: '已确认标准'
    })
    expect(result.study!.rows[1].description).toContain('X high')
    expect(result.study!.rows[1].description).toContain('Y high')
    expect(result.study!.missingRows).toBe(1)
    const heat = result.study!.charts.find((c) => c.kind === 'heatmap')!
    expect(heat.points.reduce((sum, p) => sum + Number(metric(result, p.valueId).value), 0)).toBe(3)
    expect(cell(result, 1, 'x').inputs).toContainEqual({ row: 3, cell: 'F3', value: '4' })
  })
  it('checks additive metric identities exactly, preserves residuals and uses all factors in waterfall', () => {
    const result = run(
      {
        method: 'metric-decomposition',
        chart: 'waterfall',
        factors: ['H', 'I'],
        identity: 'sum',
        ruleBasis: '实际指标 = 因素一 + 因素二',
        observationBy: 'A'
      },
      { measure: 'J', groupBy: '' }
    )
    expect(cell(result, 0, 'computed').value).toBe('0.3')
    expect(cell(result, 0, 'residual').value).toBe('0')
    expect(result.study!.checks.find((c) => c.key === 'identity')?.state).toBe('pass')
    expect(cell(result, 0, 'computed').inputs).toContainEqual({ row: 2, cell: 'H2', value: '0.1' })
    expect(cell(result, 0, 'computed').formula).toContain('(0.1) + (0.2)')
  })
  it('does not invent ratio results at zero denominators or conceal identity mismatches', async () => {
    loaded = await fixture([
      ['对象', '实际', '分子', '分母'],
      ['a', 1, 1, 0],
      ['b', 2, 3, 2]
    ])
    const result = run(
      {
        method: 'metric-decomposition',
        chart: 'table',
        factors: ['C', 'D'],
        identity: 'ratio',
        ruleBasis: '实际=分子/分母'
      },
      { measure: 'B', groupBy: '' }
    )
    expect(result.study!.rows[0].values.computed).toBeUndefined()
    expect(cell(result, 1, 'residual').value).toBe('0.5')
    expect(result.study!.checks.find((c) => c.key === 'identity')?.state).toBe('fail')
  })
  it('calculates linked-cohort adjacent and overall funnel conversions separately', () => {
    const result = run(
      {
        method: 'funnel-analysis',
        chart: 'funnel',
        stages: ['K', 'L', 'M'],
        observationBy: 'A',
        window: '同批七天',
        ruleBasis: '用户事件标记',
        windowComplete: true
      },
      { operation: 'count', measure: '', groupBy: '' }
    )
    expect(cell(result, 1, 'conversion').value).toBe('66.666666666667')
    expect(cell(result, 2, 'conversion').value).toBe('50')
    expect(cell(result, 2, 'overall').value).toBe('33.333333333333')
    expect(result.study!.checks.find((c) => c.key === 'window')?.state).toBe('pass')
  })
  it('rejects malformed or duplicate cohort objects and allows failure disclosure in a table', async () => {
    loaded = await fixture([
      ['对象', '访问', '支付'],
      ['a', 0, 1],
      ['b', 1, 1]
    ])
    const options: StudyPlan = {
      method: 'funnel-analysis',
      chart: 'table',
      stages: ['B', 'C'],
      observationBy: 'A',
      window: '七天',
      ruleBasis: '事件'
    }
    const result = run(options, { operation: 'count', measure: '', groupBy: '' })
    expect(result.study!.checks.find((c) => c.key === 'ordered')?.state).toBe('fail')
    expect(result.study!.rows[1].values.conversion).toBeUndefined()
    expect(() =>
      run({ ...options, chart: 'funnel' }, { operation: 'count', measure: '', groupBy: '' })
    ).toThrow('CHART_NOT_APPLICABLE')
    loaded = await fixture([
      ['对象', '访问', '支付'],
      ['a', 1, 1],
      ['a', 1, 0]
    ])
    expect(() => run(options, { operation: 'count', measure: '', groupBy: '' })).toThrow(
      'METHOD_REQUIREMENTS'
    )
  })
  it('uses duration rather than conversion for no-attrition flows', () => {
    const result = run(
      {
        method: 'funnel-analysis',
        chart: 'line',
        stages: ['N', 'O'],
        funnelMode: 'duration',
        observationBy: 'A',
        window: '同批服务',
        ruleBasis: '步骤耗时'
      },
      { operation: 'count', measure: '', groupBy: '', unit: '分钟' }
    )
    expect(cell(result, 0, 'value').value).toBe('5')
    expect(cell(result, 1, 'value').value).toBe('6')
    expect(cell(result, 1, 'loss').value).toBe('11')
    expect(result.study!.columns.some((c) => c.key === 'conversion')).toBe(false)
  })
  it('computes Pearson and tied Spearman using aligned complete pairs; constants remain undefined', async () => {
    loaded = await fixture([
      ['对象', 'X', 'Y'],
      ['a', 1, 2],
      ['b', 2, 4],
      ['c', 2, 4],
      ['d', 3, 6],
      ['e', null, 7]
    ])
    for (const correlation of ['pearson', 'spearman'] as const) {
      const result = run(
        {
          method: 'correlation-analysis',
          chart: 'scatter',
          secondMeasure: 'C',
          correlation,
          observationBy: 'A'
        },
        { measure: 'B', groupBy: '' }
      )
      expect(result.values.find((v) => v.approximate)?.value).toBe('1')
      expect(result.study!.missingRows).toBe(1)
    }
    loaded = await fixture([
      ['对象', 'X', 'Y'],
      ['a', 1, 2],
      ['b', 1, 4]
    ])
    const constant = run(
      { method: 'correlation-analysis', chart: 'scatter', secondMeasure: 'C' },
      { measure: 'B', groupBy: '' }
    )
    expect(constant.values.some((v) => v.approximate)).toBe(false)
    expect(constant.study!.checks.find((c) => c.key === 'coefficient')?.state).toBe('unknown')
  })
  it('preserves overlapping labels, unmatched records and empty declared labels without double-counting MECE', () => {
    const rules = [
      {
        label: '非负',
        conditions: [{ column: 'E', operator: 'gte' as const, kind: 'number' as const, value: '0' }]
      },
      {
        label: '较小',
        conditions: [{ column: 'E', operator: 'lte' as const, kind: 'number' as const, value: '1' }]
      },
      {
        label: '空组',
        conditions: [
          { column: 'E', operator: 'lt' as const, kind: 'number' as const, value: '-100' }
        ]
      }
    ]
    const label = run({ method: 'label-analysis', chart: 'table', rules, ruleBasis: '合成规则' })
    expect(label.study!.checks.find((c) => c.key === 'membership')?.state).toBe('fail')
    expect(label.study!.rows.find((r) => r.label === '空组')).toBeDefined()
    const mece = run(
      { method: 'mece-decomposition', chart: 'table', rules, ruleBasis: '合成规则' },
      { operation: 'count', measure: '' }
    )
    expect(mece.study!.rows.find((r) => r.label.includes('Multiple membership'))).toBeDefined()
    expect(
      mece.study!.rows.reduce((sum, r) => sum + Number(metric(mece, r.values.count).value), 0)
    ).toBe(4)
  })
  it('retains blank and literal blank categories separately and marks unclassified coverage unknown', async () => {
    loaded = await fixture([
      ['类别', '值'],
      ['', 1],
      ['(空白 / Blank)', 2],
      ['其他', 3]
    ])
    const result = run(
      { method: 'mece-decomposition', chart: 'table' },
      { measure: 'B', groupBy: 'A' }
    )
    expect(result.study!.rows).toHaveLength(3)
    expect(result.study!.checks.find((c) => c.key === 'coverage')?.state).toBe('unknown')
    expect(result.study!.rows.map((row) => metric(result, row.values.value).value)).toEqual([
      '1',
      '2',
      '3'
    ])
  })
  it('never merges colliding blank display labels into a misleading joint heatmap', async () => {
    loaded = await fixture([
      ['类别', '值', '系列'],
      ['', 1, '同组'],
      ['(空白 / Blank)', 2, '同组']
    ])
    const result = run(
      { method: 'structure-analysis', chart: 'table', seriesBy: 'C' },
      { measure: 'B', groupBy: 'A' }
    )
    expect(result.study!.rows).toHaveLength(2)
    expect(result.study!.charts.some((chart) => ['heatmap', 'stacked'].includes(chart.kind))).toBe(
      false
    )
    expect(result.study!.checks.find((check) => check.key === 'display-labels')?.state).toBe(
      'unknown'
    )
    expect(() =>
      run(
        { method: 'structure-analysis', chart: 'heatmap', seriesBy: 'C' },
        { measure: 'B', groupBy: 'A' }
      )
    ).toThrow('CHART_NOT_APPLICABLE')
  })
  it('uses exact sufficient statistics for large integer correlations and correct average tied ranks', async () => {
    loaded = await fixture([
      ['对象', 'X', 'Y'],
      ['a', '9007199254740993', 1],
      ['b', '9007199254740994', 2],
      ['c', '9007199254740995', 3]
    ])
    const exact = run(
      { method: 'correlation-analysis', chart: 'table', secondMeasure: 'C' },
      { measure: 'B', groupBy: '' }
    )
    expect(exact.values.find((v) => v.approximate)?.value).toBe('1')
    loaded = await fixture([
      ['对象', 'X', 'Y'],
      ['a', 1, 1],
      ['b', 2, 3],
      ['c', 2, 2],
      ['d', 3, 4]
    ])
    const tied = run(
      {
        method: 'correlation-analysis',
        chart: 'table',
        secondMeasure: 'C',
        correlation: 'spearman'
      },
      { measure: 'B', groupBy: '' }
    )
    expect(tied.values.find((v) => v.approximate)?.value).toBe('0.948683298051')
  })
  it('keeps schema and method context bounded for a normal 32K model after four follow-ups', () => {
    const result = run(
      { method: 'cycle-analysis', chart: 'line', interval: 'month' },
      { groupBy: 'B' }
    )
    const { question: _question, unit: _unit, period: _period, ...query } = result.plan
    const plan = {
      status: 'ready' as const,
      queries: [{ ...query, key: 'q1' }],
      views: [{ kind: 'method' as const, queryKey: 'q1', chart: 'line' as const }]
    }
    const model = {
      providerId: 'fixture',
      modelId: 'fixture',
      providerName: 'Fixture',
      modelName: 'Fixture',
      isDefault: true
    }
    const turns = Array.from({ length: 4 }, (_, i) => ({
      id: randomUUID(),
      createdAt: result.createdAt,
      question: `查看第 ${i + 1} 次期间比较并核对缺失范围`,
      model,
      state: 'answered' as const,
      message: '',
      plan,
      queryRuns: [{ key: 'q1', runId: result.id }],
      derived: [],
      review: { version: 'natural/1' as const, modelCalls: 2, confirmed: true },
      answer: {
        status: 'published' as const,
        candidateHash: 'a'.repeat(64),
        publishedAt: result.createdAt
      }
    }))
    const task: AnalysisTask = {
      version: 1,
      id: randomUUID(),
      title: 'Bounded follow-up',
      createdAt: result.createdAt,
      updatedAt: result.createdAt,
      sources: [result.source],
      runs: [result],
      turns
    }
    for (const prompt of [
      planningPrompt('继续比较本轮期间', task, [describeWorkbook(loaded, loaded.source)]),
      reviewPrompt('继续比较本轮期间', task, plan, new Map([['q1', result]]))
    ]) {
      expect(Math.ceil(Buffer.byteLength(prompt, 'utf8') / 2) + 8192).toBeLessThanOrEqual(32768)
      expect(prompt).toContain('$defs')
    }
  })
  it('keeps source-version, formula-cache, capacity and applicability boundaries', async () => {
    expect(() =>
      calculateWorkbook(
        loaded,
        { ...loaded.source, sha256: 'changed' },
        AnalysisPlanSchema.parse({
          sourceId: loaded.source.id,
          sheet: '明细',
          headerRow: 1,
          operation: 'sum',
          measure: 'E',
          study: { method: 'structure-analysis', chart: 'bar' },
          groupBy: 'C'
        })
      )
    ).toThrow('SOURCE_CHANGED')
    loaded = await fixture([
      ['对象', '值'],
      ...Array.from({ length: 2001 }, (_, i) => [String(i), 1])
    ])
    expect(() =>
      run({ method: 'stratification-analysis', chart: 'table' }, { measure: 'B', groupBy: '' })
    ).toThrow('METHOD_DATA_LIMIT')
  })
})
describe('All fourteen chart types and frozen published reports', () => {
  it('renders all fourteen types from real calculated values, with safe evidence links and full frozen results', () => {
    const runs = [
      run({ method: 'cycle-analysis', chart: 'line', interval: 'month' }, { groupBy: 'B' }),
      run({ method: 'structure-analysis', chart: 'pie' }),
      run({ method: 'structure-analysis', chart: 'stacked', seriesBy: 'D' }),
      run({ method: 'stratification-analysis', chart: 'boxplot' }),
      run({ method: 'matrix-analysis', chart: 'bubble', secondMeasure: 'F', sizeMeasure: 'G' }),
      run(
        {
          method: 'funnel-analysis',
          chart: 'funnel',
          stages: ['K', 'L', 'M'],
          observationBy: 'A',
          window: '七天',
          ruleBasis: '事件'
        },
        { operation: 'count', measure: '', groupBy: '' }
      )
    ]
    const available = new Map<
      ChartKind,
      { run: AnalysisRun; chart: NonNullable<AnalysisRun['study']>['charts'][number] }
    >()
    for (const result of runs)
      for (const chart of result.study!.charts) available.set(chart.kind, { run: result, chart })
    expect([...available.keys()].sort()).toEqual([...ANALYSIS_CHARTS].sort())
    for (const kind of ANALYSIS_CHARTS) {
      const sample = available.get(kind)!
      const result = structuredClone(sample.run)
      result.chart.kind = kind
      result.plan.study!.chart = kind
      result.answer.candidateHash = candidateHash(result)
      result.answer.status = 'published'
      result.answer.publishedAt = result.createdAt
      const task: AnalysisTask = {
        version: 1,
        id: randomUUID(),
        title: '合成图表验收',
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
        sources: [result.source],
        runs: [result],
        turns: []
      }
      const snapshot = freezeReportAnswer(task, {
        kind: 'run',
        id: result.id,
        candidateHash: result.answer.candidateHash
      })
      const html = buildReportDocument(
        snapshot,
        { title: '合成方法与图表', format: 'a4', locale: 'zh-CN' },
        'a'.repeat(64)
      )
      expect(html).toContain(result.source.sha256)
      expect(html).toContain('方法自检')
      expect(reportExpectedTokens(snapshot)).toContain(result.values.at(-1)!.value)
      expect(JSON.stringify(snapshot)).not.toContain(directory)
      if (kind !== 'table') {
        const images = renderStudyCharts(sample.chart, result.values, {
          reference: (id) => `evidence-${id}`
        })
        expect(images.length).toBeGreaterThan(0)
        expect(images.join('')).toContain('data-value-id=')
        expect(images.join('')).not.toMatch(/(?:NaN|Infinity)[" ,]/)
      }
      if (kind === 'bar') {
        snapshot.runs[0].study!.rows[0].values.value = 'foreign-id'
        expect(() => validateReportSnapshot(snapshot)).toThrow('REPORT_INVALID_SNAPSHOT')
      }
    }
  })
  it('keeps heatmap text above 4.5:1 after compositing and makes the dark box median distinguishable', () => {
    const luminance = (rgb: number[]) =>
      rgb
        .map((c) => {
          const v = c / 255
          return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
        })
        .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
    const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    for (const dark of [false, true])
      for (const fill of [dark ? '#85b4ff' : '#2364ca', '#ba4851'])
        for (const opacity of [0.15, 0.35, 0.575, 0.8, 1]) {
          const background = luminance(
            rgb(fill).map((c) => c * opacity + (dark ? 11 : 255) * (1 - opacity))
          )
          const foreground = luminance(rgb(heatmapForeground(fill, opacity, dark)))
          expect(
            (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05)
          ).toBeGreaterThanOrEqual(4.5)
        }
    const result = run({ method: 'stratification-analysis', chart: 'boxplot' })
    const chart = result.study!.charts.find((c) => c.kind === 'boxplot')!
    expect(renderStudyCharts(chart, result.values, { dark: true }).join('')).toContain(
      'stroke="#172638"'
    )
  })
  it('escapes labels and never executes user HTML in chart SVG', () => {
    const result = run({ method: 'structure-analysis', chart: 'pie' })
    const chart = result.study!.charts.find((c) => c.kind === 'pie')!
    chart.points[0].label = '<script>window.injected=1</script>'
    const svg = renderStudyCharts(chart, result.values).join('')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
  })
})
