import { describe, expect, test } from 'bun:test';
import {
  basisPoints,
  feeMultiplier,
  formatBasisPoints,
  formatTokenAmount,
  formatTokenAmountWithSymbol,
  gasPrice,
  tokenAmount,
} from '../src/values';

describe('value helpers', () => {
  test('parses token and gas values as bigint', () => {
    expect(tokenAmount('1.5')).toBe(1500000000000000000n);
    expect(gasPrice('34.9')).toBe(34900000000n);
  });

  test('formats token amounts without converting through number', () => {
    const token = { name: 'TEST', decimals: 18 };
    const amount = 123456789123456789123456789n;

    expect(formatTokenAmount(amount, token)).toBe('123456789.123456789123456789');
    expect(formatTokenAmountWithSymbol(amount, token)).toBe('123456789.123456789123456789 TEST');
  });

  test('formats basis points from bigint ratios', () => {
    expect(basisPoints(123n, 1000n)).toBe(1230n);
    expect(formatBasisPoints(1230n)).toBe('12.30');
    expect(basisPoints(1n, 0n)).toBe(0n);
  });

  test('converts fee basis points to a bigint multiplier', () => {
    expect(feeMultiplier(30)).toBe(9970n);
  });
});
