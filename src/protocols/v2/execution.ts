export function v2FlashLoanFee(fee: number, amount: bigint): bigint {
  const rawFee = BigInt(fee);
  return (amount * rawFee) / (10_000n - rawFee) + 1n;
}
