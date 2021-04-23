FROM node:14
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY fix_json.sh ./
RUN chmod +x ./fix_json.sh
RUN ./fix_json.sh
COPY . .

