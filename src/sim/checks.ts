/**
 * Checks for the numbers a spec or option is built from. Each throws a RangeError naming what
 * was wrong and the value it got, so a bad Scenario fails where it is built, not as a NaN
 * somewhere in a chart. `what` names the value with its unit, such as "The timeout in ms".
 */

/** Throws a RangeError, saying `rule`, unless `value` is a finite number that `ok` accepts. */
export function checkNumber(value: number, ok: (value: number) => boolean, rule: string): void {
  if (!Number.isFinite(value) || !ok(value)) throw new RangeError(`${rule}, got ${value}`)
}

/** Throws a RangeError unless `value` is a finite number more than 0. */
export function checkPositive(value: number, what: string): void {
  checkNumber(value, (v) => v > 0, `${what} must be a finite number, more than 0`)
}

/** Throws a RangeError unless `value` is a finite number, 0 or more. */
export function checkNonNegative(value: number, what: string): void {
  checkNumber(value, (v) => v >= 0, `${what} must be a finite number, 0 or more`)
}

/** Throws a RangeError unless `value` is a whole number, `min` or more. */
export function checkWholeNumber(value: number, min: number, what: string): void {
  checkNumber(
    value,
    (v) => Number.isSafeInteger(v) && v >= min,
    `${what} must be a whole number, ${min} or more`,
  )
}
