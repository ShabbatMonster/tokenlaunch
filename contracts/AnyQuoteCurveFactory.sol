// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {CurveToken} from "./CurveToken.sol";
import {AnyQuoteCurve} from "./AnyQuoteCurve.sol";

/// @title AnyQuoteCurveFactory - permissionless Pons-style launchpad, any quote
/// @notice Deploys a (token, curve) pair in one call, exactly like Pons v2 does,
///         minus the part that makes Pons annoying: there is no approved-pair
///         allowlist here. Pair against native ETH, a tokenized stock, a stable,
///         a memecoin - anything with an ERC20 interface.
///
/// Deliberate design choices, all of which differ from Pons:
///   * No pair allowlist. The caller picks the quote token.
///   * No graduation executor and no rescue delay. graduate() on the curve is
///     permissionless from the moment the threshold is hit, so a curve can never
///     end up closed-but-poolless waiting on someone else to push the button.
///   * The launch fee, curve fee and supply are all set per-launch by the caller
///     within the bounds below, rather than by a config id only an owner can add.
contract AnyQuoteCurveFactory {
    struct LaunchParams {
        string name;
        string symbol;
        string logo;
        string description;
        string twitter;
        string website;
        /// @dev address(0) == native ETH
        address quoteToken;
        /// @dev raise target, denominated in the quote token
        uint256 graduationThreshold;
        /// @dev total token supply, all of it minted to the curve
        uint256 supply;
        /// @dev v4 pool params for the graduated pool
        uint24 poolFee;
        int24 tickSpacing;
        address hooks;
        /// @dev trade fee on the curve, in bps
        uint16 feeBps;
    }

    struct Launch {
        address token;
        address curve;
        address quoteToken;
        address creator;
        uint256 createdAt;
    }

    address public immutable poolManager;

    address public owner;
    address public protocolFeeRecipient;
    /// @dev protocol share of each curve trade fee, in bps of the fee
    uint16 public protocolFeeShareBps = 2_000; // 20% of the trade fee
    /// @dev flat fee to launch, in native currency
    uint256 public launchFee;
    /// @dev hard ceiling on the per-launch curve trade fee
    uint16 public constant MAX_FEE_BPS = 500; // 5%

    uint256 public launchCount;
    mapping(uint256 => Launch) public launches;
    mapping(address => address) public curveOf; // token => curve

    event Launched(
        address indexed token,
        address indexed curve,
        address indexed creator,
        address quoteToken,
        uint256 supply,
        uint256 graduationThreshold
    );
    event LaunchFeeUpdated(uint256 fee);
    event ProtocolFeeRecipientUpdated(address recipient);
    event ProtocolFeeShareUpdated(uint16 bps);
    event OwnerUpdated(address owner);

    error NotOwner();
    error FeeTooHigh();
    error ZeroSupply();
    error ZeroThreshold();
    error InvalidTickSpacing();
    error LaunchFeeNotPaid();
    error TransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address _poolManager, address _protocolFeeRecipient) {
        poolManager = _poolManager;
        owner = msg.sender;
        protocolFeeRecipient = _protocolFeeRecipient;
    }

    /// @notice Deploy a token and its bonding curve against any quote token.
    function launch(LaunchParams calldata p) external payable returns (address token, address curve) {
        if (p.supply == 0) revert ZeroSupply();
        if (p.graduationThreshold == 0) revert ZeroThreshold();
        if (p.feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (p.tickSpacing <= 0) revert InvalidTickSpacing();
        if (msg.value < launchFee) revert LaunchFeeNotPaid();

        // The curve address is needed to mint the supply, and the token address
        // is needed to construct the curve, so the curve is deployed first
        // against a predicted token address via CREATE.
        uint256 nonce = launchCount + 1;
        launchCount = nonce;

        address predictedToken = _computeCreateAddress(address(this), _nonceFor(nonce, 1));

        AnyQuoteCurve c = new AnyQuoteCurve(
            AnyQuoteCurve.InitParams({
                token: predictedToken,
                quoteToken: p.quoteToken,
                creator: msg.sender,
                poolManager: poolManager,
                graduationThreshold: p.graduationThreshold,
                launchSupply: p.supply,
                poolFee: p.poolFee,
                tickSpacing: p.tickSpacing,
                hooks: p.hooks,
                feeBps: p.feeBps,
                protocolFeeRecipient: protocolFeeRecipient,
                protocolFeeShareBps: protocolFeeShareBps
            })
        );
        curve = address(c);

        CurveToken t = new CurveToken(
            p.name, p.symbol, p.logo, p.description, p.twitter, p.website, p.supply, curve, msg.sender
        );
        token = address(t);
        // if this ever trips, the CREATE nonce accounting is off and the curve
        // would be pointing at the wrong token - fail loudly instead
        require(token == predictedToken, "token address mismatch");

        launches[nonce] = Launch({
            token: token,
            curve: curve,
            quoteToken: p.quoteToken,
            creator: msg.sender,
            createdAt: block.timestamp
        });
        curveOf[token] = curve;

        if (launchFee > 0) {
            (bool ok,) = protocolFeeRecipient.call{value: launchFee}("");
            if (!ok) revert TransferFailed();
        }
        uint256 refund = msg.value - launchFee;
        if (refund > 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert TransferFailed();
        }

        emit Launched(token, curve, msg.sender, p.quoteToken, p.supply, p.graduationThreshold);
    }

    // --- admin ---------------------------------------------------------------

    function setLaunchFee(uint256 fee) external onlyOwner {
        launchFee = fee;
        emit LaunchFeeUpdated(fee);
    }

    function setProtocolFeeRecipient(address r) external onlyOwner {
        protocolFeeRecipient = r;
        emit ProtocolFeeRecipientUpdated(r);
    }

    function setProtocolFeeShareBps(uint16 bps) external onlyOwner {
        if (bps > 10_000) revert FeeTooHigh();
        protocolFeeShareBps = bps;
        emit ProtocolFeeShareUpdated(bps);
    }

    function setOwner(address o) external onlyOwner {
        owner = o;
        emit OwnerUpdated(o);
    }

    // --- internals -----------------------------------------------------------

    /// @dev this factory deploys 2 contracts per launch, so the token created in
    ///      launch number n sits at deployer nonce (2n) counting the constructor
    ///      nonce of 1; offset lets the caller ask for the second of the pair.
    function _nonceFor(uint256 launchIndex, uint256 offset) internal pure returns (uint256) {
        return (launchIndex - 1) * 2 + 1 + offset;
    }

    /// @dev RLP-encoded CREATE address derivation for the nonce ranges this
    ///      factory will realistically reach.
    function _computeCreateAddress(address deployer, uint256 nonce) internal pure returns (address) {
        bytes memory data;
        if (nonce == 0x00) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, bytes1(0x80));
        } else if (nonce <= 0x7f) {
            data = abi.encodePacked(bytes1(0xd6), bytes1(0x94), deployer, uint8(nonce));
        } else if (nonce <= 0xff) {
            data = abi.encodePacked(bytes1(0xd7), bytes1(0x94), deployer, bytes1(0x81), uint8(nonce));
        } else if (nonce <= 0xffff) {
            data = abi.encodePacked(bytes1(0xd8), bytes1(0x94), deployer, bytes1(0x82), uint16(nonce));
        } else if (nonce <= 0xffffff) {
            data = abi.encodePacked(bytes1(0xd9), bytes1(0x94), deployer, bytes1(0x83), uint24(nonce));
        } else {
            data = abi.encodePacked(bytes1(0xda), bytes1(0x94), deployer, bytes1(0x84), uint32(nonce));
        }
        return address(uint160(uint256(keccak256(data))));
    }
}
