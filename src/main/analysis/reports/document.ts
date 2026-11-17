import type { ReportOptions, ReportRun, ReportSnapshot } from '@shared/analysisReport'
import { compareAnalysisValues } from '@shared/analysisDecimal'
import { AnalysisError } from '../errors'
import { METHOD_RULES, type ChartKind } from '@shared/analysisStudy'
import { renderStudyCharts } from '@shared/analysisChartSvg'
import type { FileExecutionOrigin } from '@shared/analysisFileExecution'

export const escapeReportText = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]!
  )
const text = escapeReportText
const copy = {
  'zh-CN': {
    report: '分析报告',
    published: '正式回答发布于',
    frozen: '冻结于',
    scope: '计算口径',
    source: '来源',
    sheet: '工作表',
    filter: '筛选',
    noFilter: '无筛选',
    group: '分组',
    ungrouped: '全部记录',
    blank: '（空白）',
    value: '计算结果',
    exact: '精确值 / 表达式',
    reference: '依据引用',
    question: '分析问题',
    evidence: '数据依据',
    derived: '派生计算依据',
    inputs: '输入依据',
    detail: '完整行级输入已冻结，可在任务成果中另存数据依据 JSON；下列单元格仅为定位示例。',
    chartNote: '图形坐标使用近似值；#编号对应下方完整名称和精确数值表。',
    chartFallback: '数值超出图形坐标表示范围，精确值完整保留在数据表中。',
    current: '本期',
    baseline: '基期',
    difference: '差额',
    percent: '增幅',
    zero: '基期为 0，增幅无法定义',
    total: '纳入 / 空值',
    unit: '单位',
    period: '期间',
    unset: '未指定',
    sum: '求和',
    average: '平均值',
    count: '记录数',
    countNote: '记录数按匹配的非空记录计数；输入中的 1 是该记录的计数贡献，不是单元格原始值。',
    min: '最小值',
    max: '最大值',
    summary: '计算结果',
    ranking: '排序结果',
    share: '占比分析',
    comparison: '期间比较',
    notes: '计算限制与说明',
    cached: '公式采用文件已保存的缓存值，未重新计算。',
    date: '工作簿采用 1904 日期系统。',
    rounding: '平均值展示最多 12 位小数，精确分数保留。',
    textNumbers: '符合十进制格式的数字文本纳入了计算。',
    frozenNotice:
      '本报告依据已发布回答的冻结版本生成，未重新请求模型或读取当前 Excel。数值与单位沿用发布口径；后续源文件变化不会改写本报告。',
    shareNote: '占比以本次筛选后的非负分组总和为分母。',
    compareNote: '差额 = 本期 - 基期；增幅 = 差额 / 基期 × 100%。',
    precision: '派生分数和比例最多展示 12 位小数，完整精确表达式保存在依据中。',
    record: '记录编号',
    signature: '冻结依据 SHA-256',
    method: '计算方式',
    part: '图表分段',
    raw: '原始值',
    day: '按日',
    month: '按月'
  },
  'en-US': {
    report: 'Analysis report',
    published: 'Answer published',
    frozen: 'Snapshot frozen',
    scope: 'Calculation scope',
    source: 'Source',
    sheet: 'Worksheet',
    filter: 'Filters',
    noFilter: 'No filters',
    group: 'Grouping',
    ungrouped: 'All records',
    blank: '(Blank)',
    value: 'Result',
    exact: 'Exact value / expression',
    reference: 'Evidence',
    question: 'Question',
    evidence: 'Calculation evidence',
    derived: 'Derived evidence',
    inputs: 'Input evidence',
    detail:
      'Complete row-level inputs are frozen and can be saved as evidence JSON from task reports. Cells shown below are location examples only.',
    chartNote:
      'Plot coordinates are approximate; # labels map to the complete names and exact values in the table.',
    chartFallback:
      'Values exceed the plot coordinate range. Complete exact values are retained in the table.',
    current: 'Current',
    baseline: 'Baseline',
    difference: 'Difference',
    percent: 'Change',
    zero: 'Undefined: baseline is zero',
    total: 'Included / blank',
    unit: 'Unit',
    period: 'Period',
    unset: 'Unspecified',
    sum: 'Sum',
    average: 'Average',
    count: 'Record count',
    countNote:
      'Counts include matching nonempty records. An input of 1 is the record contribution, not the original cell value.',
    min: 'Minimum',
    max: 'Maximum',
    summary: 'Results',
    ranking: 'Ranking',
    share: 'Share',
    comparison: 'Period comparison',
    notes: 'Calculation notes and limits',
    cached: 'Formula values use the saved workbook cache; no recalculation was performed.',
    date: 'The workbook uses the 1904 date system.',
    rounding: 'Means display up to 12 decimal places; exact fractions are retained.',
    textNumbers: 'Valid decimal text numbers were included.',
    frozenNotice:
      'Generated from the frozen published answer without a new model request or a reread of the current Excel file. Values and units retain the published scope. Later source changes do not rewrite this report.',
    shareNote: 'Shares use the filtered nonnegative group total as denominator.',
    compareNote: 'Difference = current - baseline; change = difference / baseline × 100%.',
    precision:
      'Derived fractions and percentages display up to 12 decimal places; exact expressions are retained as evidence.',
    record: 'Record ID',
    signature: 'Frozen evidence SHA-256',
    method: 'Operation',
    part: 'Chart segment',
    raw: 'Raw categories',
    day: 'Daily',
    month: 'Monthly'
  }
} as const
export function reportExpectedTokens(snapshot: ReportSnapshot): string[] {
  return [
    ...new Set([
      'SemaPath',
      ...snapshot.runs.flatMap((run, runIndex) => [
        run.source.sha256,
        ...run.values.flatMap((value, valueIndex) => [
          `[E${runIndex + 1}.${valueIndex + 1}]`,
          value.value
        ])
      ]),
      ...snapshot.derived.flatMap((fact, index) => [
        `[D${index + 1}]`,
        ...(fact.value == null ? [] : [fact.value])
      ])
    ])
  ]
}
export function buildReportDocument(
  snapshot: ReportSnapshot,
  options: ReportOptions,
  snapshotHash: string
): string {
  const c = copy[options.locale]
  const label = (category: string, run: ReportRun) =>
    category || (run.plan.groupBy ? c.blank : c.ungrouped)
  const ref = (runId: string, valueId: string) => {
    const runIndex = snapshot.runs.findIndex((run) => run.id === runId)
    const valueIndex =
      snapshot.runs[runIndex]?.values.findIndex((value) => value.id === valueId) ?? -1
    if (runIndex < 0 || valueIndex < 0) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
    return `E${runIndex + 1}.${valueIndex + 1}`
  }
  const derivedRef = (id: string) => {
    const index = snapshot.derived.findIndex((fact) => fact.id === id)
    if (index < 0) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
    return `D${index + 1}`
  }
  const link = (id: string) => `<a href="#${text(id)}">[${text(id)}]</a>`
  const table = (headers: string[], rows: string[][]) =>
    `<table><thead><tr>${headers.map((header) => `<th>${text(header)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  const filters = (run: ReportRun) =>
    run.plan.filters
      .map(
        (filter) =>
          `${filter.column} ${filter.operator} ${filter.operator === 'in' ? filter.values?.join(', ') : filter.value}`
      )
      .join('; ') || c.noFilter
  const originMetadata = (run: ReportRun) => {
    const origin = run.source.origin
    if (!origin) return ''
    const zh = options.locale === 'zh-CN'
    const heading =
      origin.kind === 'powerbi'
        ? 'Power BI DAX ' + (zh ? '查询快照' : 'query snapshot')
        : origin.kind === 'mysql'
          ? zh
            ? 'MySQL 查询快照'
            : 'MySQL query snapshot'
          : origin.kind === 'file_execution'
            ? zh
              ? '文件代码执行结果'
              : 'Recorded file execution output'
            : zh
              ? '跨表关联快照'
              : 'Joined dataset snapshot'
    const sqlNote = zh
      ? '结果行号仅定位本次查询记录，并非业务主键；FLOAT/DOUBLE 保留源库的近似语义。'
      : 'Result row ordinals locate this query snapshot, not business primary keys. FLOAT/DOUBLE retain the source approximation.'
    const types = (values: typeof origin.types) =>
      values?.length
        ? '<p class="expression">' +
          text(values.map((c) => c.column + ' ' + c.type).join('; ')) +
          '</p>'
        : ''
    const powerBi = (p: typeof origin.powerBi) =>
      p
        ? '<p>' +
          text(
            [
              p.kind,
              p.transport,
              p.environment ?? '',
              p.modelName,
              p.modelId,
              p.workspaceName ?? '',
              p.workspaceId ?? '',
              p.tenantId ?? ''
            ]
              .filter(Boolean)
              .join(' · ')
          ) +
          '</p><p class="hash">DAX SHA-256: ' +
          text(p.querySha256) +
          '</p><p class="note">' +
          (zh
            ? '结果行号仅定位 DAX 返回记录，DAX 可能已聚合；不代表底层明细。整数/十进制保留返回文本，浮点值保留模型近似语义。'
            : 'Row ordinals locate DAX result rows, which may already be aggregated. Integer/decimal text is preserved; floating-point values retain model approximations.') +
          '</p><p class="note">' +
          (zh ? '模型结构覆盖：' : 'Metadata coverage: ') +
          text(
            p.schema
              ? Object.entries(p.schema.coverage)
                  .map(([key, value]) => key + ': ' + value)
                  .join('; ')
              : zh
                ? '未通过本次 REST 查询取得模型结构；完整结构需 XMLA 权限。'
                : 'Not obtained by this REST query; full metadata requires XMLA access.'
          ) +
          '</p>'
        : ''
    const acquisition = (a: typeof origin.acquisition) =>
      a
        ? '<p>' +
          (zh ? '自然语言只读取数：' : 'Natural-language read-only acquisition: ') +
          text(a.question) +
          '</p><p>' +
          text(a.modelName) +
          ' · ' +
          text(a.providerId) +
          ' · ' +
          text(a.modelId) +
          ' · ' +
          text(a.generatedAt) +
          '</p><p class="hash">' +
          (zh ? '结构 SHA-256: ' : 'Structure SHA-256: ') +
          text(a.structureSha256) +
          '</p>' +
          (a.querySha256 ? '<p class="hash">Query SHA-256: ' + text(a.querySha256) + '</p>' : '')
        : ''
    const fileExecution = (execution?: FileExecutionOrigin) =>
      execution
        ? '<p class="note">' +
          (zh
            ? '已记录的程序输出；输入文件版本为声明的执行依据，未捕获可重放环境，也不自动证明业务结论。'
            : 'Recorded program output. Declared input versions are captured provenance, not business verification or a replayable environment.') +
          '</p><p class="hash">Execution: ' +
          text(execution.id) +
          ' · SHA-256: ' +
          text(execution.resultSha256) +
          '</p><p class="hash">Command SHA-256: ' +
          text(execution.commandSha256) +
          ' · xlsx: ' +
          text(execution.skillStatus) +
          '</p><p class="expression">' +
          text(execution.command) +
          '</p>' +
          execution.inputs
            .map(
              (input) =>
                '<p>' +
                text(input.name) +
                ' · ' +
                text(input.sheet ?? '') +
                ' · ' +
                text(input.range ?? '') +
                '</p><p class="hash">SHA-256: ' +
                text(input.sha256) +
                '</p>'
            )
            .join('')
        : ''
    const parents = (origin.parents ?? [])
      .map(
        (p) =>
          '<p>' +
          text(p.name) +
          ' · ' +
          text(p.sheet) +
          '</p><p class="hash">SHA-256: ' +
          text(p.sha256) +
          '</p>' +
          powerBi(p.powerBi) +
          acquisition(p.acquisition) +
          fileExecution(p.fileExecution) +
          (p.query
            ? '<p>' +
              text(p.createdAt ?? '') +
              '</p><p class="expression">' +
              text(p.database) +
              ' · ' +
              text(p.query) +
              '</p>' +
              types(p.types) +
              '<p class="note">' +
              (p.kind === 'powerbi' ? '' : sqlNote) +
              '</p>'
            : '')
      )
      .join('')
    return (
      '<section class="scope"><h3>' +
      heading +
      '</h3><p>' +
      text(origin.title) +
      ' · ' +
      text(origin.createdAt) +
      ' · ' +
      origin.rows +
      (zh
        ? ' 条结果。快照固定于本次取数/关联时间；完整计算输入及映射已冻结到依据 JSON。'
        : ' result rows. Frozen at the recorded time; complete calculation inputs and mappings are included in evidence JSON.') +
      '</p>' +
      powerBi(origin.powerBi) +
      acquisition(origin.acquisition) +
      (origin.query
        ? '<p>' +
          text(origin.connectionName) +
          ' · ' +
          text(origin.database) +
          '</p><p class="expression">' +
          text(origin.query) +
          '</p>' +
          types(origin.types) +
          '<p class="note">' +
          (origin.kind === 'powerbi' ? '' : sqlNote) +
          '</p>'
        : '') +
      (origin.kind === 'join'
        ? '<p>' +
          (zh ? '匹配 / 未匹配左侧记录：' : 'Matched / unmatched left records: ') +
          text(origin.matched) +
          ' / ' +
          text(origin.unmatched) +
          '</p>' +
          (origin.steps ?? [])
            .map(
              (s) =>
                '<p class="expression">' +
                text(s.input.title) +
                ' · ' +
                text(s.input.left.sheet) +
                '.' +
                text(s.input.left.key) +
                ' → ' +
                text(s.input.right.sheet) +
                '.' +
                text(s.input.right.key) +
                ' · ' +
                (s.input.kind === 'left'
                  ? zh
                    ? '左关联'
                    : 'Left join'
                  : zh
                    ? '内关联'
                    : 'Inner join') +
                ' · ' +
                (s.input.cardinality === 'many_to_one'
                  ? zh
                    ? '多对一'
                    : 'Many to one'
                  : zh
                    ? '一对一'
                    : 'One to one') +
                ' · ' +
                (s.input.keyKind === 'text'
                  ? zh
                    ? '精确文本键'
                    : 'Exact text keys'
                  : zh
                    ? '十进制数值键'
                    : 'Decimal numeric keys') +
                '</p>'
            )
            .join('')
        : '') +
      fileExecution(origin.fileExecution) +
      parents +
      '</section>'
    )
  }
  const baseMetadata = (run: ReportRun) =>
    `<p class="scope">${text(c.source)}: ${text(run.source.name)} · ${text(c.sheet)}: ${text(run.plan.sheet)}<br>${text(c.method)}: ${text(run.study ? localized(METHOD_RULES[run.study.method].title) : c[run.plan.operation])} ${text(run.measureLabel)} · ${text(c.group)}: ${text(run.groupLabel || c.ungrouped)} · ${text(c[run.plan.grouping ?? 'raw'])}<br>${text(c.filter)}: ${text(filters(run))}<br>${text(c.unit)}: ${text(run.plan.unit || c.unset)} · ${text(c.period)}: ${text(run.plan.period || c.unset)}</p>${run.plan.rowScope ? '<p class="note">' + (options.locale === 'zh-CN' ? '继承的输入记录范围：' : 'Inherited input row scope: ') + run.plan.rowScope.rows.length + (options.locale === 'zh-CN' ? ' 行；完整行号已冻结在依据 JSON 中。' : ' rows; complete row numbers are frozen in the evidence JSON.') + '</p>' : ''}${run.plan.operation === 'count' && !run.study ? `<p class="note">${text(c.countNote)}</p>` : ''}`
  type Point = { value: string; category: string; reference: string }
  const metadata = (run: ReportRun) => baseMetadata(run) + originMetadata(run)
  const chart = (points: Point[], kind: ChartKind, unit: string) => {
    if (kind === 'table') return ''
    if (
      !points.every(
        (point) =>
          Number.isFinite(Number(point.value)) &&
          !(Number(point.value) === 0 && /[1-9]/.test(point.value))
      )
    )
      return `<p class="note">${text(c.chartFallback)}</p>`
    const numbers = points.map((point) => Number(point.value))
    const minimum = Math.min(0, ...numbers)
    const maximum = Math.max(0, ...numbers)
    const magnitude = Math.max(...numbers.map(Math.abs), 1e-300)
    const low = minimum / magnitude
    const high = maximum === minimum ? low + 1 : maximum / magnitude
    const ratio = (value: number) => (value / magnitude - low) / (high - low)
    const tick = (value: number) =>
      text(
        Number(value.toPrecision(3)).toLocaleString(options.locale, { maximumSignificantDigits: 3 })
      )
    const ticks = Array.from(
      { length: 5 },
      (_, i) => minimum * (1 - i / 4) + (maximum === minimum ? 1 : maximum) * (i / 4)
    )
    if (kind === 'line') {
      const x = (index: number) => 45 + (index / Math.max(1, points.length - 1)) * 780
      const y = (value: number) => 230 - ratio(value) * 200
      return `<figure data-keep><svg viewBox="0 0 900 265" role="img" aria-label="${text(c.value)}">${ticks.map((value) => `<line x1="45" x2="825" y1="${y(value)}" y2="${y(value)}" class="grid"/><text x="35" y="${y(value) + 4}" text-anchor="end">${tick(value)}</text>`).join('')}<polyline points="${numbers.map((value, index) => `${x(index)},${y(value)}`).join(' ')}" fill="none" stroke="#2364ca" stroke-width="2.5"/>${points.map((point, index) => `<a href="#${text(point.reference)}"><circle cx="${x(index)}" cy="${y(numbers[index])}" r="3" fill="#2364ca"><title>${text(point.category)}: ${text(point.value)} ${text(unit)}</title></circle></a>`).join('')}<text x="45" y="252">#1</text><text x="825" y="252" text-anchor="end">#${points.length}</text></svg><figcaption>${text(c.chartNote)} ${text(unit)}</figcaption></figure>`
    }
    const shortLabel = (value: string) => {
      const letters = Array.from(value)
      return text(letters.slice(0, 16).join('') + (letters.length > 16 ? '…' : ''))
    }
    const parts: string[] = []
    for (let start = 0; start < points.length; start += 12) {
      const chunk = points.slice(start, start + 12)
      const height = chunk.length * 25 + 42
      const x = (value: number) => 260 + ratio(value) * 560
      parts.push(
        `<figure data-keep><svg viewBox="0 0 900 ${height}" role="img" aria-label="${text(c.value)}">${ticks.map((value) => `<line x1="${x(value)}" x2="${x(value)}" y1="6" y2="${height - 26}" class="grid"/><text x="${x(value)}" y="${height - 6}" text-anchor="middle">${tick(value)}</text>`).join('')}<line x1="${x(0)}" x2="${x(0)}" y1="6" y2="${height - 26}" stroke="#53657b"/>${chunk.map((point, index) => `<text x="248" y="${index * 25 + 24}" text-anchor="end">#${start + index + 1} ${shortLabel(point.category)}</text><a href="#${text(point.reference)}"><rect x="${Math.min(x(0), x(Number(point.value)))}" y="${index * 25 + 8}" width="${Math.max(Math.abs(x(Number(point.value)) - x(0)), 0.3)}" height="19" rx="2" fill="#2364ca"><title>${text(point.category)}: ${text(point.value)} ${text(unit)}</title></rect></a>`).join('')}</svg><figcaption>${text(c.chartNote)} ${text(unit)}${points.length > 12 ? ` · ${text(c.part)} ${start + 1}-${start + chunk.length}/${points.length}` : ''}</figcaption></figure>`
      )
    }
    return parts.join('')
  }
  const localized = (value: { zh: string; en: string }) =>
    options.locale === 'zh-CN' ? value.zh : value.en
  const methodSection = (run: ReportRun, kind: ChartKind) => {
    const study = run.study!
    const chosen = study.charts.find((chart) => chart.kind === kind)
    if (!chosen) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
    const values = new Map(run.values.map((value) => [value.id, value]))
    const result = (id: string) => {
      const value = values.get(id)
      if (!value) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
      return `${text(value.value)} ${text(value.unit ?? '')} ${link(ref(run.id, id))}`
    }
    const figures = renderStudyCharts(chosen, run.values, {
      reference: (id) => ref(run.id, id),
      label: localized(METHOD_RULES[study.method].title)
    })
    let tables = ''
    for (let start = 0; start < study.columns.length; start += 4) {
      const columns = study.columns.slice(start, start + 4)
      tables += table(
        [
          c.group,
          ...columns.map((column) => column.label + (column.unit ? ` (${column.unit})` : ''))
        ],
        study.rows.map((row) => [
          text([row.label, row.series, row.description].filter(Boolean).join(' · ')),
          ...columns.map((column) =>
            row.values[column.key]
              ? result(row.values[column.key])
              : text(options.locale === 'zh-CN' ? '未定义 / 无观测' : 'Undefined / no observation')
          )
        ])
      )
    }
    const state = {
      pass: options.locale === 'zh-CN' ? '通过' : 'Pass',
      fail: options.locale === 'zh-CN' ? '未通过' : 'Fail',
      unknown: options.locale === 'zh-CN' ? '数据不足 / 未核实' : 'Unknown / unverified'
    }
    return `<section class="answer-section"><h2>${text(localized(METHOD_RULES[study.method].title))}</h2>${metadata(run)}<p class="note">${text(localized(study.requirements))}</p><p class="note">${text(localized(study.limits))}</p>${study.statistics.map((id) => `<p>${text(values.get(id)?.category)}: <strong class="num">${result(id)}</strong></p>`).join('')}${kind === 'table' ? '' : figures.length ? figures.map((figure) => `<figure data-keep>${figure}<figcaption>${text(localized(chosen.note))}</figcaption></figure>`).join('') : `<p class="note">${text(c.chartFallback)}</p>`}${tables}<h3>${text(options.locale === 'zh-CN' ? '方法自检' : 'Method checks')} · v${study.ruleVersion}</h3>${study.checks.map((check) => `<p><strong>${text(state[check.state])}</strong> · ${text(localized(check.detail))}</p>`).join('')}</section>`
  }
  const sections = snapshot.views
    .map((view, viewIndex) => {
      const run = snapshot.runs.find((run) => run.id === view.runId)!
      if (!run) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
      if (run.study) return methodSection(run, view.chart)
      const facts = snapshot.derived.filter((fact) => fact.viewIndex === viewIndex)
      let rows: string[][] = []
      let points: Point[] = []
      let headers: string[] = [c.group, c.value, c.exact, c.reference]
      if (view.kind === 'summary' || view.kind === 'ranking') {
        const values =
          view.kind === 'ranking'
            ? [...run.values]
                .sort(
                  (a, b) => compareAnalysisValues(a, b) * (view.direction === 'ascending' ? 1 : -1)
                )
                .slice(0, view.limit ?? 10)
            : run.values
        rows = values.map((value, index) => [
          text(`#${index + 1} ${label(value.category, run)}`),
          `<strong class="num">${text(value.value)} ${text(run.plan.unit)}</strong>`,
          text(value.exact),
          link(ref(run.id, value.id))
        ])
        points = values.map((value) => ({
          value: value.value,
          category: label(value.category, run),
          reference: ref(run.id, value.id)
        }))
      } else if (view.kind === 'share') {
        const shares = facts.filter((fact) => fact.kind === 'share')
        if (shares.length !== run.values.length) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
        rows = shares.map((fact, index) => [
          text(`#${index + 1} ${label(fact.category, run)}`),
          `<strong class="num">${text(fact.value)} %</strong>`,
          text(fact.exact),
          link(derivedRef(fact.id))
        ])
        points = shares.map((fact) => ({
          value: fact.value!,
          category: label(fact.category, run),
          reference: derivedRef(fact.id)
        }))
      } else {
        const baseline = snapshot.runs.find((run) => run.id === view.baselineRunId)
        if (!baseline) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
        headers = [c.group, c.current, c.baseline, c.difference, c.percent, c.reference]
        rows = run.values.map((value, index) => {
          const before = baseline.values.find((item) => item.category === value.category)
          const difference = facts.find(
            (fact) => fact.category === value.category && fact.kind === 'difference'
          )
          const percent = facts.find(
            (fact) => fact.category === value.category && fact.kind === 'percent_change'
          )
          if (!before || !difference || !percent) throw new AnalysisError('REPORT_INVALID_SNAPSHOT')
          points.push({
            value: difference.value!,
            category: label(value.category, run),
            reference: derivedRef(difference.id)
          })
          return [
            text(`#${index + 1} ${label(value.category, run)}`),
            `${text(value.value)} ${link(ref(run.id, value.id))}`,
            `${text(before.value)} ${link(ref(baseline.id, before.id))}`,
            text(difference.value),
            percent.value == null ? text(c.zero) : `${text(percent.value)} %`,
            `${link(derivedRef(difference.id))} / ${link(derivedRef(percent.id))}`
          ]
        })
      }
      return `<section class="answer-section"><h2>${text(run.measureLabel || c.count)} · ${text(c[view.kind])}</h2>${metadata(run)}${view.kind === 'comparison' ? `<p class="note">${text(c.compareNote)}</p>${metadata(snapshot.runs.find((run) => run.id === view.baselineRunId)!)}` : view.kind === 'share' ? `<p class="note">${text(c.shareNote)}</p>` : ''}${chart(points, view.chart, view.kind === 'share' ? '%' : run.plan.unit)}${table(headers, rows)}${facts.length ? `<p class="note">${text(c.precision)}</p>` : ''}</section>`
    })
    .join('')
  const evidence = snapshot.runs
    .map(
      (run, index) =>
        `<section class="evidence-section"><h2>${text(c.evidence)} E${index + 1}</h2>${metadata(run)}<p class="hash">SHA-256: ${text(run.source.sha256)}</p><p class="note">${text(c.detail)}</p>${table(
          [c.reference, c.group, c.value, c.exact, c.total, c.inputs],
          run.values.map((value, valueIndex) => {
            const id = `E${index + 1}.${valueIndex + 1}`
            return [
              `<span id="${id}">[${id}]</span>`,
              text(label(value.category, run)),
              text(value.value),
              text(value.exact + (value.formula ? `; ${value.formula}` : '')),
              `${value.included} / ${value.blank}`,
              text(
                value.inputs
                  .slice(0, 5)
                  .map(
                    (input) =>
                      `${input.cell}=${input.value}` +
                      (input.origin?.length
                        ? ' ← ' +
                          input.origin
                            .map(
                              (cell) => `${cell.source} · ${cell.sheet}!${cell.cell}=${cell.value}`
                            )
                            .join(' | ')
                        : '')
                  )
                  .join('; ')
              )
            ]
          })
        )}<p class="note">${text(c.record)}: ${text(run.evidenceId)}</p></section>`
    )
    .join('')
  const derived = snapshot.derived.length
    ? `<section class="derived-section"><h2>${text(c.derived)}</h2>${snapshot.derived.map((fact, index) => `<article><h3 id="D${index + 1}">[D${index + 1}] · ${text(fact.category || c.ungrouped)}</h3><p class="num">${fact.value == null ? text(c.zero) : `${text(fact.value)} ${text(fact.unit)}`}</p><p class="expression">${text(fact.formula)}</p><p>${text(c.exact)}: ${text(fact.exact || c.zero)}</p><p>${text(c.inputs)}: ${fact.inputs.map((input) => `${link(ref(input.runId, input.valueId))} = ${text(input.value)}`).join('; ')}</p></article>`).join('')}</section>`
    : ''
  const fc =
    options.locale === 'zh-CN'
      ? {
          frame: '业务分析框架',
          path: '分析路径',
          objective: '分析目标',
          question: '分析问题',
          hypothesis: '待验证假设',
          supported: '现有依据支持',
          not_supported: '现有依据未支持',
          refuted: '现有依据反驳',
          unverified: '待核实',
          continue: '继续分析',
          replace_method: '更换方法',
          stop: '本步停止',
          needs_data: '需要数据',
          caution:
            '以下判断为模型解释，依据绑定不代表业务或因果结论已证明。数值与图表以实际计算为准。',
          lineage: '父链仅记录历史上下文与版本，不作为本次新增结论。未发布父回答保留草稿状态。',
          draft: '草稿',
          published: '已发布',
          scoped: '继承父查询口径',
          selected: '仅所选数值的实际输入记录',
          rows: '范围内行数',
          noReason: '尚未记录业务判断。',
          scope: '受控下钻范围'
        }
      : {
          frame: 'Business analysis framework',
          path: 'Analysis path',
          objective: 'Decision objective',
          question: 'Question',
          hypothesis: 'Hypothesis to test',
          supported: 'Supported by current evidence',
          not_supported: 'Not supported by current evidence',
          refuted: 'Refuted by current evidence',
          unverified: 'Unverified',
          continue: 'Continue',
          replace_method: 'Replace method',
          stop: 'Stop this step',
          needs_data: 'Needs data',
          caution:
            'Judgments are model interpretations. Evidence references do not establish business or causal correctness. Quantities come from actual calculations.',
          lineage:
            'Ancestors record historical context and versions, not new conclusions. Unpublished ancestors retain draft status.',
          draft: 'Draft',
          published: 'Published',
          scoped: 'Inherited parent query scope',
          selected: 'Actual input rows of the selected value only',
          rows: 'Rows in scope',
          noReason: 'No business judgment recorded.',
          scope: 'Bound drill-down scope'
        }
  const scopeDescription = (context: ReportSnapshot['context']) => {
    const scope = context?.scope
    if (!scope) return ''
    return `<p class="scope">${text(scope.selected ? fc.selected : fc.scoped)} · ${text(scope.plan.sheet)} · ${text(scope.plan.filters.map((f) => f.column + ' ' + f.operator + ' ' + (f.operator === 'in' ? (f.values ?? []).join(', ') : f.value)).join('; ') || c.noFilter)}${scope.plan.rowScope ? ' · ' + text(fc.rows) + ': ' + scope.plan.rowScope.rows.length : ''}</p><p class="hash">SHA-256: ${text(scope.sourceSha256)}</p>`
  }
  const framework = snapshot.framework
    ? `<section class="framework-section"><h2>${text(fc.frame)}</h2><p><strong>${text(fc.objective)}:</strong> ${text(snapshot.framework.objective)}</p><p class="note">${text(fc.caution)}</p>${snapshot.framework.questions.map((q) => `<article><h3 id="F-${text(q.id)}">${text(fc[q.kind])}: ${text(q.text)}</h3><p><strong>${text(fc[q.judgment])}</strong> · ${text(fc[q.next])}</p><p>${text(q.reason || fc.noReason)}</p>${q.evidence.length ? '<p>' + text(c.reference) + ': ' + q.evidence.map((e) => link(ref(e.runId, e.valueId))).join(' · ') + '</p>' : ''}</article>`).join('')}</section>`
    : ''
  const lineage = snapshot.context
    ? `<section class="framework-section"><h2>${text(fc.path)}</h2><p class="note">${text(fc.lineage)}</p>${(snapshot.lineage ?? []).map((parent, index) => `<article><h3>${index + 1}. ${text(parent.question)}</h3><p class="note">${text(fc[parent.status])}</p>${scopeDescription(parent.context)}<p class="hash">${text(parent.id)} · ${text(parent.candidateHash)}</p></article>`).join('')}<h3>${text(fc.scope)}</h3>${scopeDescription(snapshot.context)}</section>`
    : ''
  const warnings = [...new Set(snapshot.runs.flatMap((run) => run.warnings))].map(
    (warning) =>
      ({
        CACHED_FORMULAS: c.cached,
        DATE_SYSTEM_1904: c.date,
        ROUNDING_12_DP: c.rounding,
        TEXT_NUMBERS: c.textNumbers
      })[warning]
  )
  const date = (date: string) =>
    new Date(date).toLocaleString(options.locale, { timeZone: 'Asia/Shanghai' })
  const landscape = options.format === 'slides'
  return `<!doctype html><html lang="${options.locale}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"><title>${text(options.title)}</title><style>
@page{size:${landscape ? '338.6667mm 190.5mm' : '210mm 297mm'};margin:${landscape ? '12mm 15mm 16mm' : '16mm 17mm 18mm'}}
*{box-sizing:border-box}html{color:#172638;background:#fff;font-family:'Microsoft YaHei','PingFang SC','Noto Sans CJK SC',Arial,sans-serif;font-size:${landscape ? '14px' : '12px'};line-height:1.7}body{width:${landscape ? '1166' : '665'}px;max-width:100%;margin:0}h1,h2,h3{overflow-wrap:anywhere;line-height:1.45;font-weight:650}h1{font-size:${landscape ? '32' : '26'}px;margin:16px 0 22px}h2{font-size:${landscape ? '23' : '19'}px;margin:28px 0 14px;break-after:avoid}h3{font-size:14px;margin:20px 0 8px;break-after:avoid}p{margin:8px 0;overflow-wrap:anywhere;orphans:3;widows:3}.brand{font-size:16px;font-weight:700;color:#2364ca;letter-spacing:-.02em}.scope,.note{font-size:11px;color:#526277}.question{white-space:pre-wrap}.answer-section,.evidence-section,.derived-section,.framework-section{${landscape ? 'break-before:page;' : ''}}table{width:100%;table-layout:fixed;border-collapse:collapse;margin:16px 0 22px;font-size:${landscape ? '12' : '10.5'}px}thead{display:table-header-group}tr{break-inside:avoid}th,td{border-bottom:1px solid #dce3ed;text-align:left;vertical-align:top;padding:9px 7px;overflow-wrap:anywhere;white-space:pre-wrap}th{background:#edf3fc;font-weight:600}th:first-child{width:17%}td .num{font-weight:650}a{color:#2364ca;text-decoration:none}.num{font-variant-numeric:tabular-nums}.hash{font:10px/1.8 Consolas,monospace;overflow-wrap:anywhere}.expression{white-space:pre-wrap;font-variant-numeric:tabular-nums}figure{margin:18px 0;break-inside:avoid}svg{display:block;width:100%;max-height:${landscape ? '295' : '300'}px;font-family:Arial,sans-serif;font-size:12px;fill:#425267}.grid{stroke:#dfe6ef;stroke-width:1}figcaption{font-size:10px;color:#526277}.endnote{break-inside:avoid;page-break-inside:avoid;margin-top:30px;padding-top:14px;border-top:1px solid #dce3ed}article{padding-bottom:10px;break-inside:avoid}
</style></head><body><header><div class="brand">SemaPath · ${text(c.report)}</div><h1>${text(options.title)}</h1><p class="note">${text(c.published)} ${text(date(snapshot.answer.publishedAt))} · ${text(c.frozen)} ${text(date(snapshot.frozenAt))}</p><h2>${text(c.question)}</h2><p class="question">${text(snapshot.answer.question || c.unset)}</p><p class="note">${text(c.frozenNotice)}</p></header>${lineage}${framework}${sections}${evidence}${derived}<section class="endnote"><h2>${text(c.notes)}</h2>${warnings.map((warning) => `<p>${text(warning)}</p>`).join('')}<p>${text(c.frozenNotice)}</p><p class="hash">${text(c.signature)}: ${text(snapshotHash)}</p><p class="hash">${text(c.record)}: ${text(snapshot.answer.id)} · ${text(snapshot.answer.candidateHash)}</p></section></body></html>`
}
