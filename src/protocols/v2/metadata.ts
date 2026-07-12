import { type Address } from 'viem';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import bannedTokens from '../../bannedtax.json';
import { CONTRACTS, RUNTIME } from '../../constants';
import { V2_DISCOVERY_POLICY, V2_FACTORIES } from './config';

export type V2PoolMetadata = {
  pairAddress: Address;
  token0: Address;
  token1: Address;
  fee: number;
  factory: string;
};

type V2Client = { readContract(parameters: any): Promise<unknown> };
const bannedTokenSet = new Set(bannedTokens.map(token => token.toLowerCase()));

export async function discoverV2PoolMetadata(client: V2Client): Promise<V2PoolMetadata[]> {
  const lengths = await getPairsLength(client);
  const pools: V2PoolMetadata[] = [];
  for (const factory of V2_FACTORIES) {
    const total = lengths.get(factory.name) ?? 0;
    for (let start = 0; start < total; start += V2_DISCOVERY_POLICY.batchSize) {
      pools.push(...await getPairsInRange(client, factory, start, Math.min(start + V2_DISCOVERY_POLICY.batchSize, total)));
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
  stop: number
): Promise<V2PoolMetadata[]> {
  try {
    const pairs = await client.readContract({
      address: CONTRACTS.flashQuery as Address,
      abi: UniswapFlashQueryABI,
      functionName: 'getPairsByIndexRange',
      args: [factory.address, BigInt(start), BigInt(stop)],
    }) as Address[][];
    return pairs
      .filter(([token0, token1]) => !bannedTokenSet.has(token0.toLowerCase()) && !bannedTokenSet.has(token1.toLowerCase()))
      .map(([token0, token1, pairAddress]) => ({
        pairAddress,
        token0,
        token1,
        factory: factory.name,
        fee: factory.fee,
      }));
  } catch (error) {
    if (RUNTIME.debug) console.error(`Error fetching V2 pools for ${factory.name}:`, error);
    return [];
  }
}
