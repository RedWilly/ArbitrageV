import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Address } from 'viem';
import { type V2PoolMetadata } from './getinfo';
import { type CarbonPairMetadata } from './market/carbon';
import { type V3PoolConfig } from './market/v3-types';

export type StoredPoolProtocol = 'v2' | 'v3';

export type StoredPool = {
  address: Address;
  protocol: StoredPoolProtocol;
  factory: string | null;
  token0: Address;
  token1: Address;
  fee: number;
  tickSpacing: number | null;
};

type PoolRow = {
  address: string;
  protocol: StoredPoolProtocol;
  factory: string | null;
  token0: string;
  token1: string;
  fee: number;
  tick_spacing: number | null;
};

type CarbonPairRow = {
  controller: string;
  token0: string;
  token1: string;
  strategy_count: number;
  fee_ppm: number;
  enabled: number;
};

export function marketDbPath(): string {
  return process.env.MARKET_DB_PATH || 'data/markets.sqlite';
}

export function openMarketDb(path = marketDbPath()): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  initMarketDb(db);
  return db;
}

export function initMarketDb(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      address TEXT PRIMARY KEY,
      protocol TEXT NOT NULL,
      factory TEXT,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      fee INTEGER NOT NULL,
      tick_spacing INTEGER
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS carbon_pairs (
      controller TEXT NOT NULL,
      token0 TEXT NOT NULL,
      token1 TEXT NOT NULL,
      strategy_count INTEGER NOT NULL,
      fee_ppm INTEGER NOT NULL DEFAULT 4000,
      enabled INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (controller, token0, token1)
    )
  `);
  addColumnIfMissing(db, 'carbon_pairs', 'fee_ppm', 'INTEGER NOT NULL DEFAULT 4000');
}

export function replaceStoredPools(db: Database, pools: readonly StoredPool[]): void {
  const insert = db.prepare(`
    INSERT INTO pools (address, protocol, factory, token0, token1, fee, tick_spacing)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const replace = db.transaction((rows: readonly StoredPool[]) => {
    db.exec('DELETE FROM pools');
    for (const pool of rows) {
      insert.run(
        pool.address,
        pool.protocol,
        pool.factory,
        pool.token0,
        pool.token1,
        pool.fee,
        pool.tickSpacing
      );
    }
  });

  replace(pools);
}

export function loadStoredPools(db: Database): StoredPool[] {
  const rows = db.prepare('SELECT address, protocol, factory, token0, token1, fee, tick_spacing FROM pools').all() as PoolRow[];
  return rows.map(row => ({
    address: row.address as Address,
    protocol: row.protocol,
    factory: row.factory,
    token0: row.token0 as Address,
    token1: row.token1 as Address,
    fee: row.fee,
    tickSpacing: row.tick_spacing,
  }));
}

export function replaceStoredCarbonPairs(db: Database, pairs: readonly CarbonPairMetadata[]): void {
  const insert = db.prepare(`
    INSERT INTO carbon_pairs (controller, token0, token1, strategy_count, fee_ppm, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const replace = db.transaction((rows: readonly CarbonPairMetadata[]) => {
    db.exec('DELETE FROM carbon_pairs');
    for (const pair of rows) {
      insert.run(
        pair.controller,
        pair.token0,
        pair.token1,
        pair.strategyCount,
        pair.feePpm,
        pair.enabled ? 1 : 0
      );
    }
  });

  replace(pairs);
}

export function loadStoredCarbonPairs(db: Database): CarbonPairMetadata[] {
  const rows = db.prepare(`
    SELECT controller, token0, token1, strategy_count, fee_ppm, enabled
    FROM carbon_pairs
    WHERE enabled = 1
  `).all() as CarbonPairRow[];

  return rows.map(row => ({
    controller: row.controller as Address,
    token0: row.token0 as Address,
    token1: row.token1 as Address,
    strategyCount: row.strategy_count,
    feePpm: row.fee_ppm,
    enabled: row.enabled === 1,
  }));
}

export function toStoredV2Pool(pool: V2PoolMetadata): StoredPool {
  return {
    address: pool.pairAddress,
    protocol: 'v2',
    factory: pool.factory,
    token0: pool.token0,
    token1: pool.token1,
    fee: pool.fee,
    tickSpacing: null,
  };
}

export function toStoredV3Pool(pool: V3PoolConfig): StoredPool {
  return {
    address: pool.address,
    protocol: 'v3',
    factory: null,
    token0: pool.token0,
    token1: pool.token1,
    fee: pool.fee,
    tickSpacing: pool.tickSpacing,
  };
}

export function storedV2Pools(pools: readonly StoredPool[]): V2PoolMetadata[] {
  return pools
    .filter(pool => pool.protocol === 'v2')
    .map(pool => ({
      pairAddress: pool.address,
      token0: pool.token0,
      token1: pool.token1,
      fee: pool.fee,
      factory: pool.factory || '',
    }));
}

export function storedV3Pools(pools: readonly StoredPool[]): V3PoolConfig[] {
  return pools
    .filter(pool => pool.protocol === 'v3' && pool.tickSpacing !== null)
    .map(pool => ({
      name: pool.address,
      address: pool.address,
      token0: pool.token0,
      token1: pool.token1,
      fee: pool.fee,
      tickSpacing: pool.tickSpacing!,
      enabled: true,
    }));
}

function addColumnIfMissing(db: Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some(existing => existing.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
