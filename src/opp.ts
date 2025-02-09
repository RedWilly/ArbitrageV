import { formatUnits } from 'viem';
import { DEBUG, ADDRESSES } from './constants';
import { ArbitrageGraph } from './graph';

export interface ArbitrageOpportunities {
    paths: string[][];
    profits: number[];
    pairs: string[][];
    optimalAmounts: number[];
}

export function findAndLogArbitrageOpportunities(graph: ArbitrageGraph) {
    const opportunities = graph.findArbitrageOpportunities(ADDRESSES[0].address);
    logArbitrageOpportunities(opportunities);
    return opportunities;
}

function logArbitrageOpportunities(opportunities: ArbitrageOpportunities) {
    if (opportunities.paths.length > 0) {
        console.log(`\nFound ${opportunities.paths.length} potential arbitrage opportunities:`);
        
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
    } else if (DEBUG) {
        console.log("No profitable arbitrage opportunities found");
    }
}
