import { type Address, createPublicClient } from 'viem';
import { CONTRACTS, DEX_FACTORIES, PAIR_DISCOVERY_POLICY, RUNTIME, TOKENS } from './constants';
import UniswapFlashQueryABI from './ABI/UniswapFlashQuery.json';
import bannedTokens from './bannedtax.json';
import { type PairInfo as MarketPairInfo } from './market/v2-types';

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

/**
 * Check if a pair is active based on its last timestamp
 */
function isPairActive(lastTimestamp: number): boolean {
    const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
    const pairAge = currentTime - lastTimestamp;
    return pairAge <= PAIR_DISCOVERY_POLICY.maxPairAgeSeconds;
}

/**
 * Check if a pair has sufficient liquidity for monitored tokens based on TOKENS configuration
 */
function hasEnoughWethLiquidity(pair: DiscoveredPairInfo): boolean {
    let hasMonitoredToken = false;
    
    // First check if pair contains any monitored tokens and verify their liquidity
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
    
    // If pair has monitored tokens and passed all checks above, it's valid
    if (hasMonitoredToken) {
        return true;
    }
    
    // For pairs with no monitored tokens, check if either reserve meets the minimum requirement
    const hasEnoughLiquidity = pair.reserve0 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity ||
                              pair.reserve1 >= PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity;
                              
    if (RUNTIME.debug && !hasEnoughLiquidity) {
        console.log(`Insufficient liquidity for non-monitored pair ${pair.pairAddress}: ` +
                   `reserve0=${pair.reserve0}, reserve1=${pair.reserve1}, ` +
                   `required=${PAIR_DISCOVERY_POLICY.minOtherTokenLiquidity}`);
    }
    
    return hasEnoughLiquidity;
}

/**
 * Get total pairs for each factory
 */
async function getPairsLength(
    client: ReturnType<typeof createPublicClient>,
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

/**
 * Fetches pairs from a specific factory within a range and only filters out pairs with banned tokens
 */
async function getPairsInRange(
    client: ReturnType<typeof createPublicClient>,
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

        // Map raw data to PairInfo objects
        const pairs = pairsData
            .map(([token0, token1, pairAddress]) => ({
                pairAddress,
                token0,
                token1,
                reserve0: 0n,
                reserve1: 0n,
                lastTimestamp: 0,  // Will be updated when fetching reserves
                factory: factory.name,
                fee: factory.fee,
            }));

        if (RUNTIME.debug) console.log(`Mapped ${pairs.length} pairs for ${factory.name}`);

        // Only filter out banned tokens at this stage
        let bannedTokenPairs = 0;
        const filteredPairs = pairs.filter(pair => {
            // Check banned token condition
            const hasBannedToken = bannedTokens.some(bannedToken => {
                const bannedTokenLower = bannedToken.toLowerCase();
                return pair.token0.toLowerCase() === bannedTokenLower || pair.token1.toLowerCase() === bannedTokenLower;
            });
            
            if (hasBannedToken) {
                bannedTokenPairs++;
                return false;
            }
            
            return true;
        });

        if (RUNTIME.debug) {
            console.log(`Filtering stats for ${factory.name}:`);
            console.log(`- Original pairs: ${pairs.length}`);
            console.log(`- Filtered out ${bannedTokenPairs} pairs with banned tokens`);
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

/**
 * Check if pairs are volatile (non-stable) pairs using Hermes filter
 */
async function filterVolatilePairs(
    client: ReturnType<typeof createPublicClient>,
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

/**
 * Fetches reserves for a batch of pairs
 */
async function getReservesForPairs(
    client: ReturnType<typeof createPublicClient>,
    pairs: DiscoveredPairInfo[]
): Promise<DiscoveredPairInfo[]> {
    try {
        const reserves = await client.readContract({
            address: CONTRACTS.flashQuery as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getReservesByPairs',
            args: [pairs.map(p => p.pairAddress)],
        }) as bigint[][];  // Contract returns uint256[3][] which viem converts to bigint[][]

        return pairs.map((pair, i) => ({
            ...pair,
            reserve0: reserves[i][0],
            reserve1: reserves[i][1],
            lastTimestamp: Number(reserves[i][2])  // Convert bigint timestamp to number
        }));
    } catch (error) {
        if (RUNTIME.debug) {
            console.error('Error fetching reserves:', error);
        }
        throw error; // Propagate error to handle batch removal
    }
}

/**
 * Fetches reserves for pairs in appropriate batch sizes based on factory
 */
async function getReservesWithRetry(
    client: ReturnType<typeof createPublicClient>,
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

                // For Woof factory, filter out stable pairs first
                let filteredBatch = batch;
                if (isWoofFactory) {
                    const isStablePair = await filterVolatilePairs(client, batch);
                    filteredBatch = batch.filter((_, index) => !isStablePair[index]);
                    
                    if (RUNTIME.debug && batch.length !== filteredBatch.length) {
                        console.log(`Filtered out ${batch.length - filteredBatch.length} stable pairs from Woof factory`);
                    }

                    // If all pairs in batch were stable, skip to next batch
                    if (filteredBatch.length === 0) {
                        continue;
                    }
                }

                const pairsWithReserves = await getReservesForPairs(client, filteredBatch);
                
                // Filter pairs that are active and have sufficient reserves
                const validPairs = pairsWithReserves.filter(pair => 
                    isPairActive(pair.lastTimestamp) && 
                    hasEnoughWethLiquidity(pair)
                );
                
                const skippedCount = filteredBatch.length - validPairs.length;
                if (skippedCount > 0 && RUNTIME.debug) {
                    console.log(`Skipped ${skippedCount} pairs (${
                        filteredBatch.length - validPairs.length - pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } with zero reserves, ${
                        pairsWithReserves.filter(p => !isPairActive(p.lastTimestamp)).length
                    } inactive, ${
                        pairsWithReserves.filter(p => !hasEnoughWethLiquidity(p)).length
                    } insufficient liquidity)`);
                }
                
                result.push(...validPairs);
            } catch (error) {
                // Only show minimal error message when RUNTIME.debug is false
                console.error(`Failed to fetch reserves for batch ${i} to ${i + batch.length}${RUNTIME.debug ? `, skipping these pairs: ${
                    batch.map(p => p.pairAddress).join(', ')
                }` : ''}`);
                continue;
            }
        }
    }
    
    return result;
}

/**
 * Fetches all pairs from all factories and returns them as an array
 */
export async function getAllPairsInfo(
    client: ReturnType<typeof createPublicClient>
): Promise<MarketPairInfo[]> {
    const pools = await discoverV2PoolMetadata(client);
    return getKnownPairsInfo(client, pools);
}

export async function discoverV2PoolMetadata(
    client: ReturnType<typeof createPublicClient>
): Promise<V2PoolMetadata[]> {
    try {
        // First get the total number of pairs for each factory
        console.log('Getting total pairs for each factory...');
        const pairsLength = await getPairsLength(client, DEX_FACTORIES);
        
        let allPairs: DiscoveredPairInfo[] = [];

        // Fetch pairs in batches for each factory
        for (const factory of DEX_FACTORIES) {
            const totalPairs = pairsLength.get(factory.name) || 0;
            console.log(`Found ${totalPairs} pairs for factory ${factory.name}`);

            // Get all pairs for this factory first
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
            // Add this factory's pairs to the overall list
            allPairs.push(...factoryPairs);
        }

        console.log(`Total pairs found across all factories (before filtering): ${allPairs.length}`);

        // NOW build the token pool count map considering ALL pairs from ALL factories
        const tokenPoolCount: { [token: string]: number } = {};
        allPairs.forEach(pair => {
            const tokenA = pair.token0;
            const tokenB = pair.token1;
            tokenPoolCount[tokenA] = (tokenPoolCount[tokenA] || 0) + 1;
            tokenPoolCount[tokenB] = (tokenPoolCount[tokenB] || 0) + 1;
        });

        // Filter out pairs where either token appears in only one liquidity pool
        let singlePoolTokenPairs = 0;
        const filteredByPoolCount = allPairs.filter(pair => {
            const hasSinglePoolToken = tokenPoolCount[pair.token0] <= 1 || tokenPoolCount[pair.token1] <= 1;
            if (hasSinglePoolToken) {
                singlePoolTokenPairs++;
                return false;
            }
            return true;
        });

        console.log(`Filtered out ${singlePoolTokenPairs} pairs with single-pool tokens`);
        console.log(`Pairs remaining after single-pool token filtering: ${filteredByPoolCount.length}`);

        return filteredByPoolCount.map(pair => ({
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
    client: ReturnType<typeof createPublicClient>,
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
