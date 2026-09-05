/** Boundary constructors validate runtime input; brands prevent unit mix-ups in TS. */
declare const radiansBrand: unique symbol;
declare const degreesBrand: unique symbol;
declare const metersBrand: unique symbol;
export type Radians = number & { readonly [radiansBrand]: true };
export type Degrees = number & { readonly [degreesBrand]: true };
export type Meters = number & { readonly [metersBrand]: true };

export function assertFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}
export function radians(value: number): Radians {
  assertFinite(value, 'radians');
  return value as Radians;
}
export function degrees(value: number): Degrees {
  assertFinite(value, 'degrees');
  return value as Degrees;
}
export function meters(value: number): Meters {
  assertFinite(value, 'meters');
  return value as Meters;
}
export function toRadians(value: Degrees): Radians {
  return radians(value * (Math.PI / 180));
}
export function toDegrees(value: Radians): Degrees {
  return degrees(value * (180 / Math.PI));
}
export function normalizeLongitude(value: Radians): Radians {
  assertFinite(value, 'longitudeRad');
  // Avoid adding PI to already normalized values: it would lose small deltas.
  if (value >= -Math.PI && value < Math.PI) return radians(value === 0 ? 0 : value);
  const turn = 2 * Math.PI;
  const normalized = ((value + Math.PI) % turn + turn) % turn - Math.PI;
  return radians(normalized === 0 ? 0 : normalized);
}
