import * as dotenv from "dotenv";
import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

dotenv.config({ quiet: true });

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      evmVersion: "paris",
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    bsc: {
      url: process.env.BNB_MAINNET_RPC_URL,
      accounts: [process.env.BNB_MAINNET_PRIVATE_KEY || "0x"],
    },
    bscTestnet: {
      url: process.env.BNB_TESTNET_RPC_URL,
      accounts: [process.env.BNB_TESTNET_PRIVATE_KEY || "0x"],
    },
    mst: {
      url: process.env.MST_MAINNET_RPC_URL,
      accounts: [process.env.MST_MAINNET_PRIVATE_KEY || "0x"],
    },
    mstTestnet: {
      url: process.env.MST_TESTNET_RPC_URL,
      accounts: [process.env.MST_TESTNET_PRIVATE_KEY || "0x"],
    },
  },
  etherscan: {
    apiKey: {
      bsc: process.env.ETHERSCAN_API_KEY || "",
      bscTestnet: process.env.ETHERSCAN_API_KEY || "",
      mst: "empty",
      mstTestnet: "empty",
    },
    customChains: [
      {
        network: "mst",
        chainId: 4646,
        urls: {
          apiURL: "https://mstscan.com/api",
          browserURL: "https://mstscan.com/",
        },
      },
      {
        network: "mstTestnet",
        chainId: 4545,
        urls: {
          apiURL: "https://testnet.mstscan.com/api",
          browserURL: "https://testnet.mstscan.com/",
        },
      },
    ],
  },
};

export default config;
