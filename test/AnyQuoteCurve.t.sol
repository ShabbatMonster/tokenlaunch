// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AnyQuoteCurveFactory} from "../contracts/AnyQuoteCurveFactory.sol";
import {AnyQuoteCurve} from "../contracts/AnyQuoteCurve.sol";
import {CurveToken} from "../contracts/CurveToken.sol";
import {FullMath} from "../contracts/lib/FullMath.sol";

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
        return _launch(quote, threshold, 0);
    }

    /// startMarketCap of 0 means "keep the old 0.4x default", so every existing
    /// test goes through the overload above and must behave exactly as before.
    function _launch(address quote, uint256 threshold, uint256 startMarketCap)
        internal
        returns (AnyQuoteCurve curve, CurveToken token)
    {
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
                startMarketCap: startMarketCap,
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

    // -----------------------------------------------------------------------
    // startMarketCap
    //
    // The virtual quote reserve IS the starting market cap, because the virtual
    // token reserve is the whole supply: price = quoteReserve/supply, so
    // price * supply == quoteReserve. These tests pin that identity, because it
    // is the only reason the parameter can honestly be named after a market cap.
    // -----------------------------------------------------------------------

    /// The shape asked for: 4.2 ETH raised to graduate, opening at 1.3 ETH.
    function test_startMarketCap_4point2_threshold_1point3_open() public {
        uint256 threshold = 4.2 ether;
        uint256 startMcap = 1.3 ether;
        (AnyQuoteCurve curve, CurveToken token) = _launch(address(0), threshold, startMcap);

        assertEq(curve.startMarketCap(), startMcap, "startMarketCap should be what was asked for");
        assertEq(curve.quoteReserve(), startMcap, "virtual quote reserve is the starting market cap");
        assertEq(curve.tokenReserve(), token.totalSupply(), "virtual token reserve is the whole supply");

        // price * supply == startMarketCap, to the wei
        uint256 supply = token.totalSupply();
        assertEq(FullMath.mulDiv(curve.quoteReserve(), supply, curve.tokenReserve()), startMcap,
            "opening valuation of the whole supply is exactly the start market cap");

        // buy all the way to graduation and check where it lands
        vm.deal(trader, 100 ether);
        vm.prank(trader);
        curve.buy{value: 10 ether}(10 ether, 0, trader);   // overpay; the curve refunds the excess

        assertEq(curve.realQuoteReserve(), threshold, "lands exactly on the threshold");
        assertTrue(curve.readyToGraduate(), "ready once the threshold is met");

        // GROSS vs NET, which is the thing that will surprise someone reading
        // "4.2 ETH to graduate". The threshold counts what buyers PAY:
        // realQuoteReserve takes the gross, while the pricing reserve only
        // receives what is left after the trade fee. With feeBps = 100 the
        // curve ends up holding 4.158, not 4.2.
        uint256 netIn = threshold - (threshold * 100) / 10_000;   // feeBps is 100 in _launch
        assertEq(curve.quoteReserve(), startMcap + netIn, "the pricing reserve gets the NET, not the gross");

        // sold = supply * netIn / (startMcap + netIn)
        uint256 expectedSold = FullMath.mulDiv(supply, netIn, startMcap + netIn);
        uint256 sold = supply - curve.tokenReserve();
        assertApproxEqRel(sold, expectedSold, 1e12, "76.18% of supply sells on the curve");

        // and what is left seeds the pool
        uint256 left = curve.tokenReserve();
        assertApproxEqRel(left, supply - expectedSold, 1e12, "23.82% is left to seed the pool");

        // where the coin ends up: the valuation it graduates at
        uint256 finalMcap = FullMath.mulDiv(curve.quoteReserve(), supply, left);
        assertApproxEqRel(finalMcap, 22.9 ether, 0.01e18, "graduates at roughly 22.9 ETH, a ~17.6x on the open");
    }

    /// Zero keeps the old behaviour exactly, so curves launched before this
    /// parameter existed are unaffected.
    function test_startMarketCap_zero_is_the_old_default() public {
        uint256 threshold = 4.2 ether;
        (AnyQuoteCurve a,) = _launch(address(0), threshold, 0);
        assertEq(a.quoteReserve(), (threshold * 2) / 5, "0 means 0.4x the threshold");
        assertEq(a.startMarketCap(), (threshold * 2) / 5, "and the reported start cap says so");

        // stating it explicitly gives an identical curve
        (AnyQuoteCurve b,) = _launch(address(0), threshold, (threshold * 2) / 5);
        assertEq(b.quoteReserve(), a.quoteReserve(), "explicit 0.4x matches the default");
    }

    /// A lower opening valuation means more of the supply sells on the curve,
    /// and the pool is seeded with less. Worth pinning: it is the trade-off a
    /// launcher is actually making when they move this dial.
    function test_startMarketCap_lower_open_sells_more_of_the_supply() public {
        uint256 threshold = 4.2 ether;
        (AnyQuoteCurve low,) = _launch(address(0), threshold, 1.3 ether);
        (AnyQuoteCurve high,) = _launch(address(0), threshold, 3 ether);

        vm.deal(trader, 200 ether);
        vm.startPrank(trader);
        low.buy{value: 10 ether}(10 ether, 0, trader);
        high.buy{value: 10 ether}(10 ether, 0, trader);
        vm.stopPrank();

        uint256 lowLeft = low.tokenReserve();
        uint256 highLeft = high.tokenReserve();
        assertLt(lowLeft, highLeft, "opening lower leaves less for the pool");
    }

    /// The whole point of this curve: the quote can be a contract nobody
    /// allowlisted. A token deployed in this test has never been seen by the
    /// factory and still works as the quote asset end to end.
    function test_startMarketCap_withACompletelyUnknownQuoteToken() public {
        MockQuote quote = new MockQuote();
        uint256 threshold = 4200 * 1e18;
        (AnyQuoteCurve curve,) = _launch(address(quote), threshold, 1300 * 1e18);
        assertEq(curve.startMarketCap(), 1300 * 1e18, "a brand new ERC20 is a valid quote");

        quote.mint(trader, 10_000 ether);
        vm.startPrank(trader);
        quote.approve(address(curve), type(uint256).max);
        curve.buy(threshold, 0, trader);
        vm.stopPrank();

        assertEq(curve.realQuoteReserve(), threshold, "it raises in that token");
        assertTrue(curve.readyToGraduate(), "and graduates on it");
    }
}

/// A quote token nobody has ever heard of - deployed inside the test, so it is
/// in no allowlist anywhere. This is what "pair against a memecoin" means in
/// practice: an arbitrary ERC20 contract address.
contract MockQuote {
    string public name = "Mock Memecoin";
    string public symbol = "MOCK";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        if (allowance[from][msg.sender] != type(uint256).max) allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
