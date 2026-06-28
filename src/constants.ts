import dotenv from 'dotenv';
import { parseEther, parseGwei, type Address } from 'viem';

dotenv.config();

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

export const NETWORK = {
    chainId: 109,
    rpcUrl: process.env.RPC_URL,
    wsUrl: process.env.WSS_URL,
    privateKey: process.env.PRIVATE_KEY,
} as const;

export const CONTRACTS = {
    arbitrage: process.env.ARB_CONTRACT_ADDRESS,
    flashQuery: process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS,
} as const;

export const TOKENS: TokenConfig[] = [
    {
        name: 'WBONE',
        address: '0xC76F4c819D820369Fb2d7C1531aB3Bb18e6fE8d8',
        liquidityAmount: parseEther('100'),
        minProfit: parseEther('0.05'),
        decimals: 18,
    },
    {
        name: 'WWBONE',
        address: '0x839FdB6cc98342B428E074C1573ADF6D48CA3bFd',
        liquidityAmount: parseEther('100'),
        minProfit: parseEther('0.05'),
        decimals: 18,
    },
    {
        name: 'LEASH',
        address: '0x65218A41Fb92637254B4f8c97448d3dF343A3064',
        liquidityAmount: parseEther('0.2045'),
        minProfit: parseEther('0.0002045'),
        decimals: 18,
    },
    {
        name: 'DAMN',
        address: '0xeCe898EdCc0AF91430603175F945D8de75291c70',
        liquidityAmount: parseEther('5000000'),
        minProfit: parseEther('5458'),
        decimals: 18,
    },
    {
        name: 'WETH',
        address: '0x8ed7d143Ef452316Ab1123d28Ab302dC3b80d3ce',
        liquidityAmount: parseEther('0.01668'),
        minProfit: parseEther('0.00001674'),
        decimals: 18,
    },
    {
        name: 'SHIB',
        address: '0x495eea66B0f8b636D441dC6a98d8F5C3D455C4c0',
        liquidityAmount: parseEther('2500000'),
        minProfit: parseEther('2385'),
        decimals: 18,
    },
    {
        name: 'FEED',
        address: '0xe9Cb2D7ADC24Fc59FE00D6C0A0669BDF16805Fe0',
        liquidityAmount: parseEther('42000000000'),
        minProfit: parseEther('42000000'),
        decimals: 18,
    },
];

export const DEX_FACTORIES: DexFactoryConfig[] = [
    { name: 'woolfPro', address: '0x5c6C40CAe6f57b782D8Ff445258989aaC73D5074', fee: 10, volatile: false },
    { name: 'chewy', address: '0xEDedDbde5ffA62545eDF97054edC11013ED72125', fee: 25, volatile: false },
    { name: 'shiba', address: '0xc2b4218F137e3A5A9B98ab3AE804108F0D312CBC', fee: 30, volatile: false },
    { name: 'mars', address: '0xBe0223f65813C7c82E195B48F8AAaAcb304FbAe7', fee: 20, volatile: false },
    { name: 'pumk', address: '0x5640113EA7F369E6DAFbe54cBb1406E5BF153E90', fee: 20, volatile: false },
    { name: 'woof', address: '0xB9fbdFA27B7ba8BB2d4bB4aB399e4c55F0F7F83a', fee: 20, volatile: true },
];

export const V2_SEARCH_POLICY = {
    topTokens: 2,
    routeMode: 'circular',
    maxRouteEdges: 6,
    beamWidth: 10,
    optimizationIterations: 160,
    maxInputReserveFraction: 3n,
    maxOpportunities: 20,
} as const;

export const PAIR_DISCOVERY_POLICY = {
    batchSize: 200,
    woofReserveBatchSize: 5,
    maxPairAgeSeconds: 700 * 24 * 60 * 60,
    minOtherTokenLiquidity: parseEther('500'),
} as const;

export const EXECUTION_POLICY = {
    gasLimit: 500000n,
    baseFee: parseGwei('34.9'),
    legacy: true,
} as const;

export const RUNTIME = {
    debug: false,
    websocketEnabled: false,
} as const;

export const TELEGRAM = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
} as const;
