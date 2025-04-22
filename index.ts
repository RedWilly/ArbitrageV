import { formatUnits } from 'viem';
import { initializeNetwork } from './src/network';
import { getAllPairsInfo, getV3PoolsInfo, type PairInfo } from './src/getinfo';
import { ArbitrageGraph } from './src/graph';
import { DEBUG, ADDRESSES, enableV3Pools } from './src/constants';
import { EventMonitor } from './src/event';
import { findAndLogArbitrageOpportunities } from "./src/opp";
import { createNonceManager } from './src/nonce';

async function main() {
    try {
        // Initialize network and get pairs info
        console.log("Initializing network...");
        const network = await initializeNetwork();

        // Initialize nonce manager
        console.log("Initializing nonce manager...");
        const nonceManager = createNonceManager(network.account);
        await nonceManager.initialize(network.client);

        console.log("Fetching V2 pairs information...");
        const pairs = await getAllPairsInfo(network.client);
        if (DEBUG) {
            console.log(`Found V2 ${pairs.length} pairs`);
        }

        // Initialize and build the arbitrage graph
        console.log("Building arbitrage graph...");
        const graph = new ArbitrageGraph();
        
        // Add all V2 pools to the graph
        for (const pair of pairs) {
            graph.addPair({
                type: 'V2',
                pairAddress: pair.pairAddress,
                token0: pair.token0,
                token1: pair.token1,
                reserve0: pair.reserve0,
                reserve1: pair.reserve1,
                fee: pair.fee
            });
        }

        if (enableV3Pools) {
            console.log("Fetching V3 pool info...");
            const v3Pairs = await getV3PoolsInfo(network.client);
            if (DEBUG) console.log(`Successfully fetched V3 ${v3Pairs.length} pools`);
            console.log("Adding V3 pools to graph...");
            // Map raw V3PoolInfo to discriminated PoolInfo
            graph.addV3Pools(v3Pairs.map(pool => ({
                type: 'V3',
                poolAddress: pool.poolAddress,
                token0: pool.token0,
                token1: pool.token1,
                tick: pool.tick,
                liquidity: pool.liquidity,
                sqrtPriceX96: pool.sqrtPriceX96,
                fee: pool.fee,
                tickSpacing: pool.tickSpacing
            })));
        }

        // Find arbitrage opportunities
        console.log("Searching for initial arbitrage opportunities...");
        await findAndLogArbitrageOpportunities(graph, network);

        // Start monitoring events
        console.log("\nStarting event monitor...");
        const monitor = new EventMonitor(graph, network);
        await monitor.start();

        // Keep the process running
        process.on('SIGINT', async () => {
            console.log('\nStopping event monitor...');
            await monitor.stop();
            process.exit();
        });

    } catch (error) {
        console.error("Error:", error);
        process.exit(1);
    }
}

main();