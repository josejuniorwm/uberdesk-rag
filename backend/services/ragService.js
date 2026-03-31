/**
 * @file ragService.js
 * @description Orquestrador do pipeline RAG (Retrieval-Augmented Generation).
 *
 * Este módulo centraliza as três fases do RAG:
 *
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  FASE 1 — INGEST (ingestPdfFile)                                        │
 *  │    PDF binário → extração de texto → chunking → embedding → Qdrant      │
 *  │                                                                          │
 *  │  FASE 2 — RETRIEVE (retrieveContext)                                     │
 *  │    Pergunta do usuário → embedding → busca semântica no Qdrant           │
 *  │    → chunks mais relevantes concatenados como contexto                   │
 *  │                                                                          │
 *  │  FASE 3 — GENERATE (generateGroqAnswer)                                  │
 *  │    Pergunta + contexto → prompt enriquecido → Groq LLM → resposta final  │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 * @requires fs-extra         Leitura binária do arquivo PDF do disco
 * @requires pdf-parse        Extração de texto de PDFs (sem OCR — apenas PDFs com texto)
 * @requires crypto           Geração de UUIDs para identificar pontos no Qdrant
 * @requires ./chunkingService Divisão de texto em chunks com overlap configurável
 * @requires ./embeddingService Vetorização de texto via modelo local (MiniLM-L6-v2)
 * @requires ./qdrantService  Operações no banco vetorial Qdrant
 */
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

/**
 * Constrói o prompt final para o LLM combinando contexto recuperado + pergunta do usuário.
 *
 * O formato instrucional orienta o modelo a responder apenas com base no contexto fornecido,
 * reduzindo alucinações e ancorando a resposta nos documentos indexados.
 *
 * @param {object} params
 * @param {string} params.question - Pergunta original do usuário
 * @param {string} params.context  - Texto dos chunks recuperados do Qdrant, concatenados
 * @returns {string} Prompt formatado pronto para envio ao LLM
 */
function buildPrompt({ question, context }) {
  return `Use o contexto a seguir para responder a pergunta.\nContexto: ${context}\nPergunta: ${question}`;
}

/**
 * @function ingestPdfFile
 * @description Pipeline completo de ingestão de PDF para o índice vetorial Qdrant.
 *
 * Etapas detalhadas:
 *
 *  [STEP 1 — EXTRAÇÃO DE TEXTO]
 *    Lê o arquivo PDF do disco como Buffer e usa pdf-parse para extrair o texto puro.
 *    LIMITAÇÃO: pdf-parse não suporta OCR — PDFs escaneados (imagens) retornam texto vazio.
 *    TODO: RedOps Fix — Integrar Tesseract.js ou similar para PDFs escaneados.
 *
 *  [STEP 2 — CHUNKING]
 *    Divide o texto extraído em janelas deslizantes (sliding window) com overlap.
 *    Parâmetros: chunkSize=1000 chars, overlap=200 chars.
 *    O overlap garante que informações na borda entre chunks não sejam perdidas na busca.
 *
 *  [STEP 3 — VETORIZAÇÃO]
 *    Cada chunk é convertido em um vetor de 384 dimensões pelo modelo MiniLM-L6-v2
 *    (executado localmente via @xenova/transformers — sem chamada de API externa).
 *    NOTA: A vetorização é sequencial (for...of) e pode ser lenta para PDFs grandes.
 *    TODO: RedOps Fix — Considerar batching paralelo com Promise.all para melhorar throughput.
 *
 *  [STEP 4 — UPSERT NO QDRANT]
 *    Deleta vetores antigos do mesmo arquivo (evita duplicidade em re-upload) e
 *    insere os novos pontos com payload de metadados (userId, fileId, chunkIndex, text).
 *
 * @param {object} params
 * @param {number|string} params.userId   - ID do usuário dono do arquivo
 * @param {number|string} params.fileId   - ID do registro na tabela `files` do MySQL
 * @param {string}        params.filePath - Caminho absoluto do PDF no disco
 * @param {string}        params.fileName - Nome original do arquivo (para payload)
 * @returns {Promise<{chunkCount: number, fileId: number, fileName: string}>}
 * @throws {Error} Se o texto extraído for vazio ou nenhum chunk for gerado
 */
async function ingestPdfFile({ userId, fileId, filePath, fileName }) {
  console.log(`[RAG][INGEST] Iniciando indexacao do arquivo fileId=${fileId} nome=${fileName}`);

  // STEP 1 — Leitura do arquivo PDF como Buffer binário
  const dataBuffer = await fs.readFile(filePath);
  console.log(`[RAG][INGEST] Arquivo lido do disco (${dataBuffer.length} bytes)`);

  // Extração de texto puro do PDF via pdf-parse
  // Funciona apenas para PDFs com texto embedado; PDFs escaneados retornam texto vazio
  const pdfData = await pdf(dataBuffer);
  const extractedText = String(pdfData.text || '').trim();
  console.log(`[RAG][INGEST] Texto extraido via pdf-parse (${extractedText.length} caracteres)`);

  if (!extractedText) {
    throw new Error('Nao foi possivel extrair texto do PDF para indexacao.');
  }

  // STEP 2 — Chunking: divide o texto em janelas deslizantes com overlap
  // chunkSize=1000: cada chunk tem até 1000 caracteres
  // overlap=200: os últimos 200 chars do chunk anterior são repetidos no próximo
  const chunks = chunkText(extractedText, {
    chunkSize: 1000,
    overlap: 200
  });
  console.log(`[RAG][INGEST] Chunking concluido (${chunks.length} chunks)`);

  if (!chunks.length) {
    throw new Error('Nenhum chunk foi gerado a partir do PDF.');
  }

  // STEP 3 — Vetorização: converte cada chunk em vetor de 384 dimensões (MiniLM-L6-v2)
  // Executado localmente — não depende de API externa para este passo
  const vectors = await generateEmbeddings(chunks);
  console.log(`[RAG][INGEST] Embeddings gerados com sucesso (${vectors.length} vetores)`);

  // STEP 4 — Upsert no Qdrant
  // Garante que a coleção existe com a dimensão correta antes de inserir
  await ensureCollectionExists();
  // Remove vetores antigos do mesmo arquivo para evitar duplicidade em re-indexação
  await deleteByUserAndFile(userId, fileId);

  // Monta os pontos Qdrant: cada ponto = vetor + payload de metadados
  const points = chunks.map((chunk, index) => ({
    id: randomUUID(), // UUID único por ponto — não reutilizado entre re-indexações
    vector: vectors[index],
    payload: {
      userId: Number(userId),       // Para filtro de busca por usuário
      fileId: Number(fileId),       // Para filtro de busca por arquivo
      fileName: String(fileName || `arquivo-${fileId}`),
      chunkIndex: index,            // Posição do chunk no documento original
      text: chunk,                  // Texto original do chunk (retornado na busca)
      indexedAt: new Date().toISOString() // Auditoria de quando foi indexado
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

/**
 * @function retrieveContext
 * @description Pipeline de recuperação semântica (RAG Retrieve).
 *
 * Converte a pergunta em vetor e busca os chunks mais similares no Qdrant,
 * filtrados por userId e opcionalmente por fileIds específicos.
 *
 * Etapas:
 *  [STEP 1] Gera embedding da pergunta (mesmo modelo usado na indexação: MiniLM-L6-v2)
 *  [STEP 2] Garante que a coleção Qdrant existe (idempotente)
 *  [STEP 3] Busca semântica por similaridade de cosseno, filtrada por userId + fileIds
 *  [STEP 4] Extrai e concatena os textos dos chunks retornados como contexto
 *
 * @param {object}          params
 * @param {string}          params.question - Pergunta do usuário
 * @param {number}          params.userId   - ID do usuário (filtro de isolamento)
 * @param {number[]}        params.fileIds  - IDs dos arquivos a considerar na busca
 * @param {number}          [params.topK=3] - Número máximo de chunks a recuperar
 * @returns {Promise<{hits: object[], context: string}>}
 *   hits    — Objetos crus retornados pelo Qdrant (incluem score e payload)
 *   context — Texto concatenado dos chunks para uso no prompt
 */
async function retrieveContext({ question, userId, fileIds, topK = 3 }) {
  console.log('[RAG][RETRIEVE] Iniciando recuperação de contexto...');

  // STEP 1 — Embedding da pergunta usando o mesmo modelo da indexação (consistência de espaço vetorial)
  console.log('[RAG][RETRIEVE] Step 1: Gerando embedding da pergunta...');
  const questionEmbedding = await generateEmbedding(question);
  console.log('[RAG][RETRIEVE] Step 1 OK: Embedding gerado (dimensão:', questionEmbedding.length, ')');

  // STEP 2 — Verificação da coleção (sem overhead se já existir)
  console.log('[RAG][RETRIEVE] Step 2: Garantindo coleção Qdrant...');
  await ensureCollectionExists();
  console.log('[RAG][RETRIEVE] Step 2 OK: Coleção verificada');

  // STEP 3 — Busca semântica: distância de cosseno, filtros de userId e fileIds
  console.log('[RAG][RETRIEVE] Step 3: Buscando chunks similares no Qdrant...');
  const hits = await searchRelevantChunks({
    vector: questionEmbedding,
    userId,
    fileIds,
    limit: topK
  });
  console.log('[RAG][RETRIEVE] Step 3 OK: Busca concluída, recuperados:', hits.length, 'chunks');

  // STEP 4 — Extração e concatenação dos textos dos chunks para formar o contexto
  const contextChunks = hits
    .map((item) => item?.payload?.text)
    .filter(Boolean); // Remove chunks com texto undefined/null

  console.log('[RAG][RETRIEVE] Step 4: Concatenando chunks... Retornando contexto com', contextChunks.length, 'trechos');
  return {
    hits,
    context: contextChunks.join('\n\n') // Dupla quebra de linha separa chunks visualmente no prompt
  };
}

/**
 * @function generateGroqAnswer
 * @description Pipeline de geração de resposta (RAG Generate) via API da Groq.
 *
 * Envia um prompt no formato OpenAI Chat Completions para o endpoint da Groq,
 * com o contexto RAG recuperado do Qdrant injetado na mensagem do usuário.
 *
 * O system prompt instrui o modelo a responder apenas com base no contexto fornecido
 * e em Português do Brasil, reduzindo alucinações e assegurando idioma correto.
 *
 * @security A API key é passada por parâmetro (vem de process.env.GROQ_API_KEY em server.js).
 *           Nunca hardcodar a key aqui — receber sempre via parâmetro ou ENV.
 *
 * @param {object}      params
 * @param {string}      params.question    - Pergunta original do usuário
 * @param {string}      params.context     - Contexto RAG (chunks concatenados)
 * @param {string}      params.groqApiKey  - API Key da Groq (process.env.GROQ_API_KEY)
 * @param {string}      params.groqModel   - Modelo a usar (ex: 'llama3-8b-8192')
 * @param {AbortSignal} [params.abortSignal] - Sinal para cancelamento gracioso
 * @returns {Promise<string>} Texto da resposta gerada pelo LLM
 * @throws {Error} Se groqApiKey não estiver configurada ou se a API retornar erro HTTP
 */
async function generateGroqAnswer({ question, context, groqApiKey, groqModel, abortSignal }) {
  if (!groqApiKey) {
    throw new Error('GROQ_API_KEY nao configurada.');
  }

  // Chamada ao endpoint compatível com OpenAI Chat Completions da Groq
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${groqApiKey}`, // API key injetada via parâmetro — não hardcoded
      'Content-Type': 'application/json'
    },
    signal: abortSignal, // Propagação do cancelamento do cliente para evitar consumo desnecessário de tokens
    body: JSON.stringify({
      model: groqModel,
      temperature: 0.2, // Baixa temperatura = respostas mais determinísticas e factuais
      stream: false,    // TODO: RedOps Fix — Implementar streaming (SSE) para resposta progressiva no frontend
      messages: [
        {
          role: 'system',
          // Instrução de sistema: ancora o modelo ao contexto RAG e define o idioma
          content: 'Voce responde com base no contexto recuperado de documentos PDF. Se o contexto nao for suficiente, diga isso com clareza. Responda em Portugues do Brasil.'
        },
        {
          role: 'user',
          // buildPrompt combina contexto recuperado + pergunta original
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
  // Navega pelo caminho padrão da resposta OpenAI Chat Completions
  return data?.choices?.[0]?.message?.content?.trim() || 'IA sem resposta.';
}

module.exports = {
  ingestPdfFile,
  retrieveContext,
  generateGroqAnswer
};
