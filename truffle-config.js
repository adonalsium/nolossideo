'use strict';


module.exports = {
  networks: {
    development: {
        host: "127.0.0.1",
        port: 8545,
        network_id: "*"
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
