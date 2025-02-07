import { type Address } from 'viem';
import { TokenGraph, type Edge } from './graph';
import { DEBUG } from './constants';

export type ArbitragePath = {
    path: Address[];
    pairs: Address[];
    profit: number;
    signature: string;
};

export class ArbitrageDetector {
    private readonly MIN_CYCLE_LENGTH = 2;
    private readonly MAX_CYCLE_LENGTH = 20;
    private foundSignatures = new Set<string>();

    constructor(private graph: TokenGraph) {
        if (DEBUG) console.log('ArbitrageDetector: Initialized');
    }

    private generateSignature(pairs: Address[]): string {
        const uniquePairs = [...new Set(pairs)].sort();
        return uniquePairs.join('|');
    }

    private hasDuplicatePairs(pairs: Address[]): boolean {
        const seen = new Set<Address>();
        return pairs.some(pair => seen.size === seen.add(pair).size);
    }

    private validatePath(path: Address[], pairs: Address[], source: Address): boolean {
        let isValid = true;
        
        if (path.length < this.MIN_CYCLE_LENGTH + 1) {
            if (DEBUG) console.log(`Invalid path: Too short (${path.length} nodes)`);
            isValid = false;
        }
        
        if (path[0] !== source) {
            if (DEBUG) console.log(`Invalid path: Doesn't start with source (start: ${path[0]})`);
            isValid = false;
        }
        
        if (path[path.length - 1] !== source) {
            if (DEBUG) console.log(`Invalid path: Doesn't end with source (end: ${path[path.length - 1]})`);
            isValid = false;
        }
        
        if (this.hasDuplicatePairs(pairs)) {
            if (DEBUG) console.log(`Invalid path: Duplicate pairs found`);
            isValid = false;
        }
        
        if (pairs.length !== path.length - 1) {
            if (DEBUG) console.log(`Invalid path: Pair count mismatch (${pairs.length} pairs vs ${path.length - 1} expected)`);
            isValid = false;
        }

        return isValid;
    }

    private initializeDistances(source: Address): Map<Address, number> {
        const distances = new Map<Address, number>();
        for (const token of this.graph.getAllTokens()) {
            distances.set(token, token === source ? 0 : Infinity);
        }
        return distances;
    }

    private reconstructPath(
        source: Address,
        predecessors: Map<Address, { token: Address; pair: Address }>[],
        step: number,
        cycleDist: number
    ): ArbitragePath | null {
        const path: Address[] = [];
        const pairs: Address[] = [];
        let currentToken = source;

        try {
            for (let i = step; i > 0; i--) {
                const pred = predecessors[i]?.get(currentToken);
                if (!pred) throw new Error('Broken predecessor chain');
                
                path.unshift(pred.token);
                pairs.unshift(pred.pair);
                currentToken = pred.token;
            }
            
            path.push(source);
        } catch (e) {
            if (DEBUG) console.log('Path reconstruction failed:', e);
            return null;
        }

        if (!this.validatePath(path, pairs, source)) {
            return null;
        }

        const signature = this.generateSignature(pairs);
        const profit = Math.exp(-cycleDist) - 1;

        return { path, pairs, profit, signature };
    }

    public findArbitrage(sourceToken: Address, excludeSignatures = new Set<string>()): ArbitragePath | null {
        if (DEBUG) console.log(`Starting arbitrage search from ${sourceToken}`);

        let prevDist = this.initializeDistances(sourceToken);
        const predecessors: Map<Address, { token: Address; pair: Address }>[] = [];
        let hasUpdates = true;

        for (let step = 1; step <= this.MAX_CYCLE_LENGTH; step++) {
            if (!hasUpdates) break;

            const currDist = new Map<Address, number>();
            const stepPredecessors = new Map<Address, { token: Address; pair: Address }>();
            hasUpdates = false;

            for (const token of this.graph.getAllTokens()) {
                currDist.set(token, Infinity);
            }

            for (const token of this.graph.getAllTokens()) {
                const currentDist = prevDist.get(token)!;
                if (currentDist === Infinity) continue;

                for (const edge of this.graph.getEdgesFromToken(token)) {
                    const newDist = currentDist + edge.weight;
                    if (newDist < currDist.get(edge.outputToken)!) {
                        currDist.set(edge.outputToken, newDist);
                        stepPredecessors.set(edge.outputToken, {
                            token: edge.inputToken,
                            pair: edge.pairAddress
                        });
                        hasUpdates = true;
                    }
                }
            }

            predecessors[step] = stepPredecessors;

            if (step >= this.MIN_CYCLE_LENGTH) {
                const cycleDist = currDist.get(sourceToken)!;
                if (cycleDist < 0) {
                    const result = this.reconstructPath(sourceToken, predecessors, step, cycleDist);
                    if (result && 
                        !excludeSignatures.has(result.signature) &&
                        !this.foundSignatures.has(result.signature)
                    ) {
                        if (DEBUG) {
                            console.log(`Found valid opportunity at step ${step}`);
                            console.log(`  Profit: ${(result.profit * 100).toFixed(2)}%`);
                        }
                        return result;
                    }
                }
            }

            prevDist = currDist;
        }

        return null;
    }

    public findAllArbitrage(sourceToken: Address, maxAttempts = 20): ArbitragePath[] {
        const opportunities: ArbitragePath[] = [];
        const localFoundSignatures = new Set<string>();

        for (let i = 0; i < maxAttempts; i++) {
            const opportunity = this.findArbitrage(sourceToken, localFoundSignatures);
            if (!opportunity) break;

            if (!localFoundSignatures.has(opportunity.signature)) {
                opportunities.push(opportunity);
                localFoundSignatures.add(opportunity.signature);
                this.foundSignatures.add(opportunity.signature);
            }
        }

        return opportunities;
    }

    public clearFoundSignatures() {
        this.foundSignatures.clear();
    }
}