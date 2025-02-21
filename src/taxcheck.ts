import { type Address, createPublicClient, http, parseEther } from 'viem';
import { ADDRESSES, BATCH_SIZE, FACTORY, TAX_CHECKER_ADDRESS, UNISWAP_FLASH_QUERY_CONTRACT, DEBUG } from './constants';
import CheckTaxABI from './ABI/CheckTax.json';
import UniswapFlashQueryABI from './ABI/UniswapFlashQuery.json';
import { initializeNetwork } from './network';
import fs from 'fs';

//TODO: not working for most pairs- come back to this later/contract

// Special batch size for Woof factory
const WOOF_RESERVES_BATCH_SIZE = 5;
const TAX_CHECK_BATCH_SIZE = 3;
const MIN_LIQUIDITY = parseEther("50");

interface TaxCheckResult {
    buyFeeBps: bigint;
    sellFeeBps: bigint;
    feeTakenOnTransfer: boolean;
    externalTransferFailed: boolean;
    sellReverted: boolean;
}

interface TaxInfo {
    [pairAddress: string]: {
        buyFeeBps: number;
        sellFeeBps: number;
        sellReverted: boolean;
    }
}

interface PairData {
    pairAddress: Address;
    token0: Address;
    token1: Address;
    factory: string;
    reserve0?: bigint;
    reserve1?: bigint;
    lastTimestamp?: number;
}

// Helper function to add 5% to non-zero fees and round up
function addFivePercent(fee: bigint): number {
    if (fee === 0n) return 0;
    const feeNumber = Number(fee);
    return Math.ceil(feeNumber + (feeNumber * 0.05)); // Add 5% and round up
}

async function getPairsLength(
    client: any,
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

async function getPairsInRange(
    client: any,
    factory: typeof FACTORY[0],
    start: number,
    stop: number
): Promise<PairData[]> {
    try {
        console.log(`\n[${factory.name}] Fetching pairs from index ${start} to ${stop}`);
        
        const pairsData = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getPairsByIndexRange',
            args: [factory.address, BigInt(start), BigInt(stop)],
        }) as Address[][];

        console.log(`[${factory.name}] Found ${pairsData.length} pairs in range`);
        
        // Log each pair's details
        pairsData.forEach(([token0, token1, pairAddress], index) => {
            console.log(`\n[${factory.name}] Pair ${start + index}:`);
            console.log(`  Pair Address: ${pairAddress}`);
            console.log(`  Token0: ${token0}`);
            console.log(`  Token1: ${token1}`);
        });

        const pairs = pairsData.map(([token0, token1, pairAddress]) => ({
            pairAddress,
            token0,
            token1,
            factory: factory.name,
        }));

        return pairs;
    } catch (error) {
        console.error(`[${factory.name}] Error fetching pairs in range ${start}-${stop}:`, error);
        return [];
    }
}

async function getReservesForPairs(
    client: any,
    pairs: PairData[]
): Promise<PairData[]> {
    try {
        console.log(`\nFetching reserves for pairs...`);
        const reserves = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getReservesByPairs',
            args: [pairs.map(p => p.pairAddress)],
        }) as [bigint, bigint, number][];

        return pairs.map((pair, i) => {
            const [reserve0, reserve1, timestamp] = reserves[i];
            console.log(`\nReserves for pair ${pair.pairAddress} (${pair.factory}):`);
            console.log(`  Token0: ${pair.token0}`);
            console.log(`  Token1: ${pair.token1}`);
            console.log(`  Reserve0: ${reserve0.toString()}`);
            console.log(`  Reserve1: ${reserve1.toString()}`);
            return {
                ...pair,
                reserve0,
                reserve1,
                lastTimestamp: timestamp,
            };
        });
    } catch (error) {
        console.error('Error in getReservesForPairs:', error);
        return pairs;
    }
}

async function getReservesWithRetry(
    client: any,
    pairs: PairData[]
): Promise<PairData[]> {
    try {
        console.log(`\nGetting reserves for ${pairs.length} pairs`);
        const pairsWithReserves = await getReservesForPairs(client, pairs);
        
        // Log pairs that were filtered out due to reserves
        const filteredPairs = pairsWithReserves.filter(pair => {
            if (!pair.reserve0 || !pair.reserve1) {
                console.log(`\nPair ${pair.pairAddress} filtered out:`);
                console.log(`  Reason: Missing reserves`);
                console.log(`  Reserve0: ${pair.reserve0 || 'missing'}`);
                console.log(`  Reserve1: ${pair.reserve1 || 'missing'}`);
                return false;
            }
            
            // Check if either token is in ADDRESSES
            const token0InAddresses = ADDRESSES.some(addr => addr.address.toLowerCase() === pair.token0.toLowerCase());
            const token1InAddresses = ADDRESSES.some(addr => addr.address.toLowerCase() === pair.token1.toLowerCase());
            
            if (token0InAddresses) {
                const requiredAmount = ADDRESSES.find(addr => addr.address.toLowerCase() === pair.token0.toLowerCase())?.LPAMOUNT;
                if (!requiredAmount || pair.reserve0 < BigInt(requiredAmount)) {
                    console.log(`\nPair ${pair.pairAddress} filtered out:`);
                    console.log(`  Reason: Insufficient token0 reserves`);
                    console.log(`  Token0: ${pair.token0} (monitored token)`);
                    console.log(`  Required: ${requiredAmount || 'N/A'}`);
                    console.log(`  Actual: ${pair.reserve0}`);
                    return false;
                }
            } else if (token1InAddresses) {
                const requiredAmount = ADDRESSES.find(addr => addr.address.toLowerCase() === pair.token1.toLowerCase())?.LPAMOUNT;
                if (!requiredAmount || pair.reserve1 < BigInt(requiredAmount)) {
                    console.log(`\nPair ${pair.pairAddress} filtered out:`);
                    console.log(`  Reason: Insufficient token1 reserves`);
                    console.log(`  Token1: ${pair.token1} (monitored token)`);
                    console.log(`  Required: ${requiredAmount || 'N/A'}`);
                    console.log(`  Actual: ${pair.reserve1}`);
                    return false;
                }
            } else {
                if (pair.reserve0 < MIN_LIQUIDITY && pair.reserve1 < MIN_LIQUIDITY) {
                    console.log(`\nPair ${pair.pairAddress} filtered out:`);
                    console.log(`  Reason: Both tokens below minimum liquidity`);
                    console.log(`  Token0: ${pair.token0}, Reserve: ${pair.reserve0}`);
                    console.log(`  Token1: ${pair.token1}, Reserve: ${pair.reserve1}`);
                    console.log(`  Required: ${MIN_LIQUIDITY}`);
                    return false;
                }
            }
            
            return true;
        });

        console.log(`\nAfter filtering:`);
        console.log(`  Original pairs: ${pairs.length}`);
        console.log(`  Remaining pairs: ${filteredPairs.length}`);
        console.log(`  Filtered out: ${pairs.length - filteredPairs.length}`);

        return filteredPairs;
    } catch (error) {
        console.error('Error in getReservesWithRetry:', error);
        return [];
    }
}

async function checkTaxBatch(
    client: any,
    factoryAddress: Address,
    tokens: Address[],
    baseTokens: Address[],
    amountToBorrow: bigint
): Promise<TaxCheckResult[]> {
    try {
        const results: TaxCheckResult[] = [];
        
        // Process in batches of 3
        for (let i = 0; i < tokens.length; i += TAX_CHECK_BATCH_SIZE) {
            const batchTokens = tokens.slice(i, i + TAX_CHECK_BATCH_SIZE);
            const batchPairs = baseTokens.slice(i, i + TAX_CHECK_BATCH_SIZE);
            const batchFactories = new Array(batchTokens.length).fill(factoryAddress);
            
            console.log(`\n[Tax Check] Processing batch ${Math.floor(i/TAX_CHECK_BATCH_SIZE) + 1}:`);
            batchTokens.forEach((token, idx) => {
                console.log(`  Pair ${idx + 1}:`);
                console.log(`    Token: ${token}`);
                console.log(`    Pair Address: ${batchPairs[idx]}`);
                console.log(`    Factory: ${factoryAddress}`);
            });

            try {
                const { result } = await client.simulateContract({
                    address: TAX_CHECKER_ADDRESS,
                    abi: CheckTaxABI,
                    functionName: "batchValidateAll",
                    args: [batchPairs, batchTokens, batchFactories, amountToBorrow],
                }) as { result: TaxCheckResult[] };

                // Log results for each pair in batch
                result.forEach((res, idx) => {
                    console.log(`\n[Tax Check] Result for ${batchPairs[idx]}:`);
                    console.log(`  Token: ${batchTokens[idx]}`);
                    console.log(`  Buy Fee: ${res.buyFeeBps.toString()} bps`);
                    console.log(`  Sell Fee: ${res.sellFeeBps.toString()} bps`);
                    console.log(`  Sell Reverted: ${res.sellReverted}`);
                    console.log(`  Fee Taken On Transfer: ${res.feeTakenOnTransfer}`);
                    console.log(`  External Transfer Failed: ${res.externalTransferFailed}`);
                });

                results.push(...result);
            } catch (error) {
                console.error(`[Tax Check] Batch validation failed for batch ${Math.floor(i/TAX_CHECK_BATCH_SIZE) + 1}:`, error);
                // Log which pairs were in the failed batch
                console.log('Failed batch contained:');
                batchPairs.forEach((pair, idx) => {
                    console.log(`  Pair: ${pair}, Token: ${batchTokens[idx]}`);
                });
                
                // For simulation reverts, we don't want to mark pairs as sellReverted
                // Instead, we'll skip these pairs by pushing empty results
                results.push(...new Array(batchTokens.length).fill({
                    buyFeeBps: 0n,
                    sellFeeBps: 0n,
                    feeTakenOnTransfer: false,
                    externalTransferFailed: false,
                    sellReverted: false
                }));
            }
        }

        return results;
    } catch (error) {
        console.error(`[Tax Check] Error in checkTaxBatch:`, error);
        throw error;
    }
}

async function processPairBatch(
    client: any,
    pairs: PairData[]
): Promise<TaxInfo> {
    const taxInfo: TaxInfo = {};
    const amountToBorrow = 10000000n;

    try {
        // Get reserves for all pairs first
        console.log(`\nProcessing batch of ${pairs.length} pairs`);
        const pairsWithReserves = await getReservesWithRetry(client, pairs);
        
        // Group remaining pairs by factory
        const pairsByFactory: { [factory: string]: PairData[] } = {};
        pairsWithReserves.forEach(pair => {
            console.log(`\nPair ${pair.pairAddress} passed reserve checks:`);
            console.log(`  Factory: ${pair.factory}`);
            console.log(`  Token0: ${pair.token0}, Reserve0: ${pair.reserve0}`);
            console.log(`  Token1: ${pair.token1}, Reserve1: ${pair.reserve1}`);
            
            if (!pairsByFactory[pair.factory]) {
                pairsByFactory[pair.factory] = [];
            }
            pairsByFactory[pair.factory].push(pair);
        });

        // Process each factory's pairs
        for (const [factoryName, factoryPairs] of Object.entries(pairsByFactory)) {
            console.log(`\nProcessing ${factoryPairs.length} pairs for factory ${factoryName}`);
            const factoryAddress = FACTORY.find(f => f.name === factoryName)?.address as Address;
            if (!factoryAddress) {
                console.log(`Factory address not found for ${factoryName}, skipping`);
                continue;
            }

            const SPECIAL_TOKEN = ADDRESSES[0].address;
            const tokens = factoryPairs.map(p => {
                // If token0 is the special token, use token1 instead
                if (p.token0.toLowerCase() === SPECIAL_TOKEN.toLowerCase()) {
                    console.log(`Found special token ${SPECIAL_TOKEN} as token0, using token1 ${p.token1} instead`);
                    return p.token1;
                }
                return p.token0;
            });
            const pairs = factoryPairs.map(p => p.pairAddress);

            console.log(`Checking taxes for ${pairs.length} pairs in ${factoryName}`);
            const taxResults = await checkTaxBatch(
                client,
                factoryAddress,
                tokens,
                pairs,
                amountToBorrow
            );

            // Process and save results according to new rules
            taxResults.forEach((result, index) => {
                const pairAddress = pairs[index];
                const pair = factoryPairs[index];
                
                console.log(`\nTax check result for pair ${pairAddress}:`);
                console.log(`  Token0: ${pair.token0}`);
                console.log(`  Token1: ${pair.token1}`);
                console.log(`  Buy Fee: ${result.buyFeeBps.toString()}`);
                console.log(`  Sell Fee: ${result.sellFeeBps.toString()}`);
                console.log(`  Sell Reverted: ${result.sellReverted}`);
                
                // Save if either fee is > 0 OR if sellReverted is true
                if (result.buyFeeBps > 0n || result.sellFeeBps > 0n || result.sellReverted) {
                    console.log(`  Status: Saving to taxedp.json`);
                    taxInfo[pairAddress] = {
                        buyFeeBps: result.sellReverted && result.buyFeeBps === 0n ? 0 : addFivePercent(result.buyFeeBps),
                        sellFeeBps: result.sellReverted && result.sellFeeBps === 0n ? 0 : addFivePercent(result.sellFeeBps),
                        sellReverted: result.sellReverted
                    };
                } else {
                    console.log(`  Status: Skipped (no fees and no revert)`);
                }
            });
        }

        return taxInfo;
    } catch (error) {
        console.error('Error in processPairBatch:', error);
        return taxInfo;
    }
}

async function main() {
    const network = await initializeNetwork();
    const client = network.client;
    const allTaxInfo: TaxInfo = {};

    // Get pairs length for all factories
    const pairsLengths = await getPairsLength(client, FACTORY);

    for (const factory of FACTORY) {
        console.log(`Processing factory: ${factory.name}`);
        const pairsLength = pairsLengths.get(factory.name) || 0;
        
        // Determine batch size
        const batchSize = factory.name === 'woof' ? WOOF_RESERVES_BATCH_SIZE : BATCH_SIZE;
        
        // Process pairs in batches
        for (let start = 0; start < pairsLength; start += batchSize) {
            const stop = Math.min(start + batchSize, pairsLength);
            console.log(`Processing batch ${start} to ${stop} of ${pairsLength} pairs`);
            
            // Get pairs for this batch
            const pairs = await getPairsInRange(client, factory, start, stop);
            
            // Process the batch
            const batchTaxInfo = await processPairBatch(client, pairs);
            Object.assign(allTaxInfo, batchTaxInfo);
        }
    }

    // Save results to file
    fs.writeFileSync('taxedp.json', JSON.stringify(allTaxInfo, null, 2));
    console.log('Tax information saved to taxedp.json');
}

main().catch(console.error);
