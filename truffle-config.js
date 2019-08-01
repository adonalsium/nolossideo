'use strict';

const keys = require("./private.js");
privateKeyMain = keys.main;
privateKeyRopsten = keys.test
var HDWalletProvider = require("truffle-hdwallet-provider");


require('dotenv').config();
const Web3 = require("web3");
const web3 = new Web3();
const WalletProvider = require("truffle-wallet-provider");
const Wallet = require('ethereumjs-wallet');

var mainNetPrivateKey = new Buffer(privateKeyMain, "hex")
var mainNetWallet = Wallet.fromPrivateKey(mainNetPrivateKey);
var mainNetProvider = new WalletProvider(mainNetWallet, "https://mainnet.infura.io/");

var ropstenPrivateKey = new Buffer(privateKeyRopsten, "hex")
var ropstenWallet = Wallet.fromPrivateKey(ropstenPrivateKey);
var ropstenProvider = new WalletProvider(ropstenWallet, "https://ropsten.infura.io/");


module.exports = {
  networks: {
    development: {
      host: "localhost",
      port: 8545,
      network_id: "*" // Match any network id
    },
    ropsten: {
      provider: ropstenProvider,
      // You can get the current gasLimit by running
      // truffle deploy --network rinkeby
      // truffle(rinkeby)> web3.eth.getBlock("pending", (error, result) =>
      //   console.log(result.gasLimit))
      gas: 4600000,
      gasPrice: web3.utils.toWei("20", "gwei"),
      network_id: "3",
    },
    mainnet: {
      provider: mainNetProvider,
      gas: 4600000,
      gasPrice: web3.utils.toWei("20", "gwei"),
      network_id: "1",
    }
  },

  compilers: {
    solc: {
      version: "0.5.0",
    }
  },

  solc: {
    optimizer: {
      enabled: true,
      runs: 1
    }
  },

  mocha: {
    reporter: 'eth-gas-reporter',
    reporterOptions: {
      currency: 'USD',
      gasPrice: 10
    }
  }
};

/*
module.exports = {
  networks: {
    development: {
        host: "127.0.0.1",
        port: 8545,
        network_id: "*"
    }
  },

  
};
*/