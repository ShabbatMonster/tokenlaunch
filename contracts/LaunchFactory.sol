// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TickMath} from "./lib/TickMath.sol";
import {FullMath} from "./lib/FullMath.sol";
import {LaunchToken} from "./LaunchToken.sol";

interface IUniswapV3Factory {
    function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool);
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3Pool {
    function initialize(uint160 sqrtPriceX96) external;
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external returns (uint256 amount0, uint256 amount1);
    function swap(address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96, bytes calldata data)
        external returns (int256 amount0, int256 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256 amount0, uint256 amount1);
    function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested)
        external returns (uint128 amount0, uint128 amount1);
}

interface IWETH9 {
    function deposit() external payable;
    function transfer(address to, uint256 value) external returns (bool);
}

interface IERC20Minimal {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// @title LaunchFactory — permissionless token launchpad on Uniswap V3
/// @notice One call deploys a fixed-supply token (any supply), seeds 100% of it
///         as single-sided liquidity in a fresh 1% V3 pool, optionally executes
///         a dev buy in the same tx, and locks the LP position here forever.
///         Trading fees are claimable any time: protocolFeeBps to the protocol
///         wallet, the rest to the token's devWallet.
contract LaunchFactory {
    struct Socials {
        string telegram;
        string twitter;
        string discord;
        string website;
        string farcaster;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string logo;
        string description;
        Socials socials;
        address devWallet;
        uint256 totalSupply;
    }

    struct LaunchInfo {
        address pool;
        address devWallet;
        address deployer;
        int24 tickLower;
        int24 tickUpper;
        bool tokenIsToken0;
    }

    uint24 public constant POOL_FEE = 10000; // 1% tier
    int24 public constant TICK_SPACING = 200;
    int24 internal constant MAX_ALIGNED_TICK = 887200;

    IUniswapV3Factory public immutable dexFactory;
    address public immutable weth;

    address public owner;
    address public protocolFeeRecipient;
    uint16 public protocolFeeBps; // share of claimed trading fees, in bps
    uint256 public launchFee;     // flat ETH fee per launch
    bool public launchEnabled = true;
    /// initial pool valuation in wei: starting price = initialCapWei / totalSupply
    uint256 public initialCapWei;

    mapping(address => LaunchInfo) public launches;

    // transient guard: the only pool allowed to invoke our callbacks right now
    address internal expectedPool;

    event TokenLaunched(
        address indexed token,
        address indexed deployer,
        address indexed dexFactory,
        address pairToken,
        address pool,
        uint256 dexId,
        uint256 launchConfigId,
        uint256 positionId,
        uint256 restrictionsEndBlock,
        uint256 initialBuyAmount
    );
    event FeesClaimed(
        address indexed token,
        address indexed devWallet,
        uint256 wethToDev,
        uint256 tokenToDev,
        uint256 wethToProtocol,
        uint256 tokenToProtocol
    );
    event LaunchFeeUpdated(uint256 newFee);
    event ProtocolFeeUpdated(uint16 newBps);
    event ProtocolFeeRecipientUpdated(address newRecipient);
    event LaunchEnabledUpdated(bool enabled);
    event InitialCapUpdated(uint256 newCapWei);
    event OwnershipTransferred(address indexed oldOwner, address indexed newOwner);

    error NotOwner();
    error LaunchDisabled();
    error LaunchFeeNotPaid();
    error BadSupply();
    error UnknownToken();
    error NoFeesToCollect();
    error BadCallback();
    error FeeTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address dexFactory_, address weth_, address owner_, address protocolFeeRecipient_, uint16 protocolFeeBps_, uint256 initialCapWei_) {
        dexFactory = IUniswapV3Factory(dexFactory_);
        weth = weth_;
        owner = owner_;
        protocolFeeRecipient = protocolFeeRecipient_;
        protocolFeeBps = protocolFeeBps_;
        initialCapWei = initialCapWei_;
    }

    // ------------------------------------------------------------------ launch

    function launchToken(LaunchParams calldata p, uint256 launchConfigId, uint256 dexId, bytes32 salt)
        external payable returns (address token, uint256 positionId)
    {
        if (!launchEnabled) revert LaunchDisabled();
        if (msg.value < launchFee) revert LaunchFeeNotPaid();
        // supply must be sane: at least 1 whole token, at most 1e18 whole tokens
        if (p.totalSupply < 1e18 || p.totalSupply > 1e36) revert BadSupply();

        address devWallet = p.devWallet == address(0) ? msg.sender : p.devWallet;

        token = address(new LaunchToken{salt: keccak256(abi.encode(msg.sender, salt))}(p.name, p.symbol, p.totalSupply));

        bool tokenIs0 = token < weth;
        (int24 tickLower, int24 tickUpper, uint160 sqrtInitX96) = _range(tokenIs0, p.totalSupply);

        address pool = dexFactory.createPool(token, weth, POOL_FEE);
        IUniswapV3Pool(pool).initialize(sqrtInitX96);

        uint128 liquidity = _liquidityForSupply(tokenIs0, tickLower, tickUpper, p.totalSupply);
        expectedPool = pool;
        IUniswapV3Pool(pool).mint(address(this), tickLower, tickUpper, liquidity, abi.encode(token));

        launches[token] = LaunchInfo({
            pool: pool,
            devWallet: devWallet,
            deployer: msg.sender,
            tickLower: tickLower,
            tickUpper: tickUpper,
            tokenIsToken0: tokenIs0
        });

        if (launchFee > 0) {
            (bool ok,) = protocolFeeRecipient.call{value: launchFee}("");
            if (!ok) revert FeeTransferFailed();
        }

        uint256 buyAmount = msg.value - launchFee;
        if (buyAmount > 0) {
            IWETH9(weth).deposit{value: buyAmount}();
            // paying WETH for token: zeroForOne when WETH is token0
            bool zeroForOne = !tokenIs0;
            IUniswapV3Pool(pool).swap(
                msg.sender,
                zeroForOne,
                int256(buyAmount),
                zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
                abi.encode(token)
            );
        }
        expectedPool = address(0);

        // sweep mint rounding dust so the factory never holds token balance
        uint256 dust = IERC20Minimal(token).balanceOf(address(this));
        if (dust > 0) IERC20Minimal(token).transfer(devWallet, dust);

        emit TokenLaunched(token, msg.sender, address(dexFactory), weth, pool, dexId, launchConfigId, 0, 0, buyAmount);
        return (token, 0);
    }

    // ------------------------------------------------------------------ fees

    /// @notice Permissionless: collects a token pool's accrued trading fees and
    ///         splits them protocol/devWallet. Payouts are WETH + token.
    function claimFees(address token) external {
        LaunchInfo memory info = launches[token];
        if (info.pool == address(0)) revert UnknownToken();

        IUniswapV3Pool pool = IUniswapV3Pool(info.pool);
        pool.burn(info.tickLower, info.tickUpper, 0); // poke: update fees owed
        (uint128 amount0, uint128 amount1) =
            pool.collect(address(this), info.tickLower, info.tickUpper, type(uint128).max, type(uint128).max);
        if (amount0 == 0 && amount1 == 0) revert NoFeesToCollect();

        (address token0, address token1) = info.tokenIsToken0 ? (token, weth) : (weth, token);
        (uint256 dev0, uint256 prot0) = _split(amount0);
        (uint256 dev1, uint256 prot1) = _split(amount1);
        if (dev0 > 0) IERC20Minimal(token0).transfer(info.devWallet, dev0);
        if (prot0 > 0) IERC20Minimal(token0).transfer(protocolFeeRecipient, prot0);
        if (dev1 > 0) IERC20Minimal(token1).transfer(info.devWallet, dev1);
        if (prot1 > 0) IERC20Minimal(token1).transfer(protocolFeeRecipient, prot1);

        (uint256 wethToDev, uint256 tokenToDev, uint256 wethToProt, uint256 tokenToProt) = info.tokenIsToken0
            ? (dev1, dev0, prot1, prot0)
            : (dev0, dev1, prot0, prot1);
        emit FeesClaimed(token, info.devWallet, wethToDev, tokenToDev, wethToProt, tokenToProt);
    }

    function _split(uint256 amount) internal view returns (uint256 toDev, uint256 toProtocol) {
        toProtocol = (amount * protocolFeeBps) / 10000;
        toDev = amount - toProtocol;
    }

    // ------------------------------------------------------------------ math

    /// @dev Range start tick from initialCapWei / supply, aligned to spacing;
    ///      full supply sits single-sided from there to the far end.
    function _range(bool tokenIs0, uint256 supply)
        internal view returns (int24 tickLower, int24 tickUpper, uint160 sqrtInitX96)
    {
        // price (token1 per token0) as Q192: for token0 = token it's cap/supply,
        // for token0 = weth it's supply/cap
        uint256 priceX192 = tokenIs0
            ? FullMath.mulDiv(initialCapWei, 1 << 192, supply)
            : FullMath.mulDiv(supply, 1 << 192, initialCapWei);
        uint160 sqrtP = uint160(_sqrt(priceX192));
        int24 rawTick = TickMath.getTickAtSqrtRatio(sqrtP);

        if (tokenIs0) {
            // ceil-align: range sits at/above start price, all token0
            int24 aligned = (rawTick / TICK_SPACING) * TICK_SPACING;
            if (rawTick > 0 && rawTick % TICK_SPACING != 0) aligned += TICK_SPACING;
            tickLower = aligned;
            tickUpper = MAX_ALIGNED_TICK;
        } else {
            // floor-align: range sits at/below start price, all token1
            int24 aligned = (rawTick / TICK_SPACING) * TICK_SPACING;
            if (rawTick < 0 && rawTick % TICK_SPACING != 0) aligned -= TICK_SPACING;
            tickUpper = aligned;
            tickLower = -MAX_ALIGNED_TICK;
        }
        sqrtInitX96 = TickMath.getSqrtRatioAtTick(tokenIs0 ? tickLower : tickUpper);
    }

    function _liquidityForSupply(bool tokenIs0, int24 tickLower, int24 tickUpper, uint256 supply)
        internal pure returns (uint128)
    {
        uint160 sqrtA = TickMath.getSqrtRatioAtTick(tickLower);
        uint160 sqrtB = TickMath.getSqrtRatioAtTick(tickUpper);
        uint256 liq;
        if (tokenIs0) {
            // LiquidityAmounts.getLiquidityForAmount0
            uint256 intermediate = FullMath.mulDiv(sqrtA, sqrtB, 1 << 96);
            liq = FullMath.mulDiv(supply, intermediate, sqrtB - sqrtA);
        } else {
            // LiquidityAmounts.getLiquidityForAmount1
            liq = FullMath.mulDiv(supply, 1 << 96, sqrtB - sqrtA);
        }
        require(liq <= type(uint128).max, "liq overflow");
        return uint128(liq);
    }

    function _sqrt(uint256 x) internal pure returns (uint256 z) {
        if (x == 0) return 0;
        uint256 xx = x;
        uint256 r = 1;
        if (xx >= 0x100000000000000000000000000000000) { xx >>= 128; r <<= 64; }
        if (xx >= 0x10000000000000000) { xx >>= 64; r <<= 32; }
        if (xx >= 0x100000000) { xx >>= 32; r <<= 16; }
        if (xx >= 0x10000) { xx >>= 16; r <<= 8; }
        if (xx >= 0x100) { xx >>= 8; r <<= 4; }
        if (xx >= 0x10) { xx >>= 4; r <<= 2; }
        if (xx >= 0x4) { r <<= 1; }
        z = r;
        for (uint256 i = 0; i < 7; i++) z = (z + x / z) >> 1;
        uint256 z1 = x / z;
        if (z1 < z) z = z1;
    }

    // ------------------------------------------------------------------ callbacks

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        if (msg.sender != expectedPool) revert BadCallback();
        address token = abi.decode(data, (address));
        if (amount0Owed > 0) _payPool(token, amount0Owed, true);
        if (amount1Owed > 0) _payPool(token, amount1Owed, false);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        if (msg.sender != expectedPool) revert BadCallback();
        address token = abi.decode(data, (address));
        if (amount0Delta > 0) _payPool(token, uint256(amount0Delta), true);
        if (amount1Delta > 0) _payPool(token, uint256(amount1Delta), false);
    }

    function _payPool(address token, uint256 amount, bool isAmount0) internal {
        (address token0, address token1) = token < weth ? (token, weth) : (weth, token);
        IERC20Minimal(isAmount0 ? token0 : token1).transfer(msg.sender, amount);
    }

    // ------------------------------------------------------------------ admin

    function setLaunchFee(uint256 newFee) external onlyOwner {
        launchFee = newFee;
        emit LaunchFeeUpdated(newFee);
    }

    function setProtocolFee(uint16 newBps) external onlyOwner {
        require(newBps <= 2000, "max 20%");
        protocolFeeBps = newBps;
        emit ProtocolFeeUpdated(newBps);
    }

    function setProtocolFeeRecipient(address newRecipient) external onlyOwner {
        require(newRecipient != address(0), "zero");
        protocolFeeRecipient = newRecipient;
        emit ProtocolFeeRecipientUpdated(newRecipient);
    }

    function setLaunchEnabled(bool enabled) external onlyOwner {
        launchEnabled = enabled;
        emit LaunchEnabledUpdated(enabled);
    }

    function setInitialCap(uint256 newCapWei) external onlyOwner {
        require(newCapWei >= 0.01 ether && newCapWei <= 1000 ether, "cap range");
        initialCapWei = newCapWei;
        emit InitialCapUpdated(newCapWei);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "zero");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }
}
