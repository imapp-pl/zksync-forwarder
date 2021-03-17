const fwdPrivateKey = process.env.FWD_PRIVATE_KEY ?? '0x36a383971dd01933b98252c087aa13e351fbb97424fa695a70a0c26d4296f99f';
const fwdAddress = process.env.FWD_ADDRESS ?? '0xE6a4157Ab958de300A5E894487B4a745e936f41a';
const zksyncJsrpcEndpoint = process.env.FWD_JSRPC_ENDPOINT ?? 'https://rinkeby-api.zksync.io/jsrpc';
const glmSymbol = process.env.FWD_GLM_SYMBOL ?? 'tGLM';
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
const Semaphore = require('async-mutex').Semaphore;
const JSONbig = require('json-bigint');

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
        body: JSONbig.stringify(jsonRPCRequest),
    }).then((response) => {
        if (response.status === 200) {
            console.log("sent", JSONbig.stringify(jsonRPCRequest));
            // Use client.receive when you received a JSON-RPC response.
            return response
                .json()     // TODO this does not use JSONbig
                .then((jsonRPCResponse) => {
                    console.log("received", jsonRPCResponse);
                    client.receive(jsonRPCResponse);
                });
        } else if (jsonRPCRequest.id !== undefined) {
            return Promise.reject(new Error(response.statusText));
        }
    })
);



const server = new JSONRPCServer();
const nonce_semaphore = new Semaphore(1);

server.addMethod("echo", (obj) => {
    console.log("echo", obj);
    return obj;
});
server.addMethod("fwd_status", () => {
    return {"nonce_semaphore_locked": nonce_semaphore.isLocked()};
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
		if (token != glmSymbol && token != gntTokenId) {
			return tx_fee;
		}
		if (typeof req[0] == 'object') {    // change pub key
			return tx_fee;
		} else {
		    if (req[0] != 'Transfer') {
			    return tx_fee;
		    }
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
	if (typeof req[0].type == 'object') {    // change pub key
		return client.request("tx_submit", req);
	} else {
		if (req[0].type != 'Transfer') {
			return client.request("tx_submit", req);
		}
	}
	if (req[0].token != glmSymbol && req[0].token != gntTokenId) {
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
		    return nonce_semaphore.acquire().then(function([sem_value, sem_release]) {  // acquire the semaphore
		        try {
		            return syncWallet.getNonce().then(function(fwd_nonce){
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
                            return client.request("submit_txs_batch", [batch, []]).then(function(batch_resp){   // send batch
                                client.request("tx_info", [batch_resp[1]]).finally(function(){
                                    sem_release();                               // release the semaphore when the transaction is added to a block
                                });
                                return batch_resp[0];
                            });
                        });
		            }).catch(function(err){
		                sem_release();                 // release the semaphore in case of an exception
		                throw err;
		            });
		        } catch (er) {
		            sem_release();            // just in case
		            throw er;
		        }
		    });
		});
	});
});


const app = express();
app.use(bodyParser.json());

app.post("", (req, res) => {
    const jsonRPCRequest = req.body;          // body is already parsed
    // server.receive takes a JSON-RPC request and returns a promise of a JSON-RPC response.
    server.receive(jsonRPCRequest).then((jsonRPCResponse) => {
        if (jsonRPCResponse) {
            console.log("client request", jsonRPCRequest);
            console.log("response", jsonRPCResponse);
            res.json(jsonRPCResponse);           //stringifies and sets headers
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

