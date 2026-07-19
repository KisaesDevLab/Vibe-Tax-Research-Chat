// TP-4 — money helpers. The engine works in INTEGER CENTS everywhere;
// wire types carry whole dollars. Rounding is half-up (the convention on
// IRS worksheets), applied only through these helpers — no bare
// floating-point arithmetic on money anywhere in the modules.

/** Whole dollars → cents. */
export function dollars(d: number): number {
  return Math.round(d * 100);
}

/** Cents → whole dollars, half-up (IRS worksheet rounding). */
export function toDollars(cents: number): number {
  return Math.sign(cents) * Math.round(Math.abs(cents) / 100);
}

/** Multiply cents by a decimal rate, half-up to the cent. */
export function mulRate(cents: number, rate: number): number {
  const product = cents * rate;
  return Math.sign(product) * Math.round(Math.abs(product));
}

export function clampMin0(cents: number): number {
  return cents < 0 ? 0 : cents;
}

export function min(...values: number[]): number {
  return Math.min(...values);
}

export function max(...values: number[]): number {
  return Math.max(...values);
}
