// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AnyQuoteCurveFactory} from "../contracts/AnyQuoteCurveFactory.sol";
import {AnyQuoteCurve} from "../contracts/AnyQuoteCurve.sol";
import {CurveToken} from "../contracts/CurveToken.sol";
import {FullMath} from "../contracts/lib/FullMath.sol";

/// Against the factory that is actually deployed, not a fresh one built in the
/// test. Compiling the same source proves nothing about what is on chain - this
/// drives the real address on a fork, so a mismatched or half-broadcast
/// deployment would fail here rather than on someone's first launch.
contract AnyQuoteCurveDeployedTest is Test {
    AnyQuoteCurveFactory constant FACTORY = AnyQuoteCurveFactory(payable(0xdC0E6273a9312cA1c311CFf05fBED687B3E4F917));

    address creator = address(0xC0FFEE);
    address trader = address(0xBEEF);

    function setUp() public {
        vm.createSelectFork(vm.envString("RPC_URL"));
    }

    function _launch(address quote, uint256 threshold, uint256 startMcap)
        internal
        returns (AnyQuoteCurve curve, CurveToken token)
    {
        vm.prank(creator);
        (address t, address c) = FACTORY.launch(
            AnyQuoteCurveFactory.LaunchParams({
                name: "Robinhood Curve",
                symbol: "RHC",
                logo: "",
                description: "",
                twitter: "",
                website: "",
                quoteToken: quote,
                graduationThreshold: threshold,
                supply: 1_000_000_000 ether,
                startMarketCap: startMcap,
                poolFee: 10000,
                tickSpacing: 200,
                hooks: address(0),
                feeBps: 100
            })
        );
        curve = AnyQuoteCurve(payable(c));
        token = CurveToken(t);
    }

    /// The shape asked for, end to end on the deployed factory.
    function test_deployed_4point2_and_1point3() public {
        (AnyQuoteCurve curve, CurveToken token) = _launch(address(0), 4.2 ether, 1.3 ether);

        assertEq(curve.startMarketCap(), 1.3 ether, "the deployed factory honours startMarketCap");
        assertEq(curve.graduationThreshold(), 4.2 ether, "and the threshold");

        uint256 supply = token.totalSupply();
        assertEq(FullMath.mulDiv(curve.quoteReserve(), supply, curve.tokenReserve()), 1.3 ether,
            "the whole supply is worth 1.3 ETH before anyone buys");

        vm.deal(trader, 100 ether);
        vm.prank(trader);
        curve.buy{value: 10 ether}(10 ether, 0, trader);
        assertEq(curve.realQuoteReserve(), 4.2 ether, "graduates once 4.2 ETH has been paid in");
        assertTrue(curve.readyToGraduate(), "and it is permissionless from here");

        curve.graduate();
        assertTrue(curve.graduated(), "the v4 pool is live");
    }

    /// Still the old behaviour when the dial is left alone.
    function test_deployed_zeroStartMarketCap_keepsOldDefault() public {
        (AnyQuoteCurve curve,) = _launch(address(0), 4.2 ether, 0);
        assertEq(curve.startMarketCap(), 1.68 ether, "0 still means 0.4x the threshold");
    }
}
