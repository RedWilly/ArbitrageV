import { type Address, createPublicClient, http, parseAbiItem, formatUnits, decodeEventLog } from 'viem';
import { ArbitrageGraph } from './graph';
import { DEBUG, ADDRESSES } from './constants';
import { findAndLogArbitrageOpportunities } from "./opp";

// ABI for both types of Sync events
const SYNC_EVENT_ABI = [
    parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
    parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)')
];

// Sync event topics
const SYNC_TOPIC_UINT112 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SYNC_TOPIC_UINT256 = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';

type ReserveUpdate = {
    pairAddress: Address;
    reserve0: bigint;
    reserve1: bigint;
};

export class EventMonitor {
    private client;
    private graph: ArbitrageGraph;
    private isRunning: boolean = false;
    private isCheckingArbitrage: boolean = false;
    private unwatchFn: any;
    private pendingUpdates: ReserveUpdate[] = [];

    constructor(graph: ArbitrageGraph, client: any) {
        this.graph = graph;
        this.client = client;
    }

    async start() {
        if (this.isRunning) {
            console.log('Event monitor is already running');
            return;
        }

        this.isRunning = true;

        // Get all pair addresses from graph for validation
        const pairAddresses = this.graph.getPairAddresses();
        
        console.log(`Starting event monitor for ${pairAddresses.length} pairs...`);
        if (DEBUG) {
            console.log('Monitoring pairs:', pairAddresses);
        }

        try {
            // Watch for both types of Sync events, but only for pairs in our graph
            const unwatch = await this.client.watchContractEvent({
                address: pairAddresses,
                events: SYNC_EVENT_ABI,
                onLogs: this.handleSyncEvents.bind(this),
                onError: (error: any) => {
                    console.error('Error in event monitoring:', error);
                    // Try to restart if there's an error
                    this.restart();
                },
                strict: true
            });

            console.log('Event monitoring started successfully');
            
            // Store unwatch function for cleanup
            this.unwatchFn = unwatch;
        } catch (error) {
            console.error('Failed to start event monitoring:', error);
            this.isRunning = false;
        }
    }

    private decodeSyncEvent(log: any): { reserve0: bigint, reserve1: bigint } | null {
        try {
            // Check if it's a Sync event by topic
            if (!log.topics || !log.topics[0]) {
                return null;
            }

            const topic = log.topics[0];
            
            // Try decoding based on the specific topic
            if (topic === SYNC_TOPIC_UINT256) {
                const decoded = decodeEventLog({
                    abi: [SYNC_EVENT_ABI[1]], // uint256 version
                    data: log.data,
                    topics: log.topics
                });
                return {
                    reserve0: decoded.args.reserve0,
                    reserve1: decoded.args.reserve1
                };
            } else if (topic === SYNC_TOPIC_UINT112) {
                const decoded = decodeEventLog({
                    abi: [SYNC_EVENT_ABI[0]], // uint112 version
                    data: log.data,
                    topics: log.topics
                });
                return {
                    reserve0: decoded.args.reserve0,
                    reserve1: decoded.args.reserve1
                };
            }

            console.log('Unknown Sync event topic:', topic);
            return null;
        } catch (error) {
            console.error('Failed to decode Sync event:', error);
            return null;
        }
    }

    private async handleSyncEvents(logs: any[]) {
        try {
            console.log(`Received ${logs.length} events`);
            
            // Create a mapping of lowercase to original case addresses
            const pairAddresses = this.graph.getPairAddresses();
            const validPairs = new Set(pairAddresses.map(addr => addr.toLowerCase()));
            const addressMap = new Map(pairAddresses.map(addr => [addr.toLowerCase(), addr]));
            
            // Collect all valid updates
            const updates: ReserveUpdate[] = [];
            
            for (const log of logs) {
                // Custom logging to handle BigInt values
                const logForDisplay = {
                    ...log,
                    blockNumber: log.blockNumber?.toString(),
                    logIndex: log.logIndex?.toString()
                };
                
                // Check if this pair is in our graph before proceeding
                const lowercaseAddress = log.address?.toLowerCase();
                if (!validPairs.has(lowercaseAddress)) {
                    if (DEBUG) {
                        console.log(`Skipping event from unknown pair: ${lowercaseAddress}`);
                    }
                    continue;
                }

                // Get the original case address for updating the graph
                const pairAddress = addressMap.get(lowercaseAddress) as Address;

                console.log('Raw event log:', JSON.stringify(logForDisplay, null, 2));

                // Decode the Sync event
                const decodedEvent = this.decodeSyncEvent(log);
                if (!decodedEvent) {
                    console.log('Failed to decode Sync event');
                    continue;
                }

                const { reserve0, reserve1 } = decodedEvent;

                console.log(`Sync event from ${pairAddress}:`, {
                    reserve0: reserve0.toString(),
                    reserve1: reserve1.toString()
                });

                // Add to updates batch
                updates.push({ pairAddress, reserve0, reserve1 });
            }

            // If we're currently checking arbitrage, add these updates to pending queue
            if (this.isCheckingArbitrage) {
                console.log(`Adding ${updates.length} updates to pending queue`);
                this.pendingUpdates.push(...updates);
                return;
            }

            // Process all updates at once
            await this.processUpdates(updates);

        } catch (error) {
            console.error('Error handling Sync events:', error);
        }
    }

    private async processUpdates(updates: ReserveUpdate[]) {
        if (updates.length === 0) return;

        try {
            console.log(`Processing ${updates.length} reserve updates`);
            
            // Update all reserves at once using batch update
            try {
                this.graph.updatePairReservesBatch(updates);
                console.log(`Successfully updated ${updates.length} pairs`);
            } catch (error) {
                console.error('Failed to update reserves:', error);
                return;
            }

            // Check for arbitrage opportunities only once after all updates
            this.isCheckingArbitrage = true;
            console.log('Starting arbitrage check after batch update...');
            await this.checkArbitrageOpportunities();

            // Process any pending updates that came during arbitrage check
            if (this.pendingUpdates.length > 0) {
                const pendingUpdates = [...this.pendingUpdates];
                this.pendingUpdates = [];
                await this.processUpdates(pendingUpdates);
            }

        } finally {
            this.isCheckingArbitrage = false;
        }
    }

    private async checkArbitrageOpportunities() {
        try {
            // Search for arbitrage opportunities starting from WETH
            findAndLogArbitrageOpportunities(this.graph);
        } catch (error) {
            console.error('Error checking arbitrage opportunities:', error);
        }
    }

    async stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        console.log('Stopping event monitor...');
        
        // Unsubscribe from events
        if (this.unwatchFn) {
            try {
                await this.unwatchFn();
                console.log('Successfully unsubscribed from events');
            } catch (error) {
                console.error('Error unsubscribing from events:', error);
            }
        }
        
        if (this.client) {
            await this.client.destroy();
        }
    }

    private async restart() {
        await this.stop();
        await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds
        await this.start();
    }
}