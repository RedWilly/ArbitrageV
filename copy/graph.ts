import { type PairInfo } from "./getinfov4";
import { type Address } from 'viem';
import { DEBUG } from './constants';

// Interfaces for graph construction
export interface Token {
    address: Address;
    symbol?: string;
    decimals?: number;
}

export interface Edge {
    pairAddress: Address;
    from: Token;
    to: Token;
    weight: number;  // -log((1-λ) * rj/ri)
    reserve0: bigint;
    reserve1: bigint;
    fee: number;
}

export interface Vertex {
    token: Token;
    edges: Edge[];
}

export interface LineGraphVertex {
    from: Token;
    to: Token;
    pairAddress: Address;
    neighbors: LineGraphVertex[];
    weight: number;
}

//G(V,E,P):  V: vertices, E: edges, P: pairs
export class TokenGraph { 
    private vertices: Map<string, Vertex>;
    private lineGraph: Map<string, LineGraphVertex>;
    private pairs: Map<string, PairInfo>;
    private distances: Map<string, number>;
    private predecessors: Map<string, LineGraphVertex | null>;

    constructor() {
        this.vertices = new Map();
        this.lineGraph = new Map();
        this.pairs = new Map();
        this.distances = new Map();
        this.predecessors = new Map();
    }

    /**
     * Update or add a new pair to the graph
     * @param pair PairInfo from Uniswap
     */
    addPair(pair: PairInfo) {
        // Store pair info
        this.pairs.set(pair.pairAddress, pair);

        // Create tokens if they don't exist
        const token0: Token = { address: pair.token0 };
        const token1: Token = { address: pair.token1 };

        this.addToken(token0);
        this.addToken(token1);

        // Skip pairs with zero reserves
        if (pair.reserve0 <= 0n || pair.reserve1 <= 0n) {
            if (DEBUG) {
                console.log(`Skipping pair ${pair.pairAddress} due to zero reserves: ${pair.reserve0}, ${pair.reserve1}`);
            }
            return;
        }

        // Calculate edge weights using the formula from the paper: -log((1-λ) * rj/ri)
        // where λ is the fee rate
        const feeMultiplier = 1 - (pair.fee / 10000); // Convert basis points to decimal
        
        // Calculate ratios using bigint arithmetic for higher precision
        const ratio01 = Number(pair.reserve1) / Number(pair.reserve0);
        const ratio10 = Number(pair.reserve0) / Number(pair.reserve1);
        
        const weight01 = -Math.log(feeMultiplier * ratio01);
        const weight10 = -Math.log(feeMultiplier * ratio10);

        if (!isFinite(weight01) || !isFinite(weight10)) {
            if (DEBUG) {
                console.log(`Skipping pair ${pair.pairAddress} due to invalid weights: ${weight01}, ${weight10}`);
            }
            return;
        }

        if (DEBUG) {
            console.log(`Adding pair ${pair.pairAddress}:
                - Token0: ${token0.address} (reserve: ${pair.reserve0})
                - Token1: ${token1.address} (reserve: ${pair.reserve1})
                - Fee multiplier: ${feeMultiplier}
                - Weights: ${weight01}, ${weight10}
            `);
        }

        // Create edges in both directions
        const edge01: Edge = {
            pairAddress: pair.pairAddress,
            from: token0,
            to: token1,
            weight: weight01,
            reserve0: pair.reserve0,
            reserve1: pair.reserve1,
            fee: pair.fee
        };

        const edge10: Edge = {
            pairAddress: pair.pairAddress,
            from: token1,
            to: token0,
            weight: weight10,
            reserve0: pair.reserve0,
            reserve1: pair.reserve1,
            fee: pair.fee
        };

        // Add edges to vertices
        this.vertices.get(token0.address)?.edges.push(edge01);
        this.vertices.get(token1.address)?.edges.push(edge10);

        // Reconstruct line graph since topology changed
        this.constructLineGraph();
    }

    /**
     * Remove a pair from the graph
     * @param pairAddress Address of the pair to remove
     */
    removePair(pairAddress: Address) {
        const pair = this.pairs.get(pairAddress);
        if (!pair) return;

        // Remove edges from vertices
        const vertex0 = this.vertices.get(pair.token0);
        const vertex1 = this.vertices.get(pair.token1);

        if (vertex0) {
            vertex0.edges = vertex0.edges.filter(e => e.pairAddress !== pairAddress);
        }
        if (vertex1) {
            vertex1.edges = vertex1.edges.filter(e => e.pairAddress !== pairAddress);
        }

        // Remove pair from storage
        this.pairs.delete(pairAddress);

        // Reconstruct line graph since topology changed
        this.constructLineGraph();
    }

    /**
     * Add a token to the graph if it doesn't exist
     * @param token Token to add
     */
    private addToken(token: Token) {
        if (!this.vertices.has(token.address)) {
            this.vertices.set(token.address, {
                token,
                edges: []
            });
        }
    }

    /**
     * Constructs the line graph with edge-cutting optimization as per paper Section IV-B
     */
    public constructLineGraph(): Map<string, LineGraphVertex> {
        const lineGraph = new Map<string, LineGraphVertex>();
        const mutualLinks = new Set<string>();

        if (DEBUG) {
            console.log(`Constructing line graph from ${this.vertices.size} vertices...`);
        }

        // First pass: Create vertices and identify mutual links
        for (const vertex of this.vertices.values()) {
            for (const edge of vertex.edges) {
                const key = `${edge.from.address}-${edge.to.address}`;
                const reverseKey = `${edge.to.address}-${edge.from.address}`;
                
                // Create line graph vertex
                const lineVertex: LineGraphVertex = {
                    from: edge.from,
                    to: edge.to,
                    weight: edge.weight,
                    pairAddress: edge.pairAddress,
                    neighbors: []
                };

                // Check for mutual links as per paper
                if (lineGraph.has(reverseKey)) {
                    const reverseVertex = lineGraph.get(reverseKey)!;
                    
                    // Only remove if both edges are unprofitable
                    if (edge.weight >= 0 && reverseVertex.weight >= 0) {
                        if (DEBUG) {
                            console.log(`Removing unprofitable mutual link: ${key} <-> ${reverseKey}`);
                        }
                        mutualLinks.add(key);
                        mutualLinks.add(reverseKey);
                    }
                } else if (!mutualLinks.has(key)) {
                    lineGraph.set(key, lineVertex);
                }
            }
        }

        if (DEBUG) {
            console.log(`First pass completed:
                Initial vertices: ${lineGraph.size}
                Mutual links removed: ${mutualLinks.size / 2}
            `);
        }

        // Remove mutual links from the graph
        for (const key of mutualLinks) {
            lineGraph.delete(key);
        }

        // Second pass: Connect vertices (excluding mutual links)
        for (const [key, vertex] of lineGraph.entries()) {
            for (const [otherKey, otherVertex] of lineGraph.entries()) {
                if (key === otherKey) continue;

                // Connect if ending token of vertex matches starting token of other vertex
                if (vertex.to.address === otherVertex.from.address) {
                    vertex.neighbors.push(otherVertex);
                }
            }
        }

        if (DEBUG) {
            let totalNeighbors = 0;
            for (const vertex of lineGraph.values()) {
                totalNeighbors += vertex.neighbors.length;
            }
            console.log(`Line graph construction completed:
                Final vertices: ${lineGraph.size}
                Total edges: ${totalNeighbors}
                Average neighbors per vertex: ${totalNeighbors / lineGraph.size || 0}
            `);
        }

        // Store the constructed line graph
        this.lineGraph = lineGraph;
        return lineGraph;
    }

    /**
     * Get all tokens in the graph
     */
    getTokens(): Token[] {
        return Array.from(this.vertices.values()).map(v => v.token);
    }

    /**
     * Get all pairs in the graph
     */
    getPairs(): PairInfo[] {
        return Array.from(this.pairs.values());
    }

    /**
     * Get a specific pair by its address
     */
    getPair(pairAddress: Address): PairInfo | undefined {
        return this.pairs.get(pairAddress);
    }

    /**
     * Get the line graph representation
     */
    getLineGraph(): Map<string, LineGraphVertex> {
        return this.lineGraph;
    }

    /**
     * Get the original token graph
     */
    getTokenGraph(): Map<string, Vertex> {
        return this.vertices;
    }

    /**
     * Get a vertex for a specific token
     */
    getVertex(tokenAddress: Address): Vertex | undefined {
        return this.vertices.get(tokenAddress);
    }

    /**
     * Calculate the current exchange rate between two tokens in a pair
     */
    getExchangeRate(fromToken: Address, toToken: Address, pairAddress: Address): number | undefined {
        const pair = this.pairs.get(pairAddress);
        if (!pair) return undefined;

        const feeMultiplier = 1 - (pair.fee / 10000);
        if (fromToken === pair.token0) {
            return feeMultiplier * Number(pair.reserve1) / Number(pair.reserve0);
        } else {
            return feeMultiplier * Number(pair.reserve0) / Number(pair.reserve1);
        }
    }

    /**
     * Check if the graph has a specific token
     */
    hasToken(tokenAddress: Address): boolean {
        return this.vertices.has(tokenAddress);
    }

    /**
     * Check if the graph has a specific pair
     */
    hasPair(pairAddress: Address): boolean {
        return this.pairs.has(pairAddress);
    }

    /**
     * Get the total number of tokens in the graph
     */
    getTokenCount(): number {
        return this.vertices.size;
    }

    /**
     * Get the total number of pairs in the graph
     */
    getPairCount(): number {
        return this.pairs.size;
    }

    private getAllEdges(): Edge[] {
        const edges: Edge[] = [];
        for (const vertex of this.vertices.values()) {
            edges.push(...vertex.edges);
        }
        return edges;
    }

    /**
     * Runs Modified Bellman-Ford with explicit extra node as per paper Section IV-C
     */
    public runBellmanFord(sourceToken: Token) {
        const EXTRA_NODE = '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
        this.distances.clear();
        this.predecessors.clear();

        // Create the extra node in the line graph
        const extraVertex: LineGraphVertex = {
            from: { address: EXTRA_NODE as `0x${string}`, symbol: 'EXTRA' },
            to: { address: EXTRA_NODE as `0x${string}`, symbol: 'EXTRA' },
            weight: 0,
            pairAddress: '0x0000000000000000000000000000000000000000',
            neighbors: []
        };

        // Connect extra node to all neighbor link vertices of source token
        const sourceVertex = this.vertices.get(sourceToken.address);
        if (sourceVertex) {
            for (const edge of sourceVertex.edges) {
                const neighborKey = `${edge.from.address}-${edge.to.address}`;
                const neighborVertex = this.lineGraph.get(neighborKey);
                if (neighborVertex) {
                    extraVertex.neighbors.push(neighborVertex);
                    // Set initial distances from extra node
                    this.distances.set(neighborKey, edge.weight);
                    // Create line vertex for predecessor tracking
                    const lineVertex: LineGraphVertex = {
                        from: edge.from,
                        to: edge.to,
                        weight: edge.weight,
                        pairAddress: edge.pairAddress,
                        neighbors: []
                    };
                    this.predecessors.set(neighborKey, lineVertex);
                }
            }
        }

        // Add extra node to line graph temporarily
        const extraNodeKey = EXTRA_NODE;
        this.lineGraph.set(extraNodeKey, extraVertex);
        this.distances.set(extraNodeKey, 0);

        // Initialize all other distances to infinity
        for (const [key, vertex] of this.lineGraph.entries()) {
            if (key !== extraNodeKey && !extraVertex.neighbors.some(n => 
                `${n.from.address}-${n.to.address}` === key)) {
                this.distances.set(key, Infinity);
            }
        }

        // Run MMBF iterations over the augmented line graph
        const vertexCount = this.lineGraph.size;
        for (let i = 0; i < vertexCount - 1; i++) {
            let hasChange = false;
            for (const [key, vertex] of this.lineGraph.entries()) {
                const fromDist = this.distances.get(key);
                if (fromDist === undefined || fromDist === Infinity) continue;

                for (const neighbor of vertex.neighbors) {
                    const toKey = `${neighbor.from.address}-${neighbor.to.address}`;
                    const currentToDist = this.distances.get(toKey) ?? Infinity;
                    const newDist = fromDist + neighbor.weight;

                    if (newDist < currentToDist) {
                        this.distances.set(toKey, newDist);
                        this.predecessors.set(toKey, vertex);
                        hasChange = true;
                    }
                }
            }
            if (!hasChange) break;
        }

        // Remove extra node from line graph
        this.lineGraph.delete(extraNodeKey);
    }

    /**
     * Get distances map
     */
    public getDistances(): Map<string, number> {
        return this.distances;
    }

    /**
     * Get predecessors map
     */
    public getPredecessors(): Map<string, LineGraphVertex | null> {
        return this.predecessors;
    }
}
