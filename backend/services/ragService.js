const fs = require('fs-extra');
const pdf = require('pdf-parse');
const { randomUUID } = require('crypto');

const { chunkText } = require('./chunkingService');
const { generateEmbedding, generateEmbeddings } = require('./embeddingService');
const {
  ensureCollectionExists,
  deleteByUserAndFile,
  upsertChunks,
  searchRelevantChunks
} = require('./qdrantService');

// Monta o prompt final unindo pergunta do usuario com o contexto recuperado do indice vetorial.
function buildPrompt({ question, context }) {
  return `Use o contexto a seguir para responder a pergunta.\nContexto: ${context}\nPergunta: ${question}`;
}

// Pipeline de ingestao do PDF:
// Step 1) Leitura + extracao de texto
// Step 2) Chunking
// Step 3) Vetorizacao dos chunks
// Step 4) Upsert no Qdrant com metadados por usuario/arquivo
async function ingestPdfFile({ userId, fileId, filePath, fileName }) {
  console.log(`[RAG][INGEST] Iniciando indexacao do arquivo fileId=${fileId} nome=${fileName}`);
  const dataBuffer = await fs.readFile(filePath);
  console.log(`[RAG][INGEST] Arquivo lido do disco (${dataBuffer.length} bytes)`);

  const pdfData = await pdf(dataBuffer);
  const extractedText = String(pdfData.text || '').trim();
  console.log(`[RAG][INGEST] Texto extraido via pdf-parse (${extractedText.length} caracteres)`);

  if (!extractedText) {
    throw new Error('Nao foi possivel extrair texto do PDF para indexacao.');
  }

  const chunks = chunkText(extractedText, {
    chunkSize: 1000,
    overlap: 200
  });
  console.log(`[RAG][INGEST] Chunking concluido (${chunks.length} chunks)`);

  if (!chunks.length) {
    throw new Error('Nenhum chunk foi gerado a partir do PDF.');
  }

  const vectors = await generateEmbeddings(chunks);
  console.log(`[RAG][INGEST] Embeddings gerados com sucesso (${vectors.length} vetores)`);

  await ensureCollectionExists();
  await deleteByUserAndFile(userId, fileId);

  const points = chunks.map((chunk, index) => ({
    id: randomUUID(),
    vector: vectors[index],
    payload: {
      userId: Number(userId),
      fileId: Number(fileId),
      fileName: String(fileName || `arquivo-${fileId}`),
      chunkIndex: index,
      text: chunk,
      indexedAt: new Date().toISOString()
    }
  }));

  await upsertChunks(points);
  console.log(`[RAG][INGEST] Upsert finalizado no Qdrant (${points.length} pontos)`);

  return {
    chunkCount: chunks.length,
    fileId: Number(fileId),
    fileName: String(fileName || `arquivo-${fileId}`)
  };
}

// Pipeline de recuperacao de contexto (RAG Retrieve):
// Step 1) Gera embedding da pergunta
// Step 2) Garante colecao/indexes
// Step 3) Busca semantica filtrada por usuario e arquivos
// Step 4) Consolida contexto textual para o prompt
async function retrieveContext({ question, userId, fileIds, topK = 3 }) {
  console.log('[RAG][RETRIEVE] Iniciando recuperação de contexto...');

  console.log('[RAG][RETRIEVE] Step 1: Gerando embedding da pergunta...');
  const questionEmbedding = await generateEmbedding(question);
  console.log('[RAG][RETRIEVE] Step 1 OK: Embedding gerado (dimensão:', questionEmbedding.length, ')');

  console.log('[RAG][RETRIEVE] Step 2: Garantindo coleção Qdrant...');
  await ensureCollectionExists();
  console.log('[RAG][RETRIEVE] Step 2 OK: Coleção verificada');

  console.log('[RAG][RETRIEVE] Step 3: Buscando chunks similares no Qdrant...');
  const hits = await searchRelevantChunks({
    vector: questionEmbedding,
    userId,
    fileIds,
    limit: topK
  });
  console.log('[RAG][RETRIEVE] Step 3 OK: Busca concluída, recuperados:', hits.length, 'chunks');

  const contextChunks = hits
    .map((item) => item?.payload?.text)
    .filter(Boolean);

  console.log('[RAG][RETRIEVE] Step 4: Concatenando chunks... Retornando contexto com', contextChunks.length, 'trechos');
  return {
    hits,
    context: contextChunks.join('\n\n')
  };
}

// Step de geracao final (RAG Generate): envia prompt enriquecido para Groq e retorna resposta final.
async function generateGroqAnswer({ question, context, groqApiKey, groqModel, abortSignal }) {
  if (!groqApiKey) {
    throw new Error('GROQ_API_KEY nao configurada.');
  }

  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey}`,
      'Content-Type': 'application/json'
    },
    signal: abortSignal,
    body: JSON.stringify({
      model: groqModel,
      temperature: 0.2,
      stream: false,
      messages: [
        {
          role: 'system',
          content: 'Voce responde com base no contexto recuperado de documentos PDF. Se o contexto nao for suficiente, diga isso com clareza. Responda em Portugues do Brasil.'
        },
        {
          role: 'user',
          content: buildPrompt({ question, context })
        }
      ]
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Erro Groq (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim() || 'IA sem resposta.';
}

module.exports = {
  ingestPdfFile,
  retrieveContext,
  generateGroqAnswer
};
