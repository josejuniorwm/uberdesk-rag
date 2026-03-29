const express = require('express');
const mysql = require('mysql2');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const fs = require('fs-extra');
const path = require('path');
const multer = require('multer');

// 1. CONFIGURAÇÕES INICIAIS
const app = express();
app.use(express.json());
app.use(cors());

const JWT_SECRET = 'sua_chave_secreta_aqui';
const PORT = 3001;
const UPLOAD_ROOT = path.join(__dirname, 'storage');

// --- CONFIGURAÇÃO DO MULTER (O que estava faltando!) ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Garante que o arquivo vá para a pasta 'storage'
    cb(null, UPLOAD_ROOT);
  },
  filename: (req, file, cb) => {
    // Evita nomes duplicados adicionando a data atual
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ storage: storage });

// Garante que a pasta de arquivos existe
fs.ensureDirSync(UPLOAD_ROOT);

// 2. CONEXÃO COM O BANCO DE DADOS
const db = mysql.createConnection({
  host: 'localhost',
  user: 'dashbyte_user',
  password: 'efNaekDtcZFjCmbA',
  database: 'dashbyte_chat'
});

db.connect((err) => {
  if (err) {
    console.error('❌ Erro ao conectar ao MySQL:', err.message);
  } else {
    console.log('✅ Conectado ao MySQL com sucesso.');
  }
});

// 3. MIDDLEWARE DE AUTENTICAÇÃO
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

// 4. ROTAS

// --- LOGIN ---
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  console.log(">>>> Tentativa de login:", email);

  const query = 'SELECT * FROM users WHERE email = ?';
  db.query(query, [email], async (err, results) => {
    if (err) return res.status(500).json({ error: "Erro interno." });
    if (results.length === 0) return res.status(401).json({ error: "Usuário não encontrado." });

    const user = results[0];
    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) return res.status(401).json({ error: "Senha incorreta." });

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '24h' });
    
    console.log("✅ Login realizado:", email);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
  });
});

// --- BUSCAR HISTÓRICO ---
app.get('/api/messages', authenticateToken, (req, res) => {
  const query = 'SELECT sender, text, created_at FROM messages WHERE user_id = ? ORDER BY created_at ASC';
  db.query(query, [req.user.id], (err, results) => {
    if (err) {
      console.error("Erro no histórico:", err);
      return res.status(500).json({ error: "Erro ao buscar mensagens." });
    }
    res.json(results);
  });
});

// --- ENVIAR MENSAGEM E OLLAMA ---
app.post('/api/messages', authenticateToken, async (req, res) => {
  const { text } = req.body;
  const userId = req.user.id;
  
  if (!text) return res.status(400).json({ error: "Mensagem vazia." });

  try {
    // A. Salva mensagem do Usuário
    db.query('INSERT INTO messages (user_id, sender, text) VALUES (?, ?, ?)', [userId, 'user', text]);

    // B. Chama o Ollama (IA Local no WSL)
    console.log("🤖 Chamando Ollama para:", text);
    const response = await fetch('http://192.168.0.235:11434/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama3', 
        prompt: text,
        stream: false
      })
    });
    
    if (!response.ok) throw new Error(`Ollama indisponível (Status ${response.status})`);
    
    const data = await response.json();
    console.log("RESPOSTA COMPLETA DO OLLAMA:", data); // <--- ADICIONE ISSO
    const botReply = data.response || (data.message && data.message.content) || "A IA não retornou texto.";

    // C. Salva resposta do Bot
    db.query('INSERT INTO messages (user_id, sender, text) VALUES (?, ?, ?)', [userId, 'bot', botReply]);
    // Salva no banco
    

    
    // Envia com DOIS nomes comuns para garantir que o React ache um deles
    res.json({ 
      text: botReply, 
      answer: botReply,
      reply: botReply 
    });

  } catch (error) {
    console.error("❌ Erro no Ollama:", error.message);
    res.status(500).json({ error: "A IA não respondeu, mas a mensagem foi salva no banco." });
  }
});

// --- 1. CRIAR PASTA (mkdir) ---
app.post('/api/files/mkdir', authenticateToken, async (req, res) => {
  const { folderName, parentId } = req.body; // parentId é opcional (para pastas dentro de pastas)
  const userId = req.user.id;

  if (!folderName) return res.status(400).json({ error: "Nome da pasta é obrigatório." });

  try {
    // Criamos um caminho físico único: storage/ID_USUARIO/nome_da_pasta
    // Isso evita que usuários com nomes de pastas iguais se entrolem
    const userFolderPath = path.join(UPLOAD_ROOT, userId.toString(), folderName);
    await fs.ensureDir(userFolderPath);

    // Registra no banco de dados (is_directory = 1)
    const query = 'INSERT INTO files (user_id, name, file_path, is_directory, parent_id) VALUES (?, ?, ?, 1, ?)';
    db.query(query, [userId, folderName, userFolderPath, parentId || null], (err, result) => {
      if (err) {
        console.error("Erro ao salvar pasta no DB:", err);
        return res.status(500).json({ error: "Erro ao registrar pasta no banco." });
      }
      res.json({ message: "Pasta criada com sucesso!", id: result.insertId });
    });
  } catch (err) {
    console.error("Erro físico ao criar pasta:", err);
    res.status(500).json({ error: "Erro ao criar pasta no servidor." });
  }
});

// --- 2. LISTAR TUDO (Arquivos e Pastas para a Sidebar) ---
app.get('/api/files/list', authenticateToken, (req, res) => {
  const userId = req.user.id;
  // Buscamos pastas primeiro (is_directory DESC) e depois ordem alfabética
  const query = 'SELECT id, name, is_directory, parent_id, created_at FROM files WHERE user_id = ? ORDER BY is_directory DESC, name ASC';
  
  db.query(query, [userId], (err, results) => {
    if (err) return res.status(500).json({ error: "Erro ao listar banco." });
    res.json(results);
  });
});

// --- 3. UPLOAD PRIVADO (Ajustado para aceitar pasta) ---
app.post('/api/files/upload', authenticateToken, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Arquivo vazio." });

  const userId = req.user.id;
  const parentId = req.body.parentId || null; // Se vier um ID de pasta, salvamos dentro dela
  const physicalPath = req.file.path;
  const originalName = req.file.originalname;

  const query = 'INSERT INTO files (user_id, name, file_path, is_directory, parent_id) VALUES (?, ?, ?, 0, ?)';
  db.query(query, [userId, originalName, physicalPath, parentId], (err) => {
    if (err) {
      console.error("Erro ao registrar arquivo:", err);
      return res.status(500).json({ error: "Erro ao registrar no banco." });
    }
    res.json({ message: "Upload concluído!", name: originalName });
  });
});

// 5. START
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend rodando em http://172.18.142.28:${PORT}`);
});