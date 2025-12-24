# TweetTradeBot Contracts

Smart contracts for the TweetTradeBot ecosystem, built with Solidity and Hardhat. Features an XP reward pool system with EIP-712 signed claims for secure, gas-efficient reward distribution.

## 📋 Overview

This repository contains the smart contract infrastructure for the TweetTradeBot platform, specifically focusing on the XP Reward Pool system that enables period-based reward distributions with cryptographic verification.

### 🏆 XPRewardPool Contract

The `XPRewardPool` contract provides:
- **Period-based rewards**: Native METIS rewards distributed over configurable time periods
- **EIP-712 signatures**: Gas-efficient claim verification using off-chain signatures
- **Flexible scheduling**: Versioned period configurations allowing duration changes without renumbering past periods
- **Rank-based distributions**: Support for top-N reward distributions with configurable amounts per rank
- **Security features**: Owner-controlled operations with comprehensive access controls

## 🚀 Features

- **🔐 Secure Claims**: EIP-712 typed signatures for gas-efficient verification
- **⏰ Period Management**: Configurable time periods with automatic ID calculation
- **💰 Native METIS Rewards**: Direct native token distributions
- **📊 Rank-based System**: Support for top-N leaderboard rewards
- **🔄 Versioned Configs**: Period configurations that can evolve over time
- **🛡️ OpenZeppelin Security**: Built on audited, battle-tested contracts

## 📋 Prerequisites

- Node.js v16 or higher
- npm or yarn
- Access to Ethereum-compatible network (Metis, etc.)

## 🛠 Installation

```bash
# Clone the repository
git clone <repository-url>
cd tweettradebot-contracts

# Install dependencies
npm install
```

## ⚙️ Configuration

Create a `.env` file in the root directory:

```env
# Network Configuration
ETH_RPC_URL=https://andromeda.metis.io
CHAIN_ID=1088
ETH_PRIVATE_KEY=your_private_key_here

# Contract Verification (optional)
METIS_SCAN_API_KEY=your_metis_scan_api_key

# Reward Pool Configuration (optional)
REWARD_SIGNER_PRIVATE_KEY=your_signer_private_key
REWARD_SIGNER_ADDRESS=0x... # Alternative to private key
```

## 📜 Usage

### 🧪 Testing

Run the test suite:

```bash
npm test
```

### 🚀 Deployment

Deploy to Metis network:

```bash
# Deploy XP Reward Pool
npx hardhat run scripts/deploy_xp_reward_pool_metis.js --network metis
```

### 🔍 Verification

Verify contracts on block explorer:

```bash
# Verify XP Reward Pool
npx hardhat verify --network metis <CONTRACT_ADDRESS> <OWNER_ADDRESS> <SIGNER_ADDRESS>
```

### 🏗️ Development

#### Local Development

```bash
# Compile contracts
npx hardhat compile

# Run local network
npx hardhat node

# Deploy to local network
npx hardhat run scripts/deploy_xp_reward_pool_metis.js --network localhost
```

#### Contract Architecture

The `XPRewardPool` contract implements:

```solidity
contract XPRewardPool is Ownable, EIP712 {
    // Period management with versioned configurations
    // EIP-712 signed claims for gas-efficient verification
    // Rank-based reward distributions
    // Native METIS token transfers
}
```

#### Key Functions

- `addPeriodConfig()`: Add new period configurations
- `createPool()`: Create reward pools for specific periods
- `setDistribution()`: Configure reward amounts per rank
- `claim()`: Claim rewards with EIP-712 signature verification

## 📚 API Reference

### Period Management

```javascript
// Add a new period configuration
await contract.addPeriodConfig(startTimestamp, durationSeconds);

// Calculate period ID for a timestamp
const periodId = await contract.calculatePeriodId(timestamp);
```

### Pool Management

```javascript
// Create a reward pool (requires METIS deposit)
await contract.createPool(periodId, totalReward, { value: totalReward });

// Set rank-based distribution
await contract.setDistribution(periodId, ranks, amounts);
```

### Claiming Rewards

```javascript
// Claim reward with signature verification
await contract.claim(periodId, rank, rewardAmount, nonce, signature);
```

## 🧪 Testing

The test suite covers:

- Period ID calculations across configuration changes
- Pool creation and funding
- Distribution setup and validation
- Claim verification with valid/invalid signatures
- Security edge cases and error conditions

```bash
# Run all tests
npm test

# Run with gas reporting
npx hardhat test --gas

# Run with coverage
npx hardhat coverage
```

## 🔒 Security

This contract has been built with security in mind:

- **OpenZeppelin Contracts**: Uses audited, battle-tested base contracts
- **EIP-712 Signatures**: Cryptographically secure claim verification
- **Access Controls**: Owner-only administrative functions
- **Input Validation**: Comprehensive parameter validation
- **Reentrancy Protection**: Built on Solidity's secure patterns

### Security Considerations

- Always verify signatures before claiming
- Use secure key management for the signer private key
- Monitor contract activity on block explorers
- Implement rate limiting on off-chain signing services

## 📝 Scripts

### Deployment Scripts
- `deploy_xp_reward_pool_metis.js`: Deploy XP Reward Pool to Metis network

### Utility Scripts
- `print_verify_args_xp_reward_pool.js`: Generate verification arguments
- `e2e_claim_local.js`: End-to-end claim testing

## 📄 License

ISC License - see LICENSE file for details.

## 🔗 Links

- [Metis Network](https://metis.io/)
- [Andromeda Explorer](https://andromeda-explorer.metis.io/)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts/)
- [EIP-712 Specification](https://eips.ethereum.org/EIPS/eip-712)
