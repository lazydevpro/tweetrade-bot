// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title XPRewardPool
 * @dev Manages reward pools for XP-based leaderboard periods
 * Supports flexible period durations (weekly, monthly, quarterly, custom)
 * Uses EIP-712 signatures for claim verification
 */
contract XPRewardPool is Ownable, EIP712 {
    using ECDSA for bytes32;

    // EIP-712 type hash for claim message
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "Claim(uint256 periodId,address user,uint256 rank,uint256 rewardAmount,uint256 nonce)"
    );

    // Period duration in seconds
    uint256 public periodDuration;
    
    // Epoch start timestamp (when period 0 begins)
    uint256 public epochStart;
    
    // Authorized signer address for claim signatures
    address public signerAddress;

    // Pool structure
    struct Pool {
        uint256 periodId;
        uint256 totalAmount;
        address tokenAddress; // address(0) for native token (METIS)
        bool exists;
        mapping(uint256 => uint256) rewardDistribution; // rank => amount
    }

    // Mapping of periodId => Pool
    mapping(uint256 => Pool) public pools;
    
    // Mapping of (user, periodId) => nonce
    mapping(address => mapping(uint256 => uint256)) public userPeriodNonces;
    
    // Mapping of (user, periodId) => claimed
    mapping(address => mapping(uint256 => bool)) public hasClaimed;
    
    // Array to track which periods have pools
    uint256[] private availablePeriods;

    // Events
    event PoolCreated(uint256 indexed periodId, uint256 totalAmount, address tokenAddress);
    event PoolFunded(uint256 indexed periodId, uint256 amount);
    event RewardDistributionSet(uint256 indexed periodId, uint256[] ranks, uint256[] amounts);
    event RewardClaimed(
        uint256 indexed periodId,
        address indexed user,
        uint256 rank,
        uint256 rewardAmount,
        bytes32 indexed txHash
    );
    event PeriodDurationSet(uint256 newDuration);
    event SignerAddressSet(address newSigner);

    /**
     * @dev Constructor
     * @param _periodDuration Initial period duration in seconds
     * @param _epochStart Timestamp for period 0 start
     * @param _signerAddress Address authorized to sign claims
     */
    constructor(
        uint256 _periodDuration,
        uint256 _epochStart,
        address _signerAddress
    ) Ownable(msg.sender) EIP712("XPRewardPool", "1") {
        require(_periodDuration > 0, "Period duration must be greater than 0");
        require(_signerAddress != address(0), "Signer address cannot be zero");
        
        periodDuration = _periodDuration;
        epochStart = _epochStart;
        signerAddress = _signerAddress;
    }

    /**
     * @dev Set period duration (admin only)
     * @param _duration New period duration in seconds
     */
    function setPeriodDuration(uint256 _duration) external onlyOwner {
        require(_duration > 0, "Period duration must be greater than 0");
        periodDuration = _duration;
        emit PeriodDurationSet(_duration);
    }

    /**
     * @dev Set signer address (admin only)
     * @param _signerAddress New signer address
     */
    function setSignerAddress(address _signerAddress) external onlyOwner {
        require(_signerAddress != address(0), "Signer address cannot be zero");
        signerAddress = _signerAddress;
        emit SignerAddressSet(_signerAddress);
    }

    /**
     * @dev Calculate period ID for a given timestamp
     * @param timestamp The timestamp to calculate period for
     * @return periodId The calculated period ID
     */
    function calculatePeriodId(uint256 timestamp) public view returns (uint256) {
        require(timestamp >= epochStart, "Timestamp before epoch start");
        return (timestamp - epochStart) / periodDuration;
    }

    /**
     * @dev Get current period ID
     * @return periodId Current period ID
     */
    function getCurrentPeriodId() public view returns (uint256) {
        return calculatePeriodId(block.timestamp);
    }

    /**
     * @dev Create a new reward pool (admin only)
     * @param _periodId The period ID for this pool
     * @param _totalAmount Total pool amount
     * @param _tokenAddress Token address (address(0) for native token)
     */
    function createPool(
        uint256 _periodId,
        uint256 _totalAmount,
        address _tokenAddress
    ) external onlyOwner {
        require(!pools[_periodId].exists, "Pool already exists for this period");
        require(_totalAmount > 0, "Total amount must be greater than 0");
        
        Pool storage pool = pools[_periodId];
        pool.periodId = _periodId;
        pool.totalAmount = _totalAmount;
        pool.tokenAddress = _tokenAddress;
        pool.exists = true;
        
        // Add to available periods if not already present
        bool periodExists = false;
        for (uint256 i = 0; i < availablePeriods.length; i++) {
            if (availablePeriods[i] == _periodId) {
                periodExists = true;
                break;
            }
        }
        if (!periodExists) {
            availablePeriods.push(_periodId);
        }
        
        emit PoolCreated(_periodId, _totalAmount, _tokenAddress);
    }

    /**
     * @dev Fund a pool with native token (admin only)
     * @param _periodId The period ID
     */
    function fundPool(uint256 _periodId) external payable onlyOwner {
        require(pools[_periodId].exists, "Pool does not exist");
        require(pools[_periodId].tokenAddress == address(0), "Pool is not for native token");
        require(msg.value > 0, "Amount must be greater than 0");
        
        emit PoolFunded(_periodId, msg.value);
    }

    /**
     * @dev Fund a pool with ERC20 token (admin only)
     * @param _periodId The period ID
     * @param _amount Amount to fund
     */
    function fundPoolERC20(uint256 _periodId, uint256 _amount) external onlyOwner {
        require(pools[_periodId].exists, "Pool does not exist");
        require(pools[_periodId].tokenAddress != address(0), "Pool is for native token");
        require(_amount > 0, "Amount must be greater than 0");
        
        IERC20 token = IERC20(pools[_periodId].tokenAddress);
        require(token.transferFrom(msg.sender, address(this), _amount), "Token transfer failed");
        
        emit PoolFunded(_periodId, _amount);
    }

    /**
     * @dev Set reward distribution for a period (admin only)
     * @param _periodId The period ID
     * @param _ranks Array of ranks
     * @param _amounts Array of reward amounts (corresponding to ranks)
     */
    function setRewardDistribution(
        uint256 _periodId,
        uint256[] calldata _ranks,
        uint256[] calldata _amounts
    ) external onlyOwner {
        require(pools[_periodId].exists, "Pool does not exist");
        require(_ranks.length == _amounts.length, "Arrays length mismatch");
        require(_ranks.length > 0, "Arrays cannot be empty");
        
        Pool storage pool = pools[_periodId];
        uint256 totalDistributed = 0;
        
        // Validate and set distribution
        for (uint256 i = 0; i < _ranks.length; i++) {
            require(_amounts[i] > 0, "Reward amount must be greater than 0");
            pool.rewardDistribution[_ranks[i]] = _amounts[i];
            totalDistributed += _amounts[i];
        }
        
        // Check if total doesn't exceed pool balance
        uint256 poolBalance = getPoolBalance(_periodId);
        require(totalDistributed <= poolBalance, "Total rewards exceed pool balance");
        
        emit RewardDistributionSet(_periodId, _ranks, _amounts);
    }

    /**
     * @dev Get pool balance (native or ERC20)
     * @param _periodId The period ID
     * @return balance The pool balance
     */
    function getPoolBalance(uint256 _periodId) public view returns (uint256) {
        require(pools[_periodId].exists, "Pool does not exist");
        
        if (pools[_periodId].tokenAddress == address(0)) {
            return address(this).balance;
        } else {
            IERC20 token = IERC20(pools[_periodId].tokenAddress);
            return token.balanceOf(address(this));
        }
    }

    /**
     * @dev Get reward amount for a rank in a period
     * @param _periodId The period ID
     * @param _rank The rank
     * @return rewardAmount The reward amount for this rank
     */
    function getRewardForRank(uint256 _periodId, uint256 _rank) public view returns (uint256) {
        require(pools[_periodId].exists, "Pool does not exist");
        return pools[_periodId].rewardDistribution[_rank];
    }

    /**
     * @dev Check if pool exists
     * @param _periodId The period ID
     * @return exists Whether the pool exists
     */
    function poolExists(uint256 _periodId) external view returns (bool) {
        return pools[_periodId].exists;
    }

    /**
     * @dev Get available periods
     * @return periods Array of period IDs that have pools
     */
    function getAvailablePeriods() external view returns (uint256[] memory) {
        return availablePeriods;
    }

    /**
     * @dev Get claimable reward amount for a user
     * @param _periodId The period ID
     * @param _user The user address
     * @param _rank The user's rank
     * @return rewardAmount The claimable reward amount
     */
    function getClaimableReward(
        uint256 _periodId,
        address _user,
        uint256 _rank
    ) external view returns (uint256) {
        if (!pools[_periodId].exists) {
            return 0;
        }
        if (hasClaimed[_user][_periodId]) {
            return 0;
        }
        return pools[_periodId].rewardDistribution[_rank];
    }

    /**
     * @dev Claim reward using EIP-712 signature
     * @param _periodId The period ID
     * @param _user The user address claiming
     * @param _rank The user's rank
     * @param _rewardAmount The reward amount
     * @param _nonce The nonce for this claim
     * @param _signature The EIP-712 signature from authorized signer
     */
    function claimReward(
        uint256 _periodId,
        address _user,
        uint256 _rank,
        uint256 _rewardAmount,
        uint256 _nonce,
        bytes calldata _signature
    ) external {
        require(pools[_periodId].exists, "Pool does not exist for this period");
        require(!hasClaimed[_user][_periodId], "Reward already claimed for this period");
        require(_rewardAmount > 0, "Reward amount must be greater than 0");
        require(userPeriodNonces[_user][_periodId] == _nonce, "Invalid nonce");
        
        // Verify signature
        bytes32 structHash = keccak256(
            abi.encode(
                CLAIM_TYPEHASH,
                _periodId,
                _user,
                _rank,
                _rewardAmount,
                _nonce
            )
        );
        bytes32 hash = _hashTypedDataV4(structHash);
        address recoveredSigner = hash.recover(_signature);
        require(recoveredSigner == signerAddress, "Invalid signature");
        
        // Verify reward amount matches distribution
        require(
            pools[_periodId].rewardDistribution[_rank] == _rewardAmount,
            "Reward amount mismatch"
        );
        
        // Mark as claimed
        hasClaimed[_user][_periodId] = true;
        userPeriodNonces[_user][_periodId] = _nonce + 1;
        
        // Transfer reward
        if (pools[_periodId].tokenAddress == address(0)) {
            // Native token
            require(address(this).balance >= _rewardAmount, "Insufficient pool balance");
            (bool success, ) = _user.call{value: _rewardAmount}("");
            require(success, "Transfer failed");
        } else {
            // ERC20 token
            IERC20 token = IERC20(pools[_periodId].tokenAddress);
            require(token.balanceOf(address(this)) >= _rewardAmount, "Insufficient pool balance");
            require(token.transfer(_user, _rewardAmount), "Token transfer failed");
        }
        
        emit RewardClaimed(_periodId, _user, _rank, _rewardAmount, hash);
    }

    /**
     * @dev Withdraw funds (admin only, emergency)
     * @param _tokenAddress Token address (address(0) for native)
     * @param _amount Amount to withdraw
     * @param _to Recipient address
     */
    function withdraw(
        address _tokenAddress,
        uint256 _amount,
        address _to
    ) external onlyOwner {
        require(_to != address(0), "Invalid recipient");
        
        if (_tokenAddress == address(0)) {
            require(address(this).balance >= _amount, "Insufficient balance");
            (bool success, ) = _to.call{value: _amount}("");
            require(success, "Transfer failed");
        } else {
            IERC20 token = IERC20(_tokenAddress);
            require(token.balanceOf(address(this)) >= _amount, "Insufficient balance");
            require(token.transfer(_to, _amount), "Token transfer failed");
        }
    }

    // Receive function for native token deposits
    receive() external payable {
        // Allow direct deposits
    }
}

