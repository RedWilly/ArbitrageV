import dotenv from "dotenv";
import { parseEther, parseGwei, parseUnits } from "viem";
dotenv.config();

export const CHAIN_ID = 1313161554;

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
 * - decimal: The number of decimals for the token
 */
export const ADDRESSES: { name: string; address: `0x${string}`; LPAMOUNT: string; decimal: number }[] = [
    { name: "WCHLIZ", address: "0x677F7e16C7Dd57be1D4C8aD1244883214953DC47" as `0x${string}`, LPAMOUNT: parseEther("2461").toString(), decimal: 18 },
    { name: "WCHILIZ-2", address: "0x721EF6871f1c4Efe730Dce047D40D1743B886946" as `0x${string}`, LPAMOUNT: parseEther("2461").toString(), decimal: 18 },
    { name: "PEPPER", address: "0x60f397acbcfb8f4e3234c659a3e10867e6fa6b67" as `0x${string}`, LPAMOUNT: parseEther("80000000000").toString(), decimal: 18 },
    { name: "KAYEN", address: "0x8c0b6ea89daba6516df9437a60ca481501781606" as `0x${string}`, LPAMOUNT: parseEther("4200").toString(), decimal: 18 },
    // { name: "USDTE", address: "0x4988a896b1227218e4A686fdE5EabdcAbd91571f" as `0x${string}`, LPAMOUNT: parseUnits("90", 6).toString(), decimal: 6 },
    // { name: "USDC.e", address: "0xB12BFcA5A55806AaF64E99521918A4bf0fC40802" as `0x${string}`, LPAMOUNT: parseUnits("90", 6).toString(), decimal: 6 }, // weth
    // { name: "USTC", address: "0x5ce9F0B6AFb36135b5ddBF11705cEB65E634A9dC" as `0x${string}`, LPAMOUNT: parseEther("90").toString(), decimal: 18 }, //damn
    // { name: "CDCETH", address: "0x7a7c9db510aB29A2FC362a4c34260BEcB5cE3446" as `0x${string}`, LPAMOUNT: parseEther("0.05").toString() },
    // { name: "BCRO", address: "0xeBAceB7F193955b946cC5dd8f8724a80671a1F2F" as `0x${string}`, LPAMOUNT: parseEther("1200").toString() },
    // { name: "VVS", address: "0x2D03bECE6747ADC00E1a131BBA1469C15fD11e03" as `0x${string}`, LPAMOUNT: parseEther("48100000").toString() },
    // { name: "LION", address: "0x9D8c68F185A04314DDC8B8216732455e8dbb7E45" as `0x${string}`, LPAMOUNT: parseEther("11000").toString() },
    // { name: "XRP", address: "0xb9Ce0dd29C91E02d4620F57a66700Fc5e41d6D15" as `0x${string}`, LPAMOUNT: parseUnits("42", 6).toString() },
    // { name: "LCRO", address: "0x9Fae23A2700FEeCd5b93e43fDBc03c76AA7C08A6" as `0x${string}`, LPAMOUNT: parseEther("1100").toString() },
    // { name: "CROID", address: "0xCbF0ADeA24fd5f32c6e7f0474f0d1b94Ace4E2e7" as `0x${string}`, LPAMOUNT: parseEther("2800").toString() },
    // { name: "AGENTAI", address: "0x96733708C4157218B6E6889eb9E16B1df7873061" as `0x${string}`, LPAMOUNT: parseEther("54").toString() },
    // { name: "CROB", address: "0x63eD0a82cAC237667C89Cd6AC5BFa2317186FdAa" as `0x${string}`, LPAMOUNT: parseEther("7000").toString() },
    // { name: "DAI", address: "0xF2001B145b43032AAF5Ee2884e456CCd805F677D" as `0x${string}`, LPAMOUNT: parseEther("100").toString() },
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
    { name: "KEYAN", address: "0xE2918AA38088878546c1A18F2F9b1BC83297fdD3" as `0x${string}`, fee: 30, volatile: false },
    { name: "KEWL", address: "0xA0BB8f9865f732C277d0C162249A4F6c157ae9D0" as `0x${string}`, fee: 30, volatile: false },
    { name: "CLIZSWAP", address: "0xcF4A2be8Fe92fEe8e350AD8D876274749Ae0CBb1" as `0x${string}`, fee: 30, volatile: false },
    { name: "DSWAP", address: "0xBDd9c322Ecf401E09C9D2Dca3be46a7E45d48BB1" as `0x${string}`, fee: 30, volatile: false },
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
    parseEther("2.5"),     
    parseEther("2.5"),     
    parseEther("99000000"),  
    parseEther("4.5"),
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
export const TOP_TOKENS_FOR_ARBITRAGE = 2;

export const DEBUG = true;
export const WSS_ENABLED = false; //enable this only when you are on a chain with wss support or better wss
export const NERK = false;


export const BATCH_SIZE = 200;

// Gas fee settings (in Gwei)
export const GAS_LIMIT = 500000n;
export const BASE_FEE = parseGwei("552");
export const LEGACY = true;

// Telegram notification settings
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';