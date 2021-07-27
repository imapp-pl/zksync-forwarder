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
const { createJSONRPCErrorResponse } = require("json-rpc-2.0");
const { JSONRPC } = require("json-rpc-2.0");
const fetch = require('node-fetch');
const ethers = require('ethers');
const zksync = require('zksync');
const Semaphore = require('async-mutex').Semaphore;
const JSONbig = require('json-bigint');


var syncProvider;
var gntTokenId;
const ethersProvider = ethers.getDefaultProvider(zksyncAddress);
const ethWallet = new ethers.Wallet(fwdPrivateKey, ethersProvider);
var syncWallet;


let nextID = 0;
const createID = () => nextID++;


// JSONRPCClient needs to know how to send a JSON-RPC request.
// Tell it by passing a function to its constructor. The function must take a JSON-RPC request and send it.
const client = new JSONRPCClient( function (jsonRPCRequest) {
    requestBody = JSONbig.stringify(jsonRPCRequest);
    method = jsonRPCRequest.method;
    jsonRPCRequestId = jsonRPCRequest.id;
    return fetch(zksyncJsrpcEndpoint, {
        method: "POST",
        headers: {
            "content-type": "application/json",
        },
        body: requestBody,
    }).then((response) => {
        if (response.status === 200) {
	        if (method == 'tokens' || method == 'account_info') {
		        console.log('sent ', method, 'request');
	        } else {
                console.log("sent", requestBody);
	        }
            // Use client.receive when you received a JSON-RPC response.
            return response
                .json()     // TODO this does not use JSONbig
                .then((jsonRPCResponse) => {
		            if (method == 'tokens' || method == 'account_info') {
			            console.log('received ', method, 'response');
		            } else {
                        console.log("received", jsonRPCResponse);
		            }
                    client.receive(jsonRPCResponse);
                });
        } else if (jsonRPCRequestId !== undefined) {
            return Promise.resolve(client.receive(
//                createJSONRPCErrorResponse(
//                    jsonRPCRequestId, -32603, 'forwarder http error: status: '+response.status+' statusMessage: '+response.statusText)
                    {
                        jsonrpc: JSONRPC,
                        id: jsonRPCRequestId,
                        error: {
                            code: -32603,
                            message: 'forwarder http error: status: '+response.status+', statusMessage: '+response.statusText,
                            httpCode: response.status
                        }
                    }
                )
            );
        } else {
            return Promise.reject(new Error('forwarder error: jsonRPCRequestId not found'));
        }
    });
}, createID
);


function processError(error, jsonRPCRequest) {
    return {jsonrpc: jsonRPCRequest.jsonrpc, id: jsonRPCRequest.id, error: { code: -32000, message: 'Internal Error: '+error.message }};
}


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
	    return processError(error, jsonRPCRequest);
        });
}


server.addMethod("echo", (obj) => {
    console.log("echo", obj);
    return obj;
});

var startedDate = new Date();
server.addMethod("fwd_status", () => {
    return {"nonce_semaphore_locked": nonce_semaphore.isLocked(), "network": zksyncAddress, "forwarder's eth account": fwdAddress, "started": startedDate};
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
            console.log('get_tx_fee, result undefined');
		    return fResponse;
	    }
        token = jsonRPCRequest.params[2];
        if (token != glmSymbol && token != gntTokenId) {
		    console.log('get_tx_fee, not subsidized token', token);
            return fResponse;
        }
        if (typeof jsonRPCRequest.params[0] == 'object') {    // change pub key
		    console.log('get_tx_fee, change pub key?');
            return fResponse;
        } else {
            if (jsonRPCRequest.params[0] != 'Transfer') {
		        console.log('get_tx_fee, not a transfer');
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
        return processError(error, jsonRPCRequest);
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
        process_client_req();
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
            process_client_req();
        } else {
            ensureTxStatus(tx_hash, depth + 1, max_depth, sem_release);
        }
    }).catch( function(err) {
        console.log("err", err);
        ensureTxStatus(tx_hash, depth + 1, max_depth, sem_release);
    });
}

function sendSubsidizedTxWithNonce(jsonRPCRequests, fwd_transfer, sem_release, resolve_funcs) {
    // returning is not necessary, it is deprecated code
    return syncWallet.signSyncTransfer(fwd_transfer).then( function(signed_fwd_transfer) {
        batch = [];
        for ( i = 0 ; i < jsonRPCRequests.length ; i++) {
            batch.push({"tx": jsonRPCRequests[i].params[0], "signature": jsonRPCRequests[i].params[1]});
        }
        batch.push({"tx": signed_fwd_transfer.tx, "signature": signed_fwd_transfer.ethereumSignature});
        return client.requestAdvanced({jsonrpc: JSONRPC, method: "submit_txs_batch", params: [batch, []], id: createID()}).then( function(batch_resp) {   // send batch, not signed
            if (typeof batch_resp.result == 'undefined') {
	            sem_release();
                responses = [];
                for ( i = 0 ; i < jsonRPCRequests.length ; i++) {
				    response = Object.assign({}, batch_resp);  // TODO better message?
				    response.id = jsonRPCRequests[i].id;
                    responses.push(response);
                    resolve_funcs[i](response);
                }
                process_client_req();
                return responses;
            }
	        max_depth = (waiting_threads == 2) ? 1000000 : 3;   // when third thread gonna wait for the status, let it wait long and block subsequent requests
            ensureTxStatus(batch_resp.result[jsonRPCRequests.length], 0, max_depth, sem_release);        //this function releases the semaphore in a promise
            responses = [];
            for ( i = 0 ; i < jsonRPCRequests.length ; i++) {
                response = {jsonrpc: JSONRPC, id: jsonRPCRequests[i].id, result: batch_resp.result[i]};
                resolve_funcs[i](response);
            }
            return responses;
        }).catch ( (error) => {
	        console.log('error when submit_txs_batch');
            console.log(error);
	        sem_release();
            responses = [];
            for ( i = 0 ; i < jsonRPCRequests.length ; i++) {
                response = processError(error, jsonRPCRequests[i]);
                responses.push(response);
                resolve_funcs[i](response);
            }
            process_client_req();
            return responses;
        });
    });
}

client_req_resolvers = [];
processing = false;

function sendSubsidizedTx(jsonRPCRequest, bn_subsidation_unpacked, bn_exp_fwd_fee) {
    return new Promise(resolve => {
        client_req_resolvers.push([jsonRPCRequest, bn_subsidation_unpacked, bn_exp_fwd_fee, resolve]);
        if (! processing) {
            processing = true;
            new Promise(resolve1 => {
                process_client_req();
                resolve1();
            });
        }
    });
}

function process_client_req() {
    if (client_req_resolvers.length == 0) {
        processing = false;
        return;
    }

    jsonRPCRequests = [];
    resolve_funcs = [];
    [jsonRPCRequest_0, bn_subsidation_unpacked_0, bn_exp_fwd_fee_0, resolve_0] = client_req_resolvers.shift();
    client_address = jsonRPCRequest_0.params[0].from;
    jsonRPCRequests.push(jsonRPCRequest_0);
    bn_subsidation_unpacked = bn_subsidation_unpacked_0;
    bn_exp_fwd_fee = bn_exp_fwd_fee_0;
    resolve_funcs.push(resolve_0);
    for ( i = 0 ; i < client_req_resolvers.length ; i ++) {
        [jsonRPCRequest_i, bn_subsidation_unpacked_i, bn_exp_fwd_fee_i, resolve_i] = client_req_resolvers[i];
        if (client_address == jsonRPCRequest_i.params[0].from) {
            jsonRPCRequests.push(jsonRPCRequest_i);
            bn_subsidation_unpacked = bn_subsidation_unpacked.add(bn_subsidation_unpacked_i);
            bn_exp_fwd_fee = bn_exp_fwd_fee_i;  // the last one is taken
            resolve_funcs.push(resolve_i);
            client_req_resolvers.splice(i, 1);
            i--;
        }
    }
    bn_batch_fee_unpacked = bn_subsidation_unpacked.add(bn_exp_fwd_fee);
    bn_batch_fee = zksync.utils.closestGreaterOrEqPackableTransactionFee(bn_batch_fee_unpacked);

    // returning is not necessary, it is deprecated code
    return nonce_semaphore.acquire().then( function([sem_value, sem_release]) {  // acquire the semaphore
        try {
		    if (waiting_threads == 0) {
                return client.requestAdvanced({jsonrpc: JSONRPC, method: "account_info", params: [fwdAddress], id: createID()}).then( function(fwd_account_resp) {
			        if (typeof fwd_account_resp.result == 'undefined') {
				        sem_release();
                        responses = [];
                        for ( i = 0 ; i < jsonRPCRequests.length ; i++) {
				            response = Object.assign({}, fwd_account_resp);  // TODO return something else
				            response.id = jsonRPCRequests[i].id;
                            responses.push(response);
                            resolve_funcs[i](response);
                        }
                        process_client_req();
                        return responses;
			        }
			        last_nonce = fwd_account_resp.result.committed.nonce;
                    fwd_transfer = {             // sign forwarder's transaction
                        to: fwdAddress,
                        token: glmSymbol,
                        amount: ethers.utils.parseEther("0.0"),
                        fee: bn_batch_fee,
                        nonce: last_nonce
                    };
                    return sendSubsidizedTxWithNonce(jsonRPCRequests, fwd_transfer, sem_release, resolve_funcs);
                }).catch( function(err) {
			        console.log('error getNonce');
			        console.log(err);
                    sem_release();                 // release the semaphore in case of an exception
                    responses = [];
                    for ( i = 0 ; i < jsonRPCRequests.length ; i++) {
                        response = processError(err, jsonRPCRequests[i]);
                        responses.push(response);
                        resolve_funcs[i](response);
                    }
                    process_client_req();
                    return responses;
                });
		    } else {
                fwd_transfer = {             // sign forwarder's transaction
                    to: fwdAddress,
                    token: glmSymbol,
                    amount: ethers.utils.parseEther("0.0"),
                    fee: bn_batch_fee,
                    nonce: last_nonce+waiting_threads
                };
                return sendSubsidizedTxWithNonce(jsonRPCRequests, fwd_transfer, sem_release, resolve_funcs);
		    }
        } catch (er) {
		    console.log('error sendSubsidizedTx');
		    console.log(er);
            sem_release();            // just in case
            responses = [];
            for ( i = 0 ; i < jsonRPCRequests.length ; i++) {
                response = processError(er, jsonRPCRequests[i]);
                responses.push(response);
                resolve_funcs[i](response);
            }
            process_client_req();
            return responses;
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
		        bn_subsidation_unpacked = bn_exp_client_fee.sub(bn_subs_client_fee);
		    } else {
		        bn_subsidation_unpacked = bn_exp_client_fee.sub(bn_rcv_client_fee);
		    }

		    return sendSubsidizedTx(jsonRPCRequest, bn_subsidation_unpacked, bn_exp_fwd_fee);

		}).catch( (error) => {
		    console.log('error get_tx_fee 2');
            console.log(error);
            return processError(error, jsonRPCRequest);
		});
    }).catch( (error) => {
	    console.log('error get_tx_fee 1');
        console.log(error);
	    return processError(error, jsonRPCRequest);
    });
});


const app = express();
app.use(bodyParser.json());

app.post("", (req, res) => {
    const jsonRPCRequest = req.body;          // body is already parsed
    // server.receive takes a JSON-RPC request and returns a promise of a JSON-RPC response.
    server.receive(jsonRPCRequest).then((jsonRPCResponse) => {
        if (jsonRPCResponse) {
            if (jsonRPCResponse.error && jsonRPCResponse.error.httpCode) {
                console.log("client request", jsonRPCRequest);
                console.log("response", "http status:", jsonRPCResponse.error.httpCode, "message:", jsonRPCResponse.error.message);
                let httpCode = jsonRPCResponse.error.httpCode == 520 ? 504 : jsonRPCResponse.error.httpCode;
                res.status(httpCode).send(jsonRPCResponse.error.message);
            } else {
	        if (jsonRPCRequest.method == 'tokens' || jsonRPCRequest.method == 'account_info') {
		        console.log("client request", jsonRPCRequest.method);
                console.log("response", jsonRPCRequest.method);
	        } else {
                console.log("client request", jsonRPCRequest);
                console.log("response", jsonRPCResponse);
	        }
            res.json(jsonRPCResponse);           //stringifies and sets headers
            }
        } else {
            // If response is absent, it was a JSON-RPC notification method.
            // Respond with no content status (204).
            res.sendStatus(204);
        }
    }).catch( (error) => {
        console.log("client request", jsonRPCRequest);
        console.log("response", error);
        res.status(500).send(error.message);
    });
});


zksync.getDefaultProvider(zksyncAddress).then(function(sProvider) {
    syncProvider = sProvider;
    gntTokenId = syncProvider.tokenSet.resolveTokenId(glmSymbol);
    zksync.Wallet.fromEthSigner(ethWallet, syncProvider).then(function(sWallet){
        syncWallet = sWallet;
        console.log("Starting (", zksyncAddress, ", ", fwdAddress, ") ...");
        app.listen(serverPort);
    });
}).catch(function(error) {
    console.log('error during the start, exiting ...', error);
});

