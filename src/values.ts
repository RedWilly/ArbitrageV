import { formatUnits, parseGwei, parseUnits } from 'viem';
import { type TokenConfig } from './constants';

export function tokenAmount(value: string, decimals = 18): bigint {
    return parseUnits(value, decimals);
}

export function gasPrice(value: string): bigint {
    return parseGwei(value);
}

export function feeMultiplier(feeBasisPoints: number): bigint {
    return BigInt(10000 - feeBasisPoints);
}

export function formatTokenAmount(amount: bigint, token: Pick<TokenConfig, 'decimals'>): string {
    return formatUnits(amount, token.decimals);
}

export function formatTokenAmountWithSymbol(
    amount: bigint,
    token: Pick<TokenConfig, 'decimals' | 'name'>
): string {
    return `${formatTokenAmount(amount, token)} ${token.name}`;
}

export function basisPoints(numerator: bigint, denominator: bigint): bigint {
    if (denominator === 0n) return 0n;
    return (numerator * 10000n) / denominator;
}

export function formatBasisPoints(value: bigint): string {
    const whole = value / 100n;
    const fraction = value % 100n;
    return `${whole}.${fraction.toString().padStart(2, '0')}`;
}
