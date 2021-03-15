const fwdPrivateKey = process.env.FWD_PRIVATE_KEY ?? '0x03e6cff5924d435791fb9cd1db7ecce6455475429277869aae39ee3e339fd15b';
const fwdAddress = process.env.FWD_ADDRESS ?? '0xFb4BF0D377D68Bc952E686494254BBC468f0e0d0';
const zksyncJsrpcEndpoint = process.env.FWD_JSRPC_ENDPOINT ?? 'https://rinkeby-api.zksync.io/jsrpc';
const glmSymbol = process.env.FWD_GLM_SYMBOL ?? 'GNT';
const subsidizedFeeRate = process.env.FWD_SUBSIDIZED_FEE_RATE ?? 20;    // how much of a fee a client pays, in percent (100 means no subsidies)
const zksyncAddress = process.env.FWD_ZKSYNC_ADDRESS ?? 'rinkeby';
const serverPort = process.env.FWD_SERVER_PORT ?? 3030;


const express = require("express");
const bodyParser = require("body-parser");
const { JSONRPCServer } = require("json-rpc-2.0");
const { JSONRPCClient } = require("json-rpc-2.0");
const fetch = require('node-fetch');
const ethers = require('ethers');
const zksync = require('zksync');


var syncProvider;
var gntTokenId;
const ethersProvider = ethers.getDefaultProvider('https://rinkeby.infura.io/v3/f7144cb8b8dc4522afb8ad054154b083');
const ethWallet = new ethers.Wallet(fwdPrivateKey, ethersProvider);
var syncWallet;


// JSONRPCClient needs to know how to send a JSON-RPC request.
// Tell it by passing a function to its constructor. The function must take a JSON-RPC request and send it.
const client = new JSONRPCClient((jsonRPCRequest) =>
    fetch(zksyncJsrpcEndpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: JSON.stringify(jsonRPCRequest),
    }).then((response) => {
        if (response.status === 200) {
            // Use client.receive when you received a JSON-RPC response.
            return response
                .json()
                .then((jsonRPCResponse) => client.receive(jsonRPCResponse));
        } else if (jsonRPCRequest.id !== undefined) {
            return Promise.reject(new Error(response.statusText));
        }
    })
);



const server = new JSONRPCServer();

server.addMethod("echo", (obj) => {
    console.log("echo", obj);
    return obj;
});
server.addMethod("contract_address", () => {
	return client.request("contract_address",);
});
server.addMethod("tokens", () => {
    return client.request("tokens",);
});
server.addMethod("get_tx_fee", (req) => {
    return client.request("get_tx_fee", req).then(function(tx_fee) {
		token = req[2];
		if (token != glmSymbol || req[0] != 'Transfer') {
			return tx_fee;
		}
		bn_fee = ethers.BigNumber.from(tx_fee.totalFee);
		bn_subs_fee = zksync.utils.closestPackableTransactionFee(bn_fee.mul(subsidizedFeeRate).div(100));
		subs_fee = bn_subs_fee.toString();
		tx_fee.totalFee = subs_fee;
		return tx_fee;
	});
});
server.addMethod("get_txs_batch_fee_in_wei", (req) => {
    return client.request("get_txs_batch_fee_in_wei", req);
});
server.addMethod("account_info", (req) => {
    return client.request("account_info", req);
});
server.addMethod("tx_info", (req) => {
    return client.request("tx_info", req);
});
server.addMethod("tx_submit", (req) => {
	if (req[0].type != 'Transfer') {
		return client.request("tx_submit", req);
	}
	if (req[0].token != gntTokenId) {
        return client.request("tx_submit", req);
	}
	return client.request("get_tx_fee", ["Transfer", req[0].to, glmSymbol]).then(function(exp_client_tx_fee){
		bn_exp_client_fee = ethers.BigNumber.from(exp_client_tx_fee.totalFee);
		bn_subs_client_fee = zksync.utils.closestPackableTransactionFee(bn_exp_client_fee.mul(subsidizedFeeRate).div(100));
		return client.request("get_tx_fee", ["Transfer", fwdAddress, glmSymbol]).then(function(exp_fwd_tx_fee){
		    bn_exp_fwd_fee = ethers.BigNumber.from(exp_fwd_tx_fee.totalFee);
		    bn_rcv_client_fee = ethers.BigNumber.from(req[0].fee);
		    if (bn_rcv_client_fee.gte(bn_exp_client_fee)) {  // if it does not need subsidizing
                return client.request("tx_submit", req);
		    }
		    if (bn_rcv_client_fee.lt(bn_subs_client_fee)) {   // client's fee is too low, we pass tx anyway but subsidising is limited
		        bn_batch_fee_unpacked = bn_exp_client_fee.add(bn_exp_fwd_fee).sub(bn_subs_client_fee);
		    } else {
		        bn_batch_fee_unpacked = bn_exp_client_fee.add(bn_exp_fwd_fee).sub(bn_rcv_client_fee);
		    }
		    bn_batch_fee = zksync.utils.closestGreaterOrEqPackableTransactionFee(bn_batch_fee_unpacked);
		    return syncWallet.getNonce().then(function(fwd_nonce){  //TODO worth to sync this
		        fwd_transfer = {             // sign forwarder's transaction
                        to: fwdAddress,
                        token: glmSymbol,
                        amount: ethers.utils.parseEther("0.0"),
                        fee: bn_batch_fee,
                        nonce: fwd_nonce
                    };
		        return syncWallet.signSyncTransfer(fwd_transfer).then(function(signed_fwd_transfer){
                    batch = [
                            {"tx": req[0], "signature": req[1]},
                            {"tx": signed_fwd_transfer.tx, "signature": signed_fwd_transfer.ethereumSignature}
                        ];
                    return client.request("submit_txs_batch", [batch, []]).then(function(res){   // send batch
                        return syncWallet.getNonce().then(function(fwd_nonce2){
                            //console.log('nonce2', fwd_nonce2);
                            return res[0];   //TODO wait for my tx
                        });
                    });
                });
		    });
		});
	});
});


const app = express();
app.use(bodyParser.json());

app.post("", (req, res) => {
    const jsonRPCRequest = req.body;
    // server.receive takes a JSON-RPC request and returns a promise of a JSON-RPC response.
    server.receive(jsonRPCRequest).then((jsonRPCResponse) => {
        if (jsonRPCResponse) {
            console.log("client request", jsonRPCRequest);
            console.log("response", jsonRPCResponse);
            res.json(jsonRPCResponse);
        } else {
            // If response is absent, it was a JSON-RPC notification method.
            // Respond with no content status (204).
            res.sendStatus(204);
        }
    });
});


zksync.getDefaultProvider(zksyncAddress).then(function(sProvider) {
    syncProvider = sProvider;
    gntTokenId = syncProvider.tokenSet.resolveTokenId(glmSymbol);
    zksync.Wallet.fromEthSigner(ethWallet, syncProvider).then(function(sWallet){
        syncWallet = sWallet;
        console.log("Starting ...");
        app.listen(serverPort);
    });
});

