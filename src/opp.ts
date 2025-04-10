import { formatUnits, type Address } from 'viem';
import { DEBUG, ADDRESSES, TOP_TOKENS_FOR_ARBITRAGE } from './constants';
import { ArbitrageGraph } from './graph';
import { createOpportunityManager } from './execute';
import { type NetworkConfig } from './network';

export interface ArbitrageOpportunities {
    paths: string[][];
    profits: number[];
    pairs: string[][];
    optimalAmounts: number[];
    fees: number[][];
}

export function findAndLogArbitrageOpportunities(graph: ArbitrageGraph, networkConfig: NetworkConfig) {
    // Get the top tokens to consider for arbitrage
    const startTokens = ADDRESSES
        .slice(0, Math.min(TOP_TOKENS_FOR_ARBITRAGE, ADDRESSES.length))
        .map(addr => addr.address);
    
    if (DEBUG) {
        console.log(`Searching for arbitrage opportunities using ${startTokens.length} tokens simultaneously`);
        startTokens.forEach((token, i) => {
            console.log(`Token ${i+1}: ${ADDRESSES[i].name} (${token})`);
        });
    }
    
    // Use the new method that processes multiple tokens in a single traversal
    const opportunities = graph.findMultiTokenArbitrageOpportunities(startTokens);
    
    logArbitrageOpportunities(opportunities);

    // Only process opportunities if there are any found
    if (opportunities.paths.length > 0) {
        // Convert opportunities to the format expected by OpportunityManager
        const formattedOpps = opportunities.paths.map((path, index) => ({
            path: path as Address[],
            pairs: opportunities.pairs[index] as Address[],
            fees: opportunities.fees[index],
            optimalAmount: BigInt(opportunities.optimalAmounts[index]),
            expectedProfit: BigInt(opportunities.profits[index])
        }));

        // Create manager and process opportunities
        const manager = createOpportunityManager(networkConfig);
        manager.processOpportunities(graph, formattedOpps).catch(error => {
            if (DEBUG) {
                console.error('Error processing opportunities:', error);
            }
        });
    }

    return opportunities;
}

function logArbitrageOpportunities(opportunities: ArbitrageOpportunities) {
    if (opportunities.paths.length > 0) {
        console.log(`\nFound ${opportunities.paths.length} potential arbitrage opportunities:`);
        
        opportunities.paths.forEach((path, index) => {
            const profit = opportunities.profits[index];
            const pairs = opportunities.pairs[index];
            const fees = opportunities.fees[index];
            const optimalAmount = opportunities.optimalAmounts[index];
            const profitPercentage = (profit / optimalAmount) * 100;
            
            if (DEBUG) {
                console.log(`\nOpportunity #${index + 1}:`);
                console.log(`Path: ${path.join(' -> ')}`);
                console.log(`Expected profit: ${formatUnits(BigInt(profit), 18)} ETH`);
                console.log(`Optimal input amount: ${optimalAmount} wei || ${formatUnits(BigInt(optimalAmount), 18)} ETH`);
                console.log(`Profit percentage: ${profitPercentage.toFixed(2)}%`);
                console.log(`Pairs used: ${pairs.join(', ')}`);
                console.log(`Fees: ${fees.map(fee => fee.toString()).join(', ')}`);
            }
        });
    } else if (DEBUG) {
        console.log("No profitable arbitrage opportunities found");
    }
}
