import dotenv from "dotenv";
import { parseEther, parseGwei, parseUnits } from "viem";
dotenv.config();

export const CHAIN_ID = 25;

export const RPC_URL = process.env.RPC_URL;
export const WSS_URL = process.env.WSS_URL;

export const PRIVATE_KEY = process.env.PRIVATE_KEY;

export const ARB_CONTRACT = process.env.ARB_CONTRACT_ADDRESS;

export const UNISWAP_FLASH_QUERY_CONTRACT =
    process.env.UNISWAP_FLASH_QUERY_CONTRACT_ADDRESS;

/**
 * List of tokens used for arbitrage operations
 * 
 * IMPORTANT: The order of this array is significant:
 * - The first TOP_TOKENS_FOR_ARBITRAGE tokens will be used as starting points for arbitrage
 * - Each token that is used for arbitrage must have a corresponding entry in the minProfits array
 * - For example, if TOP_TOKENS_FOR_ARBITRAGE = 3, then the first 3 tokens (WCRO, USDC, USDT) will be used
 * 
 * Each token object contains:
 * - name: A human-readable name for the token
 * - address: The token's contract address
 * - LPAMOUNT: The amount to use when calculating liquidity
 */
export const ADDRESSES: { name: string; address: `0x${string}`; LPAMOUNT: string }[] = [
    { name: "WCRO", address: "0x5C7F8A570d578ED84E63fdFA7b1eE72dEae1AE23" as `0x${string}`, LPAMOUNT: parseEther("1200").toString() },
    { name: "USDC", address: "0xc21223249CA28397B4B6541dfFaEcC539BfF0c59" as `0x${string}`, LPAMOUNT: parseUnits("100", 6).toString() },
    { name: "USDT", address: "0x66e428c3f67a68878562e79A0234c1F83c208770" as `0x${string}`, LPAMOUNT: parseUnits("100", 6).toString() }, //shib
    { name: "WBTC", address: "0x062E66477Faf219F25D27dCED647BF57C3107d52" as `0x${string}`, LPAMOUNT: parseUnits("100", 8).toString()}, // weth
    { name: "WETH", address: "0xe44Fd7fCb2b1581822D0c862B68222998a0c299a" as `0x${string}`, LPAMOUNT: parseEther("0.05").toString() }, //damn
    { name: "USC", address: "0xD42E078ceA2bE8D03cd9dFEcC1f0d28915Edea78" as `0x${string}`, LPAMOUNT: parseEther("100").toString() },
    { name: "CDCBTC", address: "0x2e53c5586e12a99d4CAE366E9Fc5C14fE9c6495d" as `0x${string}`, LPAMOUNT: parseUnits("100", 8).toString() },
    { name: "CDCETH", address: "0x7a7c9db510aB29A2FC362a4c34260BEcB5cE3446" as `0x${string}`, LPAMOUNT: parseEther("0.05").toString() },
    { name: "BCRO", address: "0xeBAceB7F193955b946cC5dd8f8724a80671a1F2F" as `0x${string}`, LPAMOUNT: parseEther("1200").toString() },
    { name: "VVS", address: "0x2D03bECE6747ADC00E1a131BBA1469C15fD11e03" as `0x${string}`, LPAMOUNT: parseEther("48100000").toString() },
    { name: "LION", address: "0x9D8c68F185A04314DDC8B8216732455e8dbb7E45" as `0x${string}`, LPAMOUNT: parseEther("11000").toString() },
    { name: "XRP", address: "0xb9Ce0dd29C91E02d4620F57a66700Fc5e41d6D15" as `0x${string}`, LPAMOUNT: parseUnits("42", 6).toString() },
    { name: "LCRO", address: "0x9Fae23A2700FEeCd5b93e43fDBc03c76AA7C08A6" as `0x${string}`, LPAMOUNT: parseEther("1100").toString() },
    { name: "CROID", address: "0xCbF0ADeA24fd5f32c6e7f0474f0d1b94Ace4E2e7" as `0x${string}`, LPAMOUNT: parseEther("2800").toString() },
    { name: "AGENTAI", address: "0x96733708C4157218B6E6889eb9E16B1df7873061" as `0x${string}`, LPAMOUNT: parseEther("54").toString() },
    { name: "CROB", address: "0x63eD0a82cAC237667C89Cd6AC5BFa2317186FdAa" as `0x${string}`, LPAMOUNT: parseEther("7000").toString() },
    { name: "DAI", address: "0xF2001B145b43032AAF5Ee2884e456CCd805F677D" as `0x${string}`, LPAMOUNT: parseEther("100").toString() },
];
        
/**
 * DEX factory addresses and configuration
 * 
 * This array defines the DEX factories that the arbitrage bot will monitor.
 * Each factory represents a different exchange on the blockchain.
 * 
 * Each factory object contains:
 * - name: The name of the DEX (e.g., "VVS", "MMF")
 * - address: The factory contract address
 * - fee: The trading fee in basis points (e.g., 30 = 0.3%)
 * - volatile: Flag to indicate if this is a volatile DEX (if true, stable pairs will be excluded)
 * 
 * The bot will search for arbitrage opportunities across all these exchanges.
 */
export const FACTORY: { name: string; address: `0x${string}`; fee: number; volatile: boolean }[] = [
    { name: "VVS", address: "0x3B44B2a187a7b3824131F8db5a74194D0a42Fc15" as `0x${string}`, fee: 30, volatile: false },
    { name: "MMF", address: "0xd590cC180601AEcD6eeADD9B7f2B7611519544f4" as `0x${string}`, fee: 17, volatile: false }, //swapfee
    { name: "Ebisu", address: "0x5f1D751F447236f486F4268b883782897A902379" as `0x${string}`, fee: 15, volatile: false }, // swap fee
    { name: "Crona", address: "0x73A48f8f521EB31c55c0e1274dB0898dE599Cb11" as `0x${string}`, fee: 25, volatile: false },
    { name: "Candy", address: "0x84343b84EEd78228CCFB65EAdEe7659F246023bf" as `0x${string}`, fee: 15, volatile: false },
    { name: "Crodex", address: "0xe9c29cB475C0ADe80bE0319B74AD112F1e80058F" as `0x${string}`, fee: 30, volatile: false },
    { name: "Photon", address: "0x462C98Cae5AffEED576c98A55dAA922604e2D875" as `0x${string}`, fee: 30, volatile: false },
    { name: "Duckfi", address: "0x796E38Bb00f39a3D39ab75297D8d6202505f52e2" as `0x${string}`, fee: 30, volatile: false },
    { name: "Obsidian", address: "0xCd2E5cC83681d62BEb066Ad0a2ec94Bf301570C9" as `0x${string}`, fee: 30, volatile: false },
    { name: "Cougar", address: "0x1CE8f3c99835eA3AaA888Df682d33F7E6eA0B3F4" as `0x${string}`, fee: 20, volatile: false },
    { name: "Cyborg", address: "0x6C50Ee65CFcfC59B09C570e55D76daa7c67D6da5" as `0x${string}`, fee: 20, volatile: false },
    { name: "Anne", address: "0xFb6FE7d66E55831b7e108B77D11b8e4d479c2986" as `0x${string}`, fee: 20, volatile: false },
];

/**
 * Token-specific minimum profit thresholds
 * 
 * IMPORTANT: This array MUST be equal to TOP_TOKENS_FOR_ARBITRAGE elements.
 * Each element corresponds to a token in the ADDRESSES array in the same order.
 * 
 * For example:
 * - minProfits[0] is the min profit for ADDRESSES[0] (WCRO)
 * - minProfits[1] is the min profit for ADDRESSES[1] (USDC)
 * - etc.
 * 
 * The system will throw an error if it tries to use a token that doesn't have
 * a corresponding minimum profit threshold defined here.
 */
export const minProfits = [
    parseEther("3"),      // WCRO (18 decimals) - corresponds to ADDRESSES[0]
    parseUnits("0.3", 6),     // USDC (6 decimals) - corresponds to ADDRESSES[1]
    parseUnits("0.3", 6),     // USDT (6 decimals) - corresponds to ADDRESSES[2]
    // Add more thresholds if TOP_TOKENS_FOR_ARBITRAGE is increased
];

// Legacy minProfit for backward compatibility - findArbitrageOpportunities
export const minProfit = parseEther("3");
export const maxIterations = 100;
export const maxHops = 3;
export const MAX_ENTRIES_PER_TOKEN = 10;

/**
 * Number of top tokens to consider for arbitrage
 * IMPORTANT: This value must not exceed the length of the minProfits array.
 * If you increase this number, make sure to add corresponding entries to the minProfits array.
 * NOTE - the more token you add - it increase the speed +100ms when searching(e.g if 3 means 300ms total)
 */
export const TOP_TOKENS_FOR_ARBITRAGE = 3;

export const DEBUG = true;
export const WSS_ENABLED = true; //enable this only when you are on a chain with wss support or better wss
export const NERK = false;


export const BATCH_SIZE = 200;

// Gas fee settings (in Gwei)
export const GAS_LIMIT = 500000n;
export const BASE_FEE = parseGwei("3750");

// Telegram notification settings
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';