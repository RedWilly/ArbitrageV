import { type Address, parseAbiItem, decodeEventLog, type PublicClient } from 'viem';
import { RUNTIME } from './constants';
import { type ReserveUpdate } from './market/v2-types';
import { OpportunityEngine } from './opportunities/opportunity-engine';
import { OpportunityWorkflow } from './opportunities/opportunity-workflow';
import { ReserveUpdateScheduler } from './runtime/event-scheduler';

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
// Maximum WebSocket reconnection attempts before falling back to HTTP
const MAX_WEBSOCKET_RECONNECT_ATTEMPTS = 3;

export class EventMonitor {
    private client: PublicClient;
    private wsClient?: PublicClient; // WebSocket client
    private graph: OpportunityEngine;
    private opportunities: OpportunityWorkflow;
    private isRunning: boolean = false;
    private unwatchFn: any;
    private scheduler: ReserveUpdateScheduler;
    private networkConfig: any;
    private usingWebSocket: boolean = false;
    private wsReconnectAttempts: number = 0;
    private reconnecting: boolean = false;

    constructor(graph: OpportunityEngine, networkConfig: any) {
        this.graph = graph;
        this.networkConfig = networkConfig;
        this.opportunities = new OpportunityWorkflow(graph, networkConfig);
        this.scheduler = new ReserveUpdateScheduler(this.processReserveUpdateBatch.bind(this));
        this.client = networkConfig.client;
        
        // Use WebSocket client if available
        if (RUNTIME.websocketEnabled && networkConfig.wsClient) {
            this.wsClient = networkConfig.wsClient;
            this.usingWebSocket = true;
            console.log('EventMonitor will use WebSocket for real-time events');
        } else {
            console.log('EventMonitor will use HTTP polling for events');
        }
    }

    async start() {
        if (this.isRunning) {
            if (RUNTIME.debug) console.log('Event monitor is already running');
            return;
        }

        this.isRunning = true;

        // Get all pair addresses from graph for validation
        const pairAddresses = this.graph.getPairAddresses();
        
        console.log(`Starting event monitor for ${pairAddresses.length} pairs...`);
        if (RUNTIME.debug) {
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
            
            // Reset reconnect attempts counter on successful connection
            if (this.usingWebSocket) {
                this.wsReconnectAttempts = 0;
            }
        } catch (error) {
            console.error('Failed to start event monitoring:', error);
            
            // If WebSocket failed, try reconnecting or fall back to HTTP
            if (this.usingWebSocket) {
                await this.handleWebSocketFailure(error);
            } else {
                this.isRunning = false;
            }
        }
    }

    private async handleWebSocketFailure(error: any) {
        // Increment reconnect attempts
        this.wsReconnectAttempts++;
        
        if (this.wsReconnectAttempts <= MAX_WEBSOCKET_RECONNECT_ATTEMPTS) {
            console.log(`WebSocket connection failed. Reconnection attempt ${this.wsReconnectAttempts}/${MAX_WEBSOCKET_RECONNECT_ATTEMPTS}...`);
            
            // Wait before reconnecting (increasing delay with each attempt)
            const reconnectDelay = this.wsReconnectAttempts * 2000; // 2s, 4s, 6s
            console.log(`Waiting ${reconnectDelay/1000} seconds before reconnecting...`);
            await new Promise(resolve => setTimeout(resolve, reconnectDelay));
            
            // Try to restart with WebSocket
            this.isRunning = false;
            await this.start();
        } else {
            console.log(`Maximum WebSocket reconnection attempts (${MAX_WEBSOCKET_RECONNECT_ATTEMPTS}) reached. Falling back to HTTP polling.`);
            this.usingWebSocket = false;
            this.wsReconnectAttempts = 0;
            
            // Restart with HTTP
            this.isRunning = false;
            await this.start();
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

            if (RUNTIME.debug) console.log('Unknown Sync event topic:', topic);
            return null;
        } catch (error) {
            console.error('Failed to decode Sync event:', error);
            return null;
        }
    }

    private async handleSyncEvents(logs: any[]) {
        try {
            if (RUNTIME.debug) console.log(`Received ${logs.length} events`);
            
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
                    if (RUNTIME.debug) {
                        console.log(`Skipping event from unknown pair: ${lowercaseAddress}`);
                    }
                    continue;
                }

                // Get the original case address for updating the graph
                const pairAddress = addressMap.get(lowercaseAddress) as Address;

                if (RUNTIME.debug) console.log('Raw event log:', JSON.stringify(logForDisplay, null, 2));

                // Decode the Sync event
                const decodedEvent = this.decodeSyncEvent(log);
                if (!decodedEvent) {
                    if (RUNTIME.debug) console.log('Failed to decode Sync event');
                    continue;
                }

                const { reserve0, reserve1 } = decodedEvent;

                if (RUNTIME.debug) console.log(`Sync event from ${pairAddress}:`, {
                    reserve0: reserve0.toString(),
                    reserve1: reserve1.toString()
                });

                
                updates.push({ pairAddress, reserve0, reserve1 });
            }

            await this.processUpdates(updates);

        } catch (error) {
            console.error('Error handling Sync events:', error);
        }
    }

    private async processUpdates(updates: ReserveUpdate[]) {
        await this.scheduler.submit(updates);
    }

    private async processReserveUpdateBatch(batch: ReserveUpdate[]): Promise<void> {
        if (RUNTIME.debug) console.log(`Processing ${batch.length} latest reserve updates`);

        try {
            this.graph.updateReserves(batch);
            if (RUNTIME.debug) console.log(`Successfully updated ${batch.length} pairs`);
        } catch (error) {
            console.error('Failed to update reserves:', error);
            return;
        }

        console.log('Starting arbitrage check after batch update...');
        await this.checkArbitrageOpportunities(batch.map(update => update.pairAddress));
    }

    private async checkArbitrageOpportunities(affectedPairs?: Address[]) {
        try {
            await this.opportunities.scanAndExecute({ changedPairs: affectedPairs });
        } catch (error) {
            console.error('Error checking arbitrage opportunities:', error);
        }
    }

    async stop() {
        if (!this.isRunning) return;
        
        this.isRunning = false;
        if (RUNTIME.debug) console.log('Stopping event monitor...');
        
        // Unsubscribe from events
        if (this.unwatchFn) {
            try {
                await this.unwatchFn();
                if (RUNTIME.debug) console.log('Successfully unsubscribed from events');
            } catch (error) {
                console.error('Error unsubscribing from events:', error);
            }
        }
        
        // Clean up WebSocket connection if it was being used
        if (this.usingWebSocket && this.wsClient) {
            try {
                console.log('Cleaning up WebSocket connection');
                delete this.wsClient;
            } catch (error) {
                console.error('Error cleaning up WebSocket connection:', error);
            }
        }
        
        // Clear any pending updates
        this.scheduler.clear();
    }

    private async restart() {
        if (this.reconnecting) {
            if (RUNTIME.debug) console.log('Already in the process of reconnecting, skipping duplicate restart');
            return;
        }
        
        this.reconnecting = true;
        
        try {
            await this.stop();
            
            // Reset WebSocket status to try again with the original configuration
            if (RUNTIME.websocketEnabled && this.networkConfig.wsClient && this.usingWebSocket) {
                this.wsClient = this.networkConfig.wsClient;
                console.log('Resetting WebSocket client for restart');
            }
            
            await new Promise(resolve => setTimeout(resolve, 5000));
            await this.start();
        } finally {
            this.reconnecting = false;
        }
    }

    private async onError(error: any) {
        if (RUNTIME.debug) {
            console.error('Error in event monitoring:', error);
        }

        // Check if it's a WebSocket-related error
        const errorMessage = error.message?.toLowerCase() || '';
        const errorDetails = error.details?.toLowerCase() || '';
        
        // Handle WebSocket-specific errors
        const isWebSocketError = this.usingWebSocket && (
            errorMessage.includes('websocket') || 
            errorDetails.includes('websocket') ||
            errorMessage.includes('connection') || 
            errorDetails.includes('connection') ||
            errorMessage.includes('socket') ||
            errorDetails.includes('socket') ||
            errorMessage.includes('closed') ||
            errorDetails.includes('closed')
        );
        
        if (isWebSocketError) {
            console.log('WebSocket connection error detected');
            
            // Increment reconnect attempts
            this.wsReconnectAttempts++;
            
            if (this.wsReconnectAttempts <= MAX_WEBSOCKET_RECONNECT_ATTEMPTS) {
                console.log(`Attempting WebSocket reconnection ${this.wsReconnectAttempts}/${MAX_WEBSOCKET_RECONNECT_ATTEMPTS}...`);
                
                // Wait before reconnecting (increasing delay with each attempt)
                const reconnectDelay = this.wsReconnectAttempts * 2000; // 2s, 4s, 6s
                console.log(`Waiting ${reconnectDelay/1000} seconds before reconnecting...`);
                await new Promise(resolve => setTimeout(resolve, reconnectDelay));
                
                await this.restart();
            } else {
                console.log(`Maximum WebSocket reconnection attempts (${MAX_WEBSOCKET_RECONNECT_ATTEMPTS}) reached. Falling back to HTTP polling.`);
                this.usingWebSocket = false;
                this.wsReconnectAttempts = 0;
                await this.restart();
            }
            return;
        }
        
        // Handle other RPC errors
        if (errorMessage.includes('filter not found') || 
            errorDetails.includes('filter not found') ||
            errorMessage.includes('invalid parameters') ||
            errorDetails.includes('invalid parameters')||
            errorMessage.includes('rpc request failed')||
            errorDetails.includes('rpc request failed')) {
            
            if (RUNTIME.debug) console.log('Filter error detected, restarting event monitor...');
            await this.restart();
        }
    }
}

