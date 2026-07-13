// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Minimal fixed-supply ERC20 minted in full to the deployer (the factory).
/// @dev    Enforces a 2% max-wallet cap: no non-exempt address may end a transfer
///         holding more than 2% of supply. The factory, the pool, and the dev are
///         exempt (set by the factory at launch), so the dev can buy past 2% and
///         the pool can hold the full liquidity.
contract LaunchToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public immutable factory;
    uint256 public immutable maxWallet; // 2% of supply
    mapping(address => bool) public isExempt;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event ExemptSet(address indexed account, bool exempt);

    constructor(string memory name_, string memory symbol_, uint256 supply_) {
        name = name_;
        symbol = symbol_;
        totalSupply = supply_;
        factory = msg.sender;
        isExempt[msg.sender] = true; // factory holds full supply transiently
        maxWallet = (supply_ * 2) / 100;
        balanceOf[msg.sender] = supply_;
        emit Transfer(address(0), msg.sender, supply_);
    }

    /// @notice Only the factory sets exemptions (pool + dev at launch time).
    function setExempt(address account, bool exempt) external {
        require(msg.sender == factory, "only factory");
        isExempt[account] = exempt;
        emit ExemptSet(account, exempt);
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
        unchecked {
            balanceOf[from] -= value;
            balanceOf[to] += value;
        }
        if (!isExempt[to]) require(balanceOf[to] <= maxWallet, "max wallet");
        emit Transfer(from, to, value);
        return true;
    }
}
