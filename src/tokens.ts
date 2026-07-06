import { type Address } from 'viem';

export const NATIVE_SEI = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' as Address;
export const WSEI = '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7' as Address;

export function graphToken(token: Address): Address {
  return token.toLowerCase() === NATIVE_SEI.toLowerCase() ? WSEI : token;
}
