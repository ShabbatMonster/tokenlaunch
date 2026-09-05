// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TickMath} from "./lib/TickMath.sol";
import {FullMath} from "./lib/FullMath.sol";

// --- Uniswap v4 -------------------------------------------------------------
// Signatures verified against the deployed PoolManager bytecode rather than
// assumed: initialize((address,address,uint24,int24,address),uint160),
// modifyLiquidity(PoolKey,(int24,int24,int256,bytes32),bytes), unlock(bytes),
// sync(address), settle(), take(address,address,uint256).
struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct ModifyLiquidityParams {
    int24 tickLower;
    int24 tickUpper;
    int256 liquidityDelta;
    bytes32 salt;
}

interface IPoolManager {
    function initialize(PoolKey memory key, uint160 sqrtPriceX96) external returns (int24 tick);
    function unlock(bytes calldata data) external returns (bytes memory);
    function modifyLiquidity(PoolKey memory key, ModifyLiquidityParams memory params, bytes calldata hookData)
        external returns (int256 callerDelta, int256 feesAccrued);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function transferFrom(address from, address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title AnyQuoteCurve - a Pons-style bonding curve that accepts ANY quote token
/// @notice Mirrors the mechanics of Pons v2 curves (constant-product against a
///         virtual quote reserve, a fixed graduation threshold denominated in the
///         quote asset, then a one-way graduation that seeds a Uniswap v4 pool),
///         with one deliberate difference: there is no approved-pair allowlist.
///         The quote can be native ETH or any ERC20 - a stock token, a stable, a
///         memecoin, whatever the deployer passes in.
///
/// Curve shape (matches the ratios observed on live Pons v2 curves):
///   virtualQuote = threshold * 2/5          (0.4x the threshold)
///   k            = supply * virtualQuote
/// which means graduation lands with ~71.43% of supply sold and ~28.57% left in
/// the contract to seed the pool alongside the raised quote.
///
/// Graduation is permissionless by design: anyone can call graduate() once the
/// threshold is met. That is the whole point - a curve that has met its
/// threshold should never sit stuck waiting on a keeper bot.
contract AnyQuoteCurve {
    // --- immutable config ---
    address public immutable factory;
    address public immutable token;
    /// @dev address(0) == native ETH
    address public immutable quoteToken;
    address public immutable creator;
    IPoolManager public immutable poolManager;

    uint256 public immutable graduationThreshold;
    uint256 public immutable launchSupply;
    uint24 public immutable poolFee;
    int24 public immutable tickSpacing;
    address public immutable hooks;

    /// @dev trade fee in bps, taken from the quote side of every buy/sell
    uint16 public immutable feeBps;
    address public immutable protocolFeeRecipient;
    uint16 public immutable protocolFeeShareBps; // share of feeBps going to protocol

    // --- curve state ---
    uint256 public tokenReserve;     // tokens still held by the curve
    uint256 public quoteReserve;     // virtual + real quote, drives pricing
    uint256 public realQuoteReserve; // actual quote paid in, counts toward threshold
    uint256 public creatorFees;
    uint256 public protocolFees;
    bool public graduated;
    uint256 public launchedAt;

    bytes32 public poolId;

    uint256 private _locked;

    event Buy(address indexed buyer, uint256 quoteIn, uint256 tokensOut, uint256 newQuoteReserve);
    event Sell(address indexed seller, uint256 tokensIn, uint256 quoteOut, uint256 newQuoteReserve);
    event Graduated(bytes32 indexed poolId, uint256 quoteSeeded, uint256 tokensSeeded, uint160 sqrtPriceX96, uint128 liquidity);
    event FeesClaimed(address indexed to, uint256 amount);

    error AlreadyGraduated();
    error NotReadyToGraduate();
    error ZeroAmount();
    error SlippageExceeded(uint256 got, uint256 wanted);
    error Reentrancy();
    error OnlyPoolManager();
    error SqrtPriceOutOfBounds();
    error NativeValueMismatch();
    error TransferFailed();

    modifier lock() {
        if (_locked == 1) revert Reentrancy();
        _locked = 1;
        _;
        _locked = 0;
    }

    modifier live() {
        if (graduated) revert AlreadyGraduated();
        _;
    }

    struct InitParams {
        address token;
        address quoteToken;
        address creator;
        address poolManager;
        uint256 graduationThreshold;
        uint256 launchSupply;
        uint24 poolFee;
        int24 tickSpacing;
        address hooks;
        uint16 feeBps;
        address protocolFeeRecipient;
        uint16 protocolFeeShareBps;
    }

    constructor(InitParams memory p) {
        factory = msg.sender;
        token = p.token;
        quoteToken = p.quoteToken;
        creator = p.creator;
        poolManager = IPoolManager(p.poolManager);
        graduationThreshold = p.graduationThreshold;
        launchSupply = p.launchSupply;
        poolFee = p.poolFee;
        tickSpacing = p.tickSpacing;
        hooks = p.hooks;
        feeBps = p.feeBps;
        protocolFeeRecipient = p.protocolFeeRecipient;
        protocolFeeShareBps = p.protocolFeeShareBps;

        tokenReserve = p.launchSupply;
        // 0.4x the threshold as the starting virtual quote - the same ratio the
        // live Pons curves use, which is what puts graduation at ~71.43% sold.
        quoteReserve = (p.graduationThreshold * 2) / 5;
        launchedAt = block.timestamp;
    }

    // -----------------------------------------------------------------------
    // views
    // -----------------------------------------------------------------------

    function readyToGraduate() public view returns (bool) {
        return !graduated && realQuoteReserve >= graduationThreshold;
    }

    /// @notice tokens out for a given quote in, net of fees, at current state
    function quoteBuy(uint256 quoteIn) external view returns (uint256 tokensOut, uint256 fee) {
        fee = (quoteIn * feeBps) / 10_000;
        uint256 net = quoteIn - fee;
        tokensOut = FullMath.mulDiv(tokenReserve, net, quoteReserve + net);
    }

    /// @notice quote out for a given token in, net of fees, at current state
    function quoteSell(uint256 tokensIn) external view returns (uint256 quoteOut, uint256 fee) {
        uint256 gross = FullMath.mulDiv(quoteReserve, tokensIn, tokenReserve + tokensIn);
        fee = (gross * feeBps) / 10_000;
        quoteOut = gross - fee;
    }

    /// @notice how much more quote the curve needs before it can graduate
    function remainingToGraduate() external view returns (uint256) {
        if (realQuoteReserve >= graduationThreshold) return 0;
        return graduationThreshold - realQuoteReserve;
    }

    // -----------------------------------------------------------------------
    // trading
    // -----------------------------------------------------------------------

    /// @notice Buy tokens off the curve. For a native-quote curve send value;
    ///         for an ERC20 quote, quoteIn is pulled via transferFrom.
    /// @dev Any amount that would push the raise past the threshold is refunded
    ///      rather than accepted, so the curve lands exactly on its target.
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient)
        external payable lock live returns (uint256 tokensOut)
    {
        uint256 received = _receiveQuote(quoteIn);
        if (received == 0) revert ZeroAmount();

        // clamp to the threshold and refund the surplus
        uint256 room = graduationThreshold - realQuoteReserve;
        uint256 refund;
        if (received > room) {
            refund = received - room;
            received = room;
        }
        if (received == 0) revert ZeroAmount();

        uint256 fee = (received * feeBps) / 10_000;
        uint256 net = received - fee;
        tokensOut = FullMath.mulDiv(tokenReserve, net, quoteReserve + net);
        if (tokensOut < minTokensOut) revert SlippageExceeded(tokensOut, minTokensOut);

        tokenReserve -= tokensOut;
        quoteReserve += net;
        realQuoteReserve += received;
        _accrueFee(fee);

        if (!IERC20(token).transfer(recipient, tokensOut)) revert TransferFailed();
        if (refund > 0) _sendQuote(msg.sender, refund);

        emit Buy(msg.sender, received, tokensOut, quoteReserve);
    }

    /// @notice Sell tokens back into the curve before it graduates.
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient)
        external lock live returns (uint256 quoteOut)
    {
        if (tokensIn == 0) revert ZeroAmount();
        if (!IERC20(token).transferFrom(msg.sender, address(this), tokensIn)) revert TransferFailed();

        uint256 gross = FullMath.mulDiv(quoteReserve, tokensIn, tokenReserve + tokensIn);
        uint256 fee = (gross * feeBps) / 10_000;
        quoteOut = gross - fee;
        if (quoteOut < minQuoteOut) revert SlippageExceeded(quoteOut, minQuoteOut);

        tokenReserve += tokensIn;
        quoteReserve -= gross;
        // realQuoteReserve tracks quote still held for the raise
        realQuoteReserve = realQuoteReserve > gross ? realQuoteReserve - gross : 0;
        _accrueFee(fee);

        _sendQuote(recipient, quoteOut);
        emit Sell(msg.sender, tokensIn, quoteOut, quoteReserve);
    }

    // -----------------------------------------------------------------------
    // graduation -> Uniswap v4
    // -----------------------------------------------------------------------

    /// @notice Permissionless. Once the curve has raised its threshold, anyone
    ///         may call this to open the Uniswap v4 pool and seed it with the
    ///         raised quote plus every token the curve still holds.
    function graduate() external lock returns (bytes32 id) {
        if (graduated) revert AlreadyGraduated();
        if (!readyToGraduate()) revert NotReadyToGraduate();
        graduated = true;

        uint256 quoteSeed = realQuoteReserve;
        uint256 tokenSeed = tokenReserve;
        if (quoteSeed == 0 || tokenSeed == 0) revert ZeroAmount();
        realQuoteReserve = 0;
        tokenReserve = 0;

        (PoolKey memory key, bool tokenIs0) = _poolKey();
        // Initialize at the price implied by exactly what is being seeded, so the
        // pool opens balanced against the deposit and nothing is stranded.
        uint160 sqrtPriceX96 = _sqrtPriceX96(
            tokenIs0 ? tokenSeed : quoteSeed,
            tokenIs0 ? quoteSeed : tokenSeed
        );
        poolManager.initialize(key, sqrtPriceX96);

        bytes memory res = poolManager.unlock(
            abi.encode(key, sqrtPriceX96, tokenIs0, quoteSeed, tokenSeed)
        );
        uint128 liquidity = abi.decode(res, (uint128));

        id = keccak256(abi.encode(key));
        poolId = id;
        emit Graduated(id, quoteSeed, tokenSeed, sqrtPriceX96, liquidity);
    }

    /// @dev PoolManager callback - this is where the liquidity actually lands.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (PoolKey memory key, uint160 sqrtPriceX96, bool tokenIs0, uint256 quoteSeed, uint256 tokenSeed) =
            abi.decode(data, (PoolKey, uint160, bool, uint256, uint256));

        int24 lower = (TickMath.MIN_TICK / key.tickSpacing) * key.tickSpacing;
        int24 upper = (TickMath.MAX_TICK / key.tickSpacing) * key.tickSpacing;

        uint256 amount0 = tokenIs0 ? tokenSeed : quoteSeed;
        uint256 amount1 = tokenIs0 ? quoteSeed : tokenSeed;
        uint128 liquidity = _liquidityForAmounts(
            sqrtPriceX96,
            TickMath.getSqrtRatioAtTick(lower),
            TickMath.getSqrtRatioAtTick(upper),
            amount0,
            amount1
        );
        if (liquidity == 0) revert ZeroAmount();

        (int256 callerDelta,) = poolManager.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: lower,
                tickUpper: upper,
                liquidityDelta: int256(uint256(liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        _settleDelta(key.currency0, _amount0(callerDelta));
        _settleDelta(key.currency1, _amount1(callerDelta));

        return abi.encode(liquidity);
    }

    // -----------------------------------------------------------------------
    // fees
    // -----------------------------------------------------------------------

    function claimCreatorFees() external lock {
        uint256 amt = creatorFees;
        if (amt == 0) revert ZeroAmount();
        creatorFees = 0;
        _sendQuote(creator, amt);
        emit FeesClaimed(creator, amt);
    }

    function claimProtocolFees() external lock {
        uint256 amt = protocolFees;
        if (amt == 0) revert ZeroAmount();
        protocolFees = 0;
        _sendQuote(protocolFeeRecipient, amt);
        emit FeesClaimed(protocolFeeRecipient, amt);
    }

    function _accrueFee(uint256 fee) internal {
        if (fee == 0) return;
        uint256 toProtocol = (fee * protocolFeeShareBps) / 10_000;
        protocolFees += toProtocol;
        creatorFees += fee - toProtocol;
    }

    // -----------------------------------------------------------------------
    // internals
    // -----------------------------------------------------------------------

    function _poolKey() internal view returns (PoolKey memory key, bool tokenIs0) {
        address a = token;
        address b = quoteToken; // address(0) sorts first, which is what v4 wants for native
        tokenIs0 = a < b;
        key = PoolKey({
            currency0: tokenIs0 ? a : b,
            currency1: tokenIs0 ? b : a,
            fee: poolFee,
            tickSpacing: tickSpacing,
            hooks: hooks
        });
    }

    /// @dev Pulls the quote in and returns the amount actually received, which
    ///      is measured rather than assumed so a fee-on-transfer quote token
    ///      cannot desync the accounting of the curve.
    function _receiveQuote(uint256 quoteIn) internal returns (uint256) {
        if (quoteToken == address(0)) {
            if (msg.value == 0) revert ZeroAmount();
            if (quoteIn != 0 && quoteIn != msg.value) revert NativeValueMismatch();
            return msg.value;
        }
        if (msg.value != 0) revert NativeValueMismatch();
        uint256 before = IERC20(quoteToken).balanceOf(address(this));
        if (!IERC20(quoteToken).transferFrom(msg.sender, address(this), quoteIn)) revert TransferFailed();
        return IERC20(quoteToken).balanceOf(address(this)) - before;
    }

    function _sendQuote(address to, uint256 amount) internal {
        if (amount == 0) return;
        if (quoteToken == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            if (!IERC20(quoteToken).transfer(to, amount)) revert TransferFailed();
        }
    }

    /// @dev negative delta means we owe the pool, positive means it owes us
    function _settleDelta(address currency, int128 delta) internal {
        if (delta < 0) {
            uint256 owed = uint256(uint128(-delta));
            if (currency == address(0)) {
                poolManager.settle{value: owed}();
            } else {
                poolManager.sync(currency);
                if (!IERC20(currency).transfer(address(poolManager), owed)) revert TransferFailed();
                poolManager.settle();
            }
        } else if (delta > 0) {
            poolManager.take(currency, address(this), uint256(uint128(delta)));
        }
    }

    function _amount0(int256 delta) internal pure returns (int128 a0) {
        assembly {
            a0 := sar(128, delta)
        }
    }

    function _amount1(int256 delta) internal pure returns (int128 a1) {
        assembly {
            a1 := signextend(15, delta)
        }
    }

    /// @dev sqrt(amount1/amount0) in Q96
    function _sqrtPriceX96(uint256 amount0, uint256 amount1) internal pure returns (uint160) {
        uint256 priceX192 = FullMath.mulDiv(amount1, 1 << 192, amount0);
        uint256 s = _sqrt(priceX192);
        if (s < TickMath.MIN_SQRT_RATIO || s >= TickMath.MAX_SQRT_RATIO) revert SqrtPriceOutOfBounds();
        return uint160(s);
    }

    function _liquidityForAmounts(
        uint160 sqrtP,
        uint160 sqrtA,
        uint160 sqrtB,
        uint256 amount0,
        uint256 amount1
    ) internal pure returns (uint128) {
        if (sqrtA > sqrtB) (sqrtA, sqrtB) = (sqrtB, sqrtA);
        uint256 l0 = FullMath.mulDiv(amount0, FullMath.mulDiv(sqrtP, sqrtB, 1 << 96), sqrtB - sqrtP);
        uint256 l1 = FullMath.mulDiv(amount1, 1 << 96, sqrtP - sqrtA);
        uint256 l = l0 < l1 ? l0 : l1;
        return uint128(l > type(uint128).max ? type(uint128).max : l);
    }

    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;
        uint256 z = (x + 1) / 2;
        uint256 y = x;
        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }
        return y;
    }

    receive() external payable {}
}
