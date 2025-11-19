// SPDX-License-Identifier: UNLICENSED
// Compatible with OpenZeppelin Contracts ^5.0.2
pragma solidity ^0.8.27;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

contract OnestableSourceBridge is
    Initializable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    AccessControlUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 public constant MESSAGE_ADAPTER_ROLE =
        keccak256("MESSAGE_ADAPTER_ROLE");

    struct LockRecord {
        address sender;
        address recipient;
        uint256 amount;
        address token;
        uint256 destChainId;
        address destTokenAddress;
        uint256 maxConfirmationTimestamp;
        uint256 nonce;
    }

    uint256 private nonce; // sequential nonce for each lock operation

    IERC20 public token; // token locked on source chain
    uint256 public totalLockedSupply; // total locked supply in this contract
    uint256 public destChainId; // destination chain id
    address public destTokenAddress; // destination token address
    uint256 public maxConfirmationPeriod; // max time in seconds to must wait for relayer to confirm

    /// @notice Track if a burn id has already been processed
    mapping(bytes32 => bool) public processedReleases;

    /// @notice Mapping of lock id to unsettled lock record
    mapping(bytes32 => LockRecord) public lockRecords;

    /// @notice Maps lock id => destination chain confirmation tx hash
    mapping(bytes32 => bytes32) public confirmedLockReceipts;

    /// @notice Track if a lock is reverted
    mapping(bytes32 => bool) public isLockReverted;

    event TokensLocked(
        bytes32 indexed lockId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        address token,
        uint256 maxConfirmationTimestamp,
        uint256 destChainId,
        address destTokenAddress
    );
    event LockConfirmed(bytes32 indexed lockId, bytes32 indexed receipt);
    event RevertedLockedTokens(
        bytes32 indexed lockId,
        address indexed recipient,
        uint256 amount
    );
    event TokensReleased(
        bytes32 indexed burnId,
        address indexed sender,
        address indexed recipient,
        uint256 amount,
        address token,
        uint256 srcChainId,
        address srcTokenAddress
    );

    error ZeroAddress(string field);
    error InvalidAmount();
    error AlreadyProcessed();
    error RescueNotAllowed(address token);
    error InvalidChainId(string field);
    error InvalidId();
    error InvalidConfirmationPeriod(uint256 provided, uint256 min, uint256 max);
    error ReleaseNotAllowedFromSource(
        uint256 allowedChainId,
        uint256 srcChainId
    );
    error ReleaseNotAllowedFromSourceToken(
        address allowedTokenAddress,
        address srcTokenAddress
    );
    error InsufficientLockedSupply(uint256 available, uint256 required);
    error RequestTimeout(uint256 current, uint256 maxConfirmationTimestamp);
    error RevertLockedTokensTooEarly(
        uint256 current,
        uint256 maxConfirmationTimestamp
    );
    error RevertNotAllowed(bytes32 lockId);
    error ConfirmLockNotAllowed(bytes32 lockId);
    error DestinationChainNotAllowed(uint256 allowed, uint256 provided);
    error DestinationTokenNotAllowed(address allowed, address provided);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        IERC20 _token,
        uint256 _destChainId,
        address _destTokenAddress,
        uint256 _maxConfirmationPeriod,
        address _defaultAdmin,
        address _pauser,
        address _upgrader
    ) public initializer {
        if (address(_token) == address(0)) revert ZeroAddress("_token");
        if (_destChainId == 0 || _destChainId == block.chainid)
            revert InvalidChainId("_destChainId");
        if (_destTokenAddress == address(0))
            revert ZeroAddress("_destTokenAddress");
        if (_defaultAdmin == address(0)) revert ZeroAddress("_defaultAdmin");
        if (_pauser == address(0)) revert ZeroAddress("_pauser");
        if (_upgrader == address(0)) revert ZeroAddress("_upgrader");

        __Pausable_init();
        __ReentrancyGuard_init();
        __AccessControl_init();
        __UUPSUpgradeable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _defaultAdmin);
        _grantRole(PAUSER_ROLE, _pauser);
        _grantRole(UPGRADER_ROLE, _upgrader);

        token = _token;
        destChainId = _destChainId;
        destTokenAddress = _destTokenAddress;
        maxConfirmationPeriod = _maxConfirmationPeriod;
    }

    function _authorizeUpgrade(
        address newImplementation
    ) internal override onlyRole(UPGRADER_ROLE) {}

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    /// @notice Grant or revoke message adapter role (admin controlled)
    function setMessageAdapter(
        address adapter,
        bool enabled
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (adapter == address(0)) revert ZeroAddress("adapter");

        if (enabled) {
            _grantRole(MESSAGE_ADAPTER_ROLE, adapter);
        } else {
            _revokeRole(MESSAGE_ADAPTER_ROLE, adapter);
        }
    }

    /// @notice Admin can adjust confirmation period
    /// @dev Event emission not needed
    function setMaxConfirmationPeriod(
        uint256 _maxPeriod
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxPeriod < 300 || _maxPeriod > 86400)
            revert InvalidConfirmationPeriod(_maxPeriod, 300, 86400);

        maxConfirmationPeriod = _maxPeriod;
    }

    function verifyParity() external view returns (bool) {
        return token.balanceOf(address(this)) == totalLockedSupply;
    }

    function getExcessTokens() public view returns (uint256) {
        uint256 currentBalance = token.balanceOf(address(this));
        return
            currentBalance > totalLockedSupply
                ? currentBalance - totalLockedSupply
                : 0;
    }

    /**
     * @notice Recover excess tokens locked up in this contract.
     * @param to Recipient address
     */
    function recoverExcessTokens(
        address to
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress("to");

        uint256 excess = getExcessTokens();
        if (excess > 0) token.safeTransfer(to, excess);
    }

    /**
     * @notice Rescue ERC20 tokens locked up in this contract.
     * @param tokenContract ERC20 token contract address
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function rescueERC20(
        IERC20 tokenContract,
        address to,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress("to");
        if (amount == 0) revert InvalidAmount();
        if (tokenContract == token)
            revert RescueNotAllowed(address(tokenContract));

        tokenContract.safeTransfer(to, amount);
    }

    function _getLockId(
        LockRecord memory lockRecord
    ) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encodePacked(
                    lockRecord.sender,
                    lockRecord.recipient,
                    lockRecord.amount,
                    lockRecord.token,
                    lockRecord.destChainId,
                    lockRecord.destTokenAddress,
                    lockRecord.maxConfirmationTimestamp,
                    lockRecord.nonce
                )
            );
    }

    /// @notice Lock tokens on source chain. Emits TokensLocked event for message adapter to forward.
    /// @dev Caller must approve this bridge to spend `amount` on the bridged token.
    /// @param recipient recipient address on destination chain
    /// @param amount amount to lock (must be > 0)
    function lockTokens(
        address recipient,
        uint256 amount
    ) external nonReentrant whenNotPaused {
        if (amount == 0) revert InvalidAmount();
        if (recipient == address(0)) revert ZeroAddress("recipient");

        nonce += 1;
        totalLockedSupply += amount;

        LockRecord memory lockRecord = LockRecord(
            msg.sender,
            recipient,
            amount,
            address(token),
            destChainId,
            destTokenAddress,
            block.timestamp + maxConfirmationPeriod,
            nonce
        );
        bytes32 lockId = _getLockId(lockRecord);
        lockRecords[lockId] = lockRecord;

        // Transfer tokens to this contract
        token.safeTransferFrom(msg.sender, address(this), amount);

        emit TokensLocked(
            lockId,
            lockRecord.sender,
            lockRecord.recipient,
            lockRecord.amount,
            address(token),
            lockRecord.maxConfirmationTimestamp,
            destChainId,
            destTokenAddress
        );
    }

    /// @notice Confirm lock on source chain. Only callable by authorized message adapter.
    function confirmLock(
        bytes32 _lockId,
        bytes32 _receipt,
        uint256 _destChainId,
        address _destTokenAddress
    ) external nonReentrant whenNotPaused onlyRole(MESSAGE_ADAPTER_ROLE) {
        LockRecord memory lockRecord = lockRecords[_lockId];
        if (lockRecord.sender == address(0)) revert InvalidId();
        if (_destChainId != lockRecord.destChainId)
            revert DestinationChainNotAllowed(
                lockRecord.destChainId,
                _destChainId
            );
        if (_destTokenAddress != lockRecord.destTokenAddress)
            revert DestinationTokenNotAllowed(
                lockRecord.destTokenAddress,
                _destTokenAddress
            );
        if (isLockReverted[_lockId]) revert ConfirmLockNotAllowed(_lockId);
        if (confirmedLockReceipts[_lockId] != bytes32(0))
            revert AlreadyProcessed();

        confirmedLockReceipts[_lockId] = _receipt;

        // Delete a lock record
        delete lockRecords[_lockId];

        emit LockConfirmed(_lockId, _receipt);
    }

    /// @notice Revert tokens locked on source chain. Only callable by authorized message adapter.
    function revertLockedTokens(
        bytes32 lockId
    ) external nonReentrant whenNotPaused onlyRole(MESSAGE_ADAPTER_ROLE) {
        LockRecord memory lockRecord = lockRecords[lockId];
        if (lockRecord.sender == address(0)) revert InvalidId();
        if (block.timestamp < lockRecord.maxConfirmationTimestamp)
            revert RevertLockedTokensTooEarly(
                block.timestamp,
                lockRecord.maxConfirmationTimestamp
            );
        if (confirmedLockReceipts[lockId] != bytes32(0))
            revert RevertNotAllowed(lockId);
        if (isLockReverted[lockId]) revert AlreadyProcessed();

        isLockReverted[lockId] = true;
        totalLockedSupply -= lockRecord.amount;

        // Transfer tokens back to sender
        token.safeTransfer(lockRecord.sender, lockRecord.amount);

        // Delete a lock record
        delete lockRecords[lockId];

        emit RevertedLockedTokens(lockId, lockRecord.sender, lockRecord.amount);
    }

    /// @notice Release tokens locked on source chain. Only callable by authorized message adapter.
    /// @dev Adapter will pass canonical payload including srcChainId and srcTxHash for replay-protection.
    function releaseTokens(
        bytes32 burnId,
        uint256 srcChainId,
        address srcTokenAddress,
        address sender,
        address recipient,
        uint256 amount,
        uint256 maxConfirmationTimestamp
    ) external whenNotPaused nonReentrant onlyRole(MESSAGE_ADAPTER_ROLE) {
        if (srcChainId == 0) revert InvalidChainId("srcChainId");
        if (srcTokenAddress == address(0))
            revert ZeroAddress("srcTokenAddress");
        if (burnId == bytes32(0)) revert InvalidId();
        if (recipient == address(0)) revert ZeroAddress("recipient");
        if (amount == 0) revert InvalidAmount();
        if (maxConfirmationTimestamp < block.timestamp)
            revert RequestTimeout(block.timestamp, maxConfirmationTimestamp);
        if (processedReleases[burnId]) revert AlreadyProcessed();
        if (srcChainId != destChainId)
            revert ReleaseNotAllowedFromSource(destChainId, srcChainId);
        if (srcTokenAddress != destTokenAddress)
            revert ReleaseNotAllowedFromSourceToken(
                destTokenAddress,
                srcTokenAddress
            );
        if (totalLockedSupply < amount)
            revert InsufficientLockedSupply(totalLockedSupply, amount);

        processedReleases[burnId] = true;
        totalLockedSupply -= amount;

        // Transfer locked tokens to recipient
        token.safeTransfer(recipient, amount);

        emit TokensReleased(
            burnId,
            sender,
            recipient,
            amount,
            address(token),
            srcChainId,
            srcTokenAddress
        );
    }

    // storage gap
    uint256[50] private __gap;
}
