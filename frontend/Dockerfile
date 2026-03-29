FROM node:20-slim

# Instala dependências básicas do sistema para o build
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

# Usa --legacy-peer-deps para evitar conflitos de dependencias do template base
RUN npm install --legacy-peer-deps --network-timeout=100000

COPY . .
ENV HOST=0.0.0.0
EXPOSE 3000

CMD ["npm", "start"]