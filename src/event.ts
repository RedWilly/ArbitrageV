import { type Address, type PublicClient } from 'viem';
import { RUNTIME } from './constants';
import { refreshKnownPairsInfo } from './getinfo';
import { type CarbonStrategyStore } from './market/carbon';
import { loadConfiguredV3StartupState } from './market/v3-loader';
import { type ReserveUpdate } from './market/v2-types';
import { type V3PoolConfig, type V3PoolInfo, type V3Tick } from './market/v3-types';
import { OpportunityEngine } from './opportunities/opportunity-engine';
import { CARBON_CONTROLLERS } from './protocols/carbon-config';
import { LatestUpdateScheduler } from './runtime/event-scheduler';
import {
    advanceCursor,
    addressMap,
    CARBON_CONTROLLER_EVENT_ABI,
    chainLogBlockNumber,
    type ChainCursor,
    compareChainLogs,
    decodeV2SyncEvent,
    decodeV3PoolEvent,
    isLogAfterCursor,
    V2_SYNC_EVENT_ABI,
    V3_POOL_EVENT_ABI,
} from './runtime/market-events';

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
    v3PoolConfigs?: readonly V3PoolConfig[];
    carbonStore?: CarbonStrategyStore;
    scan: (changedPairs: readonly string[], releasedPairs?: readonly Address[]) => Promise<void>;
};

export class EventMonitor {
    private client: PublicClient;
    private wsClient?: PublicClient; // WebSocket client
    private graph: OpportunityEngine;
    private isRunning: boolean = false;
    private unwatchFns: Array<() => void | Promise<void>> = [];
    private scheduler: LatestUpdateScheduler<ReserveUpdate>;
    private networkConfig: any;
    private usingWebSocket: boolean = false;
    private wsReconnectAttempts: number = 0;
    private reconnecting: boolean = false;
    private pairAddressMap = new Map<string, Address>();
    private v3PoolAddressMap = new Map<string, Address>();
    private v2PoolByAddress = new Map<string, V2WatchPool>();
    private v3PoolConfigByAddress = new Map<string, V3PoolConfig>();
    private buffering = false;
    private bufferedV2 = new Map<string, any>();
    private bufferedV3Swaps = new Map<string, any>();
    private bufferedV3Liquidity = new Map<string, any>();
    private bufferedCarbon = new Map<string, any>();
    private readonly cursors = new Map<string, ChainCursor>();
    private firstBufferedBlock: bigint | null = null;
    private lastBufferedBlock: bigint | null = null;
    private bufferedLogCount = 0;

    constructor(graph: OpportunityEngine, networkConfig: any, private readonly options: EventMonitorOptions) {
        this.graph = graph;
        this.networkConfig = networkConfig;
        this.scheduler = new LatestUpdateScheduler(
            this.processReserveUpdateBatch.bind(this),
            update => update.pairAddress.toLowerCase()
        );
        this.client = networkConfig.client;
        for (const pool of options.v2Pools ?? []) {
            this.v2PoolByAddress.set(pool.pairAddress.toLowerCase(), pool);
        }
        for (const pool of options.v3PoolConfigs ?? []) {
            this.v3PoolConfigByAddress.set(pool.address.toLowerCase(), pool);
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

    async startBuffering(): Promise<void> {
        this.buffering = true;
        await this.start();
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
        
        const carbonPairCount = this.options.carbonStore?.stats().pairCount ?? 0;
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
                    onLogs: this.routeV2Logs.bind(this),
                    onError: this.onError.bind(this),
                    strict: true
                });
                this.unwatchFns.push(unwatchV2);
            }

            if (v3PoolAddresses.length > 0) {
                const unwatchV3 = await eventClient.watchContractEvent({
                    address: v3PoolAddresses,
                    abi: V3_POOL_EVENT_ABI,
                    onLogs: this.routeV3Logs.bind(this),
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
                        onLogs: (logs: any[]) => this.routeCarbonLogs(controller.address, logs),
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
                await this.handleWebSocketFailure();
            } else {
                this.isRunning = false;
                throw error;
            }
        }
    }

    async activate(): Promise<void> {
        if (!this.isRunning || !this.buffering) return;

        while (this.hasBufferedLogs()) {
            const v2 = this.takeBuffered(this.bufferedV2);
            const v3Swaps = this.takeBuffered(this.bufferedV3Swaps);
            const v3Liquidity = this.takeBuffered(this.bufferedV3Liquidity);
            const carbon = this.takeBuffered(this.bufferedCarbon);

            this.markApplied(v2);
            this.markApplied(v3Swaps);
            this.markApplied(v3Liquidity);
            this.markApplied(carbon);

            // Reads made during hydration do not expose a reliable per-pool block.
            // Re-read touched markets while buffering continues instead of replaying
            // an event that may be older than the fetched state.
            await Promise.all([
                this.reloadV2Pools(v2.map(log => log.address as Address)),
                this.reloadV3Pools([
                    ...v3Swaps.map(log => log.address as Address),
                    ...v3Liquidity.map(log => log.address as Address),
                ]),
                carbon.length > 0 ? this.options.carbonStore?.loadAll() : undefined,
            ]);
        }

        this.buffering = false;
        const range = this.firstBufferedBlock === null
            ? 'no market events arrived during hydration'
            : `${this.bufferedLogCount} events observed across blocks ${this.firstBufferedBlock}-${this.lastBufferedBlock}`;
        console.log(`Market event feed caught up and is now live (${range})`);
    }

    private async handleWebSocketFailure() {
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

    private async routeV2Logs(logs: any[]): Promise<void> {
        const ordered = this.sortLogsByChainOrder(logs);
        if (this.buffering) {
            for (const log of ordered) {
                const key = log.address?.toLowerCase();
                if (key && this.pairAddressMap.has(key)) this.keepLatest(this.bufferedV2, key, log);
            }
            return;
        }

        const fresh = this.freshLogs(ordered);
        if (fresh.length > 0) await this.handleSyncEvents(fresh);
    }

    private async routeV3Logs(logs: any[]): Promise<void> {
        const ordered = this.sortLogsByChainOrder(logs);
        if (this.buffering) {
            for (const log of ordered) {
                const key = log.address?.toLowerCase();
                if (!key || !this.v3PoolAddressMap.has(key)) continue;
                const decoded = decodeV3PoolEvent(log);
                if (decoded?.kind === 'swap') this.keepLatest(this.bufferedV3Swaps, key, log);
                if (decoded?.kind === 'liquidity') this.keepLatest(this.bufferedV3Liquidity, key, log);
            }
            return;
        }

        const fresh = this.freshLogs(ordered);
        if (fresh.length > 0) await this.handleV3PoolEvents(fresh);
    }

    private async routeCarbonLogs(controller: Address, logs: any[]): Promise<void> {
        const ordered = this.sortLogsByChainOrder(logs);
        if (this.buffering) {
            for (const log of ordered) {
                const id = log.args?.id;
                if (id === undefined) continue;
                this.keepLatest(this.bufferedCarbon, `${controller.toLowerCase()}:${id.toString()}`, log);
            }
            return;
        }

        const fresh = this.freshLogs(ordered);
        if (fresh.length > 0) await this.options.carbonStore?.handleEvents(controller, fresh);
    }

    private freshLogs(logs: any[]): any[] {
        let freshCount = 0;
        for (const log of logs) {
            const key = log.address?.toLowerCase();
            if (!key) continue;
            const cursor = this.cursors.get(key);
            if (cursor && !isLogAfterCursor(log, cursor)) continue;
            this.cursors.set(key, advanceCursor(cursor, log));
            logs[freshCount++] = log;
        }
        logs.length = freshCount;
        return logs;
    }

    private keepLatest(buffer: Map<string, any>, key: string, log: any): void {
        const blockNumber = chainLogBlockNumber(log);
        if (this.firstBufferedBlock === null || blockNumber < this.firstBufferedBlock) this.firstBufferedBlock = blockNumber;
        if (this.lastBufferedBlock === null || blockNumber > this.lastBufferedBlock) this.lastBufferedBlock = blockNumber;
        this.bufferedLogCount++;
        const previous = buffer.get(key);
        if (!previous || compareChainLogs(previous, log) < 0) buffer.set(key, log);
    }

    private takeBuffered(buffer: Map<string, any>): any[] {
        if (buffer.size === 0) return [];
        const logs = Array.from(buffer.values()).sort(compareChainLogs);
        buffer.clear();
        return logs;
    }

    private markApplied(logs: readonly any[]): void {
        for (const log of logs) {
            const key = log.address?.toLowerCase();
            if (!key) continue;
            const cursor = this.cursors.get(key);
            if (!cursor || isLogAfterCursor(log, cursor)) {
                this.cursors.set(key, advanceCursor(cursor, log));
            }
        }
    }

    private hasBufferedLogs(): boolean {
        return this.bufferedV2.size > 0 ||
            this.bufferedV3Swaps.size > 0 ||
            this.bufferedV3Liquidity.size > 0 ||
            this.bufferedCarbon.size > 0;
    }

    private async reloadV3Pools(addresses: readonly Address[]): Promise<void> {
        const pools = new Map<string, V3PoolConfig>();
        for (const address of addresses) {
            const pool = this.v3PoolConfigByAddress.get(address.toLowerCase());
            if (pool) pools.set(address.toLowerCase(), pool);
        }
        if (pools.size > 0) await loadConfiguredV3StartupState(this.client, this.graph, [...pools.values()]);
    }

    private async reloadV2Pools(addresses: readonly Address[]): Promise<void> {
        const pools = new Map<string, V2WatchPool>();
        for (const address of addresses) {
            const key = address.toLowerCase();
            const pool = this.v2PoolByAddress.get(key);
            if (pool) pools.set(key, pool);
        }
        if (pools.size === 0) return;
        const pairs = await refreshKnownPairsInfo(this.client, [...pools.values()].map(pool => ({
            ...pool,
            factory: '',
        })));
        for (const pair of pairs) this.graph.addPair(pair);
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
                    const logForDisplay = JSON.parse(JSON.stringify(log, (_, value) =>
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

    private async processUpdates(updates: ReserveUpdate[]) {
        await this.scheduler.submit(updates);
    }

    private async handleV3PoolEvents(logs: any[]) {
        try {
            if (RUNTIME.debug) console.log(`Received ${logs.length} V3 pool events`);
            const affectedPools = new Map<string, Address>();
            const liquidityPoolsToReload = new Map<string, Address>();

            for (const log of logs) {
                const lowercaseAddress = log.address?.toLowerCase();
                const poolAddress = this.v3PoolAddressMap.get(lowercaseAddress);
                if (!poolAddress) {
                    if (RUNTIME.debug) {
                        console.log(`Skipping V3 event from unknown pool: ${lowercaseAddress}`);
                    }
                    continue;
                }

                const decodedEvent = decodeV3PoolEvent(log);
                if (!decodedEvent) {
                    if (RUNTIME.debug) console.log('Failed to decode V3 pool event');
                    continue;
                }

                if (decodedEvent.kind === 'collect') continue;
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

                if (this.hasV3PoolConfig(poolAddress)) {
                    liquidityPoolsToReload.set(poolAddress.toLowerCase(), poolAddress);
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

            if (liquidityPoolsToReload.size > 0) {
                await this.reloadV3Pools(Array.from(liquidityPoolsToReload.values()));
            }
            await this.refreshV3Windows(Array.from(affectedPools.values()));

            console.log('Starting arbitrage check after V3 batch update...');
            await this.checkArbitrageOpportunities(Array.from(affectedPools.values()));
        } catch (error) {
            console.error('Error handling V3 pool events:', error);
        }
    }

    private sortLogsByChainOrder(logs: any[]): any[] {
        return logs.sort(compareChainLogs);
    }

    private hasV3PoolConfig(poolAddress: Address): boolean {
        return this.v3PoolConfigByAddress.has(poolAddress.toLowerCase());
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
        if (this.buffering) return;
        try {
            await this.options.scan(affectedPairs ?? [], affectedPairs);
        } catch (error) {
            console.error('Error checking arbitrage opportunities:', error);
        }
    }

    private async refreshV3Windows(affectedPools: readonly Address[]): Promise<void> {
        const affected = new Set(affectedPools.map(pool => pool.toLowerCase()));
        const pools = (this.options.v3PoolConfigs ?? []).filter(pool =>
            affected.has(pool.address.toLowerCase()) && this.graph.v3PoolNeedsRefresh(pool.address)
        );
        if (pools.length > 0) await loadConfiguredV3StartupState(this.client, this.graph, pools);
    }

    async stop(): Promise<void> {
        await this.stopInternal(false);
    }

    private async stopInternal(preserveCursors: boolean): Promise<void> {
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
        this.bufferedV2.clear();
        this.bufferedV3Swaps.clear();
        this.bufferedV3Liquidity.clear();
        this.bufferedCarbon.clear();
        this.firstBufferedBlock = null;
        this.lastBufferedBlock = null;
        this.bufferedLogCount = 0;
        if (!preserveCursors) this.cursors.clear();
    }

    private async restart() {
        if (this.reconnecting) {
            if (RUNTIME.debug) console.log('Already in the process of reconnecting, skipping duplicate restart');
            return;
        }
        
        this.reconnecting = true;
        
        try {
            await this.stopInternal(true);
            
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
