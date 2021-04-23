#!/bin/bash

sed -i "1s/^/var JSONbig = require('json-bigint'); \n/" node_modules/express/lib/response.js
sed -i 's/JSON\./JSONbig./g' node_modules/express/lib/response.js
sed -i "1s/^/var JSONbig = require('json-bigint'); \n/" node_modules/body-parser/lib/types/json.js
sed -i 's/JSON\./JSONbig./g' node_modules/body-parser/lib/types/json.js
