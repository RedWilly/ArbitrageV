// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "contract/interfaces/Withdrawable.sol";

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
    ) external {
        // ) external returns (address, uint256) {
        if (arbPairs.length != arbFees.length) revert ArrayLengthMismatch();

        // Ensure the contract has enough funds.
        if (IERC20(startToken).balanceOf(address(this)) < startAmount)
            revert InsufficientContractBalance();

        // Execute the arbitrage path.
        (, uint256 finalAmount) = _executeArbitragePathDirect(startToken, startAmount, arbPairs, arbFees);

        if (finalAmount < startAmount) revert ArbitrageLoss();

        //  return (finalToken, finalAmount);
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

        pair.swap(amount0Out, amount1Out, address(this), data);
    }

    // --- Callback Handlers ---
    function uniswapV2Call(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function call(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function pancakeCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function chewyCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function hook(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function miniMeCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function netswapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function dogeSwapV2Call(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function YodedexCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function baguetteCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function blazeSwapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function enosysDexCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function pangolinCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function joeCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function VaporDEXCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function lydiaCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function forwardCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function elkCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function yetiswapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function sicleCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function alligatorCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function hakuswapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function tropicalCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function MeerkatCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function vvsCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function RyoshiCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function cronaCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function candyCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function cougarCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function annexCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function jwapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function croDefiSwapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function KayenCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function dragonswapCall(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }
    function donkeV2Call(address sender, uint amount0, uint amount1, bytes calldata data) external {
        _handleFlashLoan(sender, amount0, amount1, data);
    }

    /// @dev Handles the flash loan callback.
    function _handleFlashLoan(
        address,
        uint amount0,
        uint amount1,
        bytes calldata data
    ) internal {
        FlashLoanData memory loanData = abi.decode(data, (FlashLoanData));
        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;

        uint256 finalAmount = _executeArbitragePath(loanData.borrowedToken, borrowedAmount, loanData.pairs, loanData.fees);

        uint256 feeAmount = ((borrowedAmount * loanData.repayFee) / (FEE_DENOMINATOR - loanData.repayFee)) + 1;
        uint256 repayAmount = borrowedAmount + feeAmount;

        if (finalAmount < repayAmount) revert InsufficientFlashLoanRepayment();
        if (!IERC20(loanData.borrowedToken).transfer(msg.sender, repayAmount))
            revert RepaymentTransferFailed();
    }

    /// @dev Executes the arbitrage path by looping through swap steps.
    function _executeArbitragePath(
        address startToken,
        uint256 startAmount,
        address[] memory pairs,
        uint256[] memory fees
    ) internal returns (uint256) {
        SwapState memory state = SwapState({
            token: startToken,
            amount: startAmount
        });

        for (uint256 i = 0; i < pairs.length; ) {
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
        SwapState memory state = SwapState({
            token: startToken,
            amount: startAmount
        });

        for (uint256 i = 0; i < pairs.length; ) {
            (state.token, state.amount) = _executeSwapStep(state.token, state.amount, pairs[i], fees[i]);
            unchecked { i++; }
        }
        finalToken = state.token;
        finalAmount = state.amount;
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

        if (reserveIn == 0 || reserveOut == 0) revert InvalidReserves();

        _safeTransfer(currentToken, pairAddr, currentAmount);

        uint256 amountOut = _calculateSwapOutput(currentAmount, reserveIn, reserveOut, fee);

        if (amountOut >= reserveOut) revert OutputExceedsReserve();

        if (isToken0) {
            pair.swap(0, amountOut, address(this), new bytes(0));
            newToken = token1;
        } else {
            pair.swap(amountOut, 0, address(this), new bytes(0));
            newToken = token0;
        }
        newAmount = amountOut;
    }

    /// @dev Calculates the output amount for a swap.
    function _calculateSwapOutput(
        uint256 input,
        uint256 inputReserve,
        uint256 outputReserve,
        uint256 fee
    ) internal pure returns (uint256) {
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