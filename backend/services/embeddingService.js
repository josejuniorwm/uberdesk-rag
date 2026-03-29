const EMBEDDING_MODEL = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIMENSION = 384;

let extractorPromise = null;

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = (async () => {
      const { pipeline } = await import('@xenova/transformers');
      return pipeline('feature-extraction', EMBEDDING_MODEL);
    })();
  }

  return extractorPromise;
}

function validateVector(vector) {
  if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `Embedding invalido: esperado vetor com ${EMBEDDING_DIMENSION} dimensoes e recebido ${vector?.length || 0}.`
    );
  }
}

async function generateEmbedding(text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) {
    throw new Error('Nao foi possivel gerar embedding de texto vazio.');
  }

  const extractor = await getExtractor();
  const output = await extractor(cleanText, {
    pooling: 'mean',
    normalize: true
  });

  const vector = Array.from(output.data);
  validateVector(vector);
  return vector;
}

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
