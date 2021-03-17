# zksync-forwarder

## Install

Install Node (requires version 14 or higher, run `node --version`). We suggest you to install [nvm](https://github.com/nvm-sh/nvm).

```shell
npm install express
npm install json-rpc-2.0
npm install node-fetch
npm install ethers
npm install zksync
npm install async-mutex
npm install json-bigint
```

Default JSON parser cannot handle big integers, what is required
in our case.
We need to replace default parser with JSONbig and we have to replace
it manually in the libraries. Run

```shell
sed -i "1s/^/var JSONbig = require('json-bigint'); \n/" node_modules/express/lib/response.js
sed -i 's/JSON\./JSONbig./g' node_modules/express/lib/response.js
sed -i "1s/^/var JSONbig = require('json-bigint'); \n/" node_modules/body-parser/lib/types/json.js
sed -i 's/JSON\./JSONbig./g' node_modules/body-parser/lib/types/json.js
```

## Configure

Default settings connect to rinkeby. To override them use environment variables.

- FWD_PRIVATE_KEY - the private key of the forwarder's account
- FWD_ADDRESS - Ethereum address of the forwarder's account
- FWD_JSRPC_ENDPOINT - the endpoint of zksync jsonrpc service
- FWD_GLM_SYMBOL - GNT in rinkeby, GLM in mainnet
- FWD_SUBSIDIZED_FEE_RATE - how much of a fee a client pays, in percent (100 means no subsidies)
- FWD_ZKSYNC_ADDRESS - the address or name of zksync operator, rinkeby or mainnet for instance (needed to instantiate a provider)
- FWD_SERVER_PORT - the port of forwarder

## Run

```
node forwarder.js
```
