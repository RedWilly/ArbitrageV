import { formatUnits } from 'viem';
import { initializeNetwork } from './src/network';
import { getAllPairsInfo, type PairInfo } from './src/getinfo';
import { ArbitrageGraph } from './src/graph';
import { DEBUG, ADDRESSES } from './src/constants';
import { EventMonitor } from './src/event';
import { findAndLogArbitrageOpportunities } from "./src/opp";

async function main() {
    try {
        // Initialize network and get pairs info
        console.log("Initializing network...");
        const network = await initializeNetwork();
        console.log("Fetching pairs information...");
        const pairs = await getAllPairsInfo(network.client);

        if (DEBUG) {
            console.log(`Found ${pairs.length} pairs`);
        }

        // Initialize and build the arbitrage graph
        console.log("Building arbitrage graph...");
        const graph = new ArbitrageGraph();
        
        // Add all pairs to the graph
        for (const pair of pairs) {
            graph.addPair(pair);
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