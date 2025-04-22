import { type Address, parseAbiItem, decodeEventLog, type PublicClient } from 'viem';
import { ArbitrageGraph } from './graph';
import { DEBUG, WSS_ENABLED, enableV3Pools } from './constants';
import { findAndLogArbitrageOpportunities } from "./opp";

// ABI for V2 Sync events
const SYNC_EVENT_ABI_V2 = [
    parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
    parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)'),
];

// ABI for V3 Swap events
const SYNC_EVENT_ABI_V3 = [
    parseAbiItem('event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)')
];

// Combine ABIs if V3 pools are enabled
const ALL_EVENT_ABIS = enableV3Pools ? [...SYNC_EVENT_ABI_V2, ...SYNC_EVENT_ABI_V3] : SYNC_EVENT_ABI_V2;

// Sync event topics
const SYNC_TOPIC_UINT112 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SYNC_TOPIC_UINT256 = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';
// V3 Swap event topic
const SYNC_TOPIC_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';

// Maximum WebSocket reconnection attempts before falling back to HTTP
const MAX_WEBSOCKET_RECONNECT_ATTEMPTS = 3;

// Type for V2 reserve updates
type ReserveUpdateV2 = {
    type: 'V2';
    pairAddress: Address;
    reserve0: bigint;
    reserve1: bigint;
};

// Type for V3 dynamic data updates
type ReserveUpdateV3 = {
    type: 'V3';
    poolAddress: Address;
    tick: number;
    liquidity: bigint;
    sqrtPriceX96: bigint;
};

// Union type for pending updates
type PendingUpdate = ReserveUpdateV2 | ReserveUpdateV3;

export class EventMonitor {
    private client: PublicClient;
    private wsClient?: PublicClient; // WebSocket client
    private graph: ArbitrageGraph;
    private isRunning: boolean = false;
    private isCheckingArbitrage: boolean = false;
    private unwatchFn: any;
    private pendingUpdates: PendingUpdate[] = []; // Updated type
    private networkConfig: any;
    private usingWebSocket: boolean = false;
    private wsReconnectAttempts: number = 0;
    private reconnecting: boolean = false;

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

        // Get all pair and V3 pool addresses from graph for validation
        const allAddresses = this.graph.getAllPoolAndPairAddresses(); // Use combined addresses
        
        console.log(`Starting event monitor for ${allAddresses.length} pairs/pools...`);
        if (DEBUG) {
            console.log('Monitoring addresses:', allAddresses);
        }

        try {
            // Determine which client to use for event monitoring
            const eventClient = this.usingWebSocket && this.wsClient ? this.wsClient : this.client;
            
            if (this.usingWebSocket) {
                console.log('Using WebSocket for event monitoring');
            } else {
                console.log('Using HTTP polling for event monitoring');
            }
            
            // Watch for both V2 Sync and V3 Swap events
            const unwatch = await eventClient.watchContractEvent({
                address: allAddresses, // Use combined addresses
                abi: ALL_EVENT_ABIS, // Use combined ABIs
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

    private decodeSyncEventV2(log: any): { reserve0: bigint, reserve1: bigint } | null {
        try {
            // Check if it's a V2 Sync event by topic
            if (!log.topics || !log.topics[0]) {
                return null;
            }

            const topic = log.topics[0];
            
            // Try decoding based on the specific topic
            if (topic === SYNC_TOPIC_UINT256) {
                const decoded = decodeEventLog({
                    abi: [SYNC_EVENT_ABI_V2[1]], // uint256 version
                    data: log.data,
                    topics: log.topics
                });
                return {
                    reserve0: decoded.args.reserve0,
                    reserve1: decoded.args.reserve1
                };
            } else if (topic === SYNC_TOPIC_UINT112) {
                const decoded = decodeEventLog({
                    abi: [SYNC_EVENT_ABI_V2[0]], // uint112 version
                    data: log.data,
                    topics: log.topics
                });
                return {
                    reserve0: decoded.args.reserve0,
                    reserve1: decoded.args.reserve1
                };
            }

            // If not a known V2 topic, return null
            return null;
        } catch (error) {
            console.error('Failed to decode V2 Sync event:', error);
            return null;
        }
    }

    // New function to decode V3 Swap events
    private decodeSwapEventV3(log: any): { sqrtPriceX96: bigint, liquidity: bigint, tick: number } | null {
        try {
            if (!log.topics || log.topics[0] !== SYNC_TOPIC_V3) {
                return null;
            }

            const decoded = decodeEventLog({
                abi: SYNC_EVENT_ABI_V3, // Use V3 ABI
                data: log.data,
                topics: log.topics
            });

            return {
                sqrtPriceX96: decoded.args.sqrtPriceX96,
                liquidity: decoded.args.liquidity,
                tick: decoded.args.tick
            };
        } catch (error) {
            console.error('Failed to decode V3 Swap event:', error);
            return null;
        }
    }

    private async handleSyncEvents(logs: any[]) {
        try {
            if (DEBUG && logs.length > 0) console.log(`Received ${logs.length} events`);
            
            // Create a mapping of lowercase to original case addresses
            const allAddresses = this.graph.getAllPoolAndPairAddresses(); // Use combined addresses
            const validAddresses = new Set(allAddresses.map(addr => addr.toLowerCase()));
            const addressMap = new Map(allAddresses.map(addr => [addr.toLowerCase(), addr]));
            
            // Collect all valid updates (V2 and V3)
            const v2Updates: ReserveUpdateV2[] = [];
            const v3Updates: ReserveUpdateV3[] = [];
            
            for (const log of logs) {
                // Custom logging to handle BigInt values - convert all BigInt to strings
                const logForDisplay = JSON.parse(JSON.stringify(log, (key, value) => 
                    typeof value === 'bigint' ? value.toString() : value
                ));
                
                // Check if this address is in our graph before proceeding
                const lowercaseAddress = log.address?.toLowerCase();
                if (!validAddresses.has(lowercaseAddress)) {
                    if (DEBUG) {
                        console.log(`Skipping event from unknown address: ${lowercaseAddress}`);
                    }
                    continue;
                }

                // Get the original case address for updating the graph
                const eventAddress = addressMap.get(lowercaseAddress) as Address;

                if (DEBUG) console.log('Raw event log:', JSON.stringify(logForDisplay, null, 2));

                // Try decoding as V2 Sync event
                const decodedV2 = this.decodeSyncEventV2(log);
                if (decodedV2) {
                    const { reserve0, reserve1 } = decodedV2;
                    if (DEBUG) console.log(`V2 Sync event from ${eventAddress}:`, {
                        reserve0: reserve0.toString(),
                        reserve1: reserve1.toString()
                    });
                    v2Updates.push({ type: 'V2', pairAddress: eventAddress, reserve0, reserve1 });
                    continue; // Move to next log once processed
                }

                // Try decoding as V3 Swap event (only if V3 enabled)
                if (enableV3Pools) {
                    const decodedV3 = this.decodeSwapEventV3(log);
                    if (decodedV3) {
                        const { sqrtPriceX96, liquidity, tick } = decodedV3;
                         if (DEBUG) console.log(`V3 Swap event from ${eventAddress}:`, {
                            sqrtPriceX96: sqrtPriceX96.toString(),
                            liquidity: liquidity.toString(),
                            tick: tick
                        });
                        v3Updates.push({ type: 'V3', poolAddress: eventAddress, sqrtPriceX96, liquidity, tick });
                        continue; // Move to next log once processed
                    }
                }

                // If neither V2 nor V3, log if needed
                if (DEBUG) console.log(`Log from ${eventAddress} wasn't a V2 Sync or V3 Swap event.`);

            }

            // If we're currently checking arbitrage, add these updates to pending queue
            if (this.isCheckingArbitrage) {
                const combinedUpdates = [...v2Updates, ...v3Updates];
                if (combinedUpdates.length > 0) {
                    if (DEBUG) console.log(`Adding ${combinedUpdates.length} updates (V2: ${v2Updates.length}, V3: ${v3Updates.length}) to pending queue`);
                    this.pendingUpdates.push(...combinedUpdates);
                }
                return;
            }

            // Process all updates at once
            await this.processUpdates(v2Updates, v3Updates);

        } catch (error) {
            console.error('Error handling events:', error);
        }
    }

    // Updated to handle both V2 and V3 updates
    private async processUpdates(v2Updates: ReserveUpdateV2[], v3Updates: ReserveUpdateV3[]) {
        if (v2Updates.length === 0 && v3Updates.length === 0) return;

        try {
            if (DEBUG) console.log(`Processing ${v2Updates.length} V2 updates and ${v3Updates.length} V3 updates`);
            
            // Batch update V2 reserves
            if (v2Updates.length > 0) {
                try {
                    this.graph.updatePairReservesBatch(v2Updates);
                    if (DEBUG) console.log(`Successfully updated ${v2Updates.length} V2 pairs`);
                } catch (error) {
                    console.error('Failed to update V2 reserves:', error);
                }
            }

            // Batch update V3 dynamic data (only if V3 enabled)
            if (enableV3Pools && v3Updates.length > 0) {
                 try {
                    this.graph.updateV3PoolDynamicDataBatch(v3Updates);
                    // Debug log is inside updateV3PoolDynamicDataBatch
                } catch (error) {
                    console.error('Failed to update V3 pool dynamic data:', error);
                }
            }

            // Check for arbitrage opportunities only once after all updates
            this.isCheckingArbitrage = true;
            console.log('Starting arbitrage check after batch update...');
            await this.checkArbitrageOpportunities();

            // Process any pending updates that came during arbitrage check
            if (this.pendingUpdates.length > 0) {
                const pending = [...this.pendingUpdates];
                this.pendingUpdates = [];
                // Separate pending updates by type
                const pendingV2 = pending.filter(upd => upd.type === 'V2') as ReserveUpdateV2[];
                const pendingV3 = pending.filter(upd => upd.type === 'V3') as ReserveUpdateV3[];
                await this.processUpdates(pendingV2, pendingV3);
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
        if (this.reconnecting) {
            if (DEBUG) console.log('Already in the process of reconnecting, skipping duplicate restart');
            return;
        }
        
        this.reconnecting = true;
        
        try {
            await this.stop();
            
            // Reset WebSocket status to try again with the original configuration
            if (WSS_ENABLED && this.networkConfig.wsClient && this.usingWebSocket) {
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
        if (DEBUG) {
            console.error('Error in event monitoring:', error);
        }

        // Check if it's a WebSocket-related error
        const errorMessage = error.message?.toLowerCase() || '';
        const errorDetails = error.details?.toLowerCase() || '';
        
        // Handle WebSocket-specific errors
        const isWebSocketError = this.usingWebSocket && (
            errorMessage.includes('websocket') || 
            errorDetails.includes('websocket') ||
            (errorMessage.includes('connection') && !errorMessage.includes('connection reset')) || // Avoid catching 'connection reset'
            (errorDetails.includes('connection') && !errorDetails.includes('connection reset')) ||
            errorMessage.includes('socket') ||
            errorDetails.includes('socket') ||
            errorMessage.includes('closed') ||
            errorDetails.includes('closed') ||
            errorMessage.includes('timeout') || // Added timeout
            errorDetails.includes('timeout')
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
            errorMessage.includes('rpc request failed') ||
            errorDetails.includes('rpc request failed') ||
            errorMessage.includes('connection reset') || // Treat connection reset as needing restart
            errorDetails.includes('connection reset')) {
            
            if (DEBUG) console.log('RPC/Filter/Connection error detected, restarting event monitor...');
            await this.restart();
        }
    }
}