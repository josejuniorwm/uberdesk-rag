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

// Proxy Reverso (aaPanel): lê IP real do cliente e habilita HTTPS corretamente
app.set('trust proxy', 1);

app.use(express.json());
app.use(cors({ origin: '*' }));

// Log de origem para validação dos Virtual Hosts do aaPanel
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} — Host: ${req.headers.host} — IP: ${req.ip}`);
  next();
});

const JWT_SECRET = process.env.JWT_SECRET || 'sua_chave_secreta_aqui';
const QDRANT_URL = process.env.QDRANT_URL || '';
const QDRANT_API_KEY = process.env.QDRANT_API_KEY || '';
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama3-8b-8192';
const PORT = 3001;
const UPLOAD_ROOT = path.join(__dirname, 'storage');

// Configuração do Multer para salvar os PDFs
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_ROOT),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

fs.ensureDirSync(UPLOAD_ROOT);

// Conexão com o Banco usando Pool e suporte a Promises
const pool = mysql.createPool({
  host: 'db',
  user: 'dashbyte_user',
  password: 'efNaekDtcZFjCmbA',
  database: 'dashbyte_chat',
  waitForConnections: true,
  connectionLimit: 10
});
const db = pool.promise(); // Habilita o uso de await nas queries

console.log('✅ Pool de conexões MySQL configurado com Promises.');
if (!QDRANT_URL || !QDRANT_API_KEY) {
  console.warn('⚠️ Qdrant nao configurado (QDRANT_URL/QDRANT_API_KEY). O RAG vetorial nao funcionara.');
}

// Middleware de Autenticação
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Acesso negado.' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido.' });
    req.user = user;
    next();
  });
};

// --- ROTAS ---

// Auth API: valida credenciais e emite JWT para acesso às rotas protegidas.
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const [results] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
    if (results.length === 0) return res.status(401).json({ error: "Usuário não encontrado." });

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ error: "Senha incorreta." });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: "Erro no banco." });
  }
});

// Chat API (RAG):
// Step 1) Persistir pergunta no MySQL
// Step 2) Recuperar contexto semântico no Qdrant
// Step 3) Gerar resposta na Groq
// Step 4) Persistir resposta e devolver ao frontend
const handleChatMessage = async (req, res) => {
  const { text, prompt, selectedPdfIds, fileIds } = req.body;
  const userPrompt = (text || prompt || '').trim();
  const receivedFileIds = Array.isArray(selectedPdfIds)
    ? selectedPdfIds
    : (Array.isArray(fileIds) ? fileIds : []);
  const userId = req.user.id;
  if (!userPrompt) return res.status(400).json({ error: "Mensagem vazia." });

  const abortController = new AbortController();
  let clientDisconnected = false;
  const handleClientAbort = () => {
    if (clientDisconnected) return;
    clientDisconnected = true;
    abortController.abort();
    console.warn('⚠️ Cliente interrompeu a requisição de chat.');
  };
  const handleResponseClose = () => {
    // Se a resposta ainda não terminou e o socket fechou, cliente saiu no meio.
    if (!res.writableEnded) {
      handleClientAbort();
    }
  };
  req.on('aborted', handleClientAbort);
  res.on('close', handleResponseClose);

  try {
    // 1. Salva a pergunta do usuário
    await db.query('INSERT INTO messages (user_id, sender, text) VALUES (?, ?, ?)', [userId, 'user', userPrompt]);
    if (clientDisconnected) return;

    // 2. Resolve os arquivos selecionados para filtrar a busca vetorial.
    const normalizedFileIds = [...new Set(receivedFileIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0))];

    // Fallback: se o front não enviou seleção, use o último PDF do usuário.
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

    console.log('[CHAT] Passo 1: Gerando embedding da pergunta e buscando contexto no Qdrant...');
    const { context, hits } = await retrieveContext({
      question: userPrompt,
      userId,
      fileIds: normalizedFileIds,
      topK: 3
    });

    if (!context.trim()) {
      return res.status(400).json({
        error: 'Nao foi encontrado contexto relevante no indice vetorial para os PDFs selecionados.'
      });
    }
    console.log('[CHAT] Passo 1 OK: ', hits.length, 'chunks recuperados do Qdrant');
    if (clientDisconnected) return;

    // 3. Chamada à Groq
    if (!GROQ_API_KEY) {
      return res.status(500).json({ error: 'GROQ_API_KEY não configurada no servidor.' });
    }

    console.log('[CHAT] Passo 2: Enviando prompt para a API do Groq...');
    const aiResponse = await generateGroqAnswer({
      question: userPrompt,
      context,
      groqApiKey: GROQ_API_KEY,
      groqModel: GROQ_MODEL,
      abortSignal: abortController.signal
    });

    console.log('[CHAT] Passo 2 OK: Resposta recebida da IA (', aiResponse.length, 'caracteres)');
    if (clientDisconnected) return;

    // 4. Salva resposta e envia pro Front
    console.log('[CHAT] Passo 3: Salvando resposta no banco de dados...');
    await db.query('INSERT INTO messages (user_id, sender, text) VALUES (?, ?, ?)', [userId, 'bot', aiResponse]);
    console.log('[CHAT] Passo 3 OK: Resposta salva no banco');
    if (clientDisconnected) return;
    console.log('[CHAT] Passo 4: Enviando resposta ao cliente...');
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
    req.off('aborted', handleClientAbort);
    res.off('close', handleResponseClose);
  }
};

app.post('/api/messages', authenticateToken, handleChatMessage);
app.post('/api/chat', authenticateToken, handleChatMessage);

// Files API: cria pastas lógicas por usuário e mantém estrutura hierárquica no banco.
app.post('/api/files/mkdir', authenticateToken, async (req, res) => {
  const { folderName, parentId } = req.body; // parentId permite pastas dentro de pastas
  const userId = req.user.id;

  try {
    // 1. Salva no Banco
    const [result] = await db.query(
      'INSERT INTO files (user_id, name, is_directory, parent_id) VALUES (?, ?, 1, ?)',
      [userId, folderName, parentId || null]
    );
    
    // 2. Cria a pasta física (opcional, mas bom para organização)
    const folderPath = path.join(UPLOAD_ROOT, userId.toString(), folderName);
    await fs.ensureDir(folderPath);

    res.json({ message: "Pasta criada!", id: result.insertId });
  } catch (err) {
    res.status(500).json({ error: "Erro ao criar pasta." });
  }
});

// Messages API: retorna histórico de conversa do usuário autenticado.
app.get('/api/messages', authenticateToken, async (req, res) => {
  try {
    const [results] = await db.query('SELECT sender, text, created_at FROM messages WHERE user_id = ? ORDER BY created_at ASC', [req.user.id]);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Erro ao buscar mensagens." });
  }
});

// Files API: lista diretório atual (raiz ou pasta específica) para navegação incremental.
app.get('/api/files/list', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const parentId = req.query.parentId || null;

  try {
    const [results] = await db.query(
      'SELECT * FROM files WHERE user_id = ? AND (parent_id <=> ?) ORDER BY is_directory DESC, name ASC',
      [userId, parentId]
    );
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: "Erro ao listar seus arquivos." });
  }
});

// Files API: carrega árvore completa para o FileTree do frontend.
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

// Files API: renomeia arquivo/pasta respeitando escopo do usuário.
app.patch('/api/files/rename/:id', authenticateToken, async (req, res) => {
  const { newName } = req.body;
  const fileId = req.params.id;
  const userId = req.user.id;

  try {
    await db.query(
      'UPDATE files SET name = ? WHERE id = ? AND user_id = ?',
      [newName, fileId, userId]
    );
    res.json({ message: "Renomeado com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao renomear." });
  }
});

// Files API: remove item do banco e arquivo físico quando aplicável.
app.delete('/api/files/:id', authenticateToken, async (req, res) => {
  const fileId = req.params.id;
  const userId = req.user.id;

  try {
    // Busca o caminho antes de deletar para apagar o arquivo físico
    const [file] = await db.query('SELECT file_path, is_directory FROM files WHERE id = ? AND user_id = ?', [fileId, userId]);
    
    if (file.length > 0) {
      if (file[0].is_directory === 0 && file[0].file_path) {
        if (fs.existsSync(file[0].file_path)) fs.unlinkSync(file[0].file_path);
      }
      // Deleta no banco (Se for pasta, ideal seria deletar os filhos também)
      await db.query('DELETE FROM files WHERE id = ? AND user_id = ?', [fileId, userId]);
    }
    
    res.json({ message: "Excluído com sucesso!" });
  } catch (err) {
    res.status(500).json({ error: "Erro ao excluir." });
  }
});

// Files API: move item entre pastas alterando parent_id.
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

// Files API: recebe upload, registra no banco e indexa PDF no pipeline RAG.
app.post('/api/files/upload', authenticateToken, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo vazio." });
  const userId = req.user.id;
  const parentId = req.body.parentId || null;

  try {
    const [result] = await db.query(
      'INSERT INTO files (user_id, name, file_path, is_directory, parent_id) VALUES (?, ?, ?, 0, ?)',
      [userId, req.file.originalname, req.file.path, parentId]
    );

    const fileId = result.insertId;
    let indexing = null;
    let indexingWarning = null;

    if (req.file.mimetype === 'application/pdf' || req.file.originalname.toLowerCase().endsWith('.pdf')) {
      try {
        indexing = await ingestPdfFile({
          userId,
          fileId,
          filePath: req.file.path,
          fileName: req.file.originalname
        });
      } catch (indexError) {
        indexingWarning = 'Upload concluido, mas a indexacao vetorial falhou para este PDF.';
        console.error('Erro de indexacao vetorial:', indexError.message);
      }
    }

    res.json({
      message: "Upload concluído!",
      name: req.file.originalname,
      fileId,
      indexing,
      indexingWarning
    });
  } catch (err) {
    res.status(500).json({ error: "Erro ao registrar upload." });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Sistema RAG Online na porta ${PORT}`);
});