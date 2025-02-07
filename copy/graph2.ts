// Graph structure and arbitrage path detection implementation
import { maxHops } from './constants';
import { type Address } from 'viem';

export type PairInfo = {
    pairAddress: Address;
    token0: Address;
    token1: Address;
    reserve0: bigint;
    reserve1: bigint;
    fee: number;
};

interface Edge {
    to: Address;
    rate: number;
    pairAddress: Address;
}

interface DPEntry {
    product: number;
    path: Address[];
    pairs: Address[];
    usedPairs: Set<Address>;
}

interface DPTable {
    [key: number]: {
        [key: string]: DPEntry;
    };
}

export class ArbitrageGraph {
    private graph: { [key: Address]: Edge[] } = {};
    private tokens: Set<Address> = new Set();

    addPair(pair: PairInfo): void {
        // Remove redundant path tracking from edges
        const [res0, res1] = [Number(pair.reserve0), Number(pair.reserve1)];
        if (res0 === 0 || res1 === 0) return;

        this.tokens.add(pair.token0);
        this.tokens.add(pair.token1);

        const feeMultiplier = 1 - pair.fee / 10000;
        
        this.graph[pair.token0] = this.graph[pair.token0] || [];
        this.graph[pair.token1] = this.graph[pair.token1] || [];

        this.graph[pair.token0].push({
            to: pair.token1,
            rate: res1 / res0 * feeMultiplier,
            pairAddress: pair.pairAddress
        });

        this.graph[pair.token1].push({
            to: pair.token0,
            rate: res0 / res1 * feeMultiplier,
            pairAddress: pair.pairAddress
        });
    }

    findArbitrageOpportunities(
        startToken: Address,
        maxDepth: number = maxHops
    ): { paths: Address[][], pairs: Address[][], products: number[] } {
        const dp: DPTable = {};
        const opportunities: { paths: Address[][], pairs: Address[][], products: number[] } = {
            paths: [], pairs: [], products: []
        };

        // Initialize DP table with Set
        dp[0] = {
            [startToken]: {
                product: 1.0,
                path: [startToken],
                pairs: [],
                usedPairs: new Set()
            }
        };

        for (let step = 1; step <= maxDepth; step++) {
            dp[step] = {};
            
            for (const [currentToken, entry] of Object.entries(dp[step-1])) {
                const edges = this.graph[currentToken as Address] || [];
                
                for (const edge of edges) {
                    // Critical fix: Check pair usage before processing
                    if (entry.usedPairs.has(edge.pairAddress)) continue;
                    
                    const newProduct = entry.product * edge.rate;
                    const newPath = [...entry.path, edge.to];
                    const newPairs = [...entry.pairs, edge.pairAddress];
                    const newUsedPairs = new Set([...entry.usedPairs, edge.pairAddress]);

                    // Update if better path found
                    if (!dp[step][edge.to] || newProduct > dp[step][edge.to].product) {
                        dp[step][edge.to] = {
                            product: newProduct,
                            path: newPath,
                            pairs: newPairs,
                            usedPairs: newUsedPairs
                        };
                    }

                    // Profitability check with threshold
                    if (edge.to === startToken && step >= 2 && newProduct > 1.005) {
                        opportunities.paths.push(newPath);
                        opportunities.pairs.push(newPairs);
                        opportunities.products.push(newProduct);
                    }
                }
            }
        }

        // Sort and return top results
        return opportunities.products
            .map((_, i) => i)
            .sort((a, b) => opportunities.products[b] - opportunities.products[a])
            .slice(0, 20)
            // .reduce((acc, i) => ({
            .reduce((acc: { paths: Address[][], pairs: Address[][], products: number[] }, i) => ({
                paths: [...acc.paths, opportunities.paths[i]],
                pairs: [...acc.pairs, opportunities.pairs[i]],
                products: [...acc.products, opportunities.products[i]]
            }), { paths: [], pairs: [], products: [] });
    }

    // Rest of methods remain unchanged


    // Get all tokens in the graph
    getTokens(): Address[] {
        return Array.from(this.tokens);
    }

    // Get specific edge details
    getEdge(from: Address, to: Address): Edge | undefined {
        return this.graph[from]?.find(edge => edge.to === to);
    }

    // Clear the graph
    clear(): void {
        this.graph = {};
        this.tokens.clear();
    }
}