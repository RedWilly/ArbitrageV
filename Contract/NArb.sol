// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/console.sol"; // Logging library for testing
import "./interfaces/Withdrawable.sol";


/// @notice Minimal interface for a UniswapV2 pair.
interface IUniswapV2Pair {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function swap(
        uint amount0Out,
        uint amount1Out,
        address to,
        bytes calldata data
    ) external;
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
}

/// @dev Custom Errors
error ArrayLengthMismatch();
error TokenTransferFromFailed();
error FinalTokenTransferFailed();
error ArbitrageLoss();
error StartTokenNotInFlashLoanPair();
error ArbitrageMustReturnToStart();
error RepaymentTransferFailed();
error ProfitTransferFailed();
error InsufficientFlashLoanRepayment();
error SwapPathError();
error InvalidReserves();
error OutputExceedsReserve();
error TokenTransferFailed();
error InsufficientContractBalance();

/// @title Arbitrage Executor
/// @notice Executes an arbitrage using a flash loan and a path of swaps.
contract ArbitrageExecutor is Withdrawable {
    uint256 private constant FEE_DENOMINATOR = 10000;

    constructor(address owner_) Withdrawable(owner_) {}

    struct FlashLoanData {
        address[] pairs;
        uint256[] fees;
        uint256 repayFee;
        address originator;
        address borrowedToken;
    }

    struct SwapState {
        address token;
        uint256 amount;
    }

    /// @notice Executes arbitrage using user-supplied funds (no flash loan).
    /// Unlike the flash loan version, the arbitrage path need not return to the start token.
    /// @param startToken The token to start arbitrage with.
    /// @param startAmount The amount of startToken provided by the user.
    /// @param arbPairs The addresses of the arbitrage pairs to swap through.
    /// @param arbFees The fee in basis points for each arbitrage pair.
    function executeArbitrageDirect(
        address startToken,
        uint256 startAmount,
        address[] calldata arbPairs,
        uint256[] calldata arbFees
    ) external returns (address, uint256) {
        console.log("\n=== Starting Direct Arbitrage ===");
        console.log("Start Token:", startToken);
        console.log("Start Amount:", startAmount);
        console.log("Number of arb pairs:", arbPairs.length);

        if (arbPairs.length != arbFees.length) revert ArrayLengthMismatch();

        // Pull the startToken from the contract's wallet.        
        if (IERC20(startToken).balanceOf(address(this)) < startAmount)
            revert InsufficientContractBalance();

        // Execute the arbitrage path.
        (address finalToken, uint256 finalAmount) = _executeArbitragePathDirect(startToken, startAmount, arbPairs, arbFees);
        console.log("Final Token after arbitrage:", finalToken);
        console.log("Final Amount after arbitrage:", finalAmount);

        if (finalAmount < startAmount) revert ArbitrageLoss();

        // The tokens remain in the contract; no transfer back to msg.sender.
        console.log("Direct arbitrage completed. Profit retained in contract.");

        return (finalToken, finalAmount);
    }

    /// @notice Initiates the flash loan arbitrage.
    function executeArbitrage(
        address flashLoanPair,
        address startToken,
        uint256 borrowAmount,
        address[] calldata arbPairs,
        uint256[] calldata arbFees,
        uint256 repayFee
    ) external {
        console.log("\n=== Starting Flash Loan Arbitrage ===");
        console.log("Flash Loan Pair:", flashLoanPair);
        console.log("Start Token:", startToken);
        console.log("Borrow Amount:", borrowAmount);
        console.log("Repay Fee (bps):", repayFee);
        console.log("Number of arb pairs:", arbPairs.length);

        if (arbPairs.length != arbFees.length) revert ArrayLengthMismatch();

        IUniswapV2Pair pair = IUniswapV2Pair(flashLoanPair);
        address token0 = pair.token0();
        address token1 = pair.token1();
        if (startToken != token0 && startToken != token1) revert StartTokenNotInFlashLoanPair();


        uint256 amount0Out = startToken == token0 ? borrowAmount : 0;
        uint256 amount1Out = startToken == token1 ? borrowAmount : 0;

        bytes memory data = abi.encode(
            FlashLoanData({
                pairs: arbPairs,
                fees: arbFees,
                repayFee: repayFee,
                originator: msg.sender,
                borrowedToken: startToken
            })
        );

        console.log("Initiating flash loan swap...");
        pair.swap(amount0Out, amount1Out, address(this), data);
    }

    // --- Callback Handlers ---
    function uniswapV2Call(address sender, uint amount0, uint amount1, bytes calldata data) external {
        console.log("uniswapV2Call received");
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function chewyCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        console.log("chewyCall received");
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function hook(address sender, uint amount0, uint amount1, bytes calldata data) external {
        console.log("hook call received");
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function miniMeCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        console.log("miniMeCall received");
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function netswapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        console.log("netswapCall received");
        _handleFlashLoan(sender, amount0, amount1, data);
    }

    /// @dev Handles the flash loan callback.
    function _handleFlashLoan(
        address sender,
        uint amount0,
        uint amount1,
        bytes calldata data
    ) internal {
        console.log("\n=== Handling Flash Loan Callback ===");
        console.log("Sender:", sender);
        console.log("Amount0:", amount0);
        console.log("Amount1:", amount1);

        FlashLoanData memory loanData = abi.decode(data, (FlashLoanData));
        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;
        console.log("Borrowed Token:", loanData.borrowedToken);
        console.log("Borrowed Amount:", borrowedAmount);
        console.log("Repay Fee (bps):", loanData.repayFee);

        uint256 finalAmount = _executeArbitragePath(loanData.borrowedToken, borrowedAmount, loanData.pairs, loanData.fees);

        uint256 feeAmount = (( borrowedAmount * loanData.repayFee ) / (FEE_DENOMINATOR - loanData.repayFee)) + 1;
        uint256 repayAmount = borrowedAmount + feeAmount;
        console.log("Final Amount after arbitrage:", finalAmount);
        console.log("Calculated Repay Amount:", repayAmount);

        if (finalAmount < repayAmount) revert InsufficientFlashLoanRepayment();
        if (!IERC20(loanData.borrowedToken).transfer(msg.sender, repayAmount))
            revert RepaymentTransferFailed();
        console.log("Flash loan repaid.");

        uint256 profit = finalAmount - repayAmount;
        // Instead of transferring profit, we simply log it so that it remains in the contract.
        if (profit > 0) {
            console.log("Profit retained in contract:", profit);
        } else {
            console.log("No profit generated.");
        }
    }

    /// @dev Executes the arbitrage path by looping through swap steps.
    function _executeArbitragePath(
        address startToken,
        uint256 startAmount,
        address[] memory pairs,
        uint256[] memory fees
    ) internal returns (uint256) {
        console.log("\n=== Executing Arbitrage Path ===");
        console.log("Start Token:", startToken);
        console.log("Start Amount:", startAmount);

        SwapState memory state = SwapState({
            token: startToken,
            amount: startAmount
        });

        for (uint256 i = 0; i < pairs.length; ) {
            console.log("\n--- Swap Step %s ---", i + 1);
            console.log("Pair:", pairs[i]);
            console.log("Fee (bps):", fees[i]);
            console.log("Current token:", state.token);
            console.log("Amount In before swap:", state.amount);

            (state.token, state.amount) = _executeSwapStep(state.token, state.amount, pairs[i], fees[i]);
            unchecked { i++; }
        }
        if (state.token != startToken) revert ArbitrageMustReturnToStart();
        return state.amount;
    }

    /// @dev Executes the arbitrage path for direct (user-supplied) funds.
    /// Unlike the flashloan version, the final token need not equal the start token.
    /// Returns the final token and amount.
    function _executeArbitragePathDirect(
        address startToken,
        uint256 startAmount,
        address[] memory pairs,
        uint256[] memory fees
    ) internal returns (address finalToken, uint256 finalAmount) {
        console.log("\n=== Executing Direct Arbitrage Path ===");
        console.log("Start Token:", startToken);
        console.log("Start Amount:", startAmount);

        SwapState memory state = SwapState({
            token: startToken,
            amount: startAmount
        });

        for (uint256 i = 0; i < pairs.length; ) {
            console.log("\n--- Swap Step %s ---", i + 1);
            console.log("Pair:", pairs[i]);
            console.log("Fee (bps):", fees[i]);
            console.log("Current token:", state.token);
            console.log("Amount In before swap:", state.amount);

            (state.token, state.amount) = _executeSwapStep(state.token, state.amount, pairs[i], fees[i]);
            unchecked { i++; }
        }
        // Unlike the flashloan version, we do not require that the final token be the same as the start token.
        finalToken = state.token;
        finalAmount = state.amount;
        console.log("Direct arbitrage final token:", finalToken);
        console.log("Direct arbitrage final amount:", finalAmount);
    }

    /// @dev Executes a single swap step.
    /// @param currentToken The token being swapped.
    /// @param currentAmount The amount to swap.
    /// @param pairAddr The address of the pair.
    /// @param fee The fee in basis points for this swap.
    /// @return newToken The token received from the swap.
    /// @return newAmount The calculated amount after the swap.
    function _executeSwapStep(
        address currentToken,
        uint256 currentAmount,
        address pairAddr,
        uint256 fee
    ) internal returns (address newToken, uint256 newAmount) {
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddr);
        address token0 = pair.token0();
        address token1 = pair.token1();
        if (currentToken != token0 && currentToken != token1) revert SwapPathError();


        (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
        bool isToken0 = (currentToken == token0);
        uint256 reserveIn = isToken0 ? reserve0 : reserve1;
        uint256 reserveOut = isToken0 ? reserve1 : reserve0;

        // Safety check: reserves must be nonzero.
        if (reserveIn == 0 || reserveOut == 0) revert InvalidReserves();

        console.log("Reserves - In:", reserveIn, "Out:", reserveOut);

        // Transfer the currentAmount to the pair.
        _safeTransfer(currentToken, pairAddr, currentAmount);
        console.log("Using Amount In:", currentAmount);

        uint256 amountOut = _calculateSwapOutput(currentAmount, reserveIn, reserveOut, fee);
        console.log("Calculated Amount Out:", amountOut);

        // Extra check: ensure amountOut does not exceed available reserve.
        if (amountOut >= reserveOut) revert OutputExceedsReserve();

        if (isToken0) {
            pair.swap(0, amountOut, address(this), new bytes(0));
            newToken = token1;
        } else {
            pair.swap(amountOut, 0, address(this), new bytes(0));
            newToken = token0;
        }

        // Instead of checking the balance, we use the calculated amountOut.
        newAmount = amountOut;
        console.log("Token received:", newToken);
        console.log("Final Amount (calculated):", newAmount);
    }

    /// @dev Calculates the output amount for a swap.
    function _calculateSwapOutput(
        uint256 input,
        uint256 inputReserve,
        uint256 outputReserve,
        uint256 fee
    ) internal pure returns (uint256) {
        // Using the UniswapV2 formula: amountOut = (input * (FEE_DENOMINATOR - fee) * outputReserve) / (inputReserve * FEE_DENOMINATOR + input * (FEE_DENOMINATOR - fee))
        uint256 inputAmountWithFee = input * (FEE_DENOMINATOR - fee);
        uint256 numerator = inputAmountWithFee * outputReserve;
        uint256 denominator = (inputReserve * FEE_DENOMINATOR) + inputAmountWithFee;
        return numerator / denominator;
    }

    /// @dev A minimal wrapper around ERC20 transfer.
    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) revert TokenTransferFailed();
    }
}
