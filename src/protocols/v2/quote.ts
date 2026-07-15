import { feeMultiplier } from '../../values';
import { type V2QuoteState } from './types';

export const FEE_DENOMINATOR = 10000n;
const ONE = 10n ** 18n;

export function swapV2(amountIn: bigint, reserveIn: bigint, reserveOut: bigint, fee: number): bigint {
  const amountInWithFee = amountIn * (feeMultiplier(fee));
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
}

export function quoteV2ExactInput(amountIn: bigint, state: V2QuoteState): bigint {
  return state.variant === 'solidly-stable'
    ? swapSolidlyStable(amountIn, state)
    : swapV2(amountIn, state.reserveIn, state.reserveOut, state.fee);
}

export function swapSolidlyStable(amountIn: bigint, state: V2QuoteState): bigint {
  if (amountIn <= 0n || state.reserveIn <= 0n || state.reserveOut <= 0n || state.scaleIn <= 0n || state.scaleOut <= 0n) return 0n;

  const netAmountIn = amountIn - (amountIn * BigInt(state.fee)) / FEE_DENOMINATOR;
  const reserveIn = (state.reserveIn * ONE) / state.scaleIn;
  const reserveOut = (state.reserveOut * ONE) / state.scaleOut;
  const normalizedIn = (netAmountIn * ONE) / state.scaleIn;
  const invariant = stableK(state.reserveIn, state.reserveOut, state.scaleIn, state.scaleOut);
  const nextReserveOut = stableY(normalizedIn + reserveIn, invariant, reserveOut);
  return ((reserveOut - nextReserveOut) * state.scaleOut) / ONE;
}

export function v2MarginalRate(state: V2QuoteState): { numerator: bigint; denominator: bigint } {
  if (state.variant !== 'solidly-stable') {
    return {
      numerator: state.reserveOut * feeMultiplier(state.fee),
      denominator: state.reserveIn * FEE_DENOMINATOR,
    };
  }
  const probe = state.reserveIn / 1_000_000n || 1n;
  return { numerator: quoteV2ExactInput(probe, state), denominator: probe };
}

function stableK(x: bigint, y: bigint, scaleX: bigint, scaleY: bigint): bigint {
  const normalizedX = (x * ONE) / scaleX;
  const normalizedY = (y * ONE) / scaleY;
  const a = (normalizedX * normalizedY) / ONE;
  const b = (normalizedX * normalizedX) / ONE + (normalizedY * normalizedY) / ONE;
  return (a * b) / ONE;
}

function stableF(x: bigint, y: bigint): bigint {
  return (x * ((((y * y) / ONE) * y) / ONE)) / ONE
    + (((((x * x) / ONE) * x) / ONE) * y) / ONE;
}

function stableD(x: bigint, y: bigint): bigint {
  return (3n * x * ((y * y) / ONE)) / ONE + ((((x * x) / ONE) * x) / ONE);
}

function stableY(x: bigint, invariant: bigint, yStart: bigint): bigint {
  let y = yStart;
  for (let i = 0; i < 255; i++) {
    const k = stableF(x, y);
    const denominator = stableD(x, y);
    if (denominator === 0n) throw new Error('Stable pool derivative is zero');

    if (k < invariant) {
      let dy = ((invariant - k) * ONE) / denominator;
      if (dy === 0n) {
        if (k === invariant) return y;
        if (stableF(x, y + 1n) > invariant) return y + 1n;
        dy = 1n;
      }
      y += dy;
    } else {
      let dy = ((k - invariant) * ONE) / denominator;
      if (dy === 0n) {
        if (k === invariant || stableF(x, y - 1n) < invariant) return y;
        dy = 1n;
      }
      y -= dy;
    }
  }
  throw new Error('Stable pool solver did not converge');
}
