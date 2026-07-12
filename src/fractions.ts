export function compareFractions(
  aNumerator: bigint,
  aDenominator: bigint,
  bNumerator: bigint,
  bDenominator: bigint
): number {
  const left = aNumerator * bDenominator;
  const right = bNumerator * aDenominator;
  return left > right ? 1 : left < right ? -1 : 0;
}
