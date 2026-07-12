import { type Address } from 'viem';
import { CONTRACTS, RUNTIME, TOKENS } from '../../constants';
import {
    V2_DISCOVERY_POLICY as PAIR_DISCOVERY_POLICY,
    V2_FACTORIES as DEX_FACTORIES,
} from './config';
import UniswapFlashQueryABI from '../../ABI/UniswapFlashQuery.json';
import bannedTokens from '../../bannedtax.json';
import { type PairInfo as MarketPairInfo } from './types';

const bannedTokenSet = new Set(bannedTokens.map(token => token.toLowerCase()));

type V2Client = {
    readContract(parameters: any): Promise<unknown>;
};

export type V2PoolMetadata = {
    pairAddress: Address;
    token0: Address;
    token1: Address;
    fee: number;
    factory: string;
};

type DiscoveredPairInfo = V2PoolMetadata & {
    reserve0: bigint;
    reserve1: bigint;
    lastTimestamp: number;
};

function isPairActive(lastTimestamp: number): boolean {
    const currentTime = Math.floor(Date.now() / 1000);
    const pairAge = currentTime - lastTimestamp;
    return pairAge <= PAIR_DISCOVERY_POLICY.maxPairAgeSeconds;
}

function hasEnoughLiquidity(pair: DiscoveredPairInfo): boolean {
    let hasMonitoredToken = false;
    
    for (const { address, liquidityAmount } of TOKENS) {
        if (pair.token0 === address) {
            hasMonitoredToken = true;
            if (RUNTIME.debug) console.log(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token0)`);
            if (pair.reserve0 < liquidityAmount) {
                if (RUNTIME.debug) console.log(`Insufficient liquidity for monitored token ${address}: ${pair.reserve0} < ${liquidityAmount}`);
                return false;
            }
        }
        if (pair.token1 === address) {
            hasMonitoredToken = true;
            if (RUNTIME.debug) console.log(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token1)`);
            if (pair.reserve1 < liquidityAmount) {
                if (RUNTIME.debug) console.log(`Insufficient liquidity for monitored token ${address}: ${pair.reserve1} < ${liquidityAmount}`);
                return false;
            }
        }
    }
    
    if (hasMonitoredToken) {
        return true;
    }
    
    const hasEnoughLiquidity = pair.reserve0 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity ||
                              pair.reserve1 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity;
                              
    if (RUNTIME.debug && !hasEnoughLiquidity) {
        console.log(`Insufficient liquidity for non-monitored pair ${pair.pairAddress}: ` +
                   `reserve0=${pair.reserve0}, reserve1=${pair.reserve1}, ` +
                   `required=${PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity}`);
    }
    
    return hasEnoughLiquidity;
}

async function getPairsLength(
    client: V2Client,
    factories: typeof DEX_FACTORIES
): Promise<Map<string, number>> {
    try {
        const lengths = await client.readContract({
            address: CONTRACTS.flashQuery as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getPairsLength',
            args: [factories.map(f => f.address)],
        }) as bigint[];

        return new Map(
            factories.map((factory, index) => [
                factory.name,
                Number(lengths[index])
            ])
        );
    } catch (error) {
        if (RUNTIME.debug) {
            console.error('Error fetching pairs length:', error);
        }
        return new Map();
    }
}

async function getPairsInRange(
    client: V2Client,
    factory: typeof DEX_FACTORIES[number],
    start: number,
    stop: number
): Promise<DiscoveredPairInfo[]> {
    try {
        const pairsData = await client.readContract({
            address: CONTRACTS.flashQuery as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getPairsByIndexRange',
            args: [factory.address, BigInt(start), BigInt(stop)],
        }) as Address[][];

        if (RUNTIME.debug) console.log(`Raw pairs data from contract: ${pairsData.length} pairs`);

        const pairs = pairsData
            .map(([token0, token1, pairAddress]) => ({
                pairAddress,
                token0,
                token1,
                reserve0: 0n,
                reserve1: 0n,
                lastTimestamp: 0,
                factory: factory.name,
                fee: factory.fee,
            }));

        if (RUNTIME.debug) console.log(`Mapped ${pairs.length} pairs for ${factory.name}`);

        const filteredPairs = pairs.filter(pair =>
            !bannedTokenSet.has(pair.token0.toLowerCase()) &&
            !bannedTokenSet.has(pair.token1.toLowerCase())
        );

        if (RUNTIME.debug) {
            console.log(`Filtering stats for ${factory.name}:`);
            console.log(`- Original pairs: ${pairs.length}`);
            console.log(`- Filtered out ${pairs.length - filteredPairs.length} pairs with banned tokens`);
            console.log(`- Remaining pairs: ${filteredPairs.length}`);
        }

        return filteredPairs;
    } catch (error) {
        if (RUNTIME.debug) {
            console.error(`Error fetching pairs for factory ${factory.name}:`, error);
        }
        return [];
    }
}

async function filterVolatilePairs(
    client: V2Client,
    pairs: DiscoveredPairInfo[]
): Promise<boolean[]> {
    try {
        const isVolatile = await client.readContract({
            address: CONTRACTS.flashQuery as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'filterVolatileHermesPairs',
            args: [pairs.map(p => p.pairAddress)],
        }) as boolean[];

        return isVolatile;
    } catch (error) {
        if (RUNTIME.debug) {
            console.error('Error checking volatile pairs:', error);
        }
        // In case of error, assume all pairs are volatile (false)
        return pairs.map(() => false);
    }
}

async function getReservesForPairs(
    client: V2Client,
    pairs: DiscoveredPairInfo[]
): Promise<DiscoveredPairInfo[]> {
    try {
        const reserves = await client.readContract({
            address: CONTRACTS.flashQuery as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getReservesByPairs',
            args: [pairs.map(p => p.pairAddress)],
        }) as bigint[][];

        return pairs.map((pair, i) => ({
            ...pair,
            reserve0: reserves[i][0],
            reserve1: reserves[i][1],
            lastTimestamp: Number(reserves[i][2])
        }));
    } catch (error) {
        if (RUNTIME.debug) {
            console.error('Error fetching reserves:', error);
        }
        throw error;
    }
}

async function getReservesWithRetry(
    client: V2Client,
    pairs: DiscoveredPairInfo[]
): Promise<DiscoveredPairInfo[]> {
    const result: DiscoveredPairInfo[] = [];
    
    // Group pairs by factory
    const pairsByFactory: { [factory: string]: DiscoveredPairInfo[] } = {};
    
    for (const pair of pairs) {
        if (!pairsByFactory[pair.factory]) {
            pairsByFactory[pair.factory] = [];
        }
        pairsByFactory[pair.factory].push(pair);
    }
    
    // Process each factory's pairs with appropriate batch size
    for (const factory of Object.keys(pairsByFactory)) {
        const factoryPairs = pairsByFactory[factory];
        const factoryConfig = DEX_FACTORIES.find(f => f.name === factory);
        const isWoofFactory = factoryConfig?.volatile ?? false;
        const batchSize = isWoofFactory
            ? PAIR_DISCOVERY_POLICY.woofReserveBatchSize
            : PAIR_DISCOVERY_POLICY.batchSize;
        
        if (RUNTIME.debug) {
            console.log(`Processing ${factoryPairs.length} pairs from ${factory} with batch size ${batchSize}`);
        }
        
        for (let i = 0; i < factoryPairs.length; i += batchSize) {
            const batch = factoryPairs.slice(i, i + batchSize);
            try {
                if (RUNTIME.debug) {
                    console.log(`Fetching reserves for ${batch.length} pairs from ${factory} (${i + 1} to ${i + batch.length})`);
                }

                let filteredBatch = batch;
                if (isWoofFactory) {
                    const isStablePair = await filterVolatilePairs(client, batch);
                    filteredBatch = batch.filter((_, index) => !isStablePair[index]);
                    
                    if (RUNTIME.debug && batch.length !== filteredBatch.length) {
                        console.log(`Filtered out ${batch.length - filteredBatch.length} stable pairs from Woof factory`);
                    }

                    if (filteredBatch.length === 0) {
                        continue;
                    }
                }

                const pairsWithReserves = await getReservesForPairs(client, filteredBatch);
                
                const validPairs = pairsWithReserves.filter(pair => 
                    isPairActive(pair.lastTimestamp) && 
                    hasEnoughLiquidity(pair)
                );
                
                const skippedCount = filteredBatch.length - validPairs.length;
                if (skippedCount > 0 && RUNTIME.debug) {
                    console.log(`Skipped ${skippedCount} pairs (${
                        filteredBatch.length - validPairs.length - pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } with zero reserves, ${
                        pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } inactive, ${
                        pairsWithReserves.filter(p => !hasEnoughLiquidity(p)).length
                    } insufficient liquidity)`);
                }
                
                result.push(...validPairs);
            } catch (error) {
                console.error(`Failed to fetch reserves for batch ${i} to ${i + batch.length}${RUNTIME.debug ? `, skipping these pairs: ${
                    batch.map(p => p.pairAddress).join(', ')
                }` : ''}`);
                continue;
            }
        }
    }
    
    return result;
}

export async function discoverV2PoolMetadata(
    client: V2Client
): Promise<V2PoolMetadata[]> {
    try {
        console.log('Getting total pairs for each factory...');
        const pairsLength = await getPairsLength(client, DEX_FACTORIES);
        
        let allPairs: DiscoveredPairInfo[] = [];

        for (const factory of DEX_FACTORIES) {
            const totalPairs = pairsLength.get(factory.name) || 0;
            console.log(`Found ${totalPairs} pairs for factory ${factory.name}`);

            const factoryPairs: DiscoveredPairInfo[] = [];
            for (let start = 0; start < totalPairs; start += PAIR_DISCOVERY_POLICY.batchSize) {
                const stop = Math.min(start + PAIR_DISCOVERY_POLICY.batchSize, totalPairs);
                console.log(`Fetching pairs ${start} to ${stop} for ${factory.name}...`);
                
                const pairs = await getPairsInRange(client, factory, start, stop);
                if (pairs.length > 0) {
                    factoryPairs.push(...pairs);
                }
            }

            console.log(`Total pairs collected for ${factory.name}: ${factoryPairs.length}`);
            allPairs.push(...factoryPairs);
        }

        console.log(`Total pairs found across all factories: ${allPairs.length}`);

        return allPairs.map(pair => ({
            pairAddress: pair.pairAddress,
            token0: pair.token0,
            token1: pair.token1,
            fee: pair.fee,
            factory: pair.factory,
        }));
    } catch (error) {
        console.error('Error discovering pairs:', error);
        return [];
    }
}

export async function getKnownPairsInfo(
    client: V2Client,
    pools: readonly V2PoolMetadata[]
): Promise<MarketPairInfo[]> {
    const discovered = pools.map(pool => ({
        ...pool,
        reserve0: 0n,
        reserve1: 0n,
        lastTimestamp: 0,
    }));
    const pairsWithReserves = await getReservesWithRetry(client, discovered);
    console.log(`Successfully fetched reserves for ${pairsWithReserves.length} pairs`);
    return pairsWithReserves;
}

export async function refreshKnownPairsInfo(
    client: V2Client,
    pools: readonly V2PoolMetadata[]
): Promise<MarketPairInfo[]> {
    if (pools.length === 0) return [];
    const discovered = pools.map(pool => ({
        ...pool,
        reserve0: 0n,
        reserve1: 0n,
        lastTimestamp: 0,
    }));
    const refreshed: MarketPairInfo[] = [];
    for (let start = 0; start < discovered.length; start += PAIR_DISCOVERY_POLICY.batchSize) {
        refreshed.push(...await getReservesForPairs(
            client,
            discovered.slice(start, start + PAIR_DISCOVERY_POLICY.batchSize)
        ));
    }
    return refreshed;
}
