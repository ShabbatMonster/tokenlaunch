// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console} from "forge-std/Test.sol";
import {LaunchFactory, IUniswapV3Pool, IWETH9, IERC20Minimal} from "../contracts/LaunchFactory.sol";
import {LaunchToken} from "../contracts/LaunchToken.sol";
import {TickMath} from "../contracts/lib/TickMath.sol";

// run with: forge test --fork-url https://rpc.mainnet.chain.robinhood.com
contract LaunchFactoryTest is Test {
    address constant V3_FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address constant PROTOCOL = 0xbE8af7E12B536aB55fbaf92EDbb512972e0504dA;

    uint256 constant CAP = 1.3556e18;
    uint256 constant B_SUPPLY = 1e27; // 1B tokens

    LaunchFactory factory;
    address dev = makeAddr("dev");
    address trader = makeAddr("trader");

    function setUp() public {
        factory = new LaunchFactory(V3_FACTORY, WETH, PROTOCOL, PROTOCOL, 100, CAP);
        vm.deal(dev, 100 ether);
        vm.deal(trader, 100 ether);
    }

    function _params(string memory sym, uint256 supply) internal view returns (LaunchFactory.LaunchParams memory) {
        return LaunchFactory.LaunchParams({
            name: sym,
            symbol: sym,
            logo: "ipfs://test",
            description: "aaaaaaaaaa",
            socials: LaunchFactory.Socials("", "", "", "", ""),
            devWallet: dev,
            totalSupply: supply
        });
    }

    function _launch(string memory sym, uint256 supply, uint256 buyEth, bytes32 salt) internal returns (address token) {
        vm.prank(dev);
        (token,) = factory.launchToken{value: buyEth}(_params(sym, supply), 0, 0, salt);
    }

    function test_launch_1B_matchesKnownCurve() public {
        // RobinFun/Noxa curve: 0.01 ETH dev buy on 1B supply -> 7,249,784.87 tokens
        address token = _launch("TEST", B_SUPPLY, 0.01 ether, bytes32(uint256(1)));
        uint256 got = IERC20Minimal(token).balanceOf(dev);
        console.log("dev buy got tokens:", got / 1e18);
        // tick rounding can shift the start price by up to one 200-tick step (~2%)
        assertApproxEqRel(got, 7_249_784.87e18, 0.03e18);
        // pool holds the rest of supply
        LaunchToken t = LaunchToken(token);
        assertEq(t.totalSupply(), B_SUPPLY);
    }

    function test_supplyIndependent_percentage() public {
        // same ETH in => same % of supply out, regardless of supply size
        address tSmall = _launch("SMALL", 1e24, 0.01 ether, bytes32(uint256(2)));   // 1M tokens
        address tBig = _launch("BIG", 1e30, 0.01 ether, bytes32(uint256(3)));       // 1T tokens
        uint256 pctSmall = IERC20Minimal(tSmall).balanceOf(dev) * 1e18 / 1e24;
        uint256 pctBig = IERC20Minimal(tBig).balanceOf(dev) * 1e18 / 1e30;
        console.log("pct small (1e18=100%):", pctSmall);
        console.log("pct big  (1e18=100%):", pctBig);
        assertApproxEqRel(pctSmall, pctBig, 0.05e18);
    }

    function test_bothTokenOrderings() public {
        // grind salts to force token < WETH and token > WETH
        bytes32 saltLow;
        bytes32 saltHigh;
        bytes32 initHash = keccak256(abi.encodePacked(
            type(LaunchToken).creationCode, abi.encode("ORD", "ORD", B_SUPPLY)
        ));
        for (uint256 i = 0; i < 4000; i++) {
            bytes32 s = keccak256(abi.encode(dev, bytes32(i)));
            address predicted = vm.computeCreate2Address(s, initHash, address(factory));
            if (predicted < WETH && saltLow == 0) saltLow = bytes32(i);
            if (predicted > WETH && saltHigh == 0) saltHigh = bytes32(i);
            if (saltLow != 0 && saltHigh != 0) break;
        }
        require(saltLow != 0 && saltHigh != 0, "salt grind failed");

        address tokenLow = _launch("ORD", B_SUPPLY, 0.01 ether, saltLow);
        assertTrue(tokenLow < WETH, "expected token0 case");
        uint256 gotLow = IERC20Minimal(tokenLow).balanceOf(dev);

        address tokenHigh = _launch("ORD", B_SUPPLY, 0.01 ether, saltHigh);
        assertTrue(tokenHigh > WETH, "expected token1 case");
        uint256 gotHigh = IERC20Minimal(tokenHigh).balanceOf(dev);

        console.log("token0-case buy:", gotLow / 1e18, " token1-case buy:", gotHigh / 1e18);
        assertApproxEqRel(gotLow, gotHigh, 0.05e18);
    }

    function test_trade_claim_split() public {
        address token = _launch("FEE", B_SUPPLY, 0.05 ether, bytes32(uint256(4)));
        (address pool,,,,,) = factory.launches(token);

        // this contract buys 1 ETH through the pool directly (pays via its callback)
        vm.deal(address(this), 2 ether);
        IWETH9(WETH).deposit{value: 1 ether}();
        bool zeroForOne = WETH < token;
        IUniswapV3Pool(pool).swap(
            trader, zeroForOne, int256(1 ether),
            zeroForOne ? TickMath.MIN_SQRT_RATIO + 1 : TickMath.MAX_SQRT_RATIO - 1,
            ""
        );

        uint256 devWethBefore = IERC20Minimal(WETH).balanceOf(dev);
        uint256 protWethBefore = IERC20Minimal(WETH).balanceOf(PROTOCOL);

        factory.claimFees(token);

        uint256 devGot = IERC20Minimal(WETH).balanceOf(dev) - devWethBefore;
        uint256 protGot = IERC20Minimal(WETH).balanceOf(PROTOCOL) - protWethBefore;
        console.log("dev WETH fees:", devGot, " protocol WETH fees:", protGot);
        // 1.05 ETH total buys (dev buy + trade) at 1% tier => ~0.0105 WETH fees
        assertApproxEqRel(devGot + protGot, 0.0105 ether, 0.02e18);
        assertApproxEqRel(protGot * 99, devGot, 0.02e18);

        // second claim with nothing accrued reverts
        vm.expectRevert(LaunchFactory.NoFeesToCollect.selector);
        factory.claimFees(token);
    }

    // trader pays its own swap callback
    function uniswapV3SwapCallback(int256 d0, int256 d1, bytes calldata) external {
        if (d0 > 0) IERC20Minimal(IUniswapV3PoolTokens(msg.sender).token0()).transfer(msg.sender, uint256(d0));
        if (d1 > 0) IERC20Minimal(IUniswapV3PoolTokens(msg.sender).token1()).transfer(msg.sender, uint256(d1));
    }

    function test_launchFee_andToggle() public {
        vm.prank(PROTOCOL);
        factory.setLaunchFee(0.0001 ether);

        uint256 before = PROTOCOL.balance;
        _launch("FEE2", B_SUPPLY, 0.0001 ether, bytes32(uint256(5))); // fee only, no buy
        assertEq(PROTOCOL.balance - before, 0.0001 ether);

        vm.prank(PROTOCOL);
        factory.setLaunchEnabled(false);
        vm.expectRevert(LaunchFactory.LaunchDisabled.selector);
        vm.prank(dev);
        factory.launchToken{value: 1 ether}(_params("NOPE", B_SUPPLY), 0, 0, bytes32(uint256(6)));
    }

    function test_transfersUnrestricted() public {
        // distro feature needs free transfers right after launch
        address token = _launch("MOVE", B_SUPPLY, 0.2 ether, bytes32(uint256(7)));
        uint256 bal = IERC20Minimal(token).balanceOf(dev);
        vm.prank(dev);
        IERC20Minimal(token).transfer(trader, bal / 2);
        assertEq(IERC20Minimal(token).balanceOf(trader), bal / 2);
    }
}

interface IUniswapV3PoolTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}
