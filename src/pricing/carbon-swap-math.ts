import { type CarbonOrder } from '../market/carbon';

export type CarbonQuote = {
  amountIn: bigint;
  amountOut: bigint;
  complete: boolean;
};

const PPM = 1_000_000n;
const ONE = 1n << 48n;
const RATE_MANTISSA_MASK = (1n << 48n) - 1n;

export function quoteCarbonExactInput(amountIn: bigint, order: CarbonOrder, feePpm = 0): CarbonQuote {
  if (amountIn <= 0n || order.y <= 0n || order.z <= 0n) {
    return { amountIn, amountOut: 0n, complete: false };
  }

  const A = decodeCarbonRate(order.A);
  const B = decodeCarbonRate(order.B);
  const amountOutBeforeFee = calculateTargetAmount(amountIn, order.y, order.z, A, B);
  const amountOut = subtractFee(amountOutBeforeFee, feePpm);
  if (amountOutBeforeFee <= 0n || amountOutBeforeFee > order.y || amountOut <= 0n) {
    return { amountIn, amountOut, complete: false };
  }

  return { amountIn, amountOut, complete: true };
}

export function carbonMarginalRate(order: CarbonOrder, feePpm = 0): { numerator: bigint; denominator: bigint } {
  if (order.y <= 0n || order.z <= 0n) return { numerator: 0n, denominator: 0n };

  const A = decodeCarbonRate(order.A);
  const B = decodeCarbonRate(order.B);
  const curve = A * order.y + B * order.z;
  const numerator = curve * curve;
  const denominator = order.z * order.z * ONE * ONE;
  if (numerator <= 0n || denominator <= 0n) return { numerator: 0n, denominator: 0n };
  if (feePpm <= 0) return { numerator, denominator };

  return {
    numerator: numerator * feeFactor(feePpm),
    denominator: denominator * PPM,
  };
}

export function decodeCarbonRate(value: bigint): bigint {
  return (value & RATE_MANTISSA_MASK) << (value >> 48n);
}

function calculateTargetAmount(amountIn: bigint, y: bigint, z: bigint, A: bigint, B: bigint): bigint {
  if (A === 0n) {
    if (B === 0n) return 0n;
    return amountIn * B * B / (ONE * ONE);
  }

  const curve = A * y + B * z;
  if (curve <= 0n) return 0n;

  const scaledLiquidity = z * ONE;
  const denominator = A * amountIn * curve + scaledLiquidity * scaledLiquidity;
  if (denominator <= 0n) return 0n;

  return amountIn * curve * curve / denominator;
}

function subtractFee(amount: bigint, feePpm: number): bigint {
  return amount * feeFactor(feePpm) / PPM;
}

function feeFactor(feePpm: number): bigint {
  if (feePpm <= 0) return PPM;
  if (feePpm >= Number(PPM)) return 0n;
  return PPM - BigInt(feePpm);
}
