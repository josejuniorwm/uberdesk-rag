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
const path = require('path');
// .env na raiz (Qdrant, Groq, etc.); backend/.env sobrescreve quando existir
require('dotenv').config({ path: path.join(__dirname, '../.env') });
require('dotenv').config({ path: path.join(__dirname, '.env'), override: true });

const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs-extra');
const multer = require('multer');
const {
  ingestPdfFile,
  retrieveContext,
  generateGroqAnswer
} = require('./services/ragService');
const qdrantService = require('./services/qdrantService');

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

let cachedUserTable = null;
let cachedUserColumns = null;

async function getMessagesUserFKReference() {
  const [rows] = await db.query(
    'SELECT REFERENCED_TABLE_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND REFERENCED_TABLE_NAME IN (?, ?)',
    [pool.config.connectionConfig.database, 'messages', 'user_id', 'users', 'usuarios']
  );
  return rows?.[0]?.REFERENCED_TABLE_NAME || null;
}

async function getUserTable() {
  if (cachedUserTable) {
    return cachedUserTable;
  }

  const [[usuariosTable]] = await db.query("SHOW TABLES LIKE 'usuarios'");
  const [[usersTable]] = await db.query("SHOW TABLES LIKE 'users'");
  const hasUsuarios = usuariosTable && Object.values(usuariosTable).includes('usuarios');
  const hasUsers = usersTable && Object.values(usersTable).includes('users');

  if (hasUsers && hasUsuarios) {
    const referencedTable = await getMessagesUserFKReference();
    if (referencedTable === 'users') {
      cachedUserTable = 'users';
      return cachedUserTable;
    }
    if (referencedTable === 'usuarios') {
      cachedUserTable = 'usuarios';
      return cachedUserTable;
    }
    console.warn('[DB] Ambas tabelas users e usuarios existem; usando users por default devido ao FK de mensagens.');
    cachedUserTable = 'users';
    return cachedUserTable;
  }

  if (hasUsers) {
    cachedUserTable = 'users';
    return cachedUserTable;
  }

  if (hasUsuarios) {
    cachedUserTable = 'usuarios';
    return cachedUserTable;
  }

  throw new Error('Nenhuma tabela de usuários encontrada. Esperado users ou usuarios.');
}

async function getUserColumns() {
  if (cachedUserColumns) {
    return cachedUserColumns;
  }

  const userTable = await getUserTable();
  const [rows] = await db.query(
    'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [pool.config.connectionConfig.database, userTable]
  );

  cachedUserColumns = rows.map((row) => row.COLUMN_NAME);
  return cachedUserColumns;
}

function normalizeUserRow(user) {
  return {
    id: Number(user.id),
    email: user.email || user.email,
    nome: user.nome || user.name || null,
    senhaHash: user.senha_hash || user.password || null,
    empresaId: user.empresa_id || user.empresaId || null,
    role: user.role || 'user'
  };
}

function hasUserColumns(columns, requiredColumns) {
  return requiredColumns.every((column) => columns.includes(column));
}

async function ensureEnterpriseUserSchema() {
  const columns = await getUserColumns();
  const required = ['empresa_id', 'nome', 'email', 'senha_hash', 'role'];
  if (!hasUserColumns(columns, required)) {
    throw new Error('Esquema de usuários incompatível. Atualize a tabela para o schema multi-tenant com campos empresa_id, nome, email, senha_hash e role.');
  }
}

// Verificação inicial de conexão para detectar falhas silenciosas na inicialização
db.getConnection()
  .then((connection) => {
    console.log('✅ Conexão MySQL inicializada com sucesso no database:', pool.config.connectionConfig.database);
    connection.release();
  })
  .catch((err) => {
    console.error('❌ Falha ao conectar ao MySQL na inicialização:', err);
  });

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
const authenticateToken = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato esperado: "Bearer <token>"
  if (!token) return res.status(401).json({ error: 'Acesso negado.' });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(403).json({ error: 'Token inválido.' });
  }

  try {
    const userTable = await getUserTable();
    const [rows] = await db.query(`SELECT * FROM \`${userTable}\` WHERE id = ?`, [payload.id]);
    if (!rows.length) {
      return res.status(403).json({ error: 'Token inválido ou usuário inexistente.' });
    }

    const normalizedUser = normalizeUserRow(rows[0]);
    req.user = normalizedUser;
    next();
  } catch (err) {
    console.error('[AUTH] Erro ao validar usuário autenticado:', err);
    return res.status(500).json({ error: 'Erro interno de autenticação.' });
  }
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
 *  DB Query → SELECT * FROM usuarios WHERE email = ? (parameterizado — seguro contra SQL Injection)
 *  Bcrypt   → compara password com hash armazenado em senha_hash
 *  RESPONSE → { token: "<JWT>", user: { id, nome, email, empresaId, role } }
 *
 * @security A query usa placeholder (?) — protegida contra SQL Injection.
 * @security bcrypt.compare é resistente a timing attacks.
 * @security A resposta de erro propositalmente não diferencia "usuário não existe" de
 *           "senha errada" para evitar user enumeration via mensagem distinta.
 *           TODO: RedOps Fix — Unificar ambas as mensagens de erro em uma genérica.
 */
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedPassword = String(password || '');

  try {
    console.log(`[LOGIN] Processando login para email: "${normalizedEmail}"`);
    const userTable = await getUserTable();
    const [results] = await db.query(`SELECT * FROM \`${userTable}\` WHERE email = ?`, [normalizedEmail]);
    if (results.length === 0) {
      console.warn(`[LOGIN] Usuario nao encontrado: "${normalizedEmail}" (tabela ${userTable})`);
      return res.status(401).json({ error: "Usuário não encontrado." });
    }

    const user = results[0];
    const normalizedUser = normalizeUserRow(user);

    if (!normalizedUser.senhaHash) {
      console.error('[LOGIN] Hash de senha inexistente para usuário:', normalizedUser.id, 'tabela:', userTable);
      return res.status(500).json({ error: 'Erro interno de autenticação.' });
    }

    const isMatch = await bcrypt.compare(normalizedPassword, normalizedUser.senhaHash);
    if (!isMatch) {
      console.warn(`[LOGIN] Senha incorreta para email: "${normalizedEmail}"`);
      return res.status(401).json({ error: "Senha incorreta." });
    }

    const token = jwt.sign(
      {
        id: normalizedUser.id,
        email: normalizedUser.email,
        empresaId: normalizedUser.empresaId,
        role: normalizedUser.role
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: normalizedUser.id,
        nome: normalizedUser.nome,
        email: normalizedUser.email,
        empresaId: normalizedUser.empresaId,
        role: normalizedUser.role
      }
    });
  } catch (err) {
    console.error('Erro no login:', err);
    res.status(500).json({ error: "Erro no banco." });
  }
});

/**
 * @route  POST /api/register
 * @access Público
 * @description Cria uma nova empresa e o primeiro usuário (admin_empresa).
 *
 * Fluxo:
 *  REQUEST  → { nomeEmpresa, cnpj, nomeUsuario, email, password }
 *  DB Write → INSERT INTO empresas + INSERT INTO usuarios (role: 'admin_empresa')
 *  RESPONSE → { token: "<JWT>", user: {...}, empresa: {...} }
 *
 * @security Valida se email e CNPJ não existem
 * @security Hash da senha com bcrypt
 */
app.post('/api/register', async (req, res) => {
  const { nomeEmpresa, cnpj, nomeUsuario, email, password } = req.body;
  const normalizedNomeEmpresa = String(nomeEmpresa || '').trim();
  const normalizedCnpj = String(cnpj || '').trim();
  const normalizedNomeUsuario = String(nomeUsuario || '').trim();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const normalizedPassword = String(password || '');

  if (!normalizedNomeEmpresa || !normalizedCnpj || !normalizedNomeUsuario || !normalizedEmail || !normalizedPassword) {
    console.warn('[REGISTER] Campos obrigatórios faltando:', { nomeEmpresa: !!normalizedNomeEmpresa, cnpj: !!normalizedCnpj, nomeUsuario: !!normalizedNomeUsuario, email: !!normalizedEmail, password: !!normalizedPassword });
    return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
  }

  try {
    console.log(`[REGISTER] Processando registro para email: "${normalizedEmail}", empresa: "${normalizedNomeEmpresa}", CNPJ: "${normalizedCnpj}"`);
    const userTable = await getUserTable();
    await ensureEnterpriseUserSchema();

    // Verificar se email já existe
    const [existingUser] = await db.query(`SELECT id FROM \`${userTable}\` WHERE email = ?`, [normalizedEmail]);
    if (existingUser.length > 0) {
      console.warn(`[REGISTER] Email já cadastrado: "${normalizedEmail}"`);
      return res.status(400).json({ error: 'Email já cadastrado.' });
    }

    // Verificar se CNPJ já existe
    const [existingEmpresa] = await db.query('SELECT id FROM empresas WHERE cnpj = ?', [normalizedCnpj]);
    if (existingEmpresa.length > 0) {
      console.warn(`[REGISTER] CNPJ já cadastrado: "${normalizedCnpj}"`);
      return res.status(400).json({ error: 'CNPJ já cadastrado.' });
    }

    // Criar empresa
    const [empresaResult] = await db.query(
      'INSERT INTO empresas (nome_fantasia, cnpj) VALUES (?, ?)',
      [normalizedNomeEmpresa, normalizedCnpj]
    );
    const empresaId = empresaResult.insertId;
    console.log(`[REGISTER] Empresa criada com ID: ${empresaId}`);

    // Hash da senha
    const hashedPassword = await bcrypt.hash(normalizedPassword, 10);

    // Criar usuário admin da empresa
    const [userResult] = await db.query(
      `INSERT INTO \`${await getUserTable()}\` (empresa_id, nome, email, senha_hash, role) VALUES (?, ?, ?, ?, ?)`,
      [empresaId, normalizedNomeUsuario, normalizedEmail, hashedPassword, 'admin_empresa']
    );
    const userId = userResult.insertId;
    console.log(`[REGISTER] Usuário criado com ID: ${userId}`);

    // Gerar token JWT
    const token = jwt.sign(
      {
        id: userId,
        email: normalizedEmail,
        empresaId: empresaId,
        role: 'admin_empresa'
      },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(201).json({
      token,
      user: {
        id: userId,
        nome: normalizedNomeUsuario,
        email: normalizedEmail,
        empresaId: empresaId,
        role: 'admin_empresa'
      },
      empresa: {
        id: empresaId,
        nome_fantasia: normalizedNomeEmpresa,
        cnpj: normalizedCnpj
      }
    });
  } catch (err) {
    console.error('Erro no registro:', err);
    if (String(err.message).includes('Esquema de usuários incompatível')) {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erro ao criar conta.' });
  }
});

/**
 * @route  POST /api/users/invite
 * @access Privado (requer JWT + role admin_empresa ou admin_global)
 * @description Convida um novo usuário para a empresa do admin.
 *
 * Fluxo:
 *  REQUEST  → { nome, email, password }
 *  DB Write → INSERT INTO usuarios (empresa_id do admin, role: 'usuario')
 *  RESPONSE → { message, userId }
 *
 * @security Apenas admins podem convidar usuários
 * @security Usuário é criado na mesma empresa do admin
 */
app.post('/api/users/invite', authenticateToken, async (req, res) => {
  const { nome, email, password } = req.body;

  // Verificar se é admin
  if (!['admin_empresa', 'admin_global'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Apenas administradores podem convidar usuários.' });
  }

  if (!nome || !email || !password) {
    return res.status(400).json({ error: 'Nome, email e senha são obrigatórios.' });
  }

  try {
    const userTable = await getUserTable();
    await ensureEnterpriseUserSchema();

    // Verificar se email já existe
    const [existingUser] = await db.query(`SELECT id FROM \`${userTable}\` WHERE email = ?`, [email]);
    if (existingUser.length > 0) {
      return res.status(400).json({ error: 'Email já cadastrado.' });
    }

    // Hash da senha
    const hashedPassword = await bcrypt.hash(password, 10);

    // Criar usuário na empresa do admin
    const [result] = await db.query(
      `INSERT INTO \`${userTable}\` (empresa_id, nome, email, senha_hash, role) VALUES (?, ?, ?, ?, ?)`,
      [req.user.empresaId, nome, email, hashedPassword, 'usuario']
    );

    res.status(201).json({
      message: 'Usuário convidado com sucesso!',
      userId: result.insertId
    });
  } catch (err) {
    console.error('Erro ao convidar usuário:', err);
    if (String(err.message).includes('Esquema de usuários incompatível')) {
      return res.status(500).json({ error: err.message });
    }
    res.status(500).json({ error: 'Erro ao convidar usuário.' });
  }
});

/**
 * @route  POST /api/chat
 * @function handleChatMessage
 * @description Handler principal do pipeline RAG completo no modelo Workspace Aberto.
 *              Projetos pertencem a Empresas e o tenant é isolado por empresaId.
 *
 * Fluxo de dados (Request → Response):
 *  ┌─────────────────────────────────────────────────────────────────┐
 *  │ 1. [INPUT]   Recebe pergunta + IDs dos PDFs selecionados         │
 *  │ 2. [PERSIST] Salva pergunta do usuário no MySQL (tabela messages) │
 *  │ 3. [RETRIEVE] Gera embedding da pergunta → busca semântica no     │
 *  │              Qdrant filtrada por empresaId + fileIds (RAG Retrieve)
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
 * @param {import('express').Request}  req - Corpo: { text?, prompt?, selectedPdfIds?, fileIds?, session_id }
 * @param {import('express').Response} res - Resposta: { text: string, answer: string }
 * @security Filtra via req.user.empresaId para garantir isolamento tenant entre empresas.
 */
const handleChatMessage = async (req, res) => {
  // Normaliza os campos de entrada: suporta 'text' (novo) e 'prompt' (legado)
  const { text, prompt, selectedPdfIds, fileIds, session_id } = req.body;
  const userPrompt = (text || prompt || '').trim();

  // Normaliza os IDs dos PDFs independentemente do campo enviado pelo frontend
  const receivedFileIds = Array.isArray(selectedPdfIds)
    ? selectedPdfIds
    : (Array.isArray(fileIds) ? fileIds : []);
  const rawSessionId = session_id ?? null;
  const normalizedSessionId = (rawSessionId === null || rawSessionId === undefined || rawSessionId === '')
    ? null
    : Number(rawSessionId);
  const userId = req.user.id; // Injetado pelo middleware authenticateToken
  if (!userPrompt) return res.status(400).json({ error: "Mensagem vazia." });
  if (normalizedSessionId === null) {
    return res.status(400).json({ error: 'session_id é obrigatório.' });
  }
  if (normalizedSessionId !== null && (!Number.isInteger(normalizedSessionId) || normalizedSessionId <= 0)) {
    return res.status(400).json({ error: 'session_id inválido.' });
  }

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
    // STEP 0 — Validar sessão ativa enviada pelo frontend
    // -----------------------------------------------------------------------
    if (normalizedSessionId !== null) {
      const [sessionRows] = await db.query(
        'SELECT id FROM sessoes_chat WHERE id = ? AND usuario_id = ? AND empresa_id = ? LIMIT 1',
        [normalizedSessionId, userId, req.user.empresaId]
      );

      if (!Array.isArray(sessionRows) || sessionRows.length === 0) {
        return res.status(403).json({ error: 'Sessão de chat inválida para este usuário.' });
      }
    }

    // -----------------------------------------------------------------------
    // STEP 1 — Persistir pergunta do usuário
    // -----------------------------------------------------------------------
    try {
      await db.query(
        'INSERT INTO messages (user_id, sender, text, session_id) VALUES (?, ?, ?, ?)',
        [userId, 'user', userPrompt, normalizedSessionId]
      );
    } catch (insertErr) {
      if (insertErr?.code === 'ER_BAD_FIELD_ERROR' && normalizedSessionId !== null) {
        console.error('[CHAT] Coluna de sessão não encontrada na tabela messages:', insertErr.message);
        return res.status(500).json({ error: 'Coluna session_id ausente na tabela messages. Execute a migração do banco.' });
      }
      if (insertErr?.errno === 1452 || insertErr?.code === 'ER_NO_REFERENCED_ROW_2' || insertErr?.code === 'ER_NO_REFERENCED_ROW') {
        console.error('[CHAT] FK violation ao inserir message para user_id=', userId, insertErr.message);
        return res.status(403).json({ error: 'Usuário inválido para o chat. Refaça login ou contate o suporte.' });
      }
      throw insertErr;
    }
    if (clientDisconnected) return;

    // -----------------------------------------------------------------------
    // STEP 2 — Resolver e validar IDs dos arquivos para filtro vetorial
    // -----------------------------------------------------------------------
    // Deduplica e garante inteiros positivos para evitar injeção de valores inválidos no filtro Qdrant
    let normalizedFileIds = [...new Set(receivedFileIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0))];

    // Fallback de segurança: se o frontend não enviou seleção, usa o PDF mais recente da empresa
    if (normalizedFileIds.length === 0) {
      const [lastFiles] = await db.query(
        'SELECT id FROM documentos WHERE projeto_id IN (SELECT id FROM projetos WHERE empresa_id = ?) AND status = ? ORDER BY id DESC LIMIT 1',
        [req.user.empresaId, 'indexado']
      );
      if (!lastFiles.length) {
        return res.status(400).json({
          error: 'Nenhum PDF selecionado (e nenhum PDF encontrado na empresa). Envie/seleciona ao menos um documento.'
        });
      }
      normalizedFileIds.push(Number(lastFiles[0].id));
      console.warn('⚠️ Nenhum PDF selecionado; usando fallback do último PDF da empresa. id=', normalizedFileIds[0]);
    }

    // Valida que os PDFs selecionados realmente pertencem ao tenant do usuário.
    const filePlaceholders = normalizedFileIds.map(() => '?').join(',');
    const [validFiles] = await db.query(
      `SELECT id FROM documentos WHERE id IN (${filePlaceholders}) AND projeto_id IN (SELECT id FROM projetos WHERE empresa_id = ?) AND status = ?`,
      [...normalizedFileIds, req.user.empresaId, 'indexado']
    );

    if (!validFiles.length) {
      return res.status(400).json({
        error: 'Nenhum PDF indexado válido foi encontrado para a sua empresa. Selecione um documento que já tenha sido indexado com sucesso.'
      });
    }

    normalizedFileIds = validFiles.map((file) => Number(file.id));

    // -----------------------------------------------------------------------
    // STEP 3 — RAG Retrieve: embedding da pergunta + busca semântica no Qdrant
    // -----------------------------------------------------------------------
    console.log('[CHAT] Passo 1: Gerando embedding da pergunta e buscando contexto no Qdrant...');
    const { context, hits } = await retrieveContext({
      question: userPrompt,
      empresaId: req.user.empresaId,
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
    try {
      await db.query(
        'INSERT INTO messages (user_id, sender, text, session_id) VALUES (?, ?, ?, ?)',
        [userId, 'bot', aiResponse, normalizedSessionId]
      );
      console.log('[CHAT] Passo 3 OK: Resposta salva no banco');
    } catch (insertErr) {
      if (insertErr?.code === 'ER_BAD_FIELD_ERROR' && normalizedSessionId !== null) {
        console.error('[CHAT] Coluna de sessão não encontrada na tabela messages:', insertErr.message);
        return res.status(500).json({ error: 'Coluna session_id ausente na tabela messages. Execute a migração do banco.' });
      }
      if (insertErr?.errno === 1452 || insertErr?.code === 'ER_NO_REFERENCED_ROW_2' || insertErr?.code === 'ER_NO_REFERENCED_ROW') {
        console.error('[CHAT] FK violation ao inserir resposta bot para user_id=', userId, insertErr.message);
        return res.status(403).json({ error: 'Usuário inválido para o chat. Refaça login ou contate o suporte.' });
      }
      throw insertErr;
    }
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
 * Filtro de acesso Multi-Tenant para pastas/documentos.
 *
 * Um usuário pode acessar um item se:
 *  - escopo = 'empresa' e empresa_id corresponde à empresa do usuário
 *  - escopo = 'setor' e setor_id corresponde ao setor do usuário
 *  - escopo = 'pessoal' e usuario_id corresponde ao usuário
 */
/**
 * @route  POST /api/projects/create
 * @access Privado (requer JWT)
 * @description Cria um novo projeto na empresa do usuário.
 *
 * Fluxo de dados:
 *  REQUEST  → { name }
 *  DB Write → INSERT INTO projetos (empresa_id, nome)
 *  RESPONSE → { message, id }
 */
app.post('/api/projects/create', authenticateToken, async (req, res) => {
  console.log('[PROJECTS/CREATE] Requisição recebida:', { user: req.user?.id, body: req.body });
  if (req.user.empresaId == null || req.user.empresaId === '') {
    console.warn('[PROJECTS/CREATE] JWT sem empresaId');
    return res.status(403).json({ error: 'Conta sem empresa vinculada. Faça login novamente ou contate o suporte.' });
  }
  const { name } = req.body;

  if (!name || !name.trim()) {
    console.log('[PROJECTS/CREATE] Nome inválido:', name);
    return res.status(400).json({ error: 'Nome do projeto é obrigatório.' });
  }

  try {
    console.log('[PROJECTS/CREATE] Criando projeto:', name.trim(), 'para empresa:', req.user.empresaId);
    const [result] = await db.query(
      'INSERT INTO projetos (empresa_id, nome) VALUES (?, ?)',
      [req.user.empresaId, name.trim()]
    );
    console.log('[PROJECTS/CREATE] Projeto criado com ID:', result.insertId);
    // Número explícito — evita falha de JSON com BigInt em alguns drivers mysql2
    res.json({ message: 'Projeto criado!', id: Number(result.insertId) });
  } catch (err) {
    console.error('[PROJECTS/CREATE] Erro ao criar projeto:', err);
    res.status(500).json({ error: 'Erro ao criar projeto.' });
  }
});

/**
 * Compatibilidade legado: POST /api/files/mkdir
 * Redireciona para criação de projeto moderno.
 */
app.post('/api/files/mkdir', authenticateToken, async (req, res) => {
  const folderName = String(req.body.folderName || req.body.name || '').trim();
  if (!folderName) {
    return res.status(400).json({ error: 'Nome da pasta é obrigatório.' });
  }

  try {
    const [result] = await db.query(
      'INSERT INTO projetos (empresa_id, nome) VALUES (?, ?)',
      [req.user.empresaId, folderName]
    );
    res.json({ message: 'Pasta criada!', id: Number(result.insertId), nome: folderName });
  } catch (err) {
    console.error('[FILES/MKDIR] Erro ao criar pasta:', err);
    res.status(500).json({ error: 'Erro ao criar pasta.' });
  }
});

/**
 * Compatibilidade legado: GET /api/files/all
 * Retorna projetos e documentos em formato legado (pastas/documentos).
 */
app.get('/api/files/all', authenticateToken, async (req, res) => {
  try {
    const [projetos] = await db.query(
      'SELECT * FROM projetos WHERE empresa_id = ? ORDER BY nome ASC',
      [req.user.empresaId]
    );

    const [documentos] = await db.query(
      'SELECT * FROM documentos WHERE projeto_id IN (SELECT id FROM projetos WHERE empresa_id = ?) ORDER BY nome_arquivo ASC',
      [req.user.empresaId]
    );

    const pastas = projetos.map(projeto => ({
      ...projeto,
      is_directory: 1
    }));

    const documentosFormatados = documentos.map(doc => ({
      ...doc,
      pasta_id: doc.projeto_id,
      is_directory: 0
    }));

    res.json({ pastas, documentos: documentosFormatados });
  } catch (err) {
    console.error('[FILES/ALL] Erro ao listar arquivos:', err);
    res.status(500).json({ error: 'Erro ao listar arquivos.' });
  }
});

/**
 * Compatibilidade legado: GET /api/messages
 * Retorna histórico de mensagens do usuário.
 */
app.get('/api/messages', authenticateToken, async (req, res) => {
  try {
    const sessionIdRaw = req.query.session_id ?? null;
    const sessionId = sessionIdRaw ? Number(sessionIdRaw) : null;
    if (!sessionId || !Number.isFinite(sessionId)) {
      return res.json([]);
    }

    const [rows] = await db.query(
      'SELECT id, sender, text, created_at FROM messages WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC',
      [req.user.id, sessionId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[MESSAGES/GET] Erro ao carregar histórico de mensagens:', err);
    res.status(500).json({ error: 'Erro ao carregar mensagens.' });
  }
});

/**
 * @route  POST /api/chats
 * @access Privado
 * @description Cria uma nova sessão de chat para o usuário autenticado.
 *              Plano básico: máximo de 5 sessões por usuário.
 */
app.post('/api/chats', authenticateToken, async (req, res) => {
  const userId = Number(req.user.id);
  const empresaId = Number(req.user.empresaId);
  const tituloRaw = String(req.body?.titulo || '').trim();

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Usuário inválido para criar sessão.' });
  }
  if (!Number.isFinite(empresaId) || empresaId <= 0) {
    return res.status(403).json({ error: 'Conta sem empresa vinculada.' });
  }

  try {
    const [countRows] = await db.query(
      'SELECT COUNT(*) AS total FROM sessoes_chat WHERE usuario_id = ? AND empresa_id = ?',
      [userId, empresaId]
    );

    const total = Number(countRows?.[0]?.total || 0);
    if (total >= 5) {
      return res.status(403).json({
        error: 'Limite do plano grátis atingido (Max 5 chats). Faça upgrade para continuar.'
      });
    }

    const titulo = tituloRaw || `Novo Chat ${total + 1}`;
    const [result] = await db.query(
      'INSERT INTO sessoes_chat (usuario_id, empresa_id, titulo) VALUES (?, ?, ?)',
      [userId, empresaId, titulo]
    );

    return res.status(201).json({
      id: Number(result.insertId),
      usuario_id: userId,
      empresa_id: empresaId,
      titulo,
      created_at: new Date().toISOString()
    });
  } catch (err) {
    console.error('[CHATS/POST] Erro ao criar sessão de chat:', err);
    return res.status(500).json({ error: 'Erro ao criar sessão de chat.' });
  }
});

/**
 * @route  GET /api/chats
 * @access Privado
 * @description Lista sessões de chat do usuário autenticado (mais recentes primeiro).
 */
app.get('/api/chats', authenticateToken, async (req, res) => {
  const userId = Number(req.user.id);
  const empresaId = Number(req.user.empresaId);

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Usuário inválido para listar sessões.' });
  }
  if (!Number.isFinite(empresaId) || empresaId <= 0) {
    return res.status(403).json({ error: 'Conta sem empresa vinculada.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT id, usuario_id, empresa_id, titulo, created_at FROM sessoes_chat WHERE usuario_id = ? AND empresa_id = ? ORDER BY created_at DESC',
      [userId, empresaId]
    );
    return res.json(rows);
  } catch (err) {
    console.error('[CHATS/GET] Erro ao listar sessões de chat:', err);
    return res.status(500).json({ error: 'Erro ao listar sessões de chat.' });
  }
});

/**
 * @route  GET /api/chats/:id/mensagens
 * @access Privado
 * @description Lista mensagens de uma sessão específica do usuário autenticado.
 */
app.get('/api/chats/:id/mensagens', authenticateToken, async (req, res) => {
  const chatId = Number(req.params.id);
  const userId = Number(req.user.id);
  const empresaId = Number(req.user.empresaId);

  if (!Number.isFinite(chatId) || chatId <= 0) {
    return res.status(400).json({ error: 'ID de chat inválido.' });
  }

  if (!Number.isFinite(userId) || userId <= 0) {
    return res.status(400).json({ error: 'Usuário inválido para carregar mensagens.' });
  }

  if (!Number.isFinite(empresaId) || empresaId <= 0) {
    return res.status(403).json({ error: 'Conta sem empresa vinculada.' });
  }

  try {
    const [sessionRows] = await db.query(
      'SELECT id FROM sessoes_chat WHERE id = ? AND usuario_id = ? AND empresa_id = ? LIMIT 1',
      [chatId, userId, empresaId]
    );

    if (!Array.isArray(sessionRows) || sessionRows.length === 0) {
      return res.status(404).json({ error: 'Sessão de chat não encontrada.' });
    }

    const [messageRows] = await db.query(
      'SELECT id, sender, text, created_at FROM messages WHERE user_id = ? AND session_id = ? ORDER BY created_at ASC',
      [userId, chatId]
    );
    const rows = messageRows;

    const normalized = (Array.isArray(rows) ? rows : []).map((msg) => {
      const rawSender = String(msg.sender || '').toLowerCase();
      const sender = rawSender === 'assistant' ? 'bot' : (rawSender === 'user' ? 'user' : 'bot');
      return {
        id: Number(msg.id),
        sender,
        text: String(msg.text || ''),
        created_at: msg.created_at
      };
    });

    return res.json(normalized);
  } catch (err) {
    console.error('[CHATS/MESSAGES/GET] Erro ao carregar mensagens da sessão:', err);
    return res.status(500).json({ error: 'Erro ao carregar mensagens do chat.' });
  }
});

/**
 * @route  DELETE /api/chats/:id
 * @access Privado
 * @description Exclui uma sessão de chat do usuário autenticado.
 */
app.delete('/api/chats/:id', authenticateToken, async (req, res) => {
  const chatId = Number(req.params.id);
  const userId = Number(req.user.id);
  const empresaId = Number(req.user.empresaId);

  if (!Number.isFinite(chatId) || chatId <= 0) {
    return res.status(400).json({ error: 'ID de chat inválido.' });
  }

  try {
    const [result] = await db.query(
      'DELETE FROM sessoes_chat WHERE id = ? AND usuario_id = ? AND empresa_id = ?',
      [chatId, userId, empresaId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Sessão de chat não encontrada.' });
    }

    return res.json({ message: 'Sessão de chat removida com sucesso.' });
  } catch (err) {
    console.error('[CHATS/DELETE] Erro ao excluir sessão de chat:', err);
    return res.status(500).json({ error: 'Erro ao excluir sessão de chat.' });
  }
});

/**
 * @route  GET /api/projects/list
 * @access Privado (requer JWT)
 * @description Lista os projetos e documentos da empresa do usuário.
 *
 * Retorna um objeto com dois arrays: { projetos: [], documentos: [] }.
 * Opcionalmente filtra documentos por projeto_id quando req.query.projetoId está presente.
 */
app.get('/api/projects/list', authenticateToken, async (req, res) => {
  const projetoId = req.query.projetoId ? Number(req.query.projetoId) : null;

  if (req.user.empresaId == null || req.user.empresaId === '') {
    console.warn('[PROJECTS/LIST] JWT sem empresaId');
    return res.status(403).json({ error: 'Conta sem empresa vinculada. Faça login novamente ou contate o suporte.' });
  }

  try {
    // Listar projetos da empresa
    const [projetos] = await db.query(
      'SELECT * FROM projetos WHERE empresa_id = ? ORDER BY nome ASC',
      [req.user.empresaId]
    );

    // Listar documentos
    let documentoQuery = 'SELECT * FROM documentos WHERE projeto_id IN (SELECT id FROM projetos WHERE empresa_id = ?)';
    let documentoParams = [req.user.empresaId];

    if (projetoId) {
      documentoQuery += ' AND projeto_id = ?';
      documentoParams.push(projetoId);
    }

    documentoQuery += ' ORDER BY nome_arquivo ASC';
    const [documentos] = await db.query(documentoQuery, documentoParams);

    res.json({ projetos, documentos });
  } catch (err) {
    console.error('Erro ao listar projetos:', err);
    res.status(500).json({ error: 'Erro ao listar projetos.' });
  }
});

/**
 * @route  POST /api/projects/upload
 * @access Privado (requer JWT)
 * @description Upload de documento em um projeto da empresa no modelo Workspace Aberto.
 *              O projeto deve pertencer à empresa do usuário autenticado.
 *
 * Fluxo:
 *  1. Recebe FormData com os campos `file` e `projetoId`.
 *  2. Valida se o projeto pertence ao tenant (`req.user.empresaId`).
 *  3. Persiste metadados em `documentos` com status pendente.
 *  4. Move o arquivo para storage isolado por empresa/usuário.
 *  5. Dispara ingestão vetorial no Qdrant com payload multi-tenant.
 *
 * @param {object} req.body - { projetoId: number }
 * @param {File} req.file - PDF enviado pelo cliente
 * @security Valida `req.user.empresaId` e mantém os arquivos isolados por tenant.
 */
app.post('/api/projects/upload', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Arquivo vazio.' });

  const projetoId = Number(req.body.projetoId);

  if (!projetoId) {
    return res.status(400).json({ error: 'projetoId é obrigatório.' });
  }

  try {
    // Verificar se o projeto pertence à empresa do usuário
    const [projectRows] = await db.query(
      'SELECT id FROM projetos WHERE id = ? AND empresa_id = ?',
      [projetoId, req.user.empresaId]
    );

    if (projectRows.length === 0) {
      return res.status(404).json({ error: 'Projeto não encontrado ou acesso negado.' });
    }

    const tenantFolder = path.join(UPLOAD_ROOT, String(req.user.empresaId), String(req.user.id));
    await fs.ensureDir(tenantFolder);
    const storagePath = path.join(tenantFolder, req.file.filename);

    if (req.file.path !== storagePath) {
      await fs.move(req.file.path, storagePath, { overwrite: true });
    }

    // schema_completo.sql não define tamanho_bytes; schema_multitenant define. Suporta os dois.
    let insertResult;
    try {
      [insertResult] = await db.query(
        'INSERT INTO documentos (projeto_id, nome_arquivo, caminho_storage, tamanho_bytes, status) VALUES (?, ?, ?, ?, ?)',
        [projetoId, req.file.originalname, storagePath, req.file.size, 'pendente']
      );
    } catch (insertErr) {
      const isUnknownColumn =
        insertErr && (insertErr.code === 'ER_BAD_FIELD_ERROR' || insertErr.errno === 1054);
      if (isUnknownColumn && String(insertErr.message || '').includes('tamanho_bytes')) {
        [insertResult] = await db.query(
          'INSERT INTO documentos (projeto_id, nome_arquivo, caminho_storage, status) VALUES (?, ?, ?, ?)',
          [projetoId, req.file.originalname, storagePath, 'pendente']
        );
      } else {
        throw insertErr;
      }
    }

    const documentId = Number(insertResult.insertId);

    // Ingestão vetorial no Qdrant
    try {
      const ingestResult = await ingestPdfFile({
        empresaId: req.user.empresaId,
        projetoId,
        fileId: documentId,
        pdfPath: storagePath,
        fileName: req.file.originalname,
        userId: req.user.id
      });

      // Atualiza status para 'indexado' após ingestão bem-sucedida
      await db.query('UPDATE documentos SET status = ? WHERE id = ?', ['indexado', documentId]);

      res.json({
        message: 'Upload e indexação concluídos!',
        documentId,
        nome_arquivo: req.file.originalname,
        caminho_storage: storagePath,
        tamanho_bytes: req.file.size,
        chunkCount: ingestResult.chunkCount
      });
    } catch (ingestError) {
      console.error('Erro na ingestão vetorial:', ingestError);
      // Mesmo com erro na ingestão, o arquivo foi salvo
      await db.query('UPDATE documentos SET status = ? WHERE id = ?', ['erro_indexacao', documentId]);
      res.status(500).json({ error: 'Upload realizado, mas erro na indexação vetorial.' });
    }
  } catch (err) {
    console.error('Erro ao registrar upload:', err);
    res.status(500).json({ error: 'Erro ao registrar upload.' });
  }
});

/**
 * @route  PATCH /api/documents/:id
 * @access Privado
 * @description Renomeia o arquivo de documento dentro do tenant do usuário.
 */
app.patch('/api/documents/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const nomeArquivo = String(req.body.nome_arquivo || '').trim();

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de documento inválido.' });
  }
  if (!nomeArquivo) {
    return res.status(400).json({ error: 'Nome de arquivo é obrigatório.' });
  }
  if (req.user.empresaId == null || req.user.empresaId === '') {
    return res.status(403).json({ error: 'Conta sem empresa vinculada.' });
  }

  try {
    const [result] = await db.query(
      'UPDATE documentos SET nome_arquivo = ? WHERE id = ? AND projeto_id IN (SELECT id FROM projetos WHERE empresa_id = ?)',
      [nomeArquivo, id, req.user.empresaId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Documento não encontrado ou acesso negado.' });
    }

    res.json({ message: 'Nome do arquivo atualizado com sucesso.' });
  } catch (err) {
    console.error('[DOCUMENTS/PATCH] Erro ao renomear documento:', err);
    res.status(500).json({ error: 'Erro ao renomear documento.' });
  }
});

/**
 * @route  DELETE /api/documents/:id
 * @access Privado
 * @description Exclui um documento do tenant, removendo o arquivo em disco e vetores no Qdrant.
 */
app.delete('/api/documents/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de documento inválido.' });
  }
  if (req.user.empresaId == null || req.user.empresaId === '') {
    return res.status(403).json({ error: 'Conta sem empresa vinculada.' });
  }

  try {
    const [rows] = await db.query(
      'SELECT caminho_storage FROM documentos WHERE id = ? AND projeto_id IN (SELECT id FROM projetos WHERE empresa_id = ?)',
      [id, req.user.empresaId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Documento não encontrado ou acesso negado.' });
    }

    const document = rows[0];

    try {
      await qdrantService.deleteByFile(id);
    } catch (qErr) {
      console.warn('[DOCUMENTS/DELETE] Erro ao remover vetores do Qdrant:', qErr.message || qErr);
    }

    if (document.caminho_storage) {
      try {
        await fs.remove(document.caminho_storage);
      } catch (fsErr) {
        console.warn('[DOCUMENTS/DELETE] Erro ao remover arquivo em disco:', fsErr.message || fsErr);
      }
    }

    const [deleteResult] = await db.query(
      'DELETE FROM documentos WHERE id = ? AND projeto_id IN (SELECT id FROM projetos WHERE empresa_id = ?)',
      [id, req.user.empresaId]
    );

    if (deleteResult.affectedRows === 0) {
      return res.status(404).json({ error: 'Documento não encontrado ou acesso negado.' });
    }

    res.json({ message: 'Documento excluído com sucesso.' });
  } catch (err) {
    console.error('[DOCUMENTS/DELETE] Erro ao excluir documento:', err);
    res.status(500).json({ error: 'Erro ao excluir documento.' });
  }
});

/**
 * @route  PATCH /api/projects/:id
 * @access Privado
 * @description Renomeia um projeto da empresa do usuário.
 */
app.patch('/api/projects/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de projeto inválido.' });
  }
  if (req.user.empresaId == null || req.user.empresaId === '') {
    return res.status(403).json({ error: 'Conta sem empresa vinculada.' });
  }
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    return res.status(400).json({ error: 'Nome do projeto é obrigatório.' });
  }

  try {
    const [result] = await db.query(
      'UPDATE projetos SET nome = ? WHERE id = ? AND empresa_id = ?',
      [trimmed, id, req.user.empresaId]
    );
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Projeto não encontrado ou acesso negado.' });
    }
    res.json({ message: 'Projeto atualizado.', id, nome: trimmed });
  } catch (err) {
    console.error('[PROJECTS/PATCH] Erro:', err);
    res.status(500).json({ error: 'Erro ao renomear projeto.' });
  }
});

/**
 * @route  DELETE /api/projects/:id
 * @access Privado
 * @description Remove projeto, documentos (CASCADE), arquivos em disco e vetores no Qdrant.
 */
app.delete('/api/projects/:id', authenticateToken, async (req, res) => {
  const id = Number(req.params.id);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'ID de projeto inválido.' });
  }
  if (req.user.empresaId == null || req.user.empresaId === '') {
    return res.status(403).json({ error: 'Conta sem empresa vinculada.' });
  }

  try {
    const [projectRows] = await db.query(
      'SELECT id FROM projetos WHERE id = ? AND empresa_id = ?',
      [id, req.user.empresaId]
    );
    if (projectRows.length === 0) {
      return res.status(404).json({ error: 'Projeto não encontrado ou acesso negado.' });
    }

    const [docs] = await db.query(
      'SELECT caminho_storage FROM documentos WHERE projeto_id = ?',
      [id]
    );

    try {
      await qdrantService.deleteByProjetoAndEmpresa(id, req.user.empresaId);
    } catch (qErr) {
      console.warn('[PROJECTS/DELETE] Qdrant:', qErr.message);
    }

    for (const doc of docs) {
      if (doc.caminho_storage) {
        try {
          await fs.remove(doc.caminho_storage);
        } catch (fsErr) {
          console.warn('[PROJECTS/DELETE] Arquivo em disco:', fsErr.message);
        }
      }
    }

    const [del] = await db.query(
      'DELETE FROM projetos WHERE id = ? AND empresa_id = ?',
      [id, req.user.empresaId]
    );
    if (del.affectedRows === 0) {
      return res.status(404).json({ error: 'Projeto não encontrado ou acesso negado.' });
    }

    res.json({ message: 'Projeto removido.' });
  } catch (err) {
    console.error('[PROJECTS/DELETE] Erro:', err);
    res.status(500).json({ error: 'Erro ao remover projeto.' });
  }
});

/** Inicia o servidor HTTP na porta configurada, escutando em todas as interfaces. */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sistema RAG Online na porta ${PORT}`);
});