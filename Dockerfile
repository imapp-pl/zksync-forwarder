FROM node:14
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install
COPY fix_json.sh ./
RUN chmod +x ./fix_json.sh
RUN ./fix_json.sh
RUN apt-get update && apt-get install -y apache2
COPY apache2.conf /etc/apache2/apache2.conf
COPY ports.conf /etc/apache2/ports.conf
COPY . .

