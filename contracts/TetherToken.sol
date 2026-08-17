// SPDX-License-Identifier: MIT
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PausableUpgradeable.sol";
import {ERC20PermitUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

contract TetherToken is
    Initializable,
    ERC20Upgradeable,
    AccessControlUpgradeable,
    ERC20PausableUpgradeable,
    ERC20PermitUpgradeable,
    UUPSUpgradeable
{
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant BLACKLISTER_ROLE = keccak256("BLACKLISTER_ROLE");
    bytes32 public constant RECOVERY_ROLE = keccak256("RECOVERY_ROLE");

    mapping(address => bool) public blacklisted;

    error ZeroAddress();
    error ZeroAmount();
    error BlacklistedAddress(address account);
    error AlreadyBlacklisted(address account);
    error NotBlacklisted(address account);
    error InvalidRecoveryRecipient();

    event AddressBlacklisted(address indexed account);
    event AddressUnblacklisted(address indexed account);
    event BlacklistedFundsRecovered(
        address indexed account,
        address indexed recipient,
        uint256 amount
    );

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address defaultAdmin,
        address pauser,
        address upgrader,
        address blacklister,
        address recovery
    ) public initializer {
        if (defaultAdmin == address(0)) revert ZeroAddress();
        if (pauser == address(0)) revert ZeroAddress();
        if (upgrader == address(0)) revert ZeroAddress();
        if (blacklister == address(0)) revert ZeroAddress();
        if (recovery == address(0)) revert ZeroAddress();

        __ERC20_init("TetherToken", "USDT");
        __AccessControl_init();
        __ERC20Pausable_init();
        __ERC20Permit_init("TetherToken");
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, defaultAdmin);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(UPGRADER_ROLE, upgrader);
        _grantRole(BLACKLISTER_ROLE, blacklister);
        _grantRole(RECOVERY_ROLE, recovery);
    }

    function pause() public onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() public onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    function blacklist(address account) external onlyRole(BLACKLISTER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (blacklisted[account]) revert AlreadyBlacklisted(account);
        blacklisted[account] = true;
        emit AddressBlacklisted(account);
    }

    function unblacklist(address account) external onlyRole(BLACKLISTER_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        if (!blacklisted[account]) revert NotBlacklisted(account);
        blacklisted[account] = false;
        emit AddressUnblacklisted(account);
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) public onlyRole(MINTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _mint(to, amount);
    }

    function burn(uint256 amount) public onlyRole(MINTER_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _burn(_msgSender(), amount);
    }

    function recover(
        address account,
        address recipient
    ) external onlyRole(RECOVERY_ROLE) {
        if (recipient == address(0)) revert ZeroAddress();
        if (account == recipient) revert InvalidRecoveryRecipient();
        if (!blacklisted[account]) revert NotBlacklisted(account);
        if (blacklisted[recipient]) revert BlacklistedAddress(recipient);

        uint256 amount = balanceOf(account);
        if (amount == 0) return;

        super._update(account, recipient, amount);

        emit BlacklistedFundsRecovered(account, recipient, amount);
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    // The following functions are overrides required by Solidity.

    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20Upgradeable, ERC20PausableUpgradeable) {
        if (from != address(0) && blacklisted[from])
            revert BlacklistedAddress(from);
        if (to != address(0) && blacklisted[to]) revert BlacklistedAddress(to);
        super._update(from, to, value);
    }

    uint256[50] private __gap;
}
