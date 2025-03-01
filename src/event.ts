import { type Address, createPublicClient, http, parseAbiItem, formatUnits, decodeEventLog, type PublicClient } from 'viem';
import { ArbitrageGraph } from './graph';
import { DEBUG, ADDRESSES, WSS_ENABLED } from './constants';
import { findAndLogArbitrageOpportunities } from "./opp";

// ABI for both types of Sync events
const SYNC_EVENT_ABI = [
    parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
    parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)')
];
//dunno if am to add the v3 sync abi to the sync event yet
// event Swap(address,address,int256,int256,uint160,uint128,int24)

// Sync event topics
const SYNC_TOPIC_UINT112 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SYNC_TOPIC_UINT256 = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';
const SYNC_TOPIC_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

type ReserveUpdate = {
    pairAddress: Address;
    reserve0: bigint;
    reserve1: bigint;
};

export class EventMonitor {
    private client: PublicClient;
    private wsClient?: PublicClient; // WebSocket client
    private graph: ArbitrageGraph;
    private isRunning: boolean = false;
    private isCheckingArbitrage: boolean = false;
    private unwatchFn: any;
    private pendingUpdates: ReserveUpdate[] = [];
    private networkConfig: any;
    private usingWebSocket: boolean = false;

    constructor(graph: ArbitrageGraph, networkConfig: any) {
        this.graph = graph;
        this.networkConfig = networkConfig;
        this.client = networkConfig.client;
        
        // Use WebSocket client if available
        if (WSS_ENABLED && networkConfig.wsClient) {
            this.wsClient = networkConfig.wsClient;
            this.usingWebSocket = true;
            console.log('EventMonitor will use WebSocket for real-time events');
        } else {
            console.log('EventMonitor will use HTTP polling for events');
        }
    }

    async start() {
        if (this.isRunning) {
            if (DEBUG) console.log('Event monitor is already running');
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
            // Determine which client to use for event monitoring
            const eventClient = this.usingWebSocket && this.wsClient ? this.wsClient : this.client;
            
            if (this.usingWebSocket) {
                console.log('Using WebSocket for event monitoring');
            } else {
                console.log('Using HTTP polling for event monitoring');
            }
            
            // Watch for both types of Sync events, but only for pairs in our graph
            const unwatch = await eventClient.watchContractEvent({
                address: pairAddresses,
                abi: SYNC_EVENT_ABI,
                onLogs: this.handleSyncEvents.bind(this),
                onError: this.onError.bind(this),
                strict: true
            });

            console.log('Event monitoring started successfully');
            
            // Store unwatch function for cleanup
            this.unwatchFn = unwatch;
        } catch (error) {
            console.error('Failed to start event monitoring:', error);
            
            // If WebSocket failed, try falling back to HTTP
            if (this.usingWebSocket) {
                console.log('Falling back to HTTP polling for events');
                this.usingWebSocket = false;
                await this.start(); // Retry with HTTP
                return;
            }
            
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

            if (DEBUG) console.log('Unknown Sync event topic:', topic);
            return null;
        } catch (error) {
            console.error('Failed to decode Sync event:', error);
            return null;
        }
    }

    private async handleSyncEvents(logs: any[]) {
        try {
            if (DEBUG) console.log(`Received ${logs.length} events`);
            
            // Create a mapping of lowercase to original case addresses
            const pairAddresses = this.graph.getPairAddresses();
            const validPairs = new Set(pairAddresses.map(addr => addr.toLowerCase()));
            const addressMap = new Map(pairAddresses.map(addr => [addr.toLowerCase(), addr]));
            
            // Collect all valid updates
            const updates: ReserveUpdate[] = [];
            
            for (const log of logs) {
                // Custom logging to handle BigInt values - convert all BigInt to strings
                const logForDisplay = JSON.parse(JSON.stringify(log, (key, value) => 
                    typeof value === 'bigint' ? value.toString() : value
                ));
                
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

                if (DEBUG) console.log('Raw event log:', JSON.stringify(logForDisplay, null, 2));

                // Decode the Sync event
                const decodedEvent = this.decodeSyncEvent(log);
                if (!decodedEvent) {
                    if (DEBUG) console.log('Failed to decode Sync event');
                    continue;
                }

                const { reserve0, reserve1 } = decodedEvent;

                if (DEBUG) console.log(`Sync event from ${pairAddress}:`, {
                    reserve0: reserve0.toString(),
                    reserve1: reserve1.toString()
                });

                
                updates.push({ pairAddress, reserve0, reserve1 });
            }

            // If we're currently checking arbitrage, add these updates to pending queue
            if (this.isCheckingArbitrage) {
                if (DEBUG) console.log(`Adding ${updates.length} updates to pending queue`);
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
            if (DEBUG) console.log(`Processing ${updates.length} reserve updates`);
            
            // Update all reserves at once using batch update
            try {
                this.graph.updatePairReservesBatch(updates);
                if (DEBUG) console.log(`Successfully updated ${updates.length} pairs`);
            } catch (error) {
                console.error('Failed to update reserves:', error);
                return;
            }

            // Check for arbitrage opportunities only once after all updates
            this.isCheckingArbitrage = true;
            // if (DEBUG) 
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
            // Search for arbitrage opportunities
            await findAndLogArbitrageOpportunities(this.graph, this.networkConfig);
        } catch (error) {
            console.error('Error checking arbitrage opportunities:', error);
        }
    }

    async stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        if (DEBUG) console.log('Stopping event monitor...');
        
        // Unsubscribe from events
        if (this.unwatchFn) {
            try {
                await this.unwatchFn();
                if (DEBUG) console.log('Successfully unsubscribed from events');
            } catch (error) {
                console.error('Error unsubscribing from events:', error);
            }
        }
        
        // Clean up WebSocket connection if it was being used
        if (this.usingWebSocket && this.wsClient) {
            try {
                // The viem WebSocket transport automatically handles cleanup
                // when the client is no longer referenced, but we can log it
                console.log('Cleaning up WebSocket connection');
                // Set to undefined to allow garbage collection
                this.wsClient = undefined;
            } catch (error) {
                console.error('Error cleaning up WebSocket connection:', error);
            }
        }
        
        // Clear any pending updates
        this.pendingUpdates = [];
    }

    private async restart() {
        await this.stop();
        
        // Reset WebSocket status to try again with the original configuration
        if (WSS_ENABLED && this.networkConfig.wsClient) {
            this.wsClient = this.networkConfig.wsClient;
            this.usingWebSocket = true;
            console.log('Resetting WebSocket client for restart');
        }
        
        await new Promise(resolve => setTimeout(resolve, 5000));
        await this.start();
    }

    private async onError(error: any) {
        if (DEBUG) {
            console.error('Error in event monitoring:', error);
        }

        // Check if it's a filter-related error
        const errorMessage = error.message?.toLowerCase() || '';
        const errorDetails = error.details?.toLowerCase() || '';
        
        // Handle WebSocket-specific errors
        if (this.usingWebSocket && (
            errorMessage.includes('websocket') || 
            errorDetails.includes('websocket') ||
            errorMessage.includes('connection') || 
            errorDetails.includes('connection')
        )) {
            console.log('WebSocket connection error detected, falling back to HTTP...');
            this.usingWebSocket = false;
            await this.restart();
            return;
        }
        
        if (errorMessage.includes('filter not found') || 
            errorDetails.includes('filter not found') ||
            errorMessage.includes('invalid parameters') ||
            errorDetails.includes('invalid parameters')||
            errorMessage.includes('rpc request failed')||
            errorDetails.includes('rpc request failed')) {
            
            if (DEBUG) console.log('Filter error detected, restarting event monitor...');
            await this.restart();
        }
    }
}