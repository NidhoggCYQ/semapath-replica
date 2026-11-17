// Decimal coefficients remain integers throughout aggregation. Excel's already-saved numeric
// precision cannot be recovered, but aggregation does not introduce binary floating-point errors.
export type Decimal = { coefficient: bigint; scale: number }
export function decimal(value: string): Decimal {
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value.trim())
  if (!match) throw new Error('Invalid decimal')
  const exponent = Number(match[4] ?? 0)
  const fraction = match[3] ?? ''
  const scale = fraction.length - exponent
  if (Math.abs(scale) > 400) throw new Error('Decimal magnitude limit')
  const coefficient = BigInt((match[1] === '-' ? '-' : '') + match[2] + fraction)
  return scale < 0
    ? { coefficient: coefficient * 10n ** BigInt(-scale), scale: 0 }
    : { coefficient, scale }
}
export function align(a: Decimal, b: Decimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [
    a.coefficient * 10n ** BigInt(scale - a.scale),
    b.coefficient * 10n ** BigInt(scale - b.scale),
    scale
  ]
}
export function add(a: Decimal, b: Decimal): Decimal {
  const [x, y, scale] = align(a, b)
  return { coefficient: x + y, scale }
}
export function compare(a: Decimal, b: Decimal): number {
  const [x, y] = align(a, b)
  return x < y ? -1 : x > y ? 1 : 0
}
export function decimalString(a: Decimal): string {
  const negative = a.coefficient < 0n
  const digits = (negative ? -a.coefficient : a.coefficient).toString().padStart(a.scale + 1, '0')
  const value = a.scale
    ? `${digits.slice(0, -a.scale)}.${digits.slice(-a.scale)}`.replace(/\.?0+$/, '')
    : digits
  return (negative ? '-' : '') + value
}
export function divide(
  a: Decimal,
  denominator: number
): { value: string; exact: string; rounded: boolean } {
  const coefficient = a.coefficient * 10n ** 12n
  const divisor = BigInt(denominator) * 10n ** BigInt(a.scale)
  const remainder = coefficient % divisor
  const quotient =
    coefficient / divisor +
    (2n * (remainder < 0n ? -remainder : remainder) >= divisor ? (coefficient < 0n ? -1n : 1n) : 0n)
  const value = decimalString({ coefficient: quotient, scale: 12 })
  return {
    value,
    exact: remainder === 0n ? value : `${decimalString(a)} / ${denominator}`,
    rounded: remainder !== 0n
  }
}

export function multiply(a: Decimal, b: Decimal): Decimal {
  return { coefficient: a.coefficient * b.coefficient, scale: a.scale + b.scale }
}
export function divideDecimal(
  numerator: Decimal,
  denominator: Decimal
): { value: string; exact: string } | null {
  const [x, y] = align(numerator, denominator)
  if (y === 0n) return null
  const sign = y < 0n ? -1n : 1n
  const dividend = x * sign * 10n ** 12n
  const divisor = y * sign
  const remainder = dividend % divisor
  const rounded =
    dividend / divisor +
    (2n * (remainder < 0n ? -remainder : remainder) >= divisor ? (dividend < 0n ? -1n : 1n) : 0n)
  const value = decimalString({ coefficient: rounded, scale: 12 })
  return {
    value,
    exact: remainder === 0n ? value : `${decimalString(numerator)} / ${decimalString(denominator)}`
  }
}
export function compareAnalysisValues(
  a: { numerator: string; denominator: number },
  b: { numerator: string; denominator: number }
): number {
  return compare(
    multiply(decimal(a.numerator), decimal(String(b.denominator))),
    multiply(decimal(b.numerator), decimal(String(a.denominator)))
  )
}
