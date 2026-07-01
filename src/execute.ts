import TelegramBot from 'node-telegram-bot-api';
import { type Address } from 'viem';
import {
    CONTRACTS,
    EXECUTION_POLICY,
    RUNTIME,
    TELEGRAM,
    TOKENS,
} from './constants';
import ArbABI from './ABI/Arb.json';
import {
    type ExecutableOpportunity,
    ExecutionPlanner,
    type FlashLoanPairLookup,
} from './execution/execution-planner';
import { type NetworkConfig } from './network';
import { formatTokenAmountWithSymbol } from './values';

class NonceTracker {
    private currentNonce: number | null = null;

    constructor(private readonly networkConfig: NetworkConfig) {}

    async next(): Promise<number> {
        if (this.currentNonce === null) {
            this.currentNonce = Number(await this.networkConfig.client.getTransactionCount({
                address: this.networkConfig.account.address,
            }));

            if (RUNTIME.debug) {
                console.log(`Initialized nonce tracker with nonce: ${this.currentNonce}`);
            }
        }

        const nonce = this.currentNonce;
        this.currentNonce++;
        return nonce;
    }
}

class TransactionNotifier {
    private bot: TelegramBot | null = TELEGRAM.botToken
        ? new TelegramBot(TELEGRAM.botToken, { polling: false })
        : null;

    async transactionSent(
        hash: string,
        type: 'flashswap' | 'direct',
        expectedProfit: bigint,
        tokenAddress?: Address
    ): Promise<void> {
        if (!this.bot || !TELEGRAM.chatId) return;

        const token = this.resolveToken(tokenAddress);
        const status = expectedProfit > 0n ? 'PROFIT' : 'WARNING';
        const message =
            `<b>${status}: Arbitrage Transaction</b>\n\n` +
            `<b>Type:</b> ${type === 'flashswap' ? 'Flash Swap' : 'Direct Swap'}\n` +
            `<b>Expected Profit:</b> ${formatTokenAmountWithSymbol(expectedProfit, token)}\n\n` +
            `<b>Transaction:</b>\n` +
            `<code>${hash}</code>\n\n` +
            `<a href="https://www.shibariumscan.io/tx/${hash}">View on Explorer</a>`;

        try {
            await this.bot.sendMessage(TELEGRAM.chatId, message, {
                parse_mode: 'HTML',
                disable_web_page_preview: true,
            });
        } catch (error) {
            console.error('Failed to send Telegram notification:', error);
        }
    }

    private resolveToken(tokenAddress?: Address): Pick<(typeof TOKENS)[number], 'name' | 'decimals'> {
        if (!tokenAddress) return TOKENS[0] || { name: 'Unknown', decimals: 18 };

        const token = TOKENS.find(addr => addr.address.toLowerCase() === tokenAddress.toLowerCase());
        return token || { name: 'Unknown', decimals: 18 };
    }
}

// Keeps track of executed pairs to avoid conflicts
export class OpportunityManager {
    private usedPairs: Set<string> = new Set();
    private nonceTracker: NonceTracker;
    private notifier = new TransactionNotifier();
    private planner = new ExecutionPlanner();

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
        opportunities: ExecutableOpportunity[]
    ): Promise<void> {
        // Sort opportunities by expected profit (descending)
        const sortedOpps = [...opportunities].sort((a, b) => {
            if (b.expectedProfit > a.expectedProfit) return 1;
            if (b.expectedProfit < a.expectedProfit) return -1;
            return 0;
        });

        if (RUNTIME.debug) {
            console.log(`Processing ${sortedOpps.length} opportunities in profit order`);
        }

        for (const opp of sortedOpps) {
            // Skip if any pairs conflict
            if (this.hasConflict(opp.pairs)) {
                if (RUNTIME.debug) {
                    console.log('Skipping opportunity due to pair conflict:', {
                        pairs: opp.pairs,
                        usedPairs: Array.from(this.usedPairs)
                    });
                }
                continue;
            }
            try {
                // Execute the opportunity
                const executed = await this.executeArbitrageOpportunity(graph, opp);
                if (!executed) continue;

                // Mark pairs as used only after successful execution
                this.markPairsAsUsed(opp.pairs);
                if (RUNTIME.debug) {
                    console.log('Successfully executed opportunity:', {
                        profit: opp.expectedProfit.toString(),
                        pairs: opp.pairs
                    });
                }
            } catch (error) {
                if (RUNTIME.debug) {
                    console.error('Failed to execute opportunity:', error);
                }
            }
        }
        
        // Clear used pairs after processing batch
        this.usedPairs.clear();
    }

    private async executeArbitrageOpportunity(
        graph: FlashLoanPairLookup,
        opportunity: ExecutableOpportunity
    ): Promise<boolean> {
        if (!CONTRACTS.arbitrage || !CONTRACTS.arbitrage.match(/^0x[a-fA-F0-9]{40}$/)) {
            throw new Error('Invalid CONTRACTS.arbitrage address');
        }

        const plan = this.planner.createPlan(graph, opportunity);
        if (!plan) {
            if (RUNTIME.debug) {
                console.log('Skipping opportunity without executable plan:', {
                    routeKind: opportunity.routeKind,
                    path: opportunity.path,
                    pairs: opportunity.pairs,
                    protocols: opportunity.protocols,
                });
            }
            return false;
        }

        if (RUNTIME.debug) {
            console.log('Executing arbitrage:', {
                params: {
                    ...plan.params,
                    borrowAmount: plan.params.borrowAmount.toString(),
                    v2RepayFee: plan.params.v2RepayFee.toString(),
                    fees: plan.params.fees.map(fee => fee.toString()),
                },
                expectedProfit: opportunity.expectedProfit.toString()
            });
        }

        const nonce = await this.nonceTracker.next();

        // Calculate dynamic gas fees based on opportunity's expected profit
        const { maxFeePerGas, maxPriorityFeePerGas } = this.calculateGasFees(opportunity.expectedProfit);

        // Send transaction directly with gas parameters
        const hash = await this.networkConfig.walletClient.writeContract({
            address: CONTRACTS.arbitrage as Address,
            abi: ArbABI,
            functionName: 'executeArbitrage',
            args: [plan.params],
            chain: this.networkConfig.walletClient.chain,
            account: this.networkConfig.account,
            nonce,
            gas: EXECUTION_POLICY.gasLimit,
            ...(EXECUTION_POLICY.legacy
                ? { gasPrice: EXECUTION_POLICY.baseFee, type: 'legacy' as const }
                : { maxFeePerGas, maxPriorityFeePerGas, type: 'eip1559' as const }),
        });
        
        if (RUNTIME.debug) {
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

        return true;
    }

    // Helper function to calculate dynamic gas fees based on expected profit
    public calculateGasFees(expectedProfit: bigint): { maxFeePerGas: bigint, maxPriorityFeePerGas: bigint } {
        // Use 90% of expected profit as total gas fee budget
        const totalGasFee = (expectedProfit * 90n) / 100n;
        
        // Calculate maxFeePerGas with (totalGasFee * 1_000_000_000) / gasLimit
        const maxFeePerGas = (totalGasFee * 1n) /  EXECUTION_POLICY.gasLimit;
        
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

