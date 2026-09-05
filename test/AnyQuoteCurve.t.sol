// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AnyQuoteCurveFactory} from "../contracts/AnyQuoteCurveFactory.sol";
import {AnyQuoteCurve} from "../contracts/AnyQuoteCurve.sol";
import {CurveToken} from "../contracts/CurveToken.sol";

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}

/// Fork tests against the live Uniswap v4 PoolManager on Robinhood chain.
/// Compiling proves nothing about the v4 unlock/settle dance, so every test
/// here drives a real launch -> buy -> graduate against the real deployment.
contract AnyQuoteCurveTest is Test {
    address constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address constant NVDA = 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC; // 18dp equity
    address constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168; // 6dp stable
    address constant CBBTC = 0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4; // 8dp crypto

    AnyQuoteCurveFactory factory;
    address creator = address(0xC0FFEE);
    address trader = address(0xBEEF);
    address protocol = address(0xFEE5);

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
        factory = new AnyQuoteCurveFactory(POOL_MANAGER, protocol);
    }

    function _launch(address quote, uint256 threshold) internal returns (AnyQuoteCurve curve, CurveToken token) {
        vm.prank(creator);
        (address t, address c) = factory.launch(
            AnyQuoteCurveFactory.LaunchParams({
                name: "Test",
                symbol: "TEST",
                logo: "",
                description: "",
                twitter: "",
                website: "",
                quoteToken: quote,
                graduationThreshold: threshold,
                supply: 1_000_000_000 ether,
                poolFee: 10000,
                tickSpacing: 200,
                hooks: address(0),
                feeBps: 100
            })
        );
        curve = AnyQuoteCurve(payable(c));
        token = CurveToken(t);
    }

    // --- native ETH quote ----------------------------------------------------

    function test_nativeQuote_launchBuyGraduate() public {
        (AnyQuoteCurve curve, CurveToken token) = _launch(address(0), 4.2 ether);

        // curve holds the whole supply, virtual quote is 0.4x the threshold
        assertEq(token.balanceOf(address(curve)), 1_000_000_000 ether, "supply to curve");
        assertEq(curve.quoteReserve(), 1.68 ether, "virtual quote = 0.4x threshold");
        assertFalse(curve.readyToGraduate(), "not ready at launch");

        vm.deal(trader, 10 ether);
        vm.prank(trader);
        curve.buy{value: 4.2 ether}(4.2 ether, 0, trader);

        assertTrue(curve.readyToGraduate(), "ready after hitting threshold");
        assertGt(token.balanceOf(trader), 0, "trader got tokens");

        // ~71.43% of supply sold, ~28.57% left to seed the pool
        uint256 sold = 1_000_000_000 ether - curve.tokenReserve();
        uint256 pctSoldBps = (sold * 10_000) / 1_000_000_000 ether;
        assertApproxEqAbs(pctSoldBps, 7143, 30, "~71.43% sold at graduation");

        // anyone can graduate - not just the creator
        vm.prank(address(0xD00D));
        curve.graduate();

        assertTrue(curve.graduated(), "graduated");
        assertEq(curve.tokenReserve(), 0, "tokens seeded");
        assertEq(curve.realQuoteReserve(), 0, "quote seeded");
        assertTrue(curve.poolId() != bytes32(0), "pool id set");
    }

    function test_cannotGraduateBeforeThreshold() public {
        (AnyQuoteCurve curve,) = _launch(address(0), 4.2 ether);
        vm.deal(trader, 1 ether);
        vm.prank(trader);
        curve.buy{value: 1 ether}(1 ether, 0, trader);

        vm.expectRevert(AnyQuoteCurve.NotReadyToGraduate.selector);
        curve.graduate();
    }

    function test_cannotGraduateTwice() public {
        (AnyQuoteCurve curve,) = _launch(address(0), 4.2 ether);
        vm.deal(trader, 5 ether);
        vm.prank(trader);
        curve.buy{value: 4.2 ether}(4.2 ether, 0, trader);
        curve.graduate();

        vm.expectRevert(AnyQuoteCurve.AlreadyGraduated.selector);
        curve.graduate();
    }

    function test_overpayIsRefundedAndLandsExactlyOnThreshold() public {
        (AnyQuoteCurve curve,) = _launch(address(0), 4.2 ether);
        vm.deal(trader, 10 ether);
        uint256 balBefore = trader.balance;

        vm.prank(trader);
        curve.buy{value: 6 ether}(6 ether, 0, trader);

        assertEq(curve.realQuoteReserve(), 4.2 ether, "raise capped at threshold");
        assertEq(balBefore - trader.balance, 4.2 ether, "surplus refunded");
    }

    function test_sellBeforeGraduation() public {
        (AnyQuoteCurve curve, CurveToken token) = _launch(address(0), 4.2 ether);
        vm.deal(trader, 10 ether);
        vm.startPrank(trader);
        curve.buy{value: 1 ether}(1 ether, 0, trader);
        uint256 bal = token.balanceOf(trader);
        token.approve(address(curve), bal);
        uint256 ethBefore = trader.balance;
        curve.sell(bal, 0, trader);
        vm.stopPrank();

        assertGt(trader.balance, ethBefore, "got quote back");
        assertEq(token.balanceOf(trader), 0, "tokens returned to curve");
    }

    function test_tradingDisabledAfterGraduation() public {
        (AnyQuoteCurve curve,) = _launch(address(0), 4.2 ether);
        vm.deal(trader, 10 ether);
        vm.prank(trader);
        curve.buy{value: 4.2 ether}(4.2 ether, 0, trader);
        curve.graduate();

        vm.deal(trader, 1 ether);
        vm.prank(trader);
        vm.expectRevert(AnyQuoteCurve.AlreadyGraduated.selector);
        curve.buy{value: 1 ether}(1 ether, 0, trader);
    }

    // --- arbitrary ERC20 quotes: the whole point ----------------------------

    function _erc20Graduation(address quote, uint256 threshold) internal {
        (AnyQuoteCurve curve, CurveToken token) = _launch(quote, threshold);

        deal(quote, trader, threshold * 2);
        vm.startPrank(trader);
        IERC20(quote).approve(address(curve), type(uint256).max);
        curve.buy(threshold, 0, trader);
        vm.stopPrank();

        assertTrue(curve.readyToGraduate(), "ready");
        assertGt(token.balanceOf(trader), 0, "trader got tokens");

        curve.graduate();
        assertTrue(curve.graduated(), "graduated on erc20 quote");
        assertTrue(curve.poolId() != bytes32(0), "pool id set");
    }

    /// an 18dp tokenized equity - what Pons itself allows
    function test_erc20Quote_NVDA() public {
        _erc20Graduation(NVDA, 40 ether);
    }

    /// a 6dp stablecoin - decimals differ from the token being launched
    function test_erc20Quote_USDG_6dp() public {
        _erc20Graduation(USDG, 10_000e6);
    }

    /// an 8dp crypto asset - the awkward middle case
    function test_erc20Quote_cbBTC_8dp() public {
        _erc20Graduation(CBBTC, 5e8);
    }

    // --- fees ----------------------------------------------------------------

    function test_feesAccrueAndSplit() public {
        (AnyQuoteCurve curve,) = _launch(address(0), 4.2 ether);
        vm.deal(trader, 10 ether);
        vm.prank(trader);
        curve.buy{value: 1 ether}(1 ether, 0, trader);

        // 1% fee on 1 ether = 0.01 ether, 20% of that to protocol
        assertEq(curve.protocolFees(), 0.002 ether, "protocol share");
        assertEq(curve.creatorFees(), 0.008 ether, "creator share");

        uint256 before = creator.balance;
        curve.claimCreatorFees();
        assertEq(creator.balance - before, 0.008 ether, "creator paid out");
    }

    // --- proof the liquidity actually landed in the pool ---------------------

    /// poolId being set only proves initialize() was called. This asserts the
    /// PoolManager actually received both sides of the seed, which is the part
    /// the unlock/settle callback has to get right.
    function test_graduationActuallyFundsThePool() public {
        (AnyQuoteCurve curve, CurveToken token) = _launch(address(0), 4.2 ether);
        vm.deal(trader, 10 ether);
        vm.prank(trader);
        curve.buy{value: 4.2 ether}(4.2 ether, 0, trader);

        uint256 pmEthBefore = POOL_MANAGER.balance;
        uint256 pmTokBefore = token.balanceOf(POOL_MANAGER);
        uint256 quoteSeed = curve.realQuoteReserve();
        uint256 tokenSeed = curve.tokenReserve();
        assertGt(quoteSeed, 0, "has quote to seed");
        assertGt(tokenSeed, 0, "has tokens to seed");

        curve.graduate();

        uint256 ethIn = POOL_MANAGER.balance - pmEthBefore;
        uint256 tokIn = token.balanceOf(POOL_MANAGER) - pmTokBefore;

        assertGt(ethIn, 0, "pool manager received ETH");
        assertGt(tokIn, 0, "pool manager received tokens");
        // essentially all of the raise should end up in the pool
        assertApproxEqRel(ethIn, quoteSeed, 0.02e18, "~all quote seeded");
        assertApproxEqRel(tokIn, tokenSeed, 0.02e18, "~all tokens seeded");

        // and the curve should not be sitting on leftovers
        assertLt(address(curve).balance, quoteSeed / 50, "no meaningful ETH stranded");
    }

    function test_erc20GraduationFundsThePool() public {
        (AnyQuoteCurve curve, CurveToken token) = _launch(NVDA, 40 ether);
        deal(NVDA, trader, 80 ether);
        vm.startPrank(trader);
        IERC20(NVDA).approve(address(curve), type(uint256).max);
        curve.buy(40 ether, 0, trader);
        vm.stopPrank();

        uint256 pmQuoteBefore = IERC20(NVDA).balanceOf(POOL_MANAGER);
        uint256 pmTokBefore = token.balanceOf(POOL_MANAGER);
        uint256 quoteSeed = curve.realQuoteReserve();
        uint256 tokenSeed = curve.tokenReserve();

        curve.graduate();

        assertApproxEqRel(IERC20(NVDA).balanceOf(POOL_MANAGER) - pmQuoteBefore, quoteSeed, 0.02e18, "~all NVDA seeded");
        assertApproxEqRel(token.balanceOf(POOL_MANAGER) - pmTokBefore, tokenSeed, 0.02e18, "~all tokens seeded");
    }
}
