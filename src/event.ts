import { type Address, parseAbiItem, decodeEventLog, type PublicClient } from 'viem';
import { RUNTIME } from './constants';
import { type ReserveUpdate } from './market/v2-types';
import { type V3PoolUpdate } from './market/v3-types';
import { OpportunityEngine } from './opportunities/opportunity-engine';
import { OpportunityWorkflow } from './opportunities/opportunity-workflow';
import { ReserveUpdateScheduler, V3PoolUpdateScheduler } from './runtime/event-scheduler';

// ABI for both types of Sync events
const SYNC_EVENT_ABI = [
    parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
    parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)')
];

const V3_SWAP_EVENT_ABI = [
    parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)')
];

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
    private unwatchFns: Array<() => void | Promise<void>> = [];
    private scheduler: ReserveUpdateScheduler;
    private v3Scheduler: V3PoolUpdateScheduler;
    private networkConfig: any;
    private usingWebSocket: boolean = false;
    private wsReconnectAttempts: number = 0;
    private reconnecting: boolean = false;

    constructor(graph: OpportunityEngine, networkConfig: any) {
        this.graph = graph;
        this.networkConfig = networkConfig;
        this.opportunities = new OpportunityWorkflow(graph, networkConfig);
        this.scheduler = new ReserveUpdateScheduler(this.processReserveUpdateBatch.bind(this));
        this.v3Scheduler = new V3PoolUpdateScheduler(this.processV3PoolUpdateBatch.bind(this));
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

        // Get all pair/pool addresses from graph for validation
        const pairAddresses = this.graph.getPairAddresses();
        const v3PoolAddresses = this.graph.getV3PoolAddresses();
        
        console.log(`Starting event monitor for ${pairAddresses.length} V2 pairs and ${v3PoolAddresses.length} V3 pools...`);
        if (RUNTIME.debug) {
            console.log('Monitoring V2 pairs:', pairAddresses);
            console.log('Monitoring V3 pools:', v3PoolAddresses);
        }

        try {
            // Determine which client to use for event monitoring
            const eventClient = this.usingWebSocket && this.wsClient ? this.wsClient : this.client;
            
            if (this.usingWebSocket) {
                console.log('Using WebSocket for event monitoring');
            } else {
                console.log('Using HTTP polling for event monitoring');
            }
            
            this.unwatchFns = [];

            if (pairAddresses.length > 0) {
                const unwatchV2 = await eventClient.watchContractEvent({
                    address: pairAddresses,
                    abi: SYNC_EVENT_ABI,
                    onLogs: this.handleSyncEvents.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV2);
            }

            if (v3PoolAddresses.length > 0) {
                const unwatchV3 = await eventClient.watchContractEvent({
                    address: v3PoolAddresses,
                    abi: V3_SWAP_EVENT_ABI,
                    onLogs: this.handleV3SwapEvents.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV3);
            }

            console.log('Event monitoring started successfully');
            
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

    private decodeV3SwapEvent(log: any): { sqrtPriceX96: bigint, liquidity: bigint, tick: number } | null {
        try {
            if (!log.topics || !log.topics[0]) {
                return null;
            }

            const decoded = decodeEventLog({
                abi: V3_SWAP_EVENT_ABI,
                data: log.data,
                topics: log.topics
            });

            return {
                sqrtPriceX96: decoded.args.sqrtPriceX96,
                liquidity: decoded.args.liquidity,
                tick: Number(decoded.args.tick),
            };
        } catch (error) {
            console.error('Failed to decode V3 Swap event:', error);
            return null;
        }
    }

    private async processUpdates(updates: ReserveUpdate[]) {
        await this.scheduler.submit(updates);
    }

    private async handleV3SwapEvents(logs: any[]) {
        try {
            if (RUNTIME.debug) console.log(`Received ${logs.length} V3 Swap events`);

            const poolAddresses = this.graph.getV3PoolAddresses();
            const validPools = new Set(poolAddresses.map(addr => addr.toLowerCase()));
            const addressMap = new Map(poolAddresses.map(addr => [addr.toLowerCase(), addr]));
            const updates: V3PoolUpdate[] = [];

            for (const log of logs) {
                const lowercaseAddress = log.address?.toLowerCase();
                if (!validPools.has(lowercaseAddress)) {
                    if (RUNTIME.debug) {
                        console.log(`Skipping V3 event from unknown pool: ${lowercaseAddress}`);
                    }
                    continue;
                }

                const poolAddress = addressMap.get(lowercaseAddress) as Address;
                const decodedEvent = this.decodeV3SwapEvent(log);
                if (!decodedEvent) {
                    if (RUNTIME.debug) console.log('Failed to decode V3 Swap event');
                    continue;
                }

                if (RUNTIME.debug) console.log(`V3 Swap event from ${poolAddress}:`, {
                    sqrtPriceX96: decodedEvent.sqrtPriceX96.toString(),
                    liquidity: decodedEvent.liquidity.toString(),
                    tick: decodedEvent.tick,
                });

                updates.push({
                    poolAddress,
                    sqrtPriceX96: decodedEvent.sqrtPriceX96,
                    liquidity: decodedEvent.liquidity,
                    tick: decodedEvent.tick,
                });
            }

            await this.processV3Updates(updates);
        } catch (error) {
            console.error('Error handling V3 Swap events:', error);
        }
    }

    private async processV3Updates(updates: V3PoolUpdate[]) {
        await this.v3Scheduler.submit(updates);
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

    private async processV3PoolUpdateBatch(batch: V3PoolUpdate[]): Promise<void> {
        if (RUNTIME.debug) console.log(`Processing ${batch.length} latest V3 pool updates`);

        try {
            this.graph.updateV3PoolStates(batch);
            if (RUNTIME.debug) console.log(`Successfully updated ${batch.length} V3 pools`);
        } catch (error) {
            console.error('Failed to update V3 pool states:', error);
        }
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
        if (this.unwatchFns.length > 0) {
            for (const unwatch of this.unwatchFns) {
                try {
                    await unwatch();
                } catch (error) {
                    console.error('Error unsubscribing from events:', error);
                }
            }
            this.unwatchFns = [];
            if (RUNTIME.debug) console.log('Successfully unsubscribed from events');
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
        this.v3Scheduler.clear();
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

