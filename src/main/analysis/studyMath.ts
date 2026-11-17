import { decimal, decimalString, divideDecimal } from '@shared/analysisDecimal'
export type Q = { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a
  while (b) [a, b] = [b, a % b]
  return a || 1n
}
export const rational = (n: bigint, d = 1n): Q => {
  if (!d) throw new Error('Zero denominator')
  if (d < 0n) {
    n = -n
    d = -d
  }
  const divisor = gcd(n, d)
  return { n: n / divisor, d: d / divisor }
}
export const q = (value: string | number): Q => {
  const v = decimal(String(value))
  return rational(v.coefficient, 10n ** BigInt(v.scale))
}
export const plus = (a: Q, b: Q) => rational(a.n * b.d + b.n * a.d, a.d * b.d)
export const minus = (a: Q, b: Q) => rational(a.n * b.d - b.n * a.d, a.d * b.d)
export const times = (a: Q, b: Q) => rational(a.n * b.n, a.d * b.d)
export const over = (a: Q, b: Q): Q | null => (b.n ? rational(a.n * b.d, a.d * b.n) : null)
export const cmp = (a: Q, b: Q) => (a.n * b.d < b.n * a.d ? -1 : a.n * b.d > b.n * a.d ? 1 : 0)
export const total = (values: Q[]) => values.reduce(plus, q(0))
export const renderQ = (a: Q) => {
  const result = divideDecimal(decimal(a.n.toString()), decimal(a.d.toString()))!
  // A finite decimal can be exact beyond the normal 12-place display precision.
  let d = a.d
  let twos = 0
  let fives = 0
  while (d % 2n === 0n) {
    d /= 2n
    twos++
  }
  while (d % 5n === 0n) {
    d /= 5n
    fives++
  }
  const places = Math.max(twos, fives)
  if (d === 1n && places <= 400) {
    const value = decimalString({
      coefficient: a.n * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives),
      scale: places
    })
    return { value, exact: value }
  }
  return { value: result.value, exact: `${a.n} / ${a.d}` }
}
export const quantile = (ordered: Q[], numerator: number, denominator = 4): Q => {
  const position = (ordered.length - 1) * numerator
  const low = Math.floor(position / denominator)
  const weight = q(position % denominator)
  return plus(
    ordered[low],
    times(
      minus(ordered[Math.min(low + 1, ordered.length - 1)], ordered[low]),
      over(weight, q(denominator))!
    )
  )
}
const integerSqrt = (n: bigint): bigint => {
  if (n < 2n) return n
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2))
  let next = (x + n / x) / 2n
  while (next < x) {
    x = next
    next = (x + n / x) / 2n
  }
  return x
}
export const signedSqrt = (a: Q, sign: bigint): string => {
  const scaled = a.n * 10n ** 24n
  let root = integerSqrt(scaled / a.d)
  if (4n * scaled >= a.d * (2n * root + 1n) ** 2n) root++
  return decimalString({ coefficient: sign < 0n ? -root : root, scale: 12 })
}
export function correlation(xs: Q[], ys: Q[]): { value: string | null; formula: string } {
  const n = q(xs.length)
  const covariance = minus(
    times(n, total(xs.map((x, i) => times(x, ys[i])))),
    times(total(xs), total(ys))
  )
  const vx = minus(times(n, total(xs.map((x) => times(x, x)))), times(total(xs), total(xs)))
  const vy = minus(times(n, total(ys.map((y) => times(y, y)))), times(total(ys), total(ys)))
  const formula = `(${renderQ(covariance).exact}) / sqrt((${renderQ(vx).exact}) × (${renderQ(vy).exact}))`
  if (xs.length < 2 || !vx.n || !vy.n) return { value: null, formula }
  return {
    value: signedSqrt(over(times(covariance, covariance), times(vx, vy))!, covariance.n),
    formula
  }
}
export function ranks(values: Q[]): Q[] {
  const ordered = values.map((v, i) => ({ v, i })).sort((a, b) => cmp(a.v, b.v))
  const result: Q[] = []
  for (let start = 0; start < ordered.length; ) {
    let end = start + 1
    while (end < ordered.length && cmp(ordered[start].v, ordered[end].v) === 0) end++
    for (let i = start; i < end; i++) result[ordered[i].i] = over(q(start + 1 + end), q(2))!
    start = end
  }
  return result
}
