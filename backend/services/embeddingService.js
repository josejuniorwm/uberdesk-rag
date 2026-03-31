/**
 * @file embeddingService.js
 * @description Serviço de geração de embeddings (vetorizações) de texto para o pipeline RAG.
 *
 * Usa o modelo `all-MiniLM-L6-v2` da família Sentence Transformers via
 * `@xenova/transformers`, executado localmente no processo Node.js (sem GPU necessária).
 *
 * Características do modelo:
 *  - Dimensão do vetor: 384
 *  - Pooling: mean (média dos token embeddings)
 *  - Normalização: L2 (vetores unitários — compatível com similaridade de cosseno)
 *  - Tamanho do modelo: ~22MB (compacto para uso em produção)
 *
 * NOTA DE PERFORMANCE: O primeiro call a getExtractor() faz o download/carregamento
 * do modelo em memória (pode levar alguns segundos). As chamadas subsequentes reutilizam
 * a instância via padrão singleton (extractorPromise).
 *
 * @requires @xenova/transformers Pipeline de NLP rodando localmente (ONNX runtime)
 */

/** @constant {string} Identificador do modelo de embedding no HuggingFace Hub */
const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';

/**
 * @constant {number} Dimensão esperada dos vetores gerados por este modelo.
 * Deve corresponder exatamente ao `size` configurado na coleção Qdrant.
 * Se alterar o modelo, atualizar este valor e recriar a coleção no Qdrant.
 */
const EMBEDDING_DIMENSION = 384;

/**
 * Promessa singleton do pipeline de extração de features.
 * Inicializado na primeira chamada a getExtractor() e reutilizado nas seguintes.
 * Padrão lazy singleton evita carga desnecessária se o módulo for importado mas não usado.
 *
 * @type {Promise<import('@xenova/transformers').FeatureExtractionPipeline> | null}
 */
let extractorPromise = null;

/**
 * Retorna a instância do pipeline de feature-extraction (singleton lazy).
 *
 * O `import()` dinâmico é necessário porque `@xenova/transformers` é um ESModule
 * e não pode ser carregado com require() diretamente em CommonJS.
 *
 * @returns {Promise<import('@xenova/transformers').FeatureExtractionPipeline>}
 */
async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      // 'feature-extraction' extrai representações densas (embeddings) de texto
      return pipeline('feature-extraction', EMBEDDING_MODEL);
    })();
  }

  return extractorPromise;
}

/**
 * Valida que o vetor gerado tem a dimensão correta.
 * Evita inserção silenciosa de vetores com dimensão errada no Qdrant,
 * o que causaria falhas de busca difíceis de diagnosticar.
 *
 * @param {number[]} vector - Vetor a ser validado
 * @throws {Error} Se o vetor não for um array ou tiver dimensão diferente de EMBEDDING_DIMENSION
 */
function validateVector(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding invalido: esperado vetor com ${EMBEDDING_DIMENSION} dimensoes e recebido ${vector?.length || 0}.`
    );
  }
}

/**
 * Gera o embedding (vetor de representação semântica) de um texto.
 *
 * O texto é processado pelo modelo MiniLM-L6-v2 com:
 *  - pooling='mean': reduz os token embeddings a um único vetor via média
 *  - normalize=true: aplica normalização L2 (vetor unitário)
 *    → necessário para que a distância de cosseno funcione corretamente no Qdrant
 *
 * @param {string} text - Texto a ser vetorizado (não pode ser vazio)
 * @returns {Promise<number[]>} Vetor de 384 floats normalizado (L2)
 * @throws {Error} Se o texto for vazio ou se o vetor gerado tiver dimensão incorreta
 */
async function generateEmbedding(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    throw new Error('Nao foi possivel gerar embedding de texto vazio.');
  }

  const extractor = await getExtractor();
  const output = await extractor(cleanText, {
    pooling: 'mean',    // Agrega token embeddings em um único vetor (mean pooling)
    normalize: true     // Normalização L2 — obrigatória para correta comparação por cosseno
  });

  // output.data é um TypedArray (Float32Array); converter para Array nativo para serialização JSON
  const vector = Array.from(output.data);
  validateVector(vector); // Garante dimensão correta antes de retornar
  return vector;
}

/**
 * Gera embeddings para um array de textos de forma sequencial.
 *
 * NOTA: O processamento é sequencial (for...of) para simplificar tratamento de erros.
 * Para PDFs grandes (muitos chunks), isso pode ser lento.
 * TODO: RedOps Fix — Avaliar Promise.all com concorrência limitada (ex: p-limit)
 *   para melhorar throughput sem sobrecarregar a memória com muitos tensores simultâneos.
 *
 * @param {string[]} texts - Array de textos a vetorizar
 * @returns {Promise<number[][]>} Array de vetores, na mesma ordem dos textos de entrada
 */
async function generateEmbeddings(texts) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const vectors = [];
  for (const text of texts) {
    const vector = await generateEmbedding(text);
    vectors.push(vector);
  }

  return vectors;
}

module.exports = {
  EMBEDDING_MODEL,
  EMBEDDING_DIMENSION,
  generateEmbedding,
  generateEmbeddings
};
