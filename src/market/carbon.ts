import { parseAbi, type Address } from 'viem';
import { CARBON_CONTROLLERS, TOKENS, type CarbonControllerConfig } from '../constants';

export type CarbonPairMetadata = {
  controller: Address;
  token0: Address;
  token1: Address;
  strategyCount: number;
  feePpm: number;
};

export type CarbonOrder = {
  y: bigint;
  z: bigint;
  A: bigint;
  B: bigint;
};

export type CarbonStrategy = {
  id: bigint;
  owner: Address;
  controller: Address;
  token0: Address;
  token1: Address;
  feePpm: number;
  orders: [CarbonOrder, CarbonOrder];
};

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as Address;

const CARBON_CONTROLLER_ABI = parseAbi([
  'function pairs() view returns (address[2][])',
  'function strategiesByPairCount(address token0, address token1) view returns (uint256)',
  'function strategiesByPair(address token0, address token1, uint256 startIndex, uint256 endIndex) view returns ((uint256 id, address owner, address[2] tokens, (uint128 y, uint128 z, uint64 A, uint64 B)[2] orders)[])',
  'event StrategyCreated(uint256 id, address indexed owner, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1)',
  'event StrategyDeleted(uint256 id, address indexed owner, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1)',
  'event StrategyUpdated(uint256 indexed id, address indexed token0, address indexed token1, (uint128 y, uint128 z, uint64 A, uint64 B) order0, (uint128 y, uint128 z, uint64 A, uint64 B) order1, uint8 reason)',
  'event TokensTraded(address indexed trader, address indexed sourceToken, address indexed targetToken, uint256 sourceAmount, uint256 targetAmount, uint128 tradingFeeAmount, bool byTargetAmount)',
]);

type CarbonClient = {
  readContract(parameters: any): Promise<unknown>;
  watchContractEvent(parameters: any): () => void | Promise<void>;
};

type RawCarbonStrategy = {
  id?: bigint;
  owner?: Address;
  tokens?: readonly [Address, Address];
  orders?: readonly [RawCarbonOrder, RawCarbonOrder];
  0?: bigint;
  1?: Address;
  2?: readonly [Address, Address];
  3?: readonly [RawCarbonOrder, RawCarbonOrder];
};

type RawCarbonOrder = {
  y?: bigint;
  z?: bigint;
  A?: bigint;
  B?: bigint;
  0?: bigint;
  1?: bigint;
  2?: bigint;
  3?: bigint;
};

export async function discoverCarbonPairs(client: CarbonClient): Promise<CarbonPairMetadata[]> {
  const allowedTokens = new Set(TOKENS.map(token => token.address.toLowerCase()));
  const pairs: CarbonPairMetadata[] = [];

  for (const controller of CARBON_CONTROLLERS) {
    if (!controller.enabled) continue;
    const rawPairs = await client.readContract({
      address: controller.address,
      abi: CARBON_CONTROLLER_ABI,
      functionName: 'pairs',
    }) as readonly [Address, Address][];

    for (const [token0, token1] of rawPairs) {
      if (!allowedTokens.has(token0.toLowerCase()) || !allowedTokens.has(token1.toLowerCase())) continue;

      const count = await client.readContract({
        address: controller.address,
        abi: CARBON_CONTROLLER_ABI,
        functionName: 'strategiesByPairCount',
        args: [token0, token1],
      }) as bigint;

      if (count === 0n) continue;
      pairs.push({
        controller: controller.address,
        token0,
        token1,
        strategyCount: Number(count),
        feePpm: controller.feePpm,
      });
    }
  }

  return pairs;
}

export class CarbonStrategyStore {
  private readonly strategiesById = new Map<string, CarbonStrategy>();
  private readonly strategyIdsByPair = new Map<string, Set<string>>();
  private readonly pairByTokenKey = new Map<string, CarbonPairMetadata>();
  private readonly dirtyPairKeys = new Set<string>();
  private readonly controllerByAddress = new Map<string, CarbonControllerConfig>();
  private readonly unwatchFns: Array<() => void | Promise<void>> = [];

  constructor(
    private readonly client: CarbonClient,
    private readonly pairs: readonly CarbonPairMetadata[],
    private readonly onChange?: (strategies: readonly CarbonStrategy[]) => void
  ) {
    for (const controller of CARBON_CONTROLLERS) {
      this.controllerByAddress.set(controller.address.toLowerCase(), controller);
    }

    for (const pair of pairs) {
      const key = this.pairKey(pair.controller, pair.token0, pair.token1);
      this.pairByTokenKey.set(key, pair);
      this.pairByTokenKey.set(this.pairKey(pair.controller, pair.token1, pair.token0), pair);
      this.strategyIdsByPair.set(key, new Set());
    }
  }

  async start(): Promise<void> {
    await this.watch();
    await this.loadAll();
    await this.flushDirtyPairs();
  }

  async stop(): Promise<void> {
    for (const unwatch of this.unwatchFns) {
      await unwatch();
    }
    this.unwatchFns.length = 0;
  }

  strategyCount(): number {
    return this.strategiesById.size;
  }

  strategies(): CarbonStrategy[] {
    return Array.from(this.strategiesById.values());
  }

  async loadAll(): Promise<void> {
    this.strategiesById.clear();
    for (const ids of this.strategyIdsByPair.values()) ids.clear();

    for (const pair of this.pairs) {
      await this.refetchPair(pair);
    }

    this.notifyChanged();
  }

  private async watch(): Promise<void> {
    for (const controller of this.controllerByAddress.values()) {
      if (!controller.enabled) continue;
      const unwatch = await this.client.watchContractEvent({
        address: controller.address,
        abi: CARBON_CONTROLLER_ABI,
        strict: true,
        onLogs: (logs: any[]) => {
          for (const log of logs) this.applyEvent(controller.address, log as any);
          void this.flushDirtyPairs();
        },
        onError: (error: any) => console.error('Carbon event monitor error:', error),
      });
      this.unwatchFns.push(unwatch);
    }
  }

  private async refetchPair(pair: CarbonPairMetadata): Promise<void> {
    const rawStrategies = await this.client.readContract({
      address: pair.controller,
      abi: CARBON_CONTROLLER_ABI,
      functionName: 'strategiesByPair',
      args: [pair.token0, pair.token1, 0n, 0n],
    }) as RawCarbonStrategy[];

    const key = this.pairKey(pair.controller, pair.token0, pair.token1);
    const previousIds = this.strategyIdsByPair.get(key);
    if (previousIds) {
      for (const id of previousIds) this.strategiesById.delete(id);
      previousIds.clear();
    }

    const ids = previousIds ?? new Set<string>();
    for (const raw of rawStrategies) {
      const strategy = this.normalizeStrategy(pair.controller, raw);
      strategy.feePpm = pair.feePpm;
      if (!this.isLiveStrategy(strategy)) continue;
      const id = strategy.id.toString();
      this.strategiesById.set(id, strategy);
      ids.add(id);
    }
    this.strategyIdsByPair.set(key, ids);
  }

  private async flushDirtyPairs(): Promise<void> {
    if (this.dirtyPairKeys.size === 0) return;
    const keys = Array.from(this.dirtyPairKeys);
    this.dirtyPairKeys.clear();

    for (const key of keys) {
      const pair = this.pairByTokenKey.get(key);
      if (pair) await this.refetchPair(pair);
    }
    this.notifyChanged();
  }

  private applyEvent(controller: Address, log: { eventName?: string; args?: any }): void {
    const args = log.args;
    if (!args) return;

    if (log.eventName === 'StrategyDeleted') {
      this.deleteStrategy(args.id);
      this.notifyChanged();
      return;
    }

    if (log.eventName === 'StrategyCreated' || log.eventName === 'StrategyUpdated') {
      const existing = this.strategiesById.get(args.id.toString());
      const strategy: CarbonStrategy = {
        id: BigInt(args.id),
        owner: args.owner ?? existing?.owner ?? ZERO_ADDRESS,
        controller,
        token0: args.token0,
        token1: args.token1,
        feePpm: existing?.feePpm ?? this.feePpmForPair(controller, args.token0, args.token1),
        orders: [this.normalizeOrder(args.order0), this.normalizeOrder(args.order1)],
      };

      if (this.isLiveStrategy(strategy)) {
        this.strategiesById.set(strategy.id.toString(), strategy);
        this.addStrategyToPair(strategy);
      } else {
        this.deleteStrategy(strategy.id);
      }
      this.notifyChanged();
      return;
    }

    if (log.eventName === 'TokensTraded') {
      this.dirtyPairKeys.add(this.pairKey(controller, args.sourceToken, args.targetToken));
    }
  }

  private addStrategyToPair(strategy: CarbonStrategy): void {
    const key = this.pairKey(strategy.controller, strategy.token0, strategy.token1);
    let ids = this.strategyIdsByPair.get(key);
    if (!ids) {
      ids = new Set();
      this.strategyIdsByPair.set(key, ids);
    }
    ids.add(strategy.id.toString());
  }

  private deleteStrategy(id: bigint): void {
    const key = id.toString();
    this.strategiesById.delete(key);
    for (const ids of this.strategyIdsByPair.values()) ids.delete(key);
  }

  private normalizeStrategy(controller: Address, raw: RawCarbonStrategy): CarbonStrategy {
    const tokens = field<readonly [Address, Address]>(raw, 'tokens', 2);
    const orders = field<readonly [RawCarbonOrder, RawCarbonOrder]>(raw, 'orders', 3);
    return {
      id: BigInt(field<bigint>(raw, 'id', 0)),
      owner: field<Address>(raw, 'owner', 1),
      controller,
      token0: tokens[0],
      token1: tokens[1],
      feePpm: this.feePpmForPair(controller, tokens[0], tokens[1]),
      orders: [this.normalizeOrder(orders[0]), this.normalizeOrder(orders[1])],
    };
  }

  private normalizeOrder(raw: RawCarbonOrder): CarbonOrder {
    return {
      y: BigInt(field<bigint>(raw, 'y', 0)),
      z: BigInt(field<bigint>(raw, 'z', 1)),
      A: BigInt(field<bigint>(raw, 'A', 2)),
      B: BigInt(field<bigint>(raw, 'B', 3)),
    };
  }

  private isLiveStrategy(strategy: CarbonStrategy): boolean {
    return strategy.orders[0].y > 0n || strategy.orders[1].y > 0n;
  }

  private pairKey(controller: Address, token0: Address, token1: Address): string {
    return `${controller.toLowerCase()}:${token0.toLowerCase()}:${token1.toLowerCase()}`;
  }

  private feePpmForPair(controller: Address, token0: Address, token1: Address): number {
    return this.pairByTokenKey.get(this.pairKey(controller, token0, token1))?.feePpm ?? 0;
  }

  private notifyChanged(): void {
    this.onChange?.(this.strategies());
  }
}

function field<TValue>(value: any, name: string, index: number): TValue {
  if (value && typeof value === 'object' && name in value) return value[name] as TValue;
  return value[index] as TValue;
}
