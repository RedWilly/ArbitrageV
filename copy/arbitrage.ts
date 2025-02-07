import { type Address } from 'viem';
import { type Token, type LineGraphVertex, TokenGraph } from './graph';
import { DEBUG } from './constants';

interface ArbitragePath {
    path: LineGraphVertex[];
    expectedProfit: number;
    inputAmount?: bigint;
    startToken: Token;
    endToken: Token;
}

interface ArbitrageOpportunities {
    loops: ArbitragePath[];
    nonLoops: Map<string, ArbitragePath[]>;
}

export class ArbitrageDetector {
    private graph: TokenGraph;
    private maxIterations: number;
    private minProfitThreshold: number;
    private pairs: Map<string, any>;

    constructor(graph: TokenGraph, maxIterations = 100, minProfitThreshold = 0.001) {
        this.graph = graph;
        this.maxIterations = maxIterations;
        this.minProfitThreshold = minProfitThreshold;
        this.pairs = new Map();
    }

    /**
     * Find arbitrage opportunities starting from a given token
     * Implements the Modified Moore-Bellman-Ford algorithm as described in the paper
     */
    public findArbitrageOpportunities(sourceToken: Token): ArbitrageOpportunities {
        const opportunities: ArbitrageOpportunities = {
            loops: [],
            nonLoops: new Map()
        };

        console.log("Building line graph...");
        const lineGraph = this.buildLineGraph();
        console.log(`Line graph built with ${lineGraph.size} vertices`);
        
        if (lineGraph.size === 0) {
            console.log("Line graph is empty, no opportunities possible");
            return opportunities;
        }

        // Run MMBF with proper virtual node connected to source token neighbors
        console.log("Running Bellman-Ford algorithm...");
        this.graph.runBellmanFord(sourceToken);

        // Get the distances and predecessors from the graph
        const distances = this.graph.getDistances();
        const predecessors = this.graph.getPredecessors();
        
        console.log(`Bellman-Ford completed:
            - Distance entries: ${distances.size}
            - Predecessor entries: ${predecessors.size}
        `);

        // Detect negative cycles (arbitrage loops)
        console.log("Detecting negative cycles...");
        const negativeCycles = this.detectNegativeCycles(
            distances,
            predecessors,
            Array.from(lineGraph.values())
        );
        console.log(`Found ${negativeCycles.length} potential negative cycles`);

        // Process negative cycles
        console.log("Processing negative cycles...");
        opportunities.loops = this.processNegativeCycles(negativeCycles);
        console.log(`Found ${opportunities.loops.length} valid arbitrage loops`);

        // Process non-loop opportunities (paths from source token)
        for (const [endKey, endVertex] of lineGraph) {
            if (endVertex.from.address === sourceToken.address) continue;

            const path = this.reconstructPath(endVertex, predecessors);
            if (path && this.isValidArbitragePath(path)) {
                const arbitragePath = this.createArbitragePath(path);
                const key = endVertex.to.address;
                if (!opportunities.nonLoops.has(key)) {
                    opportunities.nonLoops.set(key, []);
                }
                const paths = opportunities.nonLoops.get(key);
                if (paths) {
                    paths.push(arbitragePath);
                }
            }
        }

        return opportunities;
    }

    /**
     * Calculate optimal input amount using bisection method as per paper Section IV-D
     */
    private calculateOptimalInput(
        cycle: LineGraphVertex[],
        initialToken: Token
    ): number {
        if (cycle.length < 2) return 0;

        // Get minimum reserve across the path to set upper bound
        const minReserve = this.getMinimumReserve(cycle);
        const upperBound = minReserve * 0.3; // As per paper, use 30% of minimum reserve
        const lowerBound = 0;
        const epsilon = 1e-10; // Convergence threshold

        let left = lowerBound;
        let right = upperBound;

        while (right - left > epsilon) {
            const mid = (left + right) / 2;
            const derivative = this.calculateMarginOutput(cycle, mid);

            if (Math.abs(derivative - 1.0) < epsilon) {
                return mid;
            }

            if (derivative > 1.0) {
                left = mid;
            } else {
                right = mid;
            }
        }

        return left;
    }

    /**
     * Get minimum reserve along the cycle to set upper bound
     */
    private getMinimumReserve(cycle: LineGraphVertex[]): number {
        let minReserve = Infinity;

        for (const vertex of cycle) {
            const pairInfo = this.pairs.get(vertex.pairAddress);
            if (!pairInfo) continue;

            // Consider both token0 and token1 reserves
            const reserve0 = Number(pairInfo.reserve0);
            const reserve1 = Number(pairInfo.reserve1);

            // Use the reserve corresponding to the input token of this edge
            const reserve = vertex.from.address === pairInfo.token0Address ? 
                reserve0 : reserve1;

            minReserve = Math.min(minReserve, reserve);
        }

        return minReserve === Infinity ? 0 : minReserve;
    }

    /**
     * Calculate marginal output for given input as per paper
     */
    private calculateMarginOutput(
        cycle: LineGraphVertex[],
        input: number
    ): number {
        let currentAmount = input;
        let derivative = 1.0;

        for (const vertex of cycle) {
            const pairInfo = this.pairs.get(vertex.pairAddress);
            if (!pairInfo) continue;

            const isToken0Input = vertex.from.address === pairInfo.token0Address;
            const reserve0 = Number(pairInfo.reserve0);
            const reserve1 = Number(pairInfo.reserve1);

            // Calculate marginal rate based on constant product formula
            // dy/dx = (y/x) * (1 - fee)
            const x = isToken0Input ? reserve0 : reserve1;
            const y = isToken0Input ? reserve1 : reserve0;
            // dynamic fee as per pair
            const fee = 1 - (pairInfo.fee / 10000);

            const marginalRate = (y / x) * (1 - fee);
            derivative *= marginalRate;

            // Update amount for next hop
            currentAmount *= marginalRate;
        }

        return derivative;
    }

    /**
     * Extract negative cycles using walk-to-root approach as per paper
     */
    private extractNegativeCycle(
        start: string,
        predecessors: Map<string, LineGraphVertex | null>
    ): LineGraphVertex[] {
        const cycle: LineGraphVertex[] = [];
        const visited = new Map<string, number>();  // vertex -> position in path
        let current = start;
        let position = 0;

        // Walk to root while tracking the path
        while (true) {
            // Check if we've found a cycle
            if (visited.has(current)) {
                const cycleStart = visited.get(current)!;
                // Extract the cycle vertices from the path
                return cycle.slice(cycleStart);
            }

            visited.set(current, position);
            const pred = predecessors.get(current);
            if (!pred) break;

            cycle.push(pred);
            current = `${pred.from.address}-${pred.to.address}`;
            position++;

            // Safety check for maximum path length
            if (position > predecessors.size) {
                break; // Prevent infinite loops
            }
        }

        return [];
    }

    /**
     * Detect negative cycles with enhanced validation
     */
    private detectNegativeCycles(
        distances: Map<string, number>,
        predecessors: Map<string, LineGraphVertex | null>,
        edges: LineGraphVertex[]
    ): LineGraphVertex[][] {
        const negativeCycles: LineGraphVertex[][] = [];
        const processedCycles = new Set<string>();

        // Check for negative cycles
        for (const edge of edges) {
            const fromKey = `${edge.from.address}-${edge.to.address}`;
            const toKey = `${edge.to.address}-${edge.from.address}`;
            const fromDist = distances.get(fromKey);
            const toDist = distances.get(toKey);

            if (fromDist !== undefined && toDist !== undefined && 
                (fromDist + edge.weight < toDist)) {
                
                // Extract cycle starting from this vertex
                const cycle = this.extractNegativeCycle(toKey, predecessors);
                
                if (cycle.length > 0) {
                    // Generate cycle signature for deduplication
                    const cycleKey = this.generateCycleSignature(cycle);
                    
                    // Only add if we haven't seen this cycle before
                    if (!processedCycles.has(cycleKey)) {
                        // Validate cycle profitability
                        if (this.validateCycleProfitability(cycle)) {
                            negativeCycles.push(cycle);
                            processedCycles.add(cycleKey);
                        }
                    }
                }
            }
        }

        return negativeCycles;
    }

    /**
     * Generate a unique signature for a cycle to prevent duplicates
     */
    private generateCycleSignature(cycle: LineGraphVertex[]): string {
        // Sort addresses to create a canonical representation
        const addresses = cycle.map(vertex => 
            `${vertex.from.address}-${vertex.to.address}`
        ).sort();
        return addresses.join('|');
    }

    /**
     * Validate that a cycle represents a profitable arbitrage opportunity
     */
    private validateCycleProfitability(cycle: LineGraphVertex[]): boolean {
        if (cycle.length < 2) return false;

        // Calculate total weight (log of product of exchange rates)
        let totalWeight = 0;
        for (const vertex of cycle) {
            totalWeight += vertex.weight;
        }

        // Since weights are negative logs, a negative total weight
        // indicates a profitable cycle
        const PROFIT_THRESHOLD = -0.0001; // Adjust based on requirements
        return totalWeight < PROFIT_THRESHOLD;
    }

    /**
     * Reconstruct a path from source to target using predecessor information
     */
    private reconstructPath(
        endVertex: LineGraphVertex,
        predecessors: Map<string, LineGraphVertex | null>
    ): LineGraphVertex[] | null {
        const path: LineGraphVertex[] = [endVertex];
        const visited = new Set<string>();
        let current = endVertex;

        while (true) {
            const key = `${current.from.address}-${current.to.address}`;
            if (visited.has(key)) return null; // Cycle detected
            visited.add(key);

            const pred = predecessors.get(key);
            if (!pred) break;

            path.unshift(pred);
            current = pred;
        }

        return path;
    }

    /**
     * Create an ArbitragePath object from a sequence of vertices
     */
    private createArbitragePath(vertices: LineGraphVertex[]): ArbitragePath {
        const startToken = vertices[0].from;
        const endToken = vertices[vertices.length - 1].to;
        
        // Calculate total weight (log of product of exchange rates)
        const totalWeight = vertices.reduce((sum, v) => sum + v.weight, 0);
        const expectedProfit = -totalWeight; // Negative weight means positive profit

        // Calculate optimal input amount
        const optimalInput = this.calculateOptimalInput(vertices, startToken);
        
        return {
            path: vertices,
            expectedProfit,
            inputAmount: BigInt(Math.floor(optimalInput)), // Convert to bigint after floor
            startToken,
            endToken
        };
    }

    /**
     * Check if a path represents a valid arbitrage opportunity
     */
    private isValidArbitragePath(path: LineGraphVertex[] | ArbitragePath): boolean {
        if (!path) {
            return false;
        }

        let vertices: LineGraphVertex[];
        
        // Check if it's an ArbitragePath object
        if (!Array.isArray(path) && 'path' in path) {
            vertices = path.path;
        } else if (Array.isArray(path)) {
            vertices = path;
        } else {
            return false;
        }

        if (vertices.length < 2) {
            return false;
        }

        // Check for valid connections between vertices
        for (let i = 0; i < vertices.length - 1; i++) {
            const current = vertices[i];
            const next = vertices[i + 1];
            
            // Ensure the vertices are connected
            if (!this.areVerticesConnected(current, next)) {
                return false;
            }
        }

        // Calculate total weight (log of product of exchange rates)
        const totalWeight = vertices.reduce((sum, v) => sum + v.weight, 0);
        
        // Check if the path offers enough profit to cover gas costs
        return -totalWeight > this.minProfitThreshold;
    }

    /**
     * Helper function to check if two vertices are connected
     */
    private areVerticesConnected(v1: LineGraphVertex, v2: LineGraphVertex): boolean {
        return v1.to.address === v2.from.address;
    }

    /**
     * Process negative cycles for arbitrage opportunities
     */
    private processNegativeCycles(cycles: LineGraphVertex[][]): ArbitragePath[] {
        const opportunities: ArbitragePath[] = [];
        
        for (const cycle of cycles) {
            if (this.isValidArbitragePath(cycle)) {
                try {
                    const arbitragePath = this.createArbitragePath(cycle);
                    
                    // Verify the optimal input produces positive profit
                    if (arbitragePath.inputAmount && arbitragePath.inputAmount > 0n) {
                        const marginOutput = this.calculateMarginOutput(cycle, Number(arbitragePath.inputAmount));
                        const profit = marginOutput - Number(arbitragePath.inputAmount);
                        
                        if (profit > 0) {
                            if (DEBUG) {
                                console.log(`Valid arbitrage opportunity found:
                                    Start Token: ${arbitragePath.startToken.symbol || arbitragePath.startToken.address}
                                    End Token: ${arbitragePath.endToken.symbol || arbitragePath.endToken.address}
                                    Path: ${cycle.map(v => `${v.from.symbol || v.from.address} -> ${v.to.symbol || v.to.address}`).join(" -> ")}
                                    Input Amount: ${arbitragePath.inputAmount}
                                    Expected Output: ${marginOutput}
                                    Expected Profit: ${profit}
                                `);
                            }
                            opportunities.push(arbitragePath);
                        }
                    }
                } catch (error) {
                    if (DEBUG) {
                        console.error("Error processing cycle:", error);
                    }
                    continue;
                }
            }
        }
        
        return opportunities;
    }

    /**
     * Build the line graph from the token graph
     */
    private buildLineGraph(): Map<string, LineGraphVertex> {
        // Use the TokenGraph's line graph construction
        const lineGraph = this.graph.constructLineGraph();

        if (DEBUG) {
            console.log(`Built line graph with ${lineGraph.size} vertices`);
            
            // Log some stats about the line graph
            let totalNeighbors = 0;
            for (const vertex of lineGraph.values()) {
                totalNeighbors += vertex.neighbors.length;
            }
            
            console.log(`Line graph statistics:
                Total vertices: ${lineGraph.size}
                Total edges: ${totalNeighbors}
                Average neighbors per vertex: ${totalNeighbors / lineGraph.size || 0}
            `);
        }

        return lineGraph;
    }
}
