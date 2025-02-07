import { formatUnits } from 'viem';
import { initializeNetwork } from './src/network';
import { getAllPairsInfo, type PairInfo } from './src/getinfo';
import { ArbitrageGraph } from './src/graph';
import { DEBUG, WETH_ADDRESS } from './src/constants';

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

        // Search for arbitrage opportunities starting from WETH
        console.log("Searching for arbitrage opportunities...");
        const opportunities = graph.findArbitrageOpportunities(WETH_ADDRESS);

        if (opportunities.paths.length > 0) {
            console.log(`Found ${opportunities.paths.length} potential arbitrage opportunities:`);
            
            opportunities.paths.forEach((path, index) => {
                const profit = opportunities.profits[index];
                const pairs = opportunities.pairs[index];
                const optimalAmount = opportunities.optimalAmounts[index];
                const profitPercentage = (profit / optimalAmount) * 100;
                
                console.log(`\nOpportunity #${index + 1}:`);
                console.log(`Path: ${path.join(' -> ')}`);
                console.log(`Expected profit: ${formatUnits(BigInt(profit), 18)} ETH`);
                console.log(`Optimal input amount: ${optimalAmount} wei || ${formatUnits(BigInt(optimalAmount), 18)} ETH`);
                console.log(`Profit percentage: ${profitPercentage.toFixed(2)}%`);
                console.log(`Pairs used: ${pairs.join(', ')}`);
            });
        } else {
            console.log("No profitable arbitrage opportunities found");
        }

    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

main();