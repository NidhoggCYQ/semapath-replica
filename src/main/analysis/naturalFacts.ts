import { randomUUID } from 'node:crypto'
import type { AnalysisRun, NaturalDerived, NaturalReadyPlan } from '@shared/analysis'
import { add, compare, decimal, decimalString, divideDecimal, multiply } from './decimal'
import { AnalysisError } from './errors'

const input = (run: AnalysisRun, value: AnalysisRun['values'][number]) => ({
  runId: run.id,
  valueId: value.id,
  category: value.category,
  value: value.value
})
export function buildNaturalDerived(
  plan: NaturalReadyPlan,
  runs: Map<string, AnalysisRun>
): NaturalDerived[] {
  const facts: NaturalDerived[] = []
  plan.views.forEach((view, viewIndex) => {
    const run = runs.get(view.queryKey)
    if (!run) throw new AnalysisError('INVALID_ANALYSIS_PLAN')
    if (view.kind === 'share') {
      if (
        !['sum', 'count'].includes(run.plan.operation) ||
        !run.plan.groupBy ||
        run.values.some((value) => compare(decimal(value.value), decimal('0')) < 0)
      )
        throw new AnalysisError('ANALYSIS_UNSUPPORTED')
      const total = run.values.reduce((sum, value) => add(sum, decimal(value.value)), decimal('0'))
      if (total.coefficient === 0n) throw new AnalysisError('ANALYSIS_UNSUPPORTED')
      for (const value of run.values) {
        const numerator = decimal(value.value)
        numerator.coefficient *= 100n
        const result = divideDecimal(numerator, total)!
        facts.push({
          id: randomUUID(),
          kind: 'share',
          viewIndex,
          category: value.category,
          value: result.value,
          exact: result.exact,
          formula: `${value.value} / (${run.values.map((item) => item.value).join(' + ')}) × 100`,
          numerator: decimalString(numerator),
          denominator: decimalString(total),
          unit: '%',
          reason: null,
          inputs: run.values.map((item) => input(run, item))
        })
      }
    }
    if (view.kind === 'comparison') {
      const baseline = runs.get(view.baselineQueryKey ?? '')
      if (
        !baseline ||
        run.source.id !== baseline.source.id ||
        run.plan.measure !== baseline.plan.measure ||
        run.plan.operation !== baseline.plan.operation ||
        run.plan.groupBy !== baseline.plan.groupBy ||
        (run.plan.grouping ?? 'raw') !== (baseline.plan.grouping ?? 'raw')
      )
        throw new AnalysisError('INVALID_ANALYSIS_PLAN')
      if (run.values.length !== baseline.values.length)
        throw new AnalysisError('ANALYSIS_UNSUPPORTED')
      for (const value of run.values) {
        const before = baseline.values.find((item) => item.category === value.category)
        if (!before) throw new AnalysisError('ANALYSIS_UNSUPPORTED')
        const leftNumerator = multiply(
          decimal(value.numerator),
          decimal(String(before.denominator))
        )
        const rightNumerator = multiply(
          decimal(before.numerator),
          decimal(String(value.denominator))
        )
        rightNumerator.coefficient *= -1n
        const differenceNumerator = add(leftNumerator, rightNumerator)
        const differenceDenominator = decimal(String(value.denominator * before.denominator))
        const difference = divideDecimal(differenceNumerator, differenceDenominator)!
        const references = [input(run, value), input(baseline, before)]
        facts.push({
          id: randomUUID(),
          kind: 'difference',
          viewIndex,
          category: value.category,
          value: difference.value,
          exact: difference.exact,
          formula: `(${value.exact}) - (${before.exact})`,
          numerator: decimalString(differenceNumerator),
          denominator: decimalString(differenceDenominator),
          unit: '',
          reason: null,
          inputs: references
        })
        const numerator = multiply(differenceNumerator, decimal(String(before.denominator * 100)))
        const denominator = multiply(differenceDenominator, decimal(before.numerator))
        const percent = divideDecimal(numerator, denominator)
        facts.push({
          id: randomUUID(),
          kind: 'percent_change',
          viewIndex,
          category: value.category,
          value: percent?.value ?? null,
          exact: percent?.exact ?? '',
          formula: `((${value.exact}) - (${before.exact})) / (${before.exact}) × 100`,
          numerator: decimalString(numerator),
          denominator: decimalString(denominator),
          unit: '%',
          reason: percent ? null : 'ZERO_DENOMINATOR',
          inputs: references
        })
      }
    }
  })
  return facts
}
