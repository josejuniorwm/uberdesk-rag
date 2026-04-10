# Uberdesk RAG - Inteligencia Documental

Sistema de RAG (Retrieval-Augmented Generation) com Node.js, React, Qdrant e Groq.

## Stack

- Llama 3.1 (Groq)
- Xenova (Embeddings)
- Qdrant Cloud
- MySQL
- React
- aaPanel

## Arquitetura

- Frontend em React para autenticacao, chat e gestao de arquivos.
- Backend em Node.js/Express para API de auth, mensagens, arquivos e pipeline RAG.
- MySQL para usuarios, mensagens e metadados de arquivos.
- Qdrant para indice vetorial dos chunks de PDF.
- Groq para geracao de resposta final com contexto recuperado.

## Guia Rapido de Instalacao

### 1) Instalar dependencias

```bash
cd backend && npm install
cd ../frontend && npm install
```

### 2) Subir servicos com Docker Compose

```bash
docker-compose up -d
```

### 3) Executar aplicacoes (modo desenvolvimento)

```bash
# Terminal 1
cd backend
npm start

# Terminal 2
cd frontend
npm start
```

## Variaveis de Ambiente (.env)

Crie um arquivo .env em backend/ com as chaves abaixo:

```env
# Auth
JWT_SECRET=sua_chave_jwt_super_secreta

# Groq
GROQ_API_KEY=sua_chave_groq
GROQ_MODEL=llama-3.1-8b-instant

# Qdrant Cloud
QDRANT_URL=https://SEU_CLUSTER.qdrant.tech
QDRANT_API_KEY=sua_chave_qdrant

# Banco MySQL
DB_HOST=db
DB_USER=dashbyte_user
DB_PASS=sua_senha
DB_NAME=dashbyte_chat
DB_PORT=3306
```

No frontend/, opcionalmente configure:

```env
REACT_APP_API_URL=/api
```

## Fluxo RAG (resumo)

1. Upload do PDF e persistencia do arquivo.
2. Extracao de texto e chunking.
3. Geracao de embeddings (Xenova) e upsert no Qdrant.
4. Pergunta do usuario -> embedding da pergunta.
5. Busca semantica no Qdrant com filtros de usuario/arquivo.
6. Montagem de prompt com contexto e chamada ao Groq.
7. Persistencia da resposta e retorno ao chat.
