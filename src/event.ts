import { type Address, parseAbiItem, decodeEventLog, type PublicClient } from 'viem';
import { RUNTIME } from './constants';
import { type ReserveUpdate } from './market/v2-types';
import { type V3PoolInfo, type V3PoolUpdate, type V3Tick } from './market/v3-types';
import { OpportunityEngine } from './opportunities/opportunity-engine';
import { OpportunityWorkflow } from './opportunities/opportunity-workflow';
import {
    createReserveUpdateScheduler,
    createV3PoolUpdateScheduler,
    type LatestUpdateScheduler,
} from './runtime/event-scheduler';
import { V3_LIQUIDITY_EVENT_ABI, V3_SWAP_EVENT_ABI } from './runtime/v3-events';

// ABI for both types of Sync events
const SYNC_EVENT_ABI = [
    parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)'),
    parseAbiItem('event Sync(uint256 reserve0, uint256 reserve1)')
];

// Sync event topics
const SYNC_TOPIC_UINT112 = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';
const SYNC_TOPIC_UINT256 = '0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a';
// Maximum WebSocket reconnection attempts before falling back to HTTP
const MAX_WEBSOCKET_RECONNECT_ATTEMPTS = 3;

type V2WatchPool = {
    pairAddress: Address;
    token0: Address;
    token1: Address;
    fee: number;
};

type EventMonitorOptions = {
    v2Pools?: readonly V2WatchPool[];
    v3Pools?: readonly Address[];
};

export class EventMonitor {
    private client: PublicClient;
    private wsClient?: PublicClient; // WebSocket client
    private graph: OpportunityEngine;
    private opportunities: OpportunityWorkflow;
    private isRunning: boolean = false;
    private unwatchFns: Array<() => void | Promise<void>> = [];
    private scheduler: LatestUpdateScheduler<ReserveUpdate>;
    private v3Scheduler: LatestUpdateScheduler<V3PoolUpdate>;
    private networkConfig: any;
    private usingWebSocket: boolean = false;
    private wsReconnectAttempts: number = 0;
    private reconnecting: boolean = false;
    private pairAddressMap = new Map<string, Address>();
    private v3PoolAddressMap = new Map<string, Address>();
    private v2PoolByAddress = new Map<string, V2WatchPool>();

    constructor(graph: OpportunityEngine, networkConfig: any, private readonly options: EventMonitorOptions = {}) {
        this.graph = graph;
        this.networkConfig = networkConfig;
        this.opportunities = new OpportunityWorkflow(graph, networkConfig);
        this.scheduler = createReserveUpdateScheduler(this.processReserveUpdateBatch.bind(this));
        this.v3Scheduler = createV3PoolUpdateScheduler(this.processV3PoolUpdateBatch.bind(this));
        this.client = networkConfig.client;
        for (const pool of options.v2Pools ?? []) {
            this.v2PoolByAddress.set(pool.pairAddress.toLowerCase(), pool);
        }
        
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
        const pairAddresses = this.options.v2Pools?.map(pool => pool.pairAddress) ?? this.graph.getPairAddresses();
        const v3PoolAddresses = this.options.v3Pools ? [...this.options.v3Pools] : this.graph.getV3PoolAddresses();
        this.pairAddressMap = this.addressMap(pairAddresses);
        this.v3PoolAddressMap = this.addressMap(v3PoolAddresses);
        
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
                    eventName: 'Swap',
                    onLogs: this.handleV3SwapEvents.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV3);

                const unwatchV3Mint = await eventClient.watchContractEvent({
                    address: v3PoolAddresses,
                    abi: V3_LIQUIDITY_EVENT_ABI,
                    eventName: 'Mint',
                    onLogs: this.handleV3LiquidityEvents.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV3Mint);

                const unwatchV3Burn = await eventClient.watchContractEvent({
                    address: v3PoolAddresses,
                    abi: V3_LIQUIDITY_EVENT_ABI,
                    eventName: 'Burn',
                    onLogs: this.handleV3LiquidityEvents.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV3Burn);
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
            
            // Collect all valid updates
            const updates: ReserveUpdate[] = [];
            
            for (const log of logs) {
                // Check if this pair is in our graph before proceeding
                const lowercaseAddress = log.address?.toLowerCase();
                const pairAddress = this.pairAddressMap.get(lowercaseAddress);
                if (!pairAddress) {
                    if (RUNTIME.debug) {
                        console.log(`Skipping event from unknown pair: ${lowercaseAddress}`);
                    }
                    continue;
                }

                if (RUNTIME.debug) {
                    const logForDisplay = JSON.parse(JSON.stringify(log, (key, value) =>
                        typeof value === 'bigint' ? value.toString() : value
                    ));
                    console.log('Raw event log:', JSON.stringify(logForDisplay, null, 2));
                }

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

    private decodeV3LiquidityEvent(log: any): { kind: 'mint' | 'burn'; tickLower: number; tickUpper: number; amount: bigint } | null {
        try {
            const decoded = decodeEventLog({
                abi: V3_LIQUIDITY_EVENT_ABI,
                data: log.data,
                topics: log.topics
            });

            return {
                kind: decoded.eventName === 'Mint' ? 'mint' : 'burn',
                tickLower: Number(decoded.args.tickLower),
                tickUpper: Number(decoded.args.tickUpper),
                amount: decoded.args.amount,
            };
        } catch (error) {
            console.error('Failed to decode V3 liquidity event:', error);
            return null;
        }
    }

    private async processUpdates(updates: ReserveUpdate[]) {
        await this.scheduler.submit(updates);
    }

    private async handleV3SwapEvents(logs: any[]) {
        try {
            if (RUNTIME.debug) console.log(`Received ${logs.length} V3 Swap events`);

            const updates: V3PoolUpdate[] = [];

            for (const log of logs) {
                const lowercaseAddress = log.address?.toLowerCase();
                const poolAddress = this.v3PoolAddressMap.get(lowercaseAddress);
                if (!poolAddress) {
                    if (RUNTIME.debug) {
                        console.log(`Skipping V3 event from unknown pool: ${lowercaseAddress}`);
                    }
                    continue;
                }

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

    private async handleV3LiquidityEvents(logs: any[]) {
        try {
            if (RUNTIME.debug) console.log(`Received ${logs.length} V3 liquidity events`);

            const activeLiquidityUpdates: V3PoolUpdate[] = [];

            for (const log of logs) {
                const lowercaseAddress = log.address?.toLowerCase();
                const poolAddress = this.v3PoolAddressMap.get(lowercaseAddress);
                if (!poolAddress) continue;

                const decoded = this.decodeV3LiquidityEvent(log);
                if (!decoded) continue;

                this.applyV3LiquidityUpdate(poolAddress, decoded);

                const pool = this.findV3Pool(poolAddress);
                if (pool?.state && pool.state.tick >= decoded.tickLower && pool.state.tick < decoded.tickUpper) {
                    const liquidity = decoded.kind === 'mint'
                        ? pool.state.liquidity + decoded.amount
                        : pool.state.liquidity > decoded.amount ? pool.state.liquidity - decoded.amount : 0n;

                    activeLiquidityUpdates.push({
                        poolAddress,
                        sqrtPriceX96: pool.state.sqrtPriceX96,
                        liquidity,
                        tick: pool.state.tick,
                    });
                }
            }

            if (activeLiquidityUpdates.length > 0) {
                await this.processV3Updates(activeLiquidityUpdates);
            }
        } catch (error) {
            console.error('Error handling V3 liquidity events:', error);
        }
    }

    private async processV3Updates(updates: V3PoolUpdate[]) {
        await this.v3Scheduler.submit(updates);
    }

    private async processReserveUpdateBatch(batch: ReserveUpdate[]): Promise<void> {
        if (RUNTIME.debug) console.log(`Processing ${batch.length} latest reserve updates`);

        try {
            if (this.v2PoolByAddress.size === 0) {
                this.graph.updateReserves(batch);
            } else {
                const updates: ReserveUpdate[] = [];
                for (const update of batch) {
                    const pool = this.v2PoolByAddress.get(update.pairAddress.toLowerCase());
                    if (!pool) {
                        updates.push(update);
                        continue;
                    }

                    this.graph.addPair({
                        pairAddress: pool.pairAddress,
                        token0: pool.token0,
                        token1: pool.token1,
                        fee: pool.fee,
                        reserve0: update.reserve0,
                        reserve1: update.reserve1,
                    });
                }
                if (updates.length > 0) this.graph.updateReserves(updates);
            }
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
            return;
        }

        console.log('Starting arbitrage check after V3 batch update...');
        await this.checkArbitrageOpportunities(batch.map(update => update.poolAddress));
    }

    private applyV3LiquidityUpdate(
        poolAddress: Address,
        update: { kind: 'mint' | 'burn'; tickLower: number; tickUpper: number; amount: bigint }
    ): void {
        const ticks = this.graph.getV3InitializedTicks(poolAddress);
        const grossDelta = update.kind === 'mint' ? update.amount : -update.amount;
        const lower = this.nextTick(ticks, update.tickLower, grossDelta, update.kind === 'mint' ? update.amount : -update.amount);
        const upper = this.nextTick(ticks, update.tickUpper, grossDelta, update.kind === 'mint' ? -update.amount : update.amount);
        const nextTicks = [lower, upper].filter(tick => tick !== null);

        if (nextTicks.length === 0) return;

        this.graph.updateV3Ticks([{
            poolAddress,
            ticks: nextTicks,
        }]);
    }

    private nextTick(ticks: V3Tick[], index: number, liquidityGrossDelta: bigint, liquidityNetDelta: bigint): V3Tick | null {
        const current = ticks.find(tick => tick.index === index);
        if (!current && liquidityGrossDelta < 0n) return null;

        const liquidityGross = this.addSigned(current?.liquidityGross ?? 0n, liquidityGrossDelta);

        return {
            index,
            liquidityGross,
            liquidityNet: (current?.liquidityNet ?? 0n) + liquidityNetDelta,
        };
    }

    private addSigned(value: bigint, delta: bigint): bigint {
        return delta < 0n && value < -delta ? 0n : value + delta;
    }

    private findV3Pool(poolAddress: Address): V3PoolInfo | null {
        return this.graph.getV3Pools().find(pool => pool.address === poolAddress) ?? null;
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

    private addressMap(addresses: readonly Address[]): Map<string, Address> {
        return new Map(addresses.map(address => [address.toLowerCase(), address]));
    }
}
