import { z } from 'zod'

export const ANALYSIS_METHODS = [
  'cycle-analysis',
  'structure-analysis',
  'stratification-analysis',
  'matrix-analysis',
  'metric-decomposition',
  'funnel-analysis',
  'correlation-analysis',
  'label-analysis',
  'mece-decomposition'
] as const
export const ANALYSIS_CHARTS = [
  'line',
  'bar',
  'waterfall',
  'scatter',
  'bubble',
  'funnel',
  'stacked',
  'percent_stacked',
  'pie',
  'donut',
  'histogram',
  'boxplot',
  'heatmap',
  'table'
] as const
export const ChartKindSchema = z.enum(ANALYSIS_CHARTS)
export type ChartKind = z.infer<typeof ChartKindSchema>
export type AnalysisMethod = (typeof ANALYSIS_METHODS)[number]
const column = z.string().regex(/^[A-Z]{1,2}$/)
const numeric = z
  .string()
  .max(500)
  .regex(/^[+-]?\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i)
export const MethodRuleSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    conditions: z
      .array(
        z
          .object({
            column,
            operator: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']),
            value: z.string().max(500),
            kind: z.enum(['text', 'number']).default('text')
          })
          .strict()
      )
      .min(1)
      .max(5)
  })
  .strict()
export const StudyPlanSchema = z
  .object({
    method: z.enum(ANALYSIS_METHODS),
    chart: ChartKindSchema,
    secondMeasure: column.optional(),
    secondUnit: z.string().max(30).optional(),
    sizeUnit: z.string().max(30).optional(),
    sizeMeasure: column.optional(),
    observationBy: column.optional(),
    seriesBy: column.optional(),
    interval: z.enum(['day', 'week', 'month', 'quarter', 'year']).optional(),
    boundaries: z.array(numeric).min(1).max(9).optional(),
    thresholds: z.object({ x: numeric, y: numeric }).strict().optional(),
    ruleBasis: z.string().trim().min(1).max(500).optional(),
    rules: z.array(MethodRuleSchema).min(1).max(12).optional(),
    factors: z.array(column).min(2).max(6).optional(),
    identity: z.enum(['sum', 'product', 'ratio']).optional(),
    stages: z.array(column).min(2).max(12).optional(),
    funnelMode: z.enum(['cohort_flags', 'duration']).optional(),
    window: z.string().trim().min(1).max(300).optional(),
    windowComplete: z.boolean().optional(),
    correlation: z.enum(['pearson', 'spearman']).optional()
  })
  .strict()
export type StudyPlan = z.infer<typeof StudyPlanSchema>
export const LocalizedAnalysisTextSchema = z.object({ zh: z.string(), en: z.string() })
export const StudyCheckSchema = z.object({
  key: z.string(),
  state: z.enum(['pass', 'fail', 'unknown']),
  detail: LocalizedAnalysisTextSchema
})
export const StudyChartPointSchema = z.object({
  label: z.string(),
  series: z.string().optional(),
  valueId: z.string(),
  xId: z.string().optional(),
  yId: z.string().optional(),
  sizeId: z.string().optional(),
  lowerId: z.string().optional(),
  q1Id: z.string().optional(),
  medianId: z.string().optional(),
  q3Id: z.string().optional(),
  upperId: z.string().optional(),
  startId: z.string().optional(),
  endId: z.string().optional(),
  role: z.enum(['change', 'total']).optional(),
  outlierIds: z.array(z.string()).optional(),
  time: z.string().optional(),
  breakBefore: z.boolean().optional()
})
export const StudyChartSchema = z.object({
  kind: ChartKindSchema,
  points: z.array(StudyChartPointSchema).max(2000),
  xLabel: z.string(),
  yLabel: z.string(),
  unit: z.string(),
  xThresholdId: z.string().optional(),
  yThresholdId: z.string().optional(),
  note: LocalizedAnalysisTextSchema
})
export type StudyChart = z.infer<typeof StudyChartSchema>
export type StudyChartPoint = z.infer<typeof StudyChartPointSchema>
export const StudyResultSchema = z.object({
  version: z.literal('methods/1'),
  method: z.enum(ANALYSIS_METHODS),
  ruleVersion: z.number().int(),
  requirements: LocalizedAnalysisTextSchema,
  limits: LocalizedAnalysisTextSchema,
  checks: z.array(StudyCheckSchema),
  missingRows: z.number().int().nonnegative(),
  columns: z.array(z.object({ key: z.string(), label: z.string(), unit: z.string() })),
  rows: z
    .array(
      z.object({
        label: z.string(),
        series: z.string().optional(),
        values: z.record(z.string(), z.string()),
        description: z.string().optional()
      })
    )
    .max(2000),
  statistics: z.array(z.string()),
  charts: z.array(StudyChartSchema).min(1).max(14)
})
export type StudyResult = z.infer<typeof StudyResultSchema>
export const localized = (zh: string, en: string) => ({ zh, en })
export const METHOD_RULES: Record<
  AnalysisMethod,
  {
    version: number
    title: ReturnType<typeof localized>
    requirements: ReturnType<typeof localized>
    limits: ReturnType<typeof localized>
  }
> = {
  'cycle-analysis': {
    version: 5,
    title: localized('周期分析', 'Cycle analysis'),
    requirements: localized(
      '需要真实时间字段、期间粒度、指标和完整期间口径。按已记录值比较相邻期间，保留缺期。',
      'Requires a real date, interval, measure and period completeness. Compare recorded adjacent periods; retain gaps.'
    ),
    limits: localized(
      '有记录不证明期间已完整或结账。缺期不补零；少量期间不能证明季节性、生命周期或变化原因。',
      'Records do not establish closed or complete periods. Missing periods are not zero. Short histories do not establish seasonality, lifecycle or causality.'
    )
  },
  'structure-analysis': {
    version: 13,
    title: localized('结构分析', 'Structure analysis'),
    requirements: localized(
      '需要同一范围内可加总的指标及分类。逐行唯一归类，保留空类别，并与总体精确对账。',
      'Requires an additive measure and categories in one scope. Each row is classified once, blanks are retained and totals reconciled exactly.'
    ),
    limits: localized(
      '仅解释本次筛选范围；记录数不等于去重人数。负值保留为正负贡献，不包装为构成占比。对账不证明业务原因。',
      'Describes the filtered scope. Records are not distinct people. Negative values are signed contributions, not composition shares. Reconciliation does not prove causes.'
    )
  },
  'stratification-analysis': {
    version: 6,
    title: localized('分层分析', 'Stratification analysis'),
    requirements: localized(
      '需要相同粒度的观测值和阈值依据。业务阈值采用左闭右开区间；未指定时使用样本四分位数探索分层。',
      'Requires observations at one grain and a threshold basis. Business bands are left-closed/right-open. Otherwise sample quartiles define exploratory bands.'
    ),
    limits: localized(
      '分位数采用线性插值 Type 7，箱线采用 1.5 IQR。极端值保留，缺失单独记录。探索分层不代表好坏或未来表现。',
      'Uses Type 7 linear quantiles and 1.5 IQR box plots. Outliers are retained and missing values counted. Exploratory bands do not imply quality or future performance.'
    )
  },
  'matrix-analysis': {
    version: 12,
    title: localized('矩阵分析', 'Matrix analysis'),
    requirements: localized(
      '需要同一对象逐行对齐的两项指标、各轴单位及有来源的分界。阈值等号归入高侧。',
      'Requires two aligned measures for the same object, axis units and a threshold basis. Equality belongs to the high side.'
    ),
    limits: localized(
      '未给业务标准时使用中位数作探索分界；分区仅为当期相对位置，不自动形成行动、因果或能力标签。',
      'Without business thresholds, medians are exploratory boundaries. Quadrants describe current relative positions, not actions, causes or capability labels.'
    )
  },
  'metric-decomposition': {
    version: 3,
    title: localized('指标分解', 'Metric decomposition'),
    requirements: localized(
      '需要实际指标、构成字段、加法/乘法/除法恒等关系及定义来源。逐行核对恒等关系并保存残差。',
      'Requires an observed metric, factors, a sum/product/ratio identity and its definition. Verify every row and retain residuals.'
    ),
    limits: localized(
      '算式不等于业务机制；零分母保留未定义。除加法构成外，不把因素直接堆积或当作贡献。残差不隐藏。',
      'An identity is not a business mechanism. Zero denominators are undefined. Only additive factors are stacked as contributions. Residuals are retained.'
    )
  },
  'funnel-analysis': {
    version: 6,
    title: localized('漏斗分析', 'Funnel analysis'),
    requirements: localized(
      '流失流程使用同一对象一行、各阶段 0/1 标记、明确窗口和顺序；无流失流程使用各步骤非负时长。',
      'Attrition flows require one row per object, ordered 0/1 stage flags and an explicit window. No-attrition flows use nonnegative step durations.'
    ),
    limits: localized(
      '对象去重、阶段嵌套及窗口成熟度分别核对。未进入首层的记录保留说明。时长路径不计算转化率；损失位置不证明原因。',
      'Uniqueness, nested stages and window maturity are checked separately. Records outside the first stage remain disclosed. Duration flows do not have conversion rates; loss locations do not prove causes.'
    )
  },
  'correlation-analysis': {
    version: 4,
    title: localized('相关分析', 'Correlation analysis'),
    requirements: localized(
      '需要同一对象逐行对齐的两组观测。支持 Pearson 和含并列平均秩的 Spearman；删除成对缺失并记录数量。',
      'Requires paired observations. Supports Pearson and Spearman with average tied ranks. Pairwise missing records are counted.'
    ),
    limits: localized(
      '常量变量或不足两对时系数未定义。系数数值近似，精确统计量与公式保留。关联不证明因果；未计算显著性、预测或滞后效应。',
      'Coefficients are undefined for constant variables or fewer than two pairs. Approximate coefficients retain exact sufficient statistics and formulas. Association is not causation; significance, predictions and lag effects are not computed.'
    )
  },
  'label-analysis': {
    version: 5,
    title: localized('标签分析', 'Label analysis'),
    requirements: localized(
      '使用现有事实标签或明确规则，并保留规则来源。联合标签来自同一行真实字段，重叠和未匹配记录单独核对。',
      'Uses observed labels or explicit rules with a basis. Joint labels come from actual fields on the same row. Overlap and unmatched records are audited.'
    ),
    limits: localized(
      '重叠标签不作为完整构成图；空标签保留。规则标签不是预测事实，组间差异不证明标签的因果效果或统计显著性。',
      'Overlapping labels are not a complete composition. Blank labels are retained. Rule labels are not predictions; group differences do not establish causes or significance.'
    )
  },
  'mece-decomposition': {
    version: 11,
    title: localized('MECE 分类核对', 'MECE partition audit'),
    requirements: localized(
      '围绕同一范围定义分类字段或规则，核对每条记录的归属、重叠、遗漏及可加总指标对账。',
      'Define categories or rules in one scope; audit every record for membership, overlap, omissions and additive reconciliation.'
    ),
    limits: localized(
      '未知和多重归属保留；金额对账相等不代表分类完备。这里只验证当前分类层，业务解释和后续行动需要额外证据。',
      'Unknown and multiple memberships are retained. Balanced totals do not prove completeness. Only this partition is audited; explanations and actions need additional evidence.'
    )
  }
}
