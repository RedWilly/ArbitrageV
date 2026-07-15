// SPDX-License-Identifier: MIT
//v2, v3 & carbon
pragma solidity ^0.8.0;

import "./interfaces/Withdrawable.sol";
import "./interfaces/IBaseV1Pair.sol";
import "./interfaces/IUniswapV2Pair.sol";

interface IUniswapV3Pool {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external;
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}

interface ICarbonController {
    struct TradeAction {
        uint256 strategyId;
        uint128 amount;
    }

    function tradeBySourceAmount(
        address sourceToken,
        address targetToken,
        TradeAction[] calldata tradeActions,
        uint256 deadline,
        uint128 minReturn
    ) external payable returns (uint128);
}

interface IWSEI {
    function deposit() external payable;
    function withdraw(uint256 wad) external;
}

error ArrayLengthMismatch();
error StartTokenNotInFlashLoanPair();
error ArbitrageMustReturnToStart();
error RepaymentTransferFailed();
error InsufficientFlashLoanRepayment();
error SwapPathError();
error InvalidReserves();
error OutputExceedsReserve();
error TokenTransferFailed();
error UnsupportedProtocol();
error InvalidV3SwapCallback();
error InvalidV3SwapDelta();
error InvalidFlashLoanCallback();
error InvalidCarbonAmount();
error CarbonApprovalFailed();
error UnsupportedV2QuoteMode();
error InvalidStablePair();
error StableSolverDidNotConverge();

contract ArbitrageExecutor is Withdrawable {
    uint8 private constant V2 = 0;
    uint8 private constant V3 = 1;
    uint8 private constant CARBON = 2;
    address private constant NATIVE_SEI = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    address private constant WSEI = 0xE30feDd158A2e3b13e9badaeABaFc5516e95e8C7;
    uint256 private constant FEE_DENOMINATOR = 10000;
    uint256 private constant ONE = 1e18;
    uint160 private constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_RATIO_MINUS_ONE =
        1461446703485210103287273052203988822378723970341;

    uint8 private pendingFlashProtocol;
    address private pendingFlashPool;
    address private pendingV3Pool;

    struct FlashData {
        address borrowedToken;
        uint256 borrowedAmount;
        bool borrowedToken0;
        uint256 v2RepayFee;
        address[] pools;
        uint8[] protocols;
        uint256[] fees;
        bytes[] data;
    }

    struct ArbParams {
        uint8 flashProtocol;
        address flashPool;
        address borrowToken;
        uint256 borrowAmount;
        uint256 v2RepayFee;
        address[] pools;
        uint8[] protocols;
        uint256[] fees;
        bytes[] data;
    }

    struct StablePairState {
        uint256 scale0;
        uint256 scale1;
        uint256 reserve0;
        uint256 reserve1;
        bool stable;
        address token0;
        address token1;
    }

    constructor(address owner_) Withdrawable(owner_) {}

    function executeArbitrage(ArbParams calldata params) external {
        if (
            params.pools.length != params.protocols.length ||
            params.pools.length != params.fees.length ||
            params.pools.length != params.data.length
        ) revert ArrayLengthMismatch();
        bool borrowToken0 = _isToken0(params.flashPool, params.borrowToken);
        _startFlashLoan(params, borrowToken0, _flashData(params, borrowToken0));
    }

    function _startFlashLoan(
        ArbParams calldata params,
        bool borrowToken0,
        bytes memory data
    ) internal {
        pendingFlashProtocol = params.flashProtocol;
        pendingFlashPool = params.flashPool;

        if (params.flashProtocol == V2) {
            IUniswapV2Pair(params.flashPool).swap(
                borrowToken0 ? params.borrowAmount : 0,
                borrowToken0 ? 0 : params.borrowAmount,
                address(this),
                data
            );
        } else if (params.flashProtocol == V3) {
            IUniswapV3Pool(params.flashPool).flash(
                address(this),
                borrowToken0 ? params.borrowAmount : 0,
                borrowToken0 ? 0 : params.borrowAmount,
                data
            );
        } else {
            revert UnsupportedProtocol();
        }

        pendingFlashProtocol = 0;
        pendingFlashPool = address(0);
    }

    // ponytail: one generic fallback handles callback name variants instead of dozens of wrappers.
    fallback() external payable {
        if (msg.sender == pendingV3Pool && pendingV3Pool != address(0)) {
            (int256 amount0Delta, int256 amount1Delta, ) =
                abi.decode(msg.data[4:], (int256, int256, bytes));
            _finishV3SwapCallback(amount0Delta, amount1Delta);
            return;
        }

        if (msg.sender != pendingFlashPool || msg.data.length < 132) {
            revert InvalidFlashLoanCallback();
        }

        if (pendingFlashProtocol == V3) {
            (uint256 fee0, uint256 fee1, bytes memory flashPayload) =
                abi.decode(msg.data[4:], (uint256, uint256, bytes));
            FlashData memory v3Loan = abi.decode(flashPayload, (FlashData));
            _finishFlashLoan(v3Loan, v3Loan.borrowedAmount + (v3Loan.borrowedToken0 ? fee0 : fee1));
            return;
        }

        if (pendingFlashProtocol != V2) revert InvalidFlashLoanCallback();

        (address sender, uint256 amount0, uint256 amount1, bytes memory data) =
            abi.decode(msg.data[4:], (address, uint256, uint256, bytes));
        if (sender != address(this)) revert InvalidFlashLoanCallback();

        FlashData memory loan = abi.decode(data, (FlashData));
        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;
        if (borrowedAmount != loan.borrowedAmount) revert InvalidFlashLoanCallback();

        _finishFlashLoan(
            loan,
            _v2RepayAmount(borrowedAmount, loan.v2RepayFee)
        );
    }

    function uniswapV3FlashCallback(uint256 fee0, uint256 fee1, bytes calldata data) external {
        if (pendingFlashProtocol != V3 || msg.sender != pendingFlashPool) {
            revert InvalidFlashLoanCallback();
        }

        FlashData memory loan = abi.decode(data, (FlashData));
        _finishFlashLoan(loan, loan.borrowedAmount + (loan.borrowedToken0 ? fee0 : fee1));
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _finishV3SwapCallback(amount0Delta, amount1Delta);
    }

    function _finishV3SwapCallback(int256 amount0Delta, int256 amount1Delta) internal {
        if (msg.sender != pendingV3Pool || pendingV3Pool == address(0)) revert InvalidV3SwapCallback();

        if (amount0Delta > 0 && amount1Delta <= 0) {
            _safeTransfer(IUniswapV3Pool(msg.sender).token0(), msg.sender, uint256(amount0Delta));
        } else if (amount1Delta > 0 && amount0Delta <= 0) {
            _safeTransfer(IUniswapV3Pool(msg.sender).token1(), msg.sender, uint256(amount1Delta));
        } else {
            revert InvalidV3SwapDelta();
        }
    }

    function _finishFlashLoan(FlashData memory loan, uint256 repayAmount) internal {
        uint256 finalAmount = _executeCircularRoute(loan);

        if (finalAmount < repayAmount) revert InsufficientFlashLoanRepayment();
        if (!IERC20(loan.borrowedToken).transfer(msg.sender, repayAmount)) {
            revert RepaymentTransferFailed();
        }
    }

    function _executeCircularRoute(FlashData memory loan) internal returns (uint256) {
        address token = loan.borrowedToken;
        uint256 amount = loan.borrowedAmount;

        for (uint256 i; i < loan.pools.length; ) {
            if (loan.protocols[i] == V2) {
                bool forwardToNextV2 =
                    i + 1 < loan.pools.length &&
                    loan.protocols[i + 1] == V2 &&
                    loan.pools[i + 1] != loan.pools[i];
                (token, amount) = _swapV2(
                    token,
                    amount,
                    loan.pools[i],
                    loan.fees[i],
                    loan.data[i],
                    forwardToNextV2 ? loan.pools[i + 1] : address(this),
                    i > 0 && loan.protocols[i - 1] == V2 && loan.pools[i - 1] != loan.pools[i]
                );
            } else if (loan.protocols[i] == V3) {
                (token, amount) = _swapV3(token, amount, loan.pools[i]);
            } else if (loan.protocols[i] == CARBON) {
                (token, amount) = _swapCarbon(token, amount, loan.pools[i], loan.data[i]);
            } else {
                revert UnsupportedProtocol();
            }

            unchecked { ++i; }
        }

        if (token != loan.borrowedToken) revert ArbitrageMustReturnToStart();
        return amount;
    }

    function _swapV2(
        address tokenIn,
        uint256 amountIn,
        address pairAddr,
        uint256 fee,
        bytes memory quoteData,
        address recipient,
        bool inputAlreadySent
    ) internal returns (address tokenOut, uint256 amountOut) {
        IUniswapV2Pair pair = IUniswapV2Pair(pairAddr);
        bool zeroForOne;
        (tokenOut, amountOut, zeroForOne) = _quoteV2(pair, tokenIn, amountIn, fee, quoteData);

        if (!inputAlreadySent) _safeTransfer(tokenIn, pairAddr, amountIn);
        pair.swap(
            zeroForOne ? 0 : amountOut,
            zeroForOne ? amountOut : 0,
            recipient,
            hex""
        );
    }

    function _quoteV2(
        IUniswapV2Pair pair,
        address tokenIn,
        uint256 amountIn,
        uint256 fee,
        bytes memory quoteData
    ) internal view returns (address tokenOut, uint256 amountOut, bool zeroForOne) {
        if (quoteData.length != 0) {
            if (quoteData.length != 1 || quoteData[0] != 0x01) revert UnsupportedV2QuoteMode();
            return _quoteStableV2(address(pair), tokenIn, amountIn, fee);
        }

        address token0 = pair.token0();
        address token1 = pair.token1();
        zeroForOne = tokenIn == token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        (uint112 reserve0, uint112 reserve1, ) = pair.getReserves();
        uint256 reserveIn = zeroForOne ? reserve0 : reserve1;
        uint256 reserveOut = zeroForOne ? reserve1 : reserve0;
        if (reserveIn == 0 || reserveOut == 0) revert InvalidReserves();

        amountOut = _v2AmountOut(amountIn, reserveIn, reserveOut, fee);
        if (amountOut >= reserveOut) revert OutputExceedsReserve();
        tokenOut = zeroForOne ? token1 : token0;
    }

    function _quoteStableV2(
        address pair,
        address tokenIn,
        uint256 amountIn,
        uint256 fee
    ) internal view returns (address tokenOut, uint256 amountOut, bool zeroForOne) {
        StablePairState memory state = _stablePairState(pair);
        if (!state.stable) revert InvalidStablePair();

        zeroForOne = tokenIn == state.token0;
        if (!zeroForOne && tokenIn != state.token1) revert SwapPathError();
        if (state.reserve0 == 0 || state.reserve1 == 0 || state.scale0 == 0 || state.scale1 == 0) revert InvalidReserves();

        amountOut = zeroForOne
            ? _stableAmountOut(amountIn, state.reserve0, state.reserve1, state.scale0, state.scale1, fee)
            : _stableAmountOut(amountIn, state.reserve1, state.reserve0, state.scale1, state.scale0, fee);
        if (amountOut >= (zeroForOne ? state.reserve1 : state.reserve0)) revert OutputExceedsReserve();
        tokenOut = zeroForOne ? state.token1 : state.token0;
    }

    function _stablePairState(address pair) private view returns (StablePairState memory state) {
        (
            state.scale0,
            state.scale1,
            state.reserve0,
            state.reserve1,
            state.stable,
            state.token0,
            state.token1
        ) = IBaseV1Pair(pair).metadata();
    }

    function _swapV3(
        address tokenIn,
        uint256 amountIn,
        address poolAddr
    ) internal returns (address tokenOut, uint256 amountOut) {
        IUniswapV3Pool pool = IUniswapV3Pool(poolAddr);
        address token0 = pool.token0();
        address token1 = pool.token1();
        bool zeroForOne = tokenIn == token0;
        if (!zeroForOne && tokenIn != token1) revert SwapPathError();

        tokenOut = zeroForOne ? token1 : token0;

        pendingV3Pool = poolAddr;
        (int256 amount0, int256 amount1) = pool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO_PLUS_ONE : MAX_SQRT_RATIO_MINUS_ONE,
            hex""
        );
        pendingV3Pool = address(0);

        int256 outputDelta = zeroForOne ? amount1 : amount0;
        if (outputDelta >= 0) revert InvalidV3SwapDelta();
        amountOut = uint256(-outputDelta);
    }

    function _swapCarbon(
        address tokenIn,
        uint256 amountIn,
        address controller,
        bytes memory data
    ) internal returns (address tokenOut, uint256 amountOut) {
        if (amountIn > type(uint128).max) revert InvalidCarbonAmount();

        address rawSourceToken;
        address rawTargetToken;
        ICarbonController.TradeAction[] memory actions;
        if (data.length == 96) {
            uint256 strategyId;
            (strategyId, rawSourceToken, rawTargetToken) = abi.decode(data, (uint256, address, address));
            actions = new ICarbonController.TradeAction[](1);
            actions[0] = ICarbonController.TradeAction({strategyId: strategyId, amount: uint128(amountIn)});
        } else {
            uint256[] memory strategyIds;
            uint128[] memory amounts;
            (rawSourceToken, rawTargetToken, strategyIds, amounts) =
                abi.decode(data, (address, address, uint256[], uint128[]));
            if (strategyIds.length == 0 || strategyIds.length != amounts.length) revert SwapPathError();

            actions = new ICarbonController.TradeAction[](strategyIds.length);
            uint256 totalActionAmount;
            for (uint256 i; i < strategyIds.length; ) {
                totalActionAmount += amounts[i];
                actions[i] = ICarbonController.TradeAction({
                    strategyId: strategyIds[i],
                    amount: amounts[i]
                });
                unchecked { ++i; }
            }
            if (totalActionAmount != amountIn) revert InvalidCarbonAmount();
        }
        bool sourceIsNative = rawSourceToken == NATIVE_SEI;
        bool targetIsNative = rawTargetToken == NATIVE_SEI;
        tokenOut = targetIsNative ? WSEI : rawTargetToken;
        if (sourceIsNative && tokenIn != WSEI) revert SwapPathError();
        if (!sourceIsNative && tokenIn != rawSourceToken) revert SwapPathError();

        if (sourceIsNative) {
            IWSEI(WSEI).withdraw(amountIn);
        } else {
            _approveCarbonIfNeeded(tokenIn, controller, amountIn);
        }

        uint256 balanceBefore = targetIsNative
            ? address(this).balance
            : IERC20(rawTargetToken).balanceOf(address(this));

        ICarbonController(controller).tradeBySourceAmount{value: sourceIsNative ? amountIn : 0}(
            rawSourceToken,
            rawTargetToken,
            actions,
            block.timestamp,
            1
        );

        if (targetIsNative) {
            amountOut = address(this).balance - balanceBefore;
            IWSEI(WSEI).deposit{value: amountOut}();
        } else {
            amountOut = IERC20(rawTargetToken).balanceOf(address(this)) - balanceBefore;
        }

        if (amountOut == 0) revert SwapPathError();
    }

    function _approveCarbonIfNeeded(address token, address controller, uint256 amount) internal {
        uint256 allowance = IERC20(token).allowance(address(this), controller);
        if (allowance >= amount) return;

        if (allowance != 0 && !IERC20(token).approve(controller, 0)) revert CarbonApprovalFailed();
        if (!IERC20(token).approve(controller, type(uint256).max)) revert CarbonApprovalFailed();
    }

    function _isToken0(address pool, address token) internal view returns (bool) {
        address token0 = IUniswapV2Pair(pool).token0();
        if (token == token0) return true;
        if (token != IUniswapV2Pair(pool).token1()) revert StartTokenNotInFlashLoanPair();
        return false;
    }

    function _flashData(ArbParams calldata params, bool borrowedToken0) internal pure returns (bytes memory) {
        return abi.encode(FlashData({
            borrowedToken: params.borrowToken,
            borrowedAmount: params.borrowAmount,
            borrowedToken0: borrowedToken0,
            v2RepayFee: params.v2RepayFee,
            pools: params.pools,
            protocols: params.protocols,
            fees: params.fees,
            data: params.data
        }));
    }

    function _v2AmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 fee
    ) internal pure returns (uint256) {
        uint256 amountInWithFee = amountIn * (FEE_DENOMINATOR - fee);
        return (amountInWithFee * reserveOut) / ((reserveIn * FEE_DENOMINATOR) + amountInWithFee);
    }

    function _v2RepayAmount(uint256 borrowedAmount, uint256 fee) internal pure returns (uint256) {
        uint256 denominator = FEE_DENOMINATOR - fee;
        return borrowedAmount + ((borrowedAmount * fee + denominator - 1) / denominator);
    }

    function _stableAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut,
        uint256 scaleIn,
        uint256 scaleOut,
        uint256 fee
    ) internal pure returns (uint256) {
        amountIn -= (amountIn * fee) / FEE_DENOMINATOR;
        uint256 normalizedIn = (reserveIn * ONE) / scaleIn;
        uint256 normalizedOut = (reserveOut * ONE) / scaleOut;
        uint256 invariant = _stableK(normalizedIn, normalizedOut);
        uint256 nextOut = _stableY(
            normalizedIn + (amountIn * ONE) / scaleIn,
            invariant,
            normalizedOut
        );
        return ((normalizedOut - nextOut) * scaleOut) / ONE;
    }

    function _stableK(uint256 x, uint256 y) private pure returns (uint256) {
        uint256 a = (x * y) / ONE;
        uint256 b = ((x * x) / ONE) + ((y * y) / ONE);
        return (a * b) / ONE;
    }

    function _stableF(uint256 x, uint256 x3, uint256 y) private pure returns (uint256) {
        return _stableF(x, x3, y, (y * y) / ONE);
    }

    function _stableF(uint256 x, uint256 x3, uint256 y, uint256 y2) private pure returns (uint256) {
        return (x * ((y2 * y) / ONE)) / ONE + (x3 * y) / ONE;
    }

    function _stableY(uint256 x, uint256 invariant, uint256 y) private pure returns (uint256) {
        uint256 x3 = ((((x * x) / ONE) * x) / ONE);
        for (uint256 i; i < 255; ) {
            uint256 y2 = (y * y) / ONE;
            uint256 k = _stableF(x, x3, y, y2);
            uint256 d = (3 * x * y2) / ONE + x3;
            if (d == 0) revert InvalidReserves();

            if (k < invariant) {
                uint256 dy = ((invariant - k) * ONE) / d;
                if (dy == 0) {
                    if (k == invariant) return y;
                    if (_stableF(x, x3, y + 1) > invariant) return y + 1;
                    dy = 1;
                }
                y += dy;
            } else {
                uint256 dy = ((k - invariant) * ONE) / d;
                if (dy == 0) {
                    if (k == invariant || _stableF(x, x3, y - 1) < invariant) return y;
                    dy = 1;
                }
                y -= dy;
            }
            unchecked { ++i; }
        }
        revert StableSolverDidNotConverge();
    }

    function _safeTransfer(address token, address to, uint256 amount) internal {
        if (!IERC20(token).transfer(to, amount)) revert TokenTransferFailed();
    }
}
