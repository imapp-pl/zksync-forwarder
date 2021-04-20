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


let nextID = 0;
const createID = () => nextID++;


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
    }), createID
);


const server = new JSONRPCServer();
const nonce_semaphore = new Semaphore(1);
var last_nonce = 0;
var waiting_threads = 0;

function forwardRequestAdvanced(jsonRPCRequest) {
    reqId = createID();
    fRequest = {
	"jsonrpc":jsonRPCRequest.jsonrpc,
	"method":jsonRPCRequest.method,
	"params":jsonRPCRequest.params,
	"id":reqId
    };
    return client.requestAdvanced(fRequest).then( (fResponse) => {
	    fResponse.id = jsonRPCRequest.id;
	    return fResponse;
	}).catch( (error) => {
	    console.log('error forwardRequestAdvanced');
	    console.log(error);
	    throw error;  // TODO maybe somehow better?
        });
}


server.addMethod("echo", (obj) => {
    console.log("echo", obj);
    return obj;
});

server.addMethod("fwd_status", () => {
    return {"nonce_semaphore_locked": nonce_semaphore.isLocked()};
});

server.addMethodAdvanced("contract_address", (jsonRPCRequest) => {
    return forwardRequestAdvanced(jsonRPCRequest);
});

server.addMethodAdvanced("tokens", (jsonRPCRequest) => {
    return forwardRequestAdvanced(jsonRPCRequest);
});

server.addMethodAdvanced("get_tx_fee", (jsonRPCRequest) => {
    reqId = createID();
    fRequest = {
        "jsonrpc":jsonRPCRequest.jsonrpc,
        "method":jsonRPCRequest.method,
        "params":jsonRPCRequest.params,
        "id":reqId
    };
    return client.requestAdvanced(fRequest).then( (fResponse) => {
            fResponse.id = jsonRPCRequest.id;
	    if (typeof fResponse.result == 'undefined') {
		return fResponse;
	    }
            token = fRequest.params[2];
            if (token != glmSymbol && token != gntTokenId) {
                return fResponse;
            }
            if (typeof fRequest.params[0] == 'object') {    // change pub key
                return fResponse;
            } else {
                if (fRequest.params[0] != 'Transfer') {
                    return fResponse;
                }
            }
            bn_fee = ethers.BigNumber.from(fResponse.result.totalFee);
            bn_subs_fee = zksync.utils.closestPackableTransactionFee(bn_fee.mul(subsidizedFeeRate).div(100));
            subs_fee = bn_subs_fee.toString();
            fResponse.result.totalFee = subs_fee;    // only totalFee is changed when subsidizing
            return fResponse;
        }).catch( (error) => {
	    console.log('error get_tx_fee');
            console.log(error);
            throw error;  // TODO maybe somehow better?
        });
});

server.addMethodAdvanced("get_txs_batch_fee_in_wei", (jsonRPCRequest) => {
    return forwardRequestAdvanced(jsonRPCRequest);
});

server.addMethodAdvanced("account_info", (jsonRPCRequest) => {
    return forwardRequestAdvanced(jsonRPCRequest);
});

server.addMethodAdvanced("tx_info", (jsonRPCRequest) => {
    return forwardRequestAdvanced(jsonRPCRequest);
});

function ensureTxStatus(tx_hash, depth, max_depth,  sem_release) {
    if (depth == max_depth) {
        console.log("releasing the semaphore, too many tries");
	waiting_threads++;
        sem_release();                               // give up and release the semaphore
        return;
    }
    if (depth > 0) {
        console.log("must check tx status again");
    }
    req = client.request("tx_info", [tx_hash]);
    req.then( function(tx_status) {
            if (tx_status.executed) {   // if the transaction was executed, whether successfully or not
		waiting_threads = 0;
                sem_release();                               // release the semaphore when the transaction is added to a block or not
            } else {
                ensureTxStatus(tx_hash, depth + 1, max_depth, sem_release);
            }
        }).catch( function(err) {
            console.log("err", err);
            ensureTxStatus(tx_hash, depth + 1, max_depth, sem_release);
        });
}

function sendSubsidizedTxWithNonce(jsonRPCRequest, fwd_transfer, sem_release) {
                        return syncWallet.signSyncTransfer(fwd_transfer).then( function(signed_fwd_transfer) {
                                batch = [
                                    {"tx": jsonRPCRequest.params[0], "signature": jsonRPCRequest.params[1]},
                                    {"tx": signed_fwd_transfer.tx, "signature": signed_fwd_transfer.ethereumSignature}
                                ];
                                return client.requestAdvanced({jsonrpc: jsonRPCRequest.jsonrpc, method: "submit_txs_batch", params: [batch, []], id: createID()}).then( function(batch_resp) {   // send batch, not signed
                                        if (typeof batch_resp.result == 'undefined') {
                                            batch_resp.id = jsonRPCRequest.id;
                                            return batch_resp;
                                        }
					max_depth = (waiting_threads == 2) ? 1000000 : 3;
                                        ensureTxStatus(batch_resp.result[1], 0, max_depth, sem_release);        //this function releases the semaphore in a promise
                                        return {jsonrpc: jsonRPCRequest.jsonrpc, id: jsonRPCRequest.id, result: batch_resp.result[0]};
                                    }).catch ( (error) => {
					console.log('error when submit_txs_batch');
                                        console.log(error);
					sem_release();
                                        throw error;  // TODO maybe somehow better?
                                    });
                            });

}

function sendSubsidizedTx(jsonRPCRequest, bn_batch_fee) {
    return nonce_semaphore.acquire().then( function([sem_value, sem_release]) {  // acquire the semaphore
            try {
		if (waiting_threads == 0) {
                    return syncWallet.getNonce().then( function(fwd_nonce) {
			    last_nonce = fwd_nonce;
                            fwd_transfer = {             // sign forwarder's transaction
                                to: fwdAddress,
                                token: glmSymbol,
                                amount: ethers.utils.parseEther("0.0"),
                                fee: bn_batch_fee,
                                nonce: fwd_nonce
                            };
                            return sendSubsidizedTxWithNonce(jsonRPCRequest, fwd_transfer, sem_release);
                        }).catch( function(err) {
                            sem_release();                 // release the semaphore in case of an exception
                            throw err;
                        });
		} else {
                    fwd_transfer = {             // sign forwarder's transaction
                        to: fwdAddress,
                        token: glmSymbol,
                        amount: ethers.utils.parseEther("0.0"),
                        fee: bn_batch_fee,
                        nonce: last_nonce+waiting_threads
                    };
                    return sendSubsidizedTxWithNonce(jsonRPCRequest, fwd_transfer, sem_release);
		}
            } catch (er) {
                sem_release();            // just in case
                throw er;
            }
        });
}

server.addMethodAdvanced("tx_submit", (jsonRPCRequest) => {
    if (typeof jsonRPCRequest.params[0].type == 'object') {    // change pub key
        return forwardRequestAdvanced(jsonRPCRequest);
    } else {
        if (jsonRPCRequest.params[0].type != 'Transfer') {
            return forwardRequestAdvanced(jsonRPCRequest);
        }
    }
    if (jsonRPCRequest.params[0].token != glmSymbol && jsonRPCRequest.params[0].token != gntTokenId) {
        return forwardRequestAdvanced(jsonRPCRequest);
    }

    return client.requestAdvanced({jsonrpc: jsonRPCRequest.jsonrpc, method: "get_tx_fee", params: ["Transfer", jsonRPCRequest.params[0].to, glmSymbol], id: createID()}).then(function(exp_client_tx_fee_resp){    // get original client's fee
            if (typeof exp_client_tx_fee_resp.result == 'undefined') {
                exp_client_tx_fee_resp.id = jsonRPCRequest.id;
                return exp_client_tx_fee_resp;  // TODO maybe another error code?
	    }
	    exp_client_tx_fee = exp_client_tx_fee_resp.result;
	    bn_exp_client_fee = ethers.BigNumber.from(exp_client_tx_fee.totalFee);
	    bn_subs_client_fee = zksync.utils.closestPackableTransactionFee(bn_exp_client_fee.mul(subsidizedFeeRate).div(100));
	    return client.requestAdvanced({jsonrpc: jsonRPCRequest.jsonrpc, method: "get_tx_fee", params: ["Transfer", fwdAddress, glmSymbol], id: createID()}).then(function(exp_fwd_tx_fee_resp){   // get original forwarder's fee
		    if (typeof exp_fwd_tx_fee_resp.result == 'undefined') {
                        exp_fwd_tx_fee_resp.id = jsonRPCRequest.id;
                        return exp_fwd_tx_fee_resp;  // TODO maybe another error code?
                    }
                    exp_fwd_tx_fee = exp_fwd_tx_fee_resp.result;
		    bn_exp_fwd_fee = ethers.BigNumber.from(exp_fwd_tx_fee.totalFee);
		    bn_rcv_client_fee = ethers.BigNumber.from(jsonRPCRequest.params[0].fee);
		    if (bn_rcv_client_fee.gte(bn_exp_client_fee)) {  // if it does not need subsidizing
                        return forwardRequestAdvanced(jsonRPCRequest);
		    }
		    if (bn_rcv_client_fee.lt(bn_subs_client_fee)) {   // client's fee is too low, we pass tx anyway but subsidising is limited
		        bn_batch_fee_unpacked = bn_exp_client_fee.add(bn_exp_fwd_fee).sub(bn_subs_client_fee);
		    } else {
		        bn_batch_fee_unpacked = bn_exp_client_fee.add(bn_exp_fwd_fee).sub(bn_rcv_client_fee);
		    }
		    bn_batch_fee = zksync.utils.closestGreaterOrEqPackableTransactionFee(bn_batch_fee_unpacked);

		    return sendSubsidizedTx(jsonRPCRequest, bn_batch_fee);

		}).catch( (error) => {
		    console.log('error get_tx_fee 2');
                    console.log(error);
                    throw error;  // TODO maybe somehow better?
		});
        }).catch( (error) => {
	    console.log('error get_tx_fee 1');
            console.log(error);
	    throw error;  // TODO maybe somehow better?
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
}).catch(function(error) {
    console.log('error when starting, exiting ...', error);
});

