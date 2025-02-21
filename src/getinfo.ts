import {  type Address, createPublicClient, parseEther } from 'viem';
import { BATCH_SIZE, FACTORY, UNISWAP_FLASH_QUERY_CONTRACT, DEBUG, ADDRESSES } from './constants';
import UniswapFlashQueryABI from './ABI/UniswapFlashQuery.json';
import bannedTokens from './bannedtax.json';
import fs from 'fs';

export type PairInfo = {
    pairAddress: Address;
    token0: Address;
    token1: Address;
    reserve0: bigint;
    reserve1: bigint;
    lastTimestamp: number;
    factory: string;
    fee: number;
    buyFeeBps: number;    // New field for buy fees
    sellFeeBps: number;   // New field for sell fees
};

// Special batch size for Woof factory reserves to prevent contract reverts
const WOOF_RESERVES_BATCH_SIZE = 5;

// Maximum age for pairs (35 days in seconds)
const MAX_PAIR_AGE_SECONDS = 90 * 24 * 60 * 60;

const MIN_OTHER_TOKENS_LIQUIDITY = parseEther("219202");

// Load taxedp.json data
let taxedPairsData: { [pairAddress: string]: { buyFeeBps: number; sellFeeBps: number } } = {};
try {
    const taxedPairsContent = fs.readFileSync('./taxedp.json', 'utf-8');
    taxedPairsData = JSON.parse(taxedPairsContent);
} catch (error) {
    if (DEBUG) console.error('Error loading taxedp.json:', error);
    taxedPairsData = {};
}

/**
 * Check if a pair is active based on its last timestamp
 */
function isPairActive(lastTimestamp: number): boolean {
    const currentTime = Math.floor(Date.now() / 1000); // Current time in seconds
    const pairAge = currentTime - lastTimestamp;
    return pairAge <= MAX_PAIR_AGE_SECONDS;
}

/**
 * Check if a pair has sufficient liquidity for monitored tokens based on ADDRESSES configuration
 */
function hasEnoughWethLiquidity(pair: PairInfo): boolean {
    let hasMonitoredToken = false;
    
    // First check if pair contains any monitored tokens and verify their liquidity
    for (const { address, LPAMOUNT } of ADDRESSES) {
        if (pair.token0 === address) {
            hasMonitoredToken = true;
            if (DEBUG) console.log(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token0)`);
            if (pair.reserve0 < BigInt(LPAMOUNT)) {
                if (DEBUG) console.log(`Insufficient liquidity for monitored token ${address}: ${pair.reserve0} < ${LPAMOUNT}`);
                return false;
            }
        }
        if (pair.token1 === address) {
            hasMonitoredToken = true;
            if (DEBUG) console.log(`Checking liquidity for monitored token ${address} in pair ${pair.pairAddress} (token1)`);
            if (pair.reserve1 < BigInt(LPAMOUNT)) {
                if (DEBUG) console.log(`Insufficient liquidity for monitored token ${address}: ${pair.reserve1} < ${LPAMOUNT}`);
                return false;
            }
        }
    }
    
    // If pair has monitored tokens and passed all checks above, it's valid
    if (hasMonitoredToken) {
        return true;
    }
    
    // For pairs with no monitored tokens, check if either reserve meets the minimum requirement
    const hasEnoughLiquidity = pair.reserve0 >= MIN_OTHER_TOKENS_LIQUIDITY || 
                              pair.reserve1 >= MIN_OTHER_TOKENS_LIQUIDITY;
                              
    if (DEBUG && !hasEnoughLiquidity) {
        console.log(`Insufficient liquidity for non-monitored pair ${pair.pairAddress}: ` +
                   `reserve0=${pair.reserve0}, reserve1=${pair.reserve1}, ` +
                   `required=${MIN_OTHER_TOKENS_LIQUIDITY}`);
    }
    
    return hasEnoughLiquidity;
}

/**
 * Get total pairs for each factory
 */
async function getPairsLength(
    client: ReturnType<typeof createPublicClient>,
    factories: typeof FACTORY
): Promise<Map<string, number>> {
    try {
        const lengths = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
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
        if (DEBUG) {
            console.error('Error fetching pairs length:', error);
        }
        return new Map();
    }
}

/**
 * Fetches pairs from a specific factory within a range and filters out pairs with banned tokens
 */
async function getPairsInRange(
    client: ReturnType<typeof createPublicClient>,
    factory: typeof FACTORY[0],
    start: number,
    stop: number
): Promise<PairInfo[]> {
    try {
        const pairsData = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getPairsByIndexRange',
            args: [factory.address, BigInt(start), BigInt(stop)],
        }) as Address[][];

        // Filter out pairs that contain banned tokens
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
                buyFeeBps: taxedPairsData[pairAddress]?.buyFeeBps ?? 0,
                sellFeeBps: taxedPairsData[pairAddress]?.sellFeeBps ?? 0,
            }));

        // Build a map of token liquidity pool counts
        const tokenPoolCount: { [token: string]: number } = {};
        pairs.forEach(pair => {
          const tokenA = pair.token0;
          const tokenB = pair.token1;
          tokenPoolCount[tokenA] = (tokenPoolCount[tokenA] || 0) + 1;
          tokenPoolCount[tokenB] = (tokenPoolCount[tokenB] || 0) + 1;
        });

        // Filter out pairs where either token appears in only one liquidity pool
        const filteredPairs = pairs.filter(pair => {
            // Check if pair exists in taxedp.json
            const isInTaxedPairs = pair.pairAddress.toLowerCase() in taxedPairsData;
            
            // Check if tokens are banned
            const hasBannedToken = bannedTokens.some(bannedToken => {
                const bannedTokenLower = bannedToken.toLowerCase();
                return pair.token0.toLowerCase() === bannedTokenLower || 
                       pair.token1.toLowerCase() === bannedTokenLower;
            });

            // Keep pair if:
            // 1. Both tokens have more than one liquidity pool AND
            // 2. Either:
            //    a. No banned tokens OR
            //    b. Has banned token but exists in taxedp.json
            return tokenPoolCount[pair.token0] > 1 && 
                   tokenPoolCount[pair.token1] > 1 && 
                   (!hasBannedToken || isInTaxedPairs);
        });

        // Update fees for pairs that exist in taxedp.json
        filteredPairs.forEach(pair => {
            const taxInfo = taxedPairsData[pair.pairAddress.toLowerCase()];
            if (taxInfo) {
                pair.buyFeeBps = taxInfo.buyFeeBps;
                pair.sellFeeBps = taxInfo.sellFeeBps;
            }
        });

        return filteredPairs;
    } catch (error) {
        if (DEBUG) {
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
    pairs: PairInfo[]
): Promise<boolean[]> {
    try {
        const isVolatile = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'filterVolatileHermesPairs',
            args: [pairs.map(p => p.pairAddress)],
        }) as boolean[];

        return isVolatile;
    } catch (error) {
        if (DEBUG) {
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
    pairs: PairInfo[]
): Promise<PairInfo[]> {
    try {
        const reserves = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
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
        if (DEBUG) {
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
    pairs: PairInfo[]
): Promise<PairInfo[]> {
    const result: PairInfo[] = [];
    const isWoofFactory = FACTORY.find(f => f.name === pairs[0]?.factory)?.volatile ?? false;
    const batchSize = isWoofFactory ? WOOF_RESERVES_BATCH_SIZE : BATCH_SIZE;

    for (let i = 0; i < pairs.length; i += batchSize) {
        const batch = pairs.slice(i, i + batchSize);
        try {
            if (DEBUG) {
                console.log(`Fetching reserves for ${batch.length} pairs from ${pairs[0].factory} (${i + 1} to ${i + batch.length})`);
            }

            // For Woof factory, filter out stable pairs first
            let filteredBatch = batch;
            if (isWoofFactory) {
                const isStablePair = await filterVolatilePairs(client, batch);
                filteredBatch = batch.filter((_, index) => !isStablePair[index]);
                
                if (DEBUG && batch.length !== filteredBatch.length) {
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
                pair.reserve0 > parseEther("1") && 
                pair.reserve1 > parseEther("1") && 
                isPairActive(pair.lastTimestamp) && 
                hasEnoughWethLiquidity(pair)
            );
            
            const skippedCount = filteredBatch.length - validPairs.length;
            if (skippedCount > 0 && DEBUG) {
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
            // Only show minimal error message when DEBUG is false
            console.error(`Failed to fetch reserves for batch ${i} to ${i + batch.length}${DEBUG ? `, skipping these pairs: ${
                batch.map(p => p.pairAddress).join(', ')
            }` : ''}`);
            continue;
        }
    }
    return result;
}

/**
 * Fetches all pairs and their reserves from all factories
 */
export async function getAllPairsInfo(
    client: ReturnType<typeof createPublicClient>
): Promise<PairInfo[]> {
    try {
        // First get the total number of pairs for each factory
        console.log('Getting total pairs for each factory...');
        const pairsLength = await getPairsLength(client, FACTORY);
        
        let allPairs: PairInfo[] = [];

        // Fetch pairs in batches for each factory
        for (const factory of FACTORY) {
            const totalPairs = pairsLength.get(factory.name) || 0;
            console.log(`Found ${totalPairs} pairs for factory ${factory.name}`);

            // Get all pairs for this factory first
            const factoryPairs: PairInfo[] = [];
            for (let start = 0; start < totalPairs; start += BATCH_SIZE) {
                const stop = Math.min(start + BATCH_SIZE, totalPairs);
                console.log(`Fetching pairs ${start} to ${stop} for ${factory.name}...`);
                
                const pairs = await getPairsInRange(client, factory, start, stop);
                if (pairs.length > 0) {
                    factoryPairs.push(...pairs);
                }
            }

            // Then get reserves for all pairs from this factory
            if (factoryPairs.length > 0) {
                console.log(`Getting reserves for ${factoryPairs.length} pairs from ${factory.name}...`);
                const pairsWithReserves = await getReservesWithRetry(client, factoryPairs);
                console.log(`Successfully fetched reserves for ${pairsWithReserves.length}/${factoryPairs.length} pairs from ${factory.name}`);
                allPairs = allPairs.concat(pairsWithReserves);
            }
        }

        // Build a global token liquidity pool count based on validPairs from all factories
        const globalTokenPoolCount: { [token: string]: number } = {};
        allPairs.forEach(pair => {
          const tokenA = pair.token0;
          const tokenB = pair.token1;
          globalTokenPoolCount[tokenA] = (globalTokenPoolCount[tokenA] || 0) + 1;
          globalTokenPoolCount[tokenB] = (globalTokenPoolCount[tokenB] || 0) + 1;
        });

        // Filter out pairs where either token is associated with only one liquidity pool
        const finalPairs = allPairs.filter(pair => 
          globalTokenPoolCount[pair.token0] > 1 && 
          globalTokenPoolCount[pair.token1] > 1
        );

        return finalPairs;
    } catch (error) {
        if (DEBUG) {
            console.error('Error in getAllPairsInfo:', error);
        }
        return [];
    }
}