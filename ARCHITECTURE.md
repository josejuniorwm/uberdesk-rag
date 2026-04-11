# Arquitetura Técnica do Sistema RAG SaaS Multi-Tenant

## Visão Geral do Sistema

O **Uberdesk RAG SaaS** é uma plataforma de Retrieval-Augmented Generation (RAG) multi-tenant que permite às empresas fazer upload de documentos PDF e interagir com um assistente de IA baseado em seus conteúdos. O sistema utiliza isolamento rigoroso entre tenants para garantir que os dados de uma empresa nunca sejam acessíveis a outra.

### Funcionalidades Principais
- **Ingestão de PDFs**: Upload e processamento automático de documentos PDF com extração de texto e indexação vetorial
- **Chat Isolado por Empresa**: Conversas baseadas exclusivamente nos documentos da empresa do usuário
- **Sessões de Chat Persistentes**: Criação, listagem, abertura, renomeação e exclusão de chats salvos
- **Gerenciamento de Projetos**: Estrutura hierárquica de projetos dentro de empresas
- **Autenticação JWT**: Sistema de login seguro com tokens de 7 dias
- **Pipeline RAG Completo**: Embedding local, busca semântica no Qdrant e geração de respostas via Groq API

### Tecnologias Core
- **Backend**: Node.js/Express com pipeline RAG
- **Frontend**: React SPA com roteamento protegido
- **Banco Relacional**: MySQL 8.0 para metadados e isolamento multi-tenant
- **Banco Vetorial**: Qdrant Cloud para indexação semântica
- **LLM**: Groq API (Llama 3.1) para geração de respostas
- **Infraestrutura**: Docker Compose com containers isolados

## Arquitetura Multi-Tenant e Isolamento

O sistema implementa **3 camadas de segurança** para garantir isolamento completo entre empresas:

### 1. Sessão via JWT (Camada de Autenticação)
- Tokens JWT contêm `empresaId` e `userId` do usuário logado
- Todas as requisições são validadas pelo middleware `authenticateToken`
- O payload decodificado injeta o contexto do tenant em `req.user`

### 2. Isolamento Relacional no MySQL (Camada de Dados)
- **Tabela `empresas`**: Raiz da hierarquia multi-tenant
- **Tabela `usuarios`**: Vinculados obrigatoriamente a uma empresa
- **Tabela `projetos`**: Projetos dentro de empresas, visíveis para todos os usuários da empresa
- **Tabela `documentos`**: Vinculados a projetos, herdando isolamento
- **Cláusula de Acesso**: Queries filtradas simplesmente por `empresa_id = ?`

### 3. Isolamento Vetorial no Qdrant (Camada Semântica)
- Cada ponto vetorial inclui payload com `empresa_id` e `projeto_id`
- Buscas semânticas são filtradas por `empresaId` obrigatório
- Chunks de diferentes empresas nunca se misturam na recuperação de contexto

## Mapeamento de Arquivos e Responsabilidades

### server.js (Backend Principal)
**Localização**: `/backend/server.js`

**Responsabilidades**:
- **Rotas de Autenticação**: `/api/login` - valida email/senha, emite JWT de 7 dias
- **Rotas de Projetos**:
  - `POST /api/projects/create` - cria projetos dentro da empresa
  - `GET /api/projects/list` - lista projetos/documentos acessíveis ao usuário
  - `POST /api/projects/upload` - upload de PDFs com ingestão automática no RAG
  - `PATCH /api/projects/rename/:id` e `DELETE /api/projects/:id` - operações CRUD com isolamento
- **Rotas de Sessões de Chat**:
   - `POST /api/chats` - cria uma sessão vazia para o usuário autenticado
   - `GET /api/chats` - lista sessões do usuário, mais recentes primeiro
   - `PUT /api/chats/:id` - renomeia o título de uma sessão existente
   - `GET /api/chats/:id/mensagens` - carrega o histórico de uma sessão específica
   - `DELETE /api/chats/:id` - remove a sessão e seu acesso pelo usuário
- **Rotas de Chat**: `POST /api/chat` - pipeline RAG completo (embedding → Qdrant → Groq) com `session_id` obrigatório
- **Rotas de Histórico**: `GET /api/messages?session_id=...` - leitura direta das mensagens da sessão ativa
- **Middleware**: `authenticateToken` para proteção de rotas, isolamento simplificado por empresa
- **Pool MySQL**: conexão com banco relacional usando credenciais do Docker Compose

### layouts/Main.js (Orquestração de Estado Compartilhado)
**Localização**: `/frontend/src/layouts/Main.js`

**Responsabilidades**:
- Centralizar o estado compartilhado entre sidebar e tela do chat
- Propagar via `Outlet context` os estados `selectedPdfIds`, `uploadFolderId`, `currentSessionId` e `messages`
- Garantir que a troca de sessão, seleção de PDFs e upload reflitam imediatamente no componente de chat

### layouts/Sidebar.js (Documentos + Histórico de Chats)
**Localização**: `/frontend/src/layouts/Sidebar.js`

**Responsabilidades**:
- Renderizar a árvore de projetos/documentos via `FileTree`
- Exibir o histórico de chats do usuário autenticado
- Criar um novo chat e limpar a tela antes da primeira mensagem
- Abrir sessões existentes e carregar suas mensagens
- Renomear sessões via edição inline no histórico
- Excluir sessões e limpar a sessão ativa quando necessário

### services/ragService.js (Pipeline RAG)
**Localização**: `/backend/services/ragService.js`

**Fluxo de ingestPdfFile**:
1. **Extração de Texto**: Lê PDF via `pdf-parse`, converte para texto puro
2. **Chunking**: Divide texto em chunks de 1000 chars com 100 chars de overlap
3. **Vetorização**: Gera embeddings via MiniLM-L6-v2 (local, sem API externa)
4. **Upsert no Qdrant**: Insere pontos com payload de isolamento (empresa_id, projeto_id, file_id)

**Fluxo de retrieveContext**:
1. **Embedding da Pergunta**: Converte pergunta em vetor usando mesmo modelo
2. **Busca Semântica**: Query no Qdrant filtrada por `empresaId` + `fileIds`
3. **Concatenação**: Junta textos dos top chunks como contexto para o LLM

**Fluxo de generateGroqAnswer**:
1. **Prompt Building**: Combina contexto recuperado + pergunta do usuário
2. **API Call**: Envia para Groq API com system prompt em português
3. **Resposta**: Retorna texto gerado, ancorado ao contexto fornecido

## Banco de Dados

### Estrutura Relacional Multi-Tenant

**empresas**
- `id`, `nome_fantasia`, `cnpj` - identificação da empresa
- Base da hierarquia multi-tenant

**usuarios**
- `id`, `empresa_id`, `email`, `senha_hash`, `role`
- Vinculados obrigatoriamente a uma empresa
- Roles: `admin_global`, `admin_empresa`, `usuario`

**projetos**
- `id`, `empresa_id`, `nome`
- Projetos dentro de empresas, visíveis para todos os usuários da empresa

**documentos**
- `id`, `projeto_id`, `nome_arquivo`, `caminho_storage`, `status`
- Status: `pendente`, `indexado`, `erro_indexacao`
- Vinculados a projetos, herdando isolamento multi-tenant

**sessoes_chat**
- `id`, `usuario_id`, `empresa_id`, `titulo`, `created_at`
- Representa a conversa lógica exibida no histórico lateral
- Cada sessão pertence a um usuário e a uma empresa

**messages** (histórico de chat)
- `id`, `user_id`, `sender`, `text`, `session_id`, `created_at`
- Cada mensagem pertence a uma sessão salva em `sessoes_chat`
- Usadas tanto no carregamento por sessão quanto no histórico do chat ativo

### Isolamento por Queries
As operações de tenant usam `empresa_id = ?`; as mensagens também exigem vínculo válido com `session_id` e `user_id`.

## Frontend

### Estrutura Geral
- **App.js**: Roteamento com proteção via `RequireAuth`, rotas públicas (login) vs protegidas
- **Main.js**: Layout raiz autenticado que mantém o estado compartilhado da experiência RAG
- **Sidebar.js**: Navegação lateral com FileTree e histórico de chats
- **Chat.js**: Interface principal de conversação RAG e renderização das mensagens
- **FileTree.js**: Navegação de projetos/documentos, upload e renomeação de pastas/arquivos
- **services/api.js**: Cliente HTTP centralizado para projetos e documentos

### Interação com Projetos e Documentos
- **Seleção de PDFs**: Usuário marca documentos na sidebar via `selectedPdfIds` (contexto compartilhado)
- **Upload**: PDFs enviados para a pasta/projeto selecionado (`uploadFolderId`) via `POST /api/projects/upload`
- **Feedback Visual**: Status de indexação mostrado no chat após upload
- **Isolamento UI**: Apenas projetos/documentos da empresa são exibidos

### Fluxo de Chat
1. **Validação**: Verifica token JWT, PDFs selecionados, texto não vazio
2. **Garantia de Sessão**: Se não houver `currentSessionId`, o frontend cria uma nova sessão via `POST /api/chats`
3. **Envio Otimista**: Exibe mensagem do usuário imediatamente
4. **API Call**: `POST /api/chat` com `text`, `selectedPdfIds` e `session_id`
5. **Persistência**: Backend grava pergunta e resposta em `messages` usando o `session_id` ativo
6. **Resposta**: Exibe resposta do bot ou trata erros (sem contexto, falha na API)
7. **Cancelamento**: AbortController permite interromper geração em andamento

### Fluxo do Histórico de Chats
1. **Listagem**: A sidebar carrega sessões via `GET /api/chats`
2. **Novo Chat**: O botão `+ Novo Chat` cria a sessão, limpa `messages` e define `currentSessionId`
3. **Abertura de Sessão**: Ao clicar em um item do histórico, a sidebar carrega `GET /api/chats/:id/mensagens`
4. **Renomeação**: O botão de lápis abre edição inline e persiste via `PUT /api/chats/:id`
5. **Exclusão**: O botão de lixeira remove a sessão via `DELETE /api/chats/:id` e limpa a tela se ela estava ativa

## Fluxo de Dados Completo

### Upload de PDF até Resposta do Chat

1. **Upload (Frontend → Backend)**:
   - Usuário seleciona PDF na UI, escolhe projeto destino
   - `POST /api/projects/upload` com FormData + `projetoId`
   - Validação: projeto acessível ao tenant via `empresa_id = ?`

2. **Persistência Relacional (Backend → MySQL)**:
   - Arquivo salvo em disco: `/backend/storage/{empresaId}/{userId}/filename`
   - Registro em `documentos`: `projeto_id`, `nome_arquivo`, `caminho_storage`, `status='pendente'`

3. **Ingestão RAG (Backend → Qdrant)**:
   - `ragService.ingestPdfFile()`: extração de texto → chunking → embedding → upsert
   - Pontos inseridos com payload: `empresa_id`, `projeto_id`, `file_id`, `chunk_index`, `text`
   - Status atualizado para `indexado` ou `erro_indexacao`

4. **Consulta do Chat (Frontend → Backend)**:
   - Usuário digita pergunta, seleciona PDFs na sidebar
   - Frontend garante que exista uma sessão ativa em `sessoes_chat`
   - `POST /api/chat` com `text`, `selectedPdfIds` e `session_id`
   - Validação: usuário autenticado, PDFs selecionados pertencem ao tenant e a sessão pertence ao usuário/tenant

5. **Recuperação de Contexto (Backend → Qdrant)**:
   - `ragService.retrieveContext()`: embedding da pergunta → busca semântica filtrada
   - Filtros: `empresaId` (obrigatório) + `fileIds` (selecionados)
   - Retorna top 3 chunks mais relevantes

6. **Geração de Resposta (Backend → Groq API)**:
   - `ragService.generateGroqAnswer()`: combina contexto + pergunta em prompt
   - System prompt: "Responda com base no contexto... em Português do Brasil"
   - API call para Groq com AbortController para cancelamento

7. **Persistência e Resposta (Backend → MySQL → Frontend)**:
   - Pergunta e resposta salvas em `messages` com o mesmo `session_id`
   - Resposta retornada ao frontend para exibição no chat

8. **Reabertura de Conversa (Frontend → Backend)**:
   - Sidebar seleciona um chat salvo no histórico
   - `GET /api/chats/:id/mensagens` retorna a conversa completa daquela sessão
   - Frontend reconstrói a lista de mensagens e destaca o item ativo no histórico

### Isolamento Garantido em Todo o Fluxo
- **Autenticação**: JWT valida empresa do usuário
- **Queries MySQL**: Filtradas por `empresa_id = ?`
- **Sessões de Chat**: Validadas por `usuario_id + empresa_id` antes de abrir, renomear ou excluir
- **Buscas Qdrant**: Payload com `empresa_id` em todos os pontos
- **Armazenamento**: PDFs organizados por empresa/usuário em disco
- **Histórico**: Conversas isoladas por empresa e organizadas por `session_id` no banco relacional

## Estado da Documentação na Versão 1.0

### Arquivos já bem comentados
- `backend/server.js`
- `backend/services/ragService.js`
- `frontend/src/apps/Chat.js`
- `frontend/src/layouts/FileTree.js`

### Arquivos revisados e ajustados nesta versão
- `frontend/src/layouts/Main.js`
- `frontend/src/layouts/Sidebar.js`
- `frontend/src/services/api.js`

O objetivo desta revisão 1.0 foi manter comentários explicativos nos pontos de orquestração e fluxo, evitando excesso de comentários em trechos triviais.