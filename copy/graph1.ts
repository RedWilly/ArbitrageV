import { type Address } from 'viem';
import { DEBUG } from './constants';

export type Edge = {
    inputToken: Address;
    outputToken: Address;
    pairAddress: Address;
    weight: number;
};

export type PairInfo = {
    pairAddress: Address;
    token0: Address;
    token1: Address;
    reserve0: bigint;
    reserve1: bigint;
    fee: number; // In basis points (e.g., 30 = 0.3%)
};

export class TokenGraph {
    private graph: Map<Address, Edge[]>;
    private processedPairs: Set<Address>;

    constructor() {
        this.graph = new Map();
        this.processedPairs = new Set();
        if (DEBUG) console.log('TokenGraph: Initialized empty graph');
    }

    private calculateWeight(reserveIn: bigint, reserveOut: bigint, feeBps: number): number {
        // Handle zero reserves (invalid pool)
        if (reserveIn === 0n || reserveOut === 0n) {
            if (DEBUG) console.log('TokenGraph: Ignoring pair with zero reserves');
            return Infinity;
        }

        // Convert basis points to decimal (e.g., 30 → 0.003)
        const feeDecimal = feeBps / 10000;
        
        // Calculate effective rate using precise arithmetic
        const rateIn = Number(reserveIn);
        const rateOut = Number(reserveOut);
        const effectiveRate = (rateOut / rateIn) * (1 - feeDecimal);

        if (effectiveRate <= 0 || !isFinite(effectiveRate)) {
            if (DEBUG) console.log('TokenGraph: Invalid effective rate', effectiveRate);
            return Infinity;
        }

        return -Math.log(effectiveRate);
    }

    private addEdge(edge: Edge) {
        if (!this.graph.has(edge.inputToken)) {
            this.graph.set(edge.inputToken, []);
        }
        this.graph.get(edge.inputToken)!.push(edge);
    }

    public buildFromPairs(pairs: PairInfo[]) {
        this.graph.clear();
        this.processedPairs.clear();

        if (DEBUG) console.log(`TokenGraph: Building from ${pairs.length} pairs`);

        for (const pair of pairs) {
            if (this.processedPairs.has(pair.pairAddress)) {
                if (DEBUG) console.log(`TokenGraph: Skipping duplicate pair ${pair.pairAddress}`);
                continue;
            }
            this.processedPairs.add(pair.pairAddress);

            // Validate reserves
            if (pair.reserve0 === 0n || pair.reserve1 === 0n) {
                if (DEBUG) console.log(`TokenGraph: Skipping pair ${pair.pairAddress} with zero reserves`);
                continue;
            }

            // Create bidirectional edges
            const edge0to1: Edge = {
                inputToken: pair.token0,
                outputToken: pair.token1,
                pairAddress: pair.pairAddress,
                weight: this.calculateWeight(pair.reserve0, pair.reserve1, pair.fee)
            };

            const edge1to0: Edge = {
                inputToken: pair.token1,
                outputToken: pair.token0,
                pairAddress: pair.pairAddress,
                weight: this.calculateWeight(pair.reserve1, pair.reserve0, pair.fee)
            };

            this.addEdge(edge0to1);
            this.addEdge(edge1to0);
        }
    }

    public getEdgesFromToken(token: Address): Edge[] {
        return this.graph.get(token) || [];
    }

    public getAllTokens(): Address[] {
        return Array.from(this.graph.keys());
    }

    // Get the number of edges in the graph
    public getEdgeCount(): number {
        let count = 0;
        for (const edges of this.graph.values()) {
            count += edges.length;
        }
        return count;
    }
}