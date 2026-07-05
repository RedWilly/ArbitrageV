import { describe, expect, test } from 'bun:test';
import { carbonMarginalRate, decodeCarbonRate, quoteCarbonExactInput } from '../src/pricing/carbon-swap-math';

describe('Carbon swap math', () => {
  test('quotes exact input with the implemented Carbon formula', () => {
    const order = { y: 100n, z: 10n, A: 0n, B: 2n };

    expect(quoteCarbonExactInput(5n, order)).toEqual({
      amountIn: 5n,
      amountOut: 20n,
      complete: true,
    });
    expect(carbonMarginalRate(order)).toEqual({
      numerator: 400n,
      denominator: 100n,
    });
  });

  test('rejects empty liquidity', () => {
    expect(quoteCarbonExactInput(5n, { y: 0n, z: 10n, A: 0n, B: 2n }).complete).toBe(false);
  });

  test('subtracts Carbon fee in ppm from target output', () => {
    const order = { y: 100n, z: 10n, A: 0n, B: 2n };

    expect(quoteCarbonExactInput(5n, order, 4000)).toEqual({
      amountIn: 5n,
      amountOut: 19n,
      complete: true,
    });
    expect(carbonMarginalRate(order, 4000)).toEqual({
      numerator: 398400000n,
      denominator: 100000000n,
    });
  });

  test('decodes packed Carbon rates', () => {
    expect(decodeCarbonRate((1n << 48n) | 1n)).toBe(2n);
  });
});
