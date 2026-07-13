export function v3FlashLoanFee(fee: number, amount: bigint): bigint {
  const feeAmount = amount * BigInt(fee);
  return feeAmount === 0n ? 0n : ((feeAmount - 1n) / 1_000_000n) + 1n;
}
