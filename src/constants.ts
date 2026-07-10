import { type Address } from 'viem';
import { type V3PoolConfig, type V3StartupPolicy } from './market/v3-types';
import { type ArbitrageSearchPolicy } from './market-graph/types';
import { gasPrice, tokenAmount } from './values';

export type TokenConfig = {
    name: string;
    address: Address;
    liquidityAmount: bigint;
    minProfit: bigint;
    decimals: number;
};

export type DexFactoryConfig = {
    name: string;
    address: Address;
    fee: number;
    volatile: boolean;
};

export type CarbonControllerConfig = {
    name: string;
    address: Address;
    feePpm: number;
    enabled: boolean;
};

export const NETWORK = {
    chainId: 1329,
    rpcUrl: process.env.RPC_URL,
    wsUrl: process.env.WSS_URL,
    privateKey: process.env.PRIVATE_KEY,
} as const;

export const CONTRACTS = {
    arbitrage: process.env.ARB_CONTRACT_ADDRESS,
    flashQuery: process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS,
} as const;

export const ARBITRAGE_SEARCH_POLICY: ArbitrageSearchPolicy = {
    topTokens: 7,
    allowedProtocols: ['v2', 'v3', 'carbon'],
    allowProtocolMixing: true,
    maxRouteEdges: 5,
    beamWidth: 25,
    optimizationIterations: 80,
    maxInputReserveFraction: 10n,
    maxOpportunities: 10,
} as const;

export const V3_STARTUP_POLICY: V3StartupPolicy = {
    batchSize: 5,
} as const;

export const CARBON_STARTUP_POLICY = {
    batchSize: 20,
} as const;

export const PAIR_DISCOVERY_POLICY = {
    batchSize: 200,
    woofReserveBatchSize: 5,
    maxPairAgeSeconds: 700 * 24 * 60 * 60,
    minOtherTokenLiquidity: tokenAmount('500'),
} as const;

export const EXECUTION_POLICY = {
    executeTrades: true,
    gasLimit: 1500000n,
    baseFee: gasPrice('50.9'),
    legacy: true,
} as const;

export const RUNTIME = {
    debug: true,
    websocketEnabled: true,
} as const;

export const TELEGRAM = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
} as const;


// dexes info
// & tokens info>
export const TOKENS: TokenConfig[] = [
    {
        name: 'WSEI',
        address: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
        liquidityAmount: tokenAmount('100'),
        minProfit: tokenAmount('0.05'),
        decimals: 18,
    },
    {
        name: 'USDC',
        address: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
        liquidityAmount: tokenAmount('30'),
        minProfit: tokenAmount('0.09'),
        decimals: 6,
    },
    {
        name: 'USDC.n',
        address: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
        liquidityAmount: tokenAmount('30'),
        minProfit: tokenAmount('0.09'),
        decimals: 6,
    },
    {
        name: 'USDT0',
        address: '0x9151434b16b9763660705744891fA906F660EcC5',
        liquidityAmount: tokenAmount('30'),
        minProfit: tokenAmount('0.09'),
        decimals: 6,
    },
    {
        name: 'WBTC',
        address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
        liquidityAmount: tokenAmount('0.0003324'),
        minProfit: tokenAmount('0.000001662'),
        decimals: 8,
    },
    {
        name: 'WETH',
        address: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8',
        liquidityAmount: tokenAmount('0.01238'),
        minProfit: tokenAmount('0.00006190'),
        decimals: 18,
    },
        {
        name: 'DRG',
        address: '0x0a526e425809aEA71eb279d24ae22Dee6C92A4Fe',
        liquidityAmount: tokenAmount('2100'),
        minProfit: tokenAmount('10.50'),
        decimals: 18,
    },
];

export const DEX_FACTORIES: DexFactoryConfig[] = [
    { name: 'dragonV1', address: '0x71f6b49ae1558357bBb5A6074f1143c46cBcA03d', fee: 30, volatile: false },
    { name: 'yakafinance', address: '0xd45dAff288075952822d5323F1d571e73435E929', fee: 18, volatile: true }
];

export const CARBON_CONTROLLERS: CarbonControllerConfig[] = [
    { name: 'carbon', address: '0xe4816658ad10bf215053c533cceae3f59e1f1087', feePpm: 4000, enabled: true },
];

export const V3_POOLS: V3PoolConfig[] = [
  {
    name: 'dragon-v3-drg-wsei',
    address: '0x4CeA29353508b81B6efbfb8d089EFE808e8FC991',
    token0: '0x0a526e425809aEA71eb279d24ae22Dee6C92A4Fe',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  },
  {
    name: 'dragon-v3-usdy-usdc',
    address: '0xC1b96FA8421807c5BaC89Ba699C75737c81FEEA5',
    token0: '0x54cD901491AeF397084453F4372B93c33260e2A6',
    token1: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    fee: 100,
    tickSpacing: 1,
    enabled: true,
  },
  {
    name: 'dragon-v3-usdc-wsei',
    address: '0xcca2352200a63eb0Aaba2D40BA69b1d32174F285',
    token0: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 3000,
    tickSpacing: 10,
    enabled: true,
  },
  {
    name: 'dragon-v3-usdt0-usdc',
    address: '0xf62BD525E82577a162DE88bD70dE032a62675237',
    token0: '0x9151434b16b9763660705744891fA906F660EcC5',
    token1: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    fee: 100,
    tickSpacing: 1,
    enabled: true,
  },
  {
    name: 'dragon-v3-wbtc-usdc',
    address: '0xe62fD4661C85e126744cC335E9bca8Ae3D5d19D1',
    token0: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    token1: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  },
  {
    name: 'dragon-v3-wbtc-wsei',
    address: '0x3E00Dd875fEf6cE2209007c1e625d9A656E32556',
    token0: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  },
  {
    name: 'dragon-v3-usdt0-wsei',
    address: '0xb243320bcf9c95DB7F74108B6773b8F4Dc3adaF5',
    token0: '0x9151434b16b9763660705744891fA906F660EcC5',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  },
  {
    name: 'dragon-v3-weth-wsei',
    address: '0xE0F20947365D2fcF5Fabd14AD4415ab18191BD3a',
    token0: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  },
  {
    name: 'dragon-v3-weth-usdc',
    address: '0x1E7ADE0350e9435cEDF0A9A87a8983bBBACaBF2a',
    token0: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8',
    token1: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    fee: 500,
    tickSpacing: 10,
    enabled: true,
  },
  {
    name: 'oku-weth-wsei',
    address: '0xa3A573c8D14C93FCa8FDEcb7DB168619563D9B00',
    token0: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 500,
    tickSpacing: 10,
    enabled: true,
  },
  {
    name: 'dragon-usdc.n-wsei',
    address: '0x882f62fe8E9594470D1da0f70Bc85096F6c60423',
    token0: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  },
  {
    name: 'dragon-weth-usdc.n',
    address: '0x69E2EDD60BBCd42Fd5eD549599de249A9A34b98B',
    token0: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8',
    token1: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
    fee: 3000,
    tickSpacing: 60,
    enabled: true,
  },
  {
    name: 'dragon-usdc.n-usdc',
    address: '0x8b7bC59c92f77980d1120406a173D7C611060DA3',
    token0: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
    token1: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    fee: 100,
    tickSpacing: 1,
    enabled: true,
  },
  {
    name: 'oku-weth-usdc.n',
    address: '0x8A1a9Efb7f7F74ACe10A31F2f5f9F7E804f957b1',
    token0: '0x160345fC359604fC6e70E3c5fAcbdE5F7A9342d8',
    token1: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
    fee: 500,
    tickSpacing: 10,
    enabled: true,
  },
  {
    name: 'oku-usdc.n-usdc',
    address: '0xc53b65811e3D33AdA5a90d476dCF2063b53bcFB3',
    token0: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
    token1: '0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392',
    fee: 100,
    tickSpacing: 1,
    enabled: true,
  },
  {
    name: 'oku-usdc-wsei.n',
    address: '0x5cFA8dB453C9904511C4eA9eb0bfc903E36b9F5F',
    token0: '0x3894085Ef7Ff0f0aeDf52E2A2704928d1Ec074F1',
    token1: '0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7',
    fee: 500,
    tickSpacing: 10,
    enabled: true,
  }
];
