import { parseAbi, type Address } from 'viem';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import bannedTokens from '../../bannedtax.json';
import { CONTRACTS, RUNTIME } from '../../constants';
import { V2_DISCOVERY_POLICY, V2_FACTORIES } from './config';
import { type V2Variant } from './types';

const BASE_V1_PAIR_ABI = parseAbi([
  'function metadata() view returns (uint256 scale0, uint256 scale1, uint256 reserve0, uint256 reserve1, bool stable, address token0, address token1)',
]);
const BASE_V1_FACTORY_ABI = parseAbi([
  'function getFee(bool stable) view returns (uint256)',
]);

export type V2PoolMetadata = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  fee: number;
  factory: string;
  variant: V2Variant;
  scale0: bigint;
  scale1: bigint;
};

type V2Client = { readContract(parameters: any): Promise<unknown> };
type BaseV1Metadata = {
  scale0: bigint;
  scale1: bigint;
  reserve0: bigint;
  reserve1: bigint;
  stable: boolean;
  token0: Address;
  token1: Address;
};
type RawBaseV1Metadata = BaseV1Metadata | readonly [bigint, bigint, bigint, bigint, boolean, Address, Address];
type SolidlyFees = { stable: number; volatile: number };
const bannedTokenSet = new Set(bannedTokens.map(token => token.toLowerCase()));

export async function discoverV2PoolMetadata(client: V2Client): Promise<V2PoolMetadata[]> {
  const lengths = await getPairsLength(client);
  const pools: V2PoolMetadata[] = [];
  for (const factory of V2_FACTORIES) {
    const total = lengths.get(factory.name) ?? 0;
    if (total === 0) continue;
    const fees = factory.kind === 'solidly' ? await getSolidlyFees(client, factory.address) : null;
    const batchSize = factory.kind === 'solidly'
      ? V2_DISCOVERY_POLICY.solidlyReserveBatchSize
      : V2_DISCOVERY_POLICY.batchSize;
    for (let start = 0; start < total; start += batchSize) {
      pools.push(...await getPairsInRange(client, factory, start, Math.min(start + batchSize, total), fees));
    }
  }
  console.log(`Found ${pools.length} V2 pools across ${V2_FACTORIES.length} factories`);
  return pools;
}

async function getPairsLength(client: V2Client): Promise<Map<string, number>> {
  try {
    const lengths = await client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: UniswapFlashQueryABI,
      functionName: 'getPairsLength',
      args: [V2_FACTORIES.map(factory => factory.address)],
    }) as bigint[];
    return new Map(V2_FACTORIES.map((factory, index) => [factory.name, Number(lengths[index])]));
  } catch (error) {
    if (RUNTIME.debug) console.error('Error fetching V2 pair counts:', error);
    return new Map();
  }
}

async function getPairsInRange(
  client: V2Client,
  factory: typeof V2_FACTORIES[number],
  start: number,
  stop: number,
  fees: SolidlyFees | null
): Promise<V2PoolMetadata[]> {
  try {
    const pairs = await client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: UniswapFlashQueryABI,
      functionName: 'getPairsByIndexRange',
      args: [factory.address, BigInt(start), BigInt(stop)],
    }) as Address[][];
    const discovered = pairs
      .filter(([token0, token1]) => !bannedTokenSet.has(token0.toLowerCase()) && !bannedTokenSet.has(token1.toLowerCase()))
      .map(([token0, token1, pairAddress]) => ({
        pairAddress,
        token0,
        token1,
        factory: factory.name,
        fee: factory.fee,
        variant: 'uniswap-v2' as const,
        scale0: 1n,
        scale1: 1n,
      }));
    if (factory.kind !== 'solidly' || discovered.length === 0) return discovered;

    const stable = await client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: UniswapFlashQueryABI,
      functionName: 'filterVolatileHermesPairs',
      args: [discovered.map(pair => pair.pairAddress)],
    }) as boolean[];

    return Promise.all(discovered.map(async (pair, index) => {
      const isStable = stable[index];
      const metadata = isStable
        ? normalizeBaseV1Metadata(await client.readContract({
            address: pair.pairAddress,
            abi: BASE_V1_PAIR_ABI,
            functionName: 'metadata',
          }) as RawBaseV1Metadata)
        : null;
      return {
        ...pair,
        fee: isStable ? fees!.stable : fees!.volatile,
        variant: isStable ? 'solidly-stable' : 'solidly-volatile',
        scale0: metadata?.scale0 ?? 1n,
        scale1: metadata?.scale1 ?? 1n,
      };
    }));
  } catch (error) {
    if (!String(error).toLowerCase().includes('revert')) throw error;
    if (stop - start > 1) {
      const middle = start + Math.floor((stop - start) / 2);
      if (RUNTIME.debug) console.warn(`Retrying ${factory.name} V2 range ${start}-${stop} as smaller calls`);
      return [
        ...await getPairsInRange(client, factory, start, middle, fees),
        ...await getPairsInRange(client, factory, middle, stop, fees),
      ];
    }
    console.warn(`Skipping reverting ${factory.name} V2 pair index ${start}`);
    return [];
  }
}

async function getSolidlyFees(client: V2Client, factory: Address): Promise<SolidlyFees> {
  const [stable, volatile] = await Promise.all([true, false].map(stable => client.readContract({
    address: factory,
    abi: BASE_V1_FACTORY_ABI,
    functionName: 'getFee',
    args: [stable],
  }) as Promise<bigint>));
  return { stable: Number(stable), volatile: Number(volatile) };
}

function normalizeBaseV1Metadata(metadata: RawBaseV1Metadata): BaseV1Metadata {
  if (!Array.isArray(metadata)) return metadata as BaseV1Metadata;
  return {
    scale0: metadata[0],
    scale1: metadata[1],
    reserve0: metadata[2],
    reserve1: metadata[3],
    stable: metadata[4],
    token0: metadata[5],
    token1: metadata[6],
  };
}
