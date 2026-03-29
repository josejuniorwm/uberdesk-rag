const { QdrantClient } = require('@qdrant/js-client-rest');
const { EMBEDDING_DIMENSION } = require('./embeddingService');

const COLLECTION_NAME = 'documentos_pdf';

let qdrantClient = null;

// Inicializa singleton do cliente Qdrant para reutilizar conexoes durante todo o processo.
function getQdrantClient() {
  if (qdrantClient) {
    return qdrantClient;
  }

  const url = process.env.QDRANT_URL || '';
  const apiKey = process.env.QDRANT_API_KEY || '';

  if (!url || !apiKey) {
    throw new Error('QDRANT_URL e QDRANT_API_KEY precisam estar configuradas no ambiente.');
  }

  qdrantClient = new QdrantClient({
    url,
    apiKey
  });

  return qdrantClient;
}

// Cria indices de payload para acelerar filtros por usuario e arquivo durante a busca vetorial.
async function ensurePayloadIndexes(client) {
  const fields = ['userId', 'fileId'];

  for (const fieldName of fields) {
    await client.createPayloadIndex(COLLECTION_NAME, {
      wait: true,
      field_name: fieldName,
      field_schema: 'integer'
    });
  }
}

// Garante que a colecao vetorial exista com dimensao correta e distancia por cosseno.
async function ensureCollectionExists() {
  const client = getQdrantClient();
  const collections = await client.getCollections();

  const exists = collections.collections.some(
    (collection) => collection.name === COLLECTION_NAME
  );

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: EMBEDDING_DIMENSION,
        distance: 'Cosine'
      }
    });
    console.log(`Colecao ${COLLECTION_NAME} criada no Qdrant.`);
  }

  await ensurePayloadIndexes(client);
}

// Remove vetores antigos de um arquivo para evitar duplicidade em reindexacao.
async function deleteByUserAndFile(userId, fileId) {
  const client = getQdrantClient();

  await client.delete(COLLECTION_NAME, {
    wait: true,
    filter: {
      must: [
        { key: 'userId', match: { value: Number(userId) } },
        { key: 'fileId', match: { value: Number(fileId) } }
      ]
    }
  });
}

// Upsert em lote dos pontos (vetor + payload) gerados na indexacao do PDF.
async function upsertChunks(points) {
  const client = getQdrantClient();

  if (!Array.isArray(points) || points.length === 0) {
    return;
  }

  await client.upsert(COLLECTION_NAME, {
    wait: true,
    points
  });
}

// Busca semantica com filtro por userId e, opcionalmente, por lista de fileIds.
async function searchRelevantChunks({ vector, userId, fileIds = [], limit = 3 }) {
  const client = getQdrantClient();

  const must = [
    {
      key: 'userId',
      match: {
        value: Number(userId)
      }
    }
  ];

  const normalizedFileIds = Array.isArray(fileIds)
    ? fileIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
    : [];

  if (normalizedFileIds.length > 0) {
    must.push({
      key: 'fileId',
      match: {
        any: normalizedFileIds
      }
    });
  }

  const results = await client.search(COLLECTION_NAME, {
    vector,
    limit,
    with_payload: true,
    filter: {
      must
    }
  });

  return results;
}

module.exports = {
  COLLECTION_NAME,
  ensureCollectionExists,
  deleteByUserAndFile,
  upsertChunks,
  searchRelevantChunks
};
