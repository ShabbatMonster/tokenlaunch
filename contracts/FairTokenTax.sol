// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Fixed-supply, non-mintable ERC20 with a buy/sell fee routed to a fee
///         wallet. No owner and no post-deploy setters — the fee, fee wallet and
///         the taxed pair are all fixed at construction. The Uniswap V2 pair
///         address is derived deterministically (CREATE2) so no privileged
///         "setPair" is ever needed. Fees are taken in-token; the deployer and
///         the fee wallet are exempt, so adding liquidity is untaxed and the fee
///         wallet can move its balance freely.
/// @dev    Mainnet Uniswap V2 constants. The fee applies only to transfers where
///         one side is the pair (buys and sells); plain wallet transfers are free.
contract FairTokenTax {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable feeWallet;
    uint16 public immutable feeBps; // basis points taken on each buy/sell
    address public immutable pair;  // Uniswap V2 pair (this token / WETH), derived
    mapping(address => bool) public isExempt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    address private constant UNISWAP_V2_FACTORY = 0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f;
    address private constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
    bytes32 private constant PAIR_INIT_CODE_HASH = 0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f;

    constructor(string memory name_, string memory symbol_, uint256 supply_, address feeWallet_, uint16 feeBps_) {
        require(feeWallet_ != address(0), "fee wallet");
        require(feeBps_ <= 2000, "fee too high"); // hard cap 20%
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        feeWallet = feeWallet_;
        feeBps = feeBps_;

        // deterministic Uniswap V2 pair address for (this token, WETH)
        (address t0, address t1) = address(this) < WETH ? (address(this), WETH) : (WETH, address(this));
        pair = address(uint160(uint256(keccak256(abi.encodePacked(
            hex"ff", UNISWAP_V2_FACTORY, keccak256(abi.encodePacked(t0, t1)), PAIR_INIT_CODE_HASH
        )))));

        isExempt[msg.sender] = true;   // deployer adds liquidity untaxed
        isExempt[feeWallet_] = true;   // fee wallet moves its balance untaxed

        balanceOf[msg.sender] = supply_;
        emit Transfer(address(0), msg.sender, supply_);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return _transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "allowance");
            allowance[from][msg.sender] = allowed - value;
        }
        return _transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal returns (bool) {
        require(balanceOf[from] >= value, "balance");
        unchecked { balanceOf[from] -= value; }

        uint256 fee = 0;
        // tax only buys/sells (a pair leg), and never when an exempt party is involved
        if ((from == pair || to == pair) && !isExempt[from] && !isExempt[to] && feeBps > 0) {
            fee = (value * feeBps) / 10000;
        }
        if (fee > 0) {
            unchecked {
                balanceOf[feeWallet] += fee;
                balanceOf[to] += value - fee;
            }
            emit Transfer(from, feeWallet, fee);
            emit Transfer(from, to, value - fee);
        } else {
            unchecked { balanceOf[to] += value; }
            emit Transfer(from, to, value);
        }
        return true;
    }
}
