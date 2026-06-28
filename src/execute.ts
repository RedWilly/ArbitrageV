import TelegramBot from 'node-telegram-bot-api';
import { formatEther, type Address, formatUnits } from 'viem';
import {
    ADDRESSES,
    ARB_CONTRACT,
    BASE_FEE,
    DEBUG,
    GAS_LIMIT,
    LEGACY,
    TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID,
} from './constants';
import ArbABI from './ABI/Arb.json';
import { type NetworkConfig } from './network';

interface ArbitrageOpportunity {
    path: Address[];
    pairs: Address[];
    fees: number[];
    optimalAmount: bigint;
    expectedProfit: bigint;
}

type FlashLoanPairLookup = {
    findBestPairForToken(
        token: Address,
        amountIn: bigint,
        excludePairs?: Address[]
    ): { pairAddress: Address; fee: number } | null;
};

class NonceTracker {
    private currentNonce: number | null = null;

    constructor(private readonly networkConfig: NetworkConfig) {}

    async next(): Promise<number> {
        if (this.currentNonce === null) {
            this.currentNonce = Number(await this.networkConfig.client.getTransactionCount({
                address: this.networkConfig.account.address,
            }));

            if (DEBUG) {
                console.log(`Initialized nonce tracker with nonce: ${this.currentNonce}`);
            }
        }

        const nonce = this.currentNonce;
        this.currentNonce++;
        return nonce;
    }
}

class TransactionNotifier {
    private bot: TelegramBot | null = TELEGRAM_BOT_TOKEN
        ? new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false })
        : null;

    async transactionSent(
        hash: string,
        type: 'flashswap' | 'direct',
        expectedProfit: bigint,
        tokenAddress?: Address
    ): Promise<void> {
        if (!this.bot || !TELEGRAM_CHAT_ID) return;

        const tokenName = this.resolveTokenName(tokenAddress);
        const status = expectedProfit > 0n ? 'PROFIT' : 'WARNING';
        const message =
            `<b>${status}: Arbitrage Transaction</b>\n\n` +
            `<b>Type:</b> ${type === 'flashswap' ? 'Flash Swap' : 'Direct Swap'}\n` +
            `<b>Expected Profit:</b> ${formatEther(expectedProfit)} ${tokenName}\n\n` +
            `<b>Transaction:</b>\n` +
            `<code>${hash}</code>\n\n` +
            `<a href="https://www.shibariumscan.io/tx/${hash}">View on Explorer</a>`;

        try {
            await this.bot.sendMessage(TELEGRAM_CHAT_ID, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        } catch (error) {
            console.error('Failed to send Telegram notification:', error);
        }
    }

    private resolveTokenName(tokenAddress?: Address): string {
        if (!tokenAddress) return ADDRESSES[0]?.name || 'Unknown';

        const token = ADDRESSES.find(addr => addr.address.toLowerCase() === tokenAddress.toLowerCase());
        return token?.name || 'Unknown';
    }
}

// Keeps track of executed pairs to avoid conflicts
export class OpportunityManager {
    private usedPairs: Set<string> = new Set();
    private nonceTracker: NonceTracker;
    private notifier = new TransactionNotifier();

    constructor(private readonly networkConfig: NetworkConfig) {
        this.nonceTracker = new NonceTracker(networkConfig);
    }

    // Check if an opportunity conflicts with already executed pairs
    private hasConflict(pairs: Address[]): boolean {
        return pairs.some(pair => this.usedPairs.has(pair.toLowerCase()));
    }
    // Mark pairs as used after execution
    private markPairsAsUsed(pairs: Address[]): void {
        pairs.forEach(pair => this.usedPairs.add(pair.toLowerCase()));
    }

    // Process and execute a batch of opportunities
    async processOpportunities(
        graph: FlashLoanPairLookup,
        opportunities: ArbitrageOpportunity[]
    ): Promise<void> {
        // Sort opportunities by expected profit (descending)
        const sortedOpps = [...opportunities].sort((a, b) => {
            if (b.expectedProfit > a.expectedProfit) return 1;
            if (b.expectedProfit < a.expectedProfit) return -1;
            return 0;
        });

        if (DEBUG) {
            console.log(`Processing ${sortedOpps.length} opportunities in profit order`);
        }

        for (const opp of sortedOpps) {
            // Skip if any pairs conflict
            if (this.hasConflict(opp.pairs)) {
                if (DEBUG) {
                    console.log('Skipping opportunity due to pair conflict:', {
                        pairs: opp.pairs,
                        usedPairs: Array.from(this.usedPairs)
                    });
                }
                continue;
            }
            try {
                // Execute the opportunity
                await this.executeArbitrageOpportunity(graph, opp);

                // Mark pairs as used only after successful execution
                this.markPairsAsUsed(opp.pairs);
                if (DEBUG) {
                    console.log('Successfully executed opportunity:', {
                        profit: formatUnits(opp.expectedProfit, 18),
                        pairs: opp.pairs
                    });
                }
            } catch (error) {
                if (DEBUG) {
                    console.error('Failed to execute opportunity:', error);
                }
            }
        }
        
        // Clear used pairs after processing batch
        this.usedPairs.clear();
    }

    private async executeArbitrageOpportunity(
        graph: FlashLoanPairLookup,
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        const startToken = opportunity.path[0];
        const endToken = opportunity.path[opportunity.path.length - 1];
        const isCircular = startToken.toLowerCase() === endToken.toLowerCase();

        if (isCircular) {
            await this.executeWithFlashswap(graph, opportunity);
        } else {
            await this.executeDirectly(opportunity);
        }
    }

    private async executeWithFlashswap(
        graph: FlashLoanPairLookup,
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        if (!ARB_CONTRACT || !ARB_CONTRACT.match(/^0x[a-fA-F0-9]{40}$/)) {
            throw new Error('Invalid ARB_CONTRACT address');
        }

        const startToken = opportunity.path[0];

        // Find the best pair for flashswap
        const flashLoanPair = graph.findBestPairForToken(
            startToken,
            opportunity.optimalAmount,
            opportunity.pairs
        );

        if (!flashLoanPair) {
            throw new Error(`No suitable flashswap pair found for token ${startToken}`);
        }

        if (DEBUG) {
            console.log('Executing arbitrage with flashswap:', {
                flashLoanPair: flashLoanPair.pairAddress,
                startToken,
                borrowAmount: opportunity.optimalAmount.toString(),
                pairs: opportunity.pairs,
                fees: opportunity.fees,
                repayFee: flashLoanPair.fee,
                expectedProfit: formatUnits(opportunity.expectedProfit, 18)
            });
        }

        const nonce = await this.nonceTracker.next();

        // Calculate dynamic gas fees based on opportunity's expected profit
        const { maxFeePerGas, maxPriorityFeePerGas } = this.calculateGasFees(opportunity.expectedProfit);

        // Send transaction directly with gas parameters
        const hash = await this.networkConfig.walletClient.writeContract({
            address: ARB_CONTRACT as Address,
            abi: ArbABI,
            functionName: 'executeArbitrage',
            args: [
                flashLoanPair.pairAddress,    // flashLoanPair
                startToken,                   // startToken
                opportunity.optimalAmount,    // borrowAmount
                opportunity.pairs,            // arbPairs
                opportunity.fees,             // arbFees
                flashLoanPair.fee             // repayFee
            ],
            chain: this.networkConfig.walletClient.chain,
            account: this.networkConfig.account,
            nonce,
            gas: GAS_LIMIT,
            ...(LEGACY
                ? { gasPrice: BASE_FEE, type: 'legacy' as const }
                : { maxFeePerGas, maxPriorityFeePerGas, type: 'eip1559' as const }),
        });
        
        if (DEBUG) {
            console.log('Transaction sent:', {
                hash,
                nonce,
                type: 'flashswap',
            });
        }

        await this.notifier.transactionSent(
            hash,
            'flashswap',
            opportunity.expectedProfit,
            opportunity.path[opportunity.path.length - 1]
        );
    }

    private async executeDirectly(
        opportunity: ArbitrageOpportunity
    ): Promise<void> {
        if (DEBUG) {
            console.log('Executing arbitrage directly:', {
                startToken: opportunity.path[0],
                startAmount: opportunity.optimalAmount.toString(),
                pairs: opportunity.pairs,
                fees: opportunity.fees,
                expectedProfit: formatUnits(opportunity.expectedProfit, 18)
            });
        }

        const nonce = await this.nonceTracker.next();

        // Calculate dynamic gas fees based on opportunity's expected profit
        const { maxFeePerGas, maxPriorityFeePerGas } = this.calculateGasFees(opportunity.expectedProfit);

        // Send transaction directly with gas parameters
        const hash = await this.networkConfig.walletClient.writeContract({
            address: ARB_CONTRACT as Address,
            abi: ArbABI,
            functionName: 'executeArbitrageDirect',
            args: [
                opportunity.path[0],          // startToken
                opportunity.optimalAmount,    // startAmount
                opportunity.pairs,            // arbPairs
                opportunity.fees              // arbFees
            ],
            chain: this.networkConfig.walletClient.chain,
            account: this.networkConfig.account,
            nonce,
            gas: GAS_LIMIT,
            ...(LEGACY
                ? { gasPrice: BASE_FEE, type: 'legacy' as const }
                : { maxFeePerGas, maxPriorityFeePerGas, type: 'eip1559' as const }),
        });

        if (DEBUG) {
            console.log('Transaction sent:', {
                hash,
                nonce,
                type: 'direct',
            });
        }

        await this.notifier.transactionSent(
            hash,
            'direct',
            opportunity.expectedProfit,
            opportunity.path[opportunity.path.length - 1]
        );
    }

    // Helper function to calculate dynamic gas fees based on expected profit
    public calculateGasFees(expectedProfit: bigint): { maxFeePerGas: bigint, maxPriorityFeePerGas: bigint } {
        // Use 90% of expected profit as total gas fee budget
        const totalGasFee = (expectedProfit * 90n) / 100n;
        
        // Calculate maxFeePerGas with (totalGasFee * 1_000_000_000) / gasLimit
        const maxFeePerGas = (totalGasFee * 1n) /  GAS_LIMIT;
        
        // // Use same value for maxPriorityFeePerGas as maxFeePerGas
        const maxPriorityFeePerGas = maxFeePerGas;
        
        return {
            maxFeePerGas,
            maxPriorityFeePerGas
        };
    }
}

// Create and export the opportunity manager factory
export function createOpportunityManager(networkConfig: NetworkConfig): OpportunityManager {
    return new OpportunityManager(networkConfig);
}
