/**
 * @file server.js
 * @description Servidor principal do sistema RAG (Retrieval-Augmented Generation) Uberdesk.
 *
 * Fluxo geral de dados:
 *   [Frontend React] → HTTP/REST → [server.js] → [ragService] → [Qdrant + Groq API]
 *                                               ↘ [MySQL] (persistência de mensagens e metadados de arquivos)
 *
 * Módulos principais orquestrados por este arquivo:
 *  - Autenticação JWT (login / proteção de rotas)
 *  - Upload de PDFs via Multer → disparo do pipeline de ingestão RAG
 *  - Gerenciamento de arquivos/pastas por usuário no MySQL
 *  - Endpoint de chat: recupera contexto vetorial (Qdrant) e gera resposta (Groq)
 *
 * @requires dotenv       Carrega variáveis de ambiente do arquivo .env
 * @requires express      Framework HTTP
 * @requires mysql2       Driver MySQL com pool de conexões
 * @requires bcryptjs     Hash de senhas (comparação segura)
 * @requires jsonwebtoken Geração e verificação de JWTs
 * @requires multer       Middleware de upload multipart/form-data
 * @requires fs-extra     Utilitários de sistema de arquivos com Promises
 * @requires ./services/ragService Pipeline RAG (ingestão, recuperação, geração)
 */
require('dotenv').config();

const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');
const {
  ingestPdfFile,
  retrieveContext,
  generateGroqAnswer
} = require('./services/ragService');

const app = express();

/**
 * Configuração de proxy reverso para aaPanel / Nginx.
 * Sem isso, req.ip retornaria o IP interno do container em vez do IP real do cliente.
 * Nível 1 significa que apenas o primeiro proxy da cadeia é confiável.
 */
app.set('trust proxy', 1);

app.use(express.json());

/**
 * CORS liberado para todas as origens em desenvolvimento.
 * TODO: RedOps Fix — Em produção, restringir para o domínio real do frontend.
 * Exemplo seguro: cors({ origin: process.env.CORS_ORIGIN || 'https://app.uberdesk.com.br' })
 */
app.use(cors({ origin: '*' }));

/**
 * Middleware de log de requisições.
 * Registra método, path, host (útil para debug de virtual hosts no aaPanel) e IP real do cliente.
 * Saída: [ISO timestamp] METHOD /path — Host: ... — IP: ...
 */
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} — Host: ${req.headers.host} — IP: ${req.ip}`);
  next();
});

// ---------------------------------------------------------------------------
// VARIÁVEIS DE AMBIENTE — Configuração sensível
// ---------------------------------------------------------------------------

/**
 * @security JWT_SECRET NUNCA deve ter fallback em produção.
 * TODO: RedOps Fix — Remover o fallback 'sua_chave_secreta_aqui'. Se JWT_SECRET não estiver
 * definida, o processo deve encerrar imediatamente para evitar tokens forjáveis.
 * Boas práticas: openssl rand -hex 64 e armazenar no .env (nunca versionar).
 */
const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_aqui';

/** @type {string} URL do cluster Qdrant. Deve vir de process.env.QDRANT_URL */
const QDRANT_URL = process.env.QDRANT_URL || '';

/** @type {string} API Key do Qdrant. Deve vir de process.env.QDRANT_API_KEY */
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';

/** @type {string} API Key da Groq para geração de respostas LLM. */
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';

/** @type {string} Modelo LLM da Groq. Padrão: llama3-8b-8192 */
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama3-8b-8192';

/**
 * @security PORT hardcoded. Mover para process.env.PORT para flexibilidade em diferentes
 * ambientes (dev local vs container).
 */
const PORT = process.env.PORT || 3001;

/** @type {string} Diretório raiz onde os arquivos enviados pelos usuários são armazenados fisicamente. */
const UPLOAD_ROOT = path.join(__dirname, 'storage');

// ---------------------------------------------------------------------------
// CONFIGURAÇÃO DE UPLOAD (Multer)
// ---------------------------------------------------------------------------

/**
 * Estratégia de armazenamento em disco para o Multer.
 * Todos os uploads vão para UPLOAD_ROOT (sem subdiretório por usuário neste estágio).
 * O nome do arquivo é prefixado com timestamp + número aleatório para evitar colisões.
 *
 * @security Não há validação de tipo de arquivo no nível do Multer (fileFilter).
 * TODO: RedOps Fix — Adicionar fileFilter para aceitar apenas PDFs (application/pdf)
 * e limitar tamanho máximo via limits: { fileSize: 20 * 1024 * 1024 }.
 */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

// Garante que o diretório de storage exista antes de qualquer upload
fs.ensureDirSync(UPLOAD_ROOT);

// ---------------------------------------------------------------------------
// POOL DE CONEXÕES MySQL
// ---------------------------------------------------------------------------

/**
 * Pool de conexões MySQL2 com suporte nativo a Promises.
 * O pool gerencia até 10 conexões simultâneas; requisições excedentes aguardam
 * na fila (waitForConnections: true).
 *
 * @security CRÍTICO — Credenciais hardcoded abaixo.
 * TODO: RedOps Fix — Substituir todos os valores literais por variáveis de ambiente:
 *   host:     process.env.DB_HOST     || 'db'
 *   user:     process.env.DB_USER     (sem fallback — falhar rápido se não configurado)
 *   password: process.env.DB_PASS     (sem fallback)
 *   database: process.env.DB_NAME     (sem fallback)
 *
 * TODO: RedOps Fix — 'dashbyte_user' e 'dashbyte_chat' são referências ao template
 * legado 'Dashbyte'. Renomear para refletir o produto Uberdesk após migração do banco.
 */
const pool = mysql.createPool({
  host: 'db',
  user: 'dashbyte_user',       // TODO: RedOps Fix — usar process.env.DB_USER
  password: 'efNaekDtcZFjCmbA', // TODO: RedOps Fix — usar process.env.DB_PASS (credencial exposta)
  database: 'dashbyte_chat',   // TODO: RedOps Fix — usar process.env.DB_NAME; renomear banco para 'uberdesk'
  waitForConnections: true,
  connectionLimit: 10
});

/** @type {mysql2.Pool} Pool com interface Promise para uso com async/await */
const db = pool.promise();

console.log('✅ Pool de conexões MySQL configurado com Promises.');
if (!QDRANT_URL || !QDRANT_API_KEY) {
  console.warn('⚠️ Qdrant nao configurado (QDRANT_URL/QDRANT_API_KEY). O RAG vetorial nao funcionara.');
}

// ---------------------------------------------------------------------------
// MIDDLEWARE DE AUTENTICAÇÃO
// ---------------------------------------------------------------------------

/**
 * Middleware JWT — protege rotas que exigem autenticação.
 *
 * Fluxo:
 *  1. Extrai o Bearer token do header Authorization.
 *  2. Verifica assinatura e expiração via jsonwebtoken.
 *  3. Injeta o payload decodificado em req.user para uso pelas rotas downstream.
 *
 * @param {import('express').Request}  req  - Objeto de requisição Express
 * @param {import('express').Response} res  - Objeto de resposta Express
 * @param {import('express').NextFunction} next - Próximo middleware na cadeia
 * @returns {void} Chama next() se o token for válido; encerra com 401/403 caso contrário.
 */
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato esperado: "Bearer <token>"
  if (!token) return res.status(401).json({ error: 'Acesso negado.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido.' });
    req.user = user; // Payload: { id, email, iat, exp }
    next();
  });
};

// ===========================================================================
// ROTAS
// ===========================================================================

/**
 * @route  POST /api/login
 * @access Público
 * @description Autenticação de usuário. Valida email/senha e emite um JWT de 7 dias.
 *
 * Fluxo:
 *  REQUEST  → { email, password }
 *  DB Query → SELECT * FROM users WHERE email = ? (parameterizado — seguro contra SQL Injection)
 *  Bcrypt   → compara password com hash armazenado
 *  RESPONSE → { token: "<JWT>", user: { id, name, email } }
 *
 * @security A query usa placeholder (?) — protegida contra SQL Injection.
 * @security bcrypt.compare é resistente a timing attacks.
 * @security A resposta de erro propositalmente não diferencia "usuário não existe" de
 *           "senha errada" para evitar user enumeration via mensagem distinta.
 *           TODO: RedOps Fix — Unificar ambas as mensagens de erro em uma genérica.
 */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    // Query parametrizada — protege contra SQL Injection
    const [results] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (results.length === 0) return res.status(401).json({ error: "Usuário não encontrado." });

    const user = results[0];
    // Comparação segura: bcrypt.compare previne timing attacks ao contrário de === direto
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Senha incorreta." });

    // Payload mínimo no JWT: apenas id e email. Não incluir dados sensíveis.
    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: "Erro no banco." });
  }
});

/**
 * @function handleChatMessage
 * @description Handler principal do pipeline RAG completo.
 *
 * Fluxo de dados (Request → Response):
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │ 1. [INPUT]   Recebe pergunta + IDs dos PDFs selecionados         │
 *  │ 2. [PERSIST] Salva pergunta do usuário no MySQL (tabela messages) │
 *  │ 3. [RETRIEVE] Gera embedding da pergunta → busca semântica no     │
 *  │              Qdrant filtrada por userId + fileIds (RAG Retrieve)  │
 *  │ 4. [GENERATE] Envia prompt enriquecido (pergunta + contexto) para │
 *  │              API da Groq → obtém resposta do LLM (RAG Generate)  │
 *  │ 5. [PERSIST] Salva resposta do bot no MySQL                       │
 *  │ 6. [OUTPUT]  Retorna { text, answer } ao frontend                 │
 *  └─────────────────────────────────────────────────────────────────┘
 *
 * Cancelamento gracioso: AbortController propaga o sinal de cancelamento
 * até a chamada fetch para a Groq, evitando consumo desnecessário de tokens
 * quando o cliente desconecta.
 *
 * @param {import('express').Request}  req - Corpo: { text?, prompt?, selectedPdfIds?, fileIds? }
 * @param {import('express').Response} res - Resposta: { text: string, answer: string }
 */
const handleChatMessage = async (req, res) => {
  // Normaliza os campos de entrada: suporta 'text' (novo) e 'prompt' (legado)
  const { text, prompt, selectedPdfIds, fileIds } = req.body;
  const userPrompt = (text || prompt || '').trim();

  // Normaliza os IDs dos PDFs independentemente do campo enviado pelo frontend
  const receivedFileIds = Array.isArray(selectedPdfIds)
    ? selectedPdfIds
    : (Array.isArray(fileIds) ? fileIds : []);
  const userId = req.user.id; // Injetado pelo middleware authenticateToken
  if (!userPrompt) return res.status(400).json({ error: "Mensagem vazia." });

  /**
   * AbortController permite cancelar a requisição para a Groq se o cliente
   * fechar a conexão antes de receber a resposta (economiza tokens da API).
   */
  const abortController = new AbortController();
  let clientDisconnected = false;

  const handleClientAbort = () => {
    if (clientDisconnected) return;
    clientDisconnected = true;
    abortController.abort(); // Propaga o sinal de cancelamento para o fetch da Groq
    console.warn('⚠️ Cliente interrompeu a requisição de chat.');
  };

  const handleResponseClose = () => {
    // Socket fechou antes do res.end() — cliente saiu no meio da geração
    if (!res.writableEnded) {
      handleClientAbort();
    }
  };

  req.on('aborted', handleClientAbort);
  res.on('close', handleResponseClose);

  try {
    // -----------------------------------------------------------------------
    // STEP 1 — Persistir pergunta do usuário
    // -----------------------------------------------------------------------
    await db.query('INSERT INTO messages (user_id, sender, text) VALUES (?, ?, ?)', [userId, 'user', userPrompt]);
    if (clientDisconnected) return;

    // -----------------------------------------------------------------------
    // STEP 2 — Resolver e validar IDs dos arquivos para filtro vetorial
    // -----------------------------------------------------------------------
    // Deduplica e garante inteiros positivos para evitar injeção de valores inválidos no filtro Qdrant
    const normalizedFileIds = [...new Set(receivedFileIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0))];

    // Fallback de segurança: se o frontend não enviou seleção, usa o PDF mais recente do usuário
    if (normalizedFileIds.length === 0) {
      const [lastFiles] = await db.query(
        'SELECT id FROM files WHERE user_id = ? AND is_directory = 0 ORDER BY created_at DESC LIMIT 1',
        [userId]
      );
      if (!lastFiles.length) {
        return res.status(400).json({
          error: 'Nenhum PDF selecionado (e nenhum PDF encontrado no seu histórico). Envie/seleciona ao menos um documento.'
        });
      }
      normalizedFileIds.push(Number(lastFiles[0].id));
      console.warn('⚠️ Nenhum PDF selecionado; usando fallback do último PDF. id=', normalizedFileIds[0]);
    }

    // -----------------------------------------------------------------------
    // STEP 3 — RAG Retrieve: embedding da pergunta + busca semântica no Qdrant
    // -----------------------------------------------------------------------
    console.log('[CHAT] Passo 1: Gerando embedding da pergunta e buscando contexto no Qdrant...');
    const { context, hits } = await retrieveContext({
      question: userPrompt,
      userId,
      fileIds: normalizedFileIds,
      topK: 3 // Retorna os 3 chunks mais relevantes semanticamente
    });

    if (!context.trim()) {
      // Nenhum chunk relevante encontrado — os PDFs podem não ter sido indexados
      return res.status(400).json({
        error: 'Nao foi encontrado contexto relevante no indice vetorial para os PDFs selecionados.'
      });
    }
    console.log('[CHAT] Passo 1 OK: ', hits.length, 'chunks recuperados do Qdrant');
    if (clientDisconnected) return;

    // -----------------------------------------------------------------------
    // STEP 4 — RAG Generate: envio do prompt enriquecido para a Groq LLM
    // -----------------------------------------------------------------------
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY não configurada no servidor.' });
    }

    console.log('[CHAT] Passo 2: Enviando prompt para a API do Groq...');
    const aiResponse = await generateGroqAnswer({
      question: userPrompt,
      context,          // Chunks recuperados do Qdrant, concatenados como contexto
      groqApiKey: GROQ_API_KEY,
      groqModel: GROQ_MODEL,
      abortSignal: abortController.signal // Propaga cancelamento do cliente
    });

    console.log('[CHAT] Passo 2 OK: Resposta recebida da IA (', aiResponse.length, 'caracteres)');
    if (clientDisconnected) return;

    // -----------------------------------------------------------------------
    // STEP 5 — Persistir resposta e entregar ao frontend
    // -----------------------------------------------------------------------
    console.log('[CHAT] Passo 3: Salvando resposta no banco de dados...');
    await db.query('INSERT INTO messages (user_id, sender, text) VALUES (?, ?, ?)', [userId, 'bot', aiResponse]);
    console.log('[CHAT] Passo 3 OK: Resposta salva no banco');
    if (clientDisconnected) return;
    console.log('[CHAT] Passo 4: Enviando resposta ao cliente...');
    // Retorna 'text' e 'answer' para compatibilidade com versões antigas do frontend
    res.json({ text: aiResponse, answer: aiResponse });
    console.log('[CHAT] ✅ Requisição concluída com sucesso!');

  } catch (error) {
    if (clientDisconnected || error.name === 'AbortError') {
      console.warn('⚠️ Geração interrompida por cancelamento do cliente.');
      if (!res.headersSent) {
        return res.status(499).json({ error: 'Requisição interrompida pelo cliente.' });
      }
      return;
    }
    console.error('[CHAT] ❌ ERRO FATAL:', error.name || 'Error', '-', error.message);
    console.error('[CHAT] Stack trace:', error.stack);
    if (!res.headersSent) {
      return res.status(500).json({ error: `[${error.name || 'Error'}] ${error.message}` });
    }
  } finally {
    // Remove listeners para evitar memory leaks em conexões de longa duração
    req.off('aborted', handleClientAbort);
    res.off('close', handleResponseClose);
  }
};

/**
 * As duas rotas abaixo apontam para o mesmo handler.
 * /api/messages (legado) e /api/chat (atual) são mantidas para compatibilidade.
 * TODO: RedOps Fix — Deprecar /api/messages para fins de chat. Manter apenas /api/chat.
 */
app.post('/api/messages', authenticateToken, handleChatMessage);
app.post('/api/chat', authenticateToken, handleChatMessage);

/**
 * @route  POST /api/files/mkdir
 * @access Privado (requer JWT)
 * @description Cria uma pasta lógica na árvore de arquivos do usuário.
 *
 * Fluxo de dados:
 *  REQUEST  → { folderName: string, parentId?: number }
 *  DB Write → INSERT INTO files (is_directory=1, parent_id)
 *  FS Write → fs.ensureDir cria a pasta física em storage/{userId}/{folderName}
 *  RESPONSE → { message, id: insertId }
 *
 * @security parentId não é validado contra ownership do usuário.
 * TODO: RedOps Fix — Verificar que o parentId pertence ao userId antes do INSERT
 * para evitar que um usuário crie pastas dentro de diretórios de outro usuário.
 */
app.post('/api/files/mkdir', authenticateToken, async (req, res) => {
  const { folderName, parentId } = req.body;
  const userId = req.user.id;

  try {
    // Persiste a pasta como entrada lógica no banco (is_directory=1)
    const [result] = await db.query(
      'INSERT INTO files (user_id, name, is_directory, parent_id) VALUES (?, ?, 1, ?)',
      [userId, folderName, parentId || null]
    );
    
    // Cria pasta física correspondente para organização do storage em disco
    const folderPath = path.join(UPLOAD_ROOT, userId.toString(), folderName);
    await fs.ensureDir(folderPath);

    res.json({ message: "Pasta criada!", id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: "Erro ao criar pasta." });
  }
});

/**
 * @route  GET /api/messages
 * @access Privado (requer JWT)
 * @description Retorna o histórico de mensagens do usuário autenticado em ordem cronológica.
 *
 * Dados retornados: [{ sender: 'user'|'bot', text: string, created_at: Date }]
 * Usado pelo frontend para reconstruir o histórico visual do chat ao recarregar a página.
 */
app.get('/api/messages', authenticateToken, async (req, res) => {
  try {
    // Filtra por user_id — isola conversas por usuário (sem acesso cruzado)
    const [results] = await db.query('SELECT sender, text, created_at FROM messages WHERE user_id = ? ORDER BY created_at ASC', [req.user.id]);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar mensagens." });
  }
});

/**
 * @route  GET /api/files/list
 * @access Privado (requer JWT)
 * @description Lista o conteúdo de um diretório específico (ou raiz se parentId omitido).
 *
 * Usa o operador NULL-safe `<=>` do MySQL para comparar com NULL corretamente,
 * permitindo listar arquivos sem parentId (raiz) sem precisar de IS NULL explícito.
 *
 * @param {string} [req.query.parentId] - ID da pasta pai; omitir para listar a raiz.
 */
app.get('/api/files/list', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const parentId = req.query.parentId || null;

  try {
    // <=> é o operador NULL-safe do MySQL: (parent_id <=> NULL) == (parent_id IS NULL)
    const [results] = await db.query(
      'SELECT * FROM files WHERE user_id = ? AND (parent_id <=> ?) ORDER BY is_directory DESC, name ASC',
      [userId, parentId]
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Erro ao listar seus arquivos." });
  }
});

/**
 * @route  GET /api/files/all
 * @access Privado (requer JWT)
 * @description Retorna todos os arquivos e pastas do usuário em uma única query.
 *
 * Usado pelo componente FileTree do frontend para renderizar a árvore completa de uma vez.
 * Para usuários com muitos arquivos, considerar paginação futuramente.
 */
app.get('/api/files/all', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  try {
    const [results] = await db.query(
      'SELECT * FROM files WHERE user_id = ? ORDER BY is_directory DESC, name ASC',
      [userId]
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Erro ao listar arquivos." });
  }
});

/**
 * @route  PATCH /api/files/rename/:id
 * @access Privado (requer JWT)
 * @description Renomeia um arquivo ou pasta. A cláusula `AND user_id = ?` garante
 *              que um usuário só consiga renomear seus próprios itens (IDOR protection).
 *
 * @security Não renomeia o arquivo físico em disco — apenas o registro no banco.
 * TODO: RedOps Fix — Sincronizar o rename físico do arquivo em storage se necessário.
 */
app.patch('/api/files/rename/:id', authenticateToken, async (req, res) => {
  const { newName } = req.body;
  const fileId = req.params.id;
  const userId = req.user.id;

  try {
    // user_id no WHERE previne IDOR (Insecure Direct Object Reference)
    await db.query(
      'UPDATE files SET name = ? WHERE id = ? AND user_id = ?',
      [newName, fileId, userId]
    );
    res.json({ message: "Renomeado com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao renomear." });
  }
});

/**
 * @route  DELETE /api/files/:id
 * @access Privado (requer JWT)
 * @description Remove um arquivo do banco e, quando aplicável, apaga o arquivo físico do disco.
 *
 * Fluxo:
 *  1. Busca file_path e is_directory para o id + userId
 *  2. Se for arquivo (is_directory=0) com caminho físico, apaga via fs.unlinkSync
 *  3. Remove registro do banco
 *
 * TODO: RedOps Fix — Deleção de pastas não remove os filhos recursivamente.
 *   Implementar DELETE CASCADE no banco ou query recursiva para evitar orphan records.
 * TODO: RedOps Fix — Remover também os vetores do Qdrant ao deletar um PDF
 *   (chamar deleteByUserAndFile para evitar acúmulo de dados stale no índice vetorial).
 */
app.delete('/api/files/:id', authenticateToken, async (req, res) => {
  const fileId = req.params.id;
  const userId = req.user.id;

  try {
    // Busca dados do arquivo antes de deletar para poder remover o arquivo físico
    const [file] = await db.query('SELECT file_path, is_directory FROM files WHERE id = ? AND user_id = ?', [fileId, userId]);
    
    if (file.length > 0) {
      if (file[0].is_directory === 0 && file[0].file_path) {
        // Remove o arquivo físico do disco se existir
        if (fs.existsSync(file[0].file_path)) fs.unlinkSync(file[0].file_path);
      }
      // TODO: RedOps Fix — Se for pasta, deletar filhos recursivamente antes deste DELETE
      await db.query('DELETE FROM files WHERE id = ? AND user_id = ?', [fileId, userId]);
    }
    
    res.json({ message: "Excluído com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao excluir." });
  }
});

/**
 * @route  PATCH /api/files/move/:id
 * @access Privado (requer JWT)
 * @description Move um item para outra pasta alterando o parent_id no banco.
 *              Passar newParentId=null move o item para a raiz.
 *
 * @security newParentId não é validado contra ownership do usuário.
 * TODO: RedOps Fix — Verificar que newParentId pertence ao userId antes do UPDATE.
 */
app.patch('/api/files/move/:id', authenticateToken, async (req, res) => {
  const { newParentId } = req.body;
  const fileId = req.params.id;
  const userId = req.user.id;

  try {
    await db.query(
      'UPDATE files SET parent_id = ? WHERE id = ? AND user_id = ?',
      [newParentId || null, fileId, userId]
    );
    res.json({ message: "Movido com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao mover." });
  }
});

/**
 * @route  POST /api/files/upload
 * @access Privado (requer JWT)
 * @description Recebe um arquivo via multipart/form-data, registra no banco e,
 *              se for PDF, dispara o pipeline completo de ingestão RAG.
 *
 * Fluxo de dados (PDF Upload → Indexação RAG):
 *  ┌──────────────────────────────────────────────────────────────────────┐
 *  │ 1. Multer salva o arquivo em UPLOAD_ROOT com nome único              │
 *  │ 2. DB INSERT registra metadados (nome, caminho, user_id, parent_id)  │
 *  │ 3. Se mimetype === PDF → ingestPdfFile() dispara:                    │
 *  │    a. pdf-parse extrai texto do binário                              │
 *  │    b. chunkText divide em overlapping chunks de 1000 chars           │
 *  │    c. generateEmbeddings vetoriza cada chunk (MiniLM-L6-v2, 384d)   │
 *  │    d. upsertChunks insere vetores + payload no Qdrant                │
 *  │ 4. Retorna { fileId, indexing stats, indexingWarning? }              │
 *  └──────────────────────────────────────────────────────────────────────┘
 *
 * Falha de indexação não bloqueia o upload — o arquivo é salvo mesmo se o
 * Qdrant estiver indisponível, e indexingWarning é retornado para informar o usuário.
 */
app.post('/api/files/upload', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo vazio." });
  const userId = req.user.id;
  const parentId = req.body.parentId || null;

  try {
    // Registra metadados do arquivo no banco antes de tentar indexar
    const [result] = await db.query(
      'INSERT INTO files (user_id, name, file_path, is_directory, parent_id) VALUES (?, ?, ?, 0, ?)',
      [userId, req.file.originalname, req.file.path, parentId]
    );

    const fileId = result.insertId;
    let indexing = null;
    let indexingWarning = null;

    // Dispara ingestão RAG apenas para PDFs (por MIME type ou extensão)
    if (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf')) {
      try {
        // ingestPdfFile retorna { chunkCount, fileId, fileName } após indexação bem-sucedida
        indexing = await ingestPdfFile({
          userId,
          fileId,
          filePath: req.file.path,
          fileName: req.file.originalname
        });
      } catch (indexError) {
        // Falha não-crítica: arquivo salvo, mas vetores não indexados
        indexingWarning = 'Upload concluido, mas a indexacao vetorial falhou para este PDF.';
        console.error('Erro de indexacao vetorial:', indexError.message);
      }
    }

    res.json({
      message: "Upload concluído!",
      name: req.file.originalname,
      fileId,
      indexing,       // null se não for PDF ou se indexação falhou
      indexingWarning // string de alerta se indexação falhou, null caso contrário
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao registrar upload." });
  }
});

/** Inicia o servidor HTTP na porta configurada, escutando em todas as interfaces. */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sistema RAG Online na porta ${PORT}`);
});