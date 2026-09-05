// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title CurveToken — fixed-supply ERC20 minted once to its bonding curve
/// @notice Deliberately boring: no owner, no mint after construction, no tax,
///         no blacklist. The entire supply is minted to the curve at deploy;
///         what the curve doesn't sell gets seeded into the Uniswap v4 pool at
///         graduation, so nothing here can rug after launch.
contract CurveToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    // launch metadata, kept on-chain so indexers/UIs don't need the factory
    string public logo;
    string public description;
    string public twitter;
    string public website;
    address public immutable curve;
    address public immutable creator;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(
        string memory _name,
        string memory _symbol,
        string memory _logo,
        string memory _description,
        string memory _twitter,
        string memory _website,
        uint256 _supply,
        address _curve,
        address _creator
    ) {
        name = _name;
        symbol = _symbol;
        logo = _logo;
        description = _description;
        twitter = _twitter;
        website = _website;
        curve = _curve;
        creator = _creator;

        totalSupply = _supply;
        balanceOf[_curve] = _supply;
        emit Transfer(address(0), _curve, _supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            if (allowed < value) revert InsufficientAllowance();
            allowance[from][msg.sender] = allowed - value;
        }
        _transfer(from, to, value);
        return true;
    }

    function _transfer(address from, address to, uint256 value) internal {
        uint256 bal = balanceOf[from];
        if (bal < value) revert InsufficientBalance();
        unchecked {
            balanceOf[from] = bal - value;
            balanceOf[to] += value;
        }
        emit Transfer(from, to, value);
    }
}
