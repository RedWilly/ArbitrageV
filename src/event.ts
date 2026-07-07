import { type Address, decodeEventLog, type PublicClient } from 'viem';
import { CARBON_CONTROLLERS, RUNTIME } from './constants';
import { type CarbonStrategyStore } from './market/carbon';
import { type ReserveUpdate } from './market/v2-types';
import { type V3PoolInfo, type V3PoolUpdate, type V3Tick } from './market/v3-types';
import { OpportunityEngine } from './opportunities/opportunity-engine';
import { scanAndExecuteOpportunities } from './opportunities/opportunity-workflow';
import { LatestUpdateScheduler } from './runtime/event-scheduler';
import { CARBON_CONTROLLER_EVENT_ABI } from './runtime/carbon-events';
import { addressMap, decodeV2SyncEvent, V2_SYNC_EVENT_ABI } from './runtime/v2-events';
import { V3_POOL_EVENT_ABI } from './runtime/v3-events';

// Maximum WebSocket reconnection attempts before falling back to HTTP
const MAX_WEBSOCKET_RECONNECT_ATTEMPTS = 9;

type V2WatchPool = {
    pairAddress: Address;
    token0: Address;
    token1: Address;
    fee: number;
};

type EventMonitorOptions = {
    v2Pools?: readonly V2WatchPool[];
    v3Pools?: readonly Address[];
    carbonStore?: CarbonStrategyStore;
};

type DecodedV3PoolEvent =
    | { kind: 'swap'; update: Omit<V3PoolUpdate, 'poolAddress'> }
    | { kind: 'liquidity'; update: { kind: 'mint' | 'burn'; tickLower: number; tickUpper: number; amount: bigint } };

export class EventMonitor {
    private client: PublicClient;
    private wsClient?: PublicClient; // WebSocket client
    private graph: OpportunityEngine;
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
        this.scheduler = new LatestUpdateScheduler(
            this.processReserveUpdateBatch.bind(this),
            update => update.pairAddress.toLowerCase()
        );
        this.v3Scheduler = new LatestUpdateScheduler(
            this.processV3PoolUpdateBatch.bind(this),
            update => update.poolAddress.toLowerCase()
        );
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
        this.pairAddressMap = addressMap(pairAddresses);
        this.v3PoolAddressMap = addressMap(v3PoolAddresses);
        
        const carbonPairCount = this.options.carbonStore?.pairCount() ?? 0;
        const carbonText = carbonPairCount ? `, and ${carbonPairCount} Carbon pairs` : '';
        console.log(`Starting event monitor for ${pairAddresses.length} V2 pairs, ${v3PoolAddresses.length} V3 pools${carbonText}...`);
        if (RUNTIME.debug) {
            console.log('Monitoring V2 pairs:', pairAddresses);
            console.log('Monitoring V3 pools:', v3PoolAddresses);
            if (this.options.carbonStore) console.log('Monitoring Carbon controllers:', CARBON_CONTROLLERS.filter(controller => controller.enabled).map(controller => controller.address));
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
                    abi: V2_SYNC_EVENT_ABI,
                    onLogs: this.handleSyncEvents.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV2);
            }

            if (v3PoolAddresses.length > 0) {
                const unwatchV3 = await eventClient.watchContractEvent({
                    address: v3PoolAddresses,
                    abi: V3_POOL_EVENT_ABI,
                    onLogs: this.handleV3PoolEvents.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV3);
            }

            if (this.options.carbonStore) {
                for (const controller of CARBON_CONTROLLERS) {
                    if (!controller.enabled) continue;
                    if (RUNTIME.debug) console.log(`Watching Carbon controller ${controller.name} (${controller.address})`);
                    const unwatchCarbon = await eventClient.watchContractEvent({
                        address: controller.address,
                        abi: CARBON_CONTROLLER_EVENT_ABI,
                        strict: true,
                        onLogs: async (logs: any[]) => {
                            await this.options.carbonStore?.handleEvents(controller.address, this.sortLogsByChainOrder(logs));
                        },
                        onError: this.onError.bind(this),
                    });
                    this.unwatchFns.push(unwatchCarbon);
                }
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
        await this.recoverWebSocket(
            'WebSocket connection failed',
            async () => {
                // start() failed before subscriptions were established, so retry directly.
                this.isRunning = false;
                await this.start();
            }
        );
    }

    private async recoverWebSocket(reason: string, reconnect: () => Promise<void>): Promise<void> {
        this.wsReconnectAttempts++;

        if (this.wsReconnectAttempts > MAX_WEBSOCKET_RECONNECT_ATTEMPTS) {
            console.log(`Maximum WebSocket reconnection attempts (${MAX_WEBSOCKET_RECONNECT_ATTEMPTS}) reached. Falling back to HTTP polling.`);
            this.usingWebSocket = false;
            this.wsReconnectAttempts = 0;
            await reconnect();
            return;
        }

        console.log(`${reason}. Reconnection attempt ${this.wsReconnectAttempts}/${MAX_WEBSOCKET_RECONNECT_ATTEMPTS}...`);
        const reconnectDelay = this.wsReconnectAttempts * 2000;
        console.log(`Waiting ${reconnectDelay / 1000} seconds before reconnecting...`);
        await new Promise(resolve => setTimeout(resolve, reconnectDelay));
        await reconnect();
    }

    private async handleSyncEvents(logs: any[]) {
        try {
            if (RUNTIME.debug) console.log(`Received ${logs.length} events`);
            
            // Collect all valid updates
            const updates: ReserveUpdate[] = [];
            
            for (const log of this.sortLogsByChainOrder(logs)) {
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
                const decodedEvent = decodeV2SyncEvent(log);
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

    private decodeV3PoolEvent(log: any): DecodedV3PoolEvent | null {
        try {
            if (!log.topics || !log.topics[0]) {
                return null;
            }

            const decoded = decodeEventLog({
                abi: V3_POOL_EVENT_ABI,
                data: log.data,
                topics: log.topics
            });

            if (decoded.eventName === 'Swap') {
                return {
                    kind: 'swap',
                    update: {
                        sqrtPriceX96: decoded.args.sqrtPriceX96,
                        liquidity: decoded.args.liquidity,
                        tick: Number(decoded.args.tick),
                    },
                };
            }

            if (decoded.eventName === 'Mint' || decoded.eventName === 'Burn') {
                return {
                    kind: 'liquidity',
                    update: {
                        kind: decoded.eventName === 'Mint' ? 'mint' : 'burn',
                        tickLower: Number(decoded.args.tickLower),
                        tickUpper: Number(decoded.args.tickUpper),
                        amount: decoded.args.amount,
                    },
                };
            }

            return null;
        } catch (error) {
            // console.error('Failed to decode V3 pool event:', error);
            return null;
        }
    }

    private async processUpdates(updates: ReserveUpdate[]) {
        await this.scheduler.submit(updates);
    }

    private async handleV3PoolEvents(logs: any[]) {
        try {
            if (RUNTIME.debug) console.log(`Received ${logs.length} V3 pool events`);
            const affectedPools = new Map<string, Address>();

            for (const log of this.sortLogsByChainOrder(logs)) {
                const lowercaseAddress = log.address?.toLowerCase();
                const poolAddress = this.v3PoolAddressMap.get(lowercaseAddress);
                if (!poolAddress) {
                    if (RUNTIME.debug) {
                        console.log(`Skipping V3 event from unknown pool: ${lowercaseAddress}`);
                    }
                    continue;
                }

                const decodedEvent = this.decodeV3PoolEvent(log);
                if (!decodedEvent) {
                    if (RUNTIME.debug) console.log('Failed to decode V3 pool event');
                    continue;
                }

                affectedPools.set(poolAddress.toLowerCase(), poolAddress);
                if (decodedEvent.kind === 'swap') {
                    if (RUNTIME.debug) console.log(`V3 Swap event from ${poolAddress}:`, {
                        sqrtPriceX96: decodedEvent.update.sqrtPriceX96.toString(),
                        liquidity: decodedEvent.update.liquidity.toString(),
                        tick: decodedEvent.update.tick,
                    });

                    this.graph.updateV3PoolStates([{
                        poolAddress,
                        ...decodedEvent.update,
                    }]);
                    continue;
                }

                this.applyV3LiquidityUpdate(poolAddress, decodedEvent.update);

                const pool = this.findV3Pool(poolAddress);
                if (pool?.state && pool.state.tick >= decodedEvent.update.tickLower && pool.state.tick < decodedEvent.update.tickUpper) {
                    const liquidity = decodedEvent.update.kind === 'mint'
                        ? pool.state.liquidity + decodedEvent.update.amount
                        : pool.state.liquidity > decodedEvent.update.amount ? pool.state.liquidity - decodedEvent.update.amount : 0n;

                    this.graph.updateV3PoolStates([{
                        poolAddress,
                        sqrtPriceX96: pool.state.sqrtPriceX96,
                        liquidity,
                        tick: pool.state.tick,
                    }]);
                }
            }

            if (RUNTIME.debug) console.log(`Successfully updated ${affectedPools.size} V3 pools`);
            if (affectedPools.size === 0) return;

            console.log('Starting arbitrage check after V3 batch update...');
            await this.checkArbitrageOpportunities(Array.from(affectedPools.values()));
        } catch (error) {
            console.error('Error handling V3 pool events:', error);
        }
    }

    private sortLogsByChainOrder(logs: any[]): any[] {
        return [...logs].sort((a, b) => {
            const block = this.compareLogField(a.blockNumber, b.blockNumber);
            if (block !== 0) return block;
            const transaction = this.compareLogField(a.transactionIndex, b.transactionIndex);
            if (transaction !== 0) return transaction;
            return this.compareLogField(a.logIndex, b.logIndex);
        });
    }

    private compareLogField(a: unknown, b: unknown): number {
        const left = this.logFieldToBigInt(a);
        const right = this.logFieldToBigInt(b);
        if (left < right) return -1;
        if (left > right) return 1;
        return 0;
    }

    private logFieldToBigInt(value: unknown): bigint {
        return typeof value === 'bigint' ? value : BigInt(typeof value === 'number' ? value : 0);
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
            await scanAndExecuteOpportunities(this.graph, this.networkConfig, { changedPairs: affectedPairs });
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
            await this.recoverWebSocket('Attempting WebSocket reconnection', () => this.restart());
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
