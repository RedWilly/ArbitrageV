import { type Address, createPublicClient, http, parseEther } from 'viem';
import { ADDRESSES, BATCH_SIZE, FACTORY, TAX_CHECKER_ADDRESS, UNISWAP_FLASH_QUERY_CONTRACT, DEBUG } from './constants';
import CheckTaxABI from './ABI/CheckTax.json';
import UniswapFlashQueryABI from './ABI/UniswapFlashQuery.json';
import { initializeNetwork } from './network';
import fs from 'fs';

//TODO: not working for most pairs- come back to this later/contract

// Special batch size for Woof factory
const WOOF_RESERVES_BATCH_SIZE = 5;
const TAX_CHECK_BATCH_SIZE = 2;
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
        const pairsData = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
            abi: UniswapFlashQueryABI,
            functionName: 'getPairsByIndexRange',
            args: [factory.address, BigInt(start), BigInt(stop)],
        }) as Address[][];

        return pairsData.map(([token0, token1, pairAddress]) => ({
            pairAddress,
            token0,
            token1,
            factory: factory.name,
        }));
    } catch (error) {
        if (DEBUG) {
            console.error(`Error fetching pairs for factory ${factory.name}:`, error);
        }
        return [];
    }
}

async function getReservesForPairs(
    client: any,
    pairs: PairData[]
): Promise<PairData[]> {
    try {
        const reserves = await client.readContract({
            address: UNISWAP_FLASH_QUERY_CONTRACT as Address,
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
        if (DEBUG) {
            console.error('Error fetching reserves:', error);
        }
        throw error;
    }
}

async function getReservesWithRetry(
    client: any,
    pairs: PairData[]
): Promise<PairData[]> {
    const result: PairData[] = [];
    const isWoofFactory = pairs[0]?.factory.toLowerCase().includes('woof');
    const batchSize = isWoofFactory ? WOOF_RESERVES_BATCH_SIZE : BATCH_SIZE;

    for (let i = 0; i < pairs.length; i += batchSize) {
        const batch = pairs.slice(i, i + batchSize);
        try {
            if (DEBUG) {
                console.log(`Fetching reserves for ${batch.length} pairs from ${pairs[0].factory} (${i + 1} to ${i + batch.length})`);
            }
            const pairsWithReserves = await getReservesForPairs(client, batch);
            result.push(...pairsWithReserves);
        } catch (error) {
            if (DEBUG) {
                console.error(`Error fetching reserves for batch, skipping...`, error);
            }
            continue;
        }
    }

    return result;
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
        
        // Process in batches of 50
        for (let i = 0; i < tokens.length; i += TAX_CHECK_BATCH_SIZE) {
            const batchTokens = tokens.slice(i, i + TAX_CHECK_BATCH_SIZE);
            const batchBaseTokens = baseTokens.slice(i, i + TAX_CHECK_BATCH_SIZE);
            
            console.log(`Processing tax check batch ${i} to ${i + batchTokens.length} of ${tokens.length}`);
            console.log('batchValidateOne args:', {
                factoryAddress,
                tokensCount: batchTokens.length,
                tokens: batchTokens,
                baseTokensCount: batchBaseTokens.length,
                baseTokens: batchBaseTokens,
                amountToBorrow: amountToBorrow.toString()
            });

            const { result } = await client.simulateContract({
                address: TAX_CHECKER_ADDRESS,
                abi: CheckTaxABI,
                functionName: "batchValidateOne",
                args: [factoryAddress, batchTokens, batchBaseTokens, amountToBorrow],
            }) as { result: TaxCheckResult[] };

            results.push(...result);
        }

        return results;
    } catch (error) {
        console.error(`Error checking tax batch:`, error);
        throw error;
    }
}

async function processPairBatch(
    client: any,
    pairs: PairData[]
): Promise<TaxInfo> {
    const taxInfo: TaxInfo = {};
    const amountToBorrow = 1000000n; // 1000000 wei as specified

    try {
        // Get reserves for all pairs first
        const pairsWithReserves = await getReservesWithRetry(client, pairs);
        
        // Filter out pairs with low liquidity
        const filteredPairs = pairsWithReserves.filter(pair => {
            if (!pair.reserve0 || !pair.reserve1) return false;
            
            // Check if either token is in ADDRESSES
            const token0InAddresses = ADDRESSES.some(addr => addr.address.toLowerCase() === pair.token0.toLowerCase());
            const token1InAddresses = ADDRESSES.some(addr => addr.address.toLowerCase() === pair.token1.toLowerCase());
            
            if (token0InAddresses) {
                // If token0 is monitored token, check its reserve
                const requiredAmount = ADDRESSES.find(addr => addr.address.toLowerCase() === pair.token0.toLowerCase())?.LPAMOUNT;
                if (!requiredAmount || pair.reserve0 < BigInt(requiredAmount)) return false;
            } else if (token1InAddresses) {
                // If token1 is monitored token, check its reserve
                const requiredAmount = ADDRESSES.find(addr => addr.address.toLowerCase() === pair.token1.toLowerCase())?.LPAMOUNT;
                if (!requiredAmount || pair.reserve1 < BigInt(requiredAmount)) return false;
            } else {
                // If neither token is monitored, both must meet MIN_LIQUIDITY
                if (pair.reserve0 < MIN_LIQUIDITY && pair.reserve1 < MIN_LIQUIDITY) return false;
            }
            
            return true;
        });

        if (DEBUG) {
            console.log(`Filtered out ${pairsWithReserves.length - filteredPairs.length} pairs with insufficient liquidity`);
            console.log(`Remaining pairs: ${filteredPairs.length}`);
        }

        // Group remaining pairs by factory
        const pairsByFactory: { [factory: string]: PairData[] } = {};
        filteredPairs.forEach(pair => {
            if (!pairsByFactory[pair.factory]) {
                pairsByFactory[pair.factory] = [];
            }
            pairsByFactory[pair.factory].push(pair);
        });

        // Process each factory's pairs
        for (const [factoryName, factoryPairs] of Object.entries(pairsByFactory)) {
            const factoryAddress = FACTORY.find(f => f.name === factoryName)?.address as Address;
            if (!factoryAddress) continue;

            const tokens: Address[] = [];
            const baseTokens: Address[] = [];
            const pairMap: { [key: string]: PairData } = {};

            // Prepare batch arrays
            factoryPairs.forEach(pair => {
                const token0InAddresses = ADDRESSES.some(addr => addr.address.toLowerCase() === pair.token0.toLowerCase());
                const token1InAddresses = ADDRESSES.some(addr => addr.address.toLowerCase() === pair.token1.toLowerCase());

                if (token0InAddresses || token1InAddresses) {
                    // One token is in ADDRESSES, use it as base token
                    const [token, baseToken] = token0InAddresses ? [pair.token1, pair.token0] : [pair.token0, pair.token1];
                    tokens.push(token);
                    baseTokens.push(baseToken);
                    pairMap[`${token}_${baseToken}`] = pair;
                } else {
                    // Check both directions
                    tokens.push(pair.token0, pair.token1);
                    baseTokens.push(pair.token1, pair.token0);
                    pairMap[`${pair.token0}_${pair.token1}`] = pair;
                    pairMap[`${pair.token1}_${pair.token0}`] = pair;
                }
            });

            if (tokens.length === 0) continue;

            // Batch check taxes
            const results = await checkTaxBatch(client, factoryAddress, tokens, baseTokens, amountToBorrow);

            // Process results
            results.forEach((result, index) => {
                if (Number(result.buyFeeBps) > 0 || Number(result.sellFeeBps) > 0) {
                    const token = tokens[index];
                    const baseToken = baseTokens[index];
                    const pair = pairMap[`${token}_${baseToken}`];
                    if (pair) {
                        taxInfo[pair.pairAddress] = {
                            buyFeeBps: Number(result.buyFeeBps),
                            sellFeeBps: Number(result.sellFeeBps)
                        };
                    }
                }
            });
        }
    } catch (error) {
        console.error(`Error processing pair batch:`, error);
    }

    return taxInfo;
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
