/**
 * @file qdrantService.js
 * @description Camada de acesso ao banco de dados vetorial Qdrant.
 *
 * Responsabilidades:
 *  - Gerenciar o cliente Qdrant como singleton (evita múltiplas conexões)
 *  - Garantir que a coleção e os índices de payload existam antes de operar
 *  - Realizar upsert de chunks vetorizados com metadados
 *  - Executar busca semântica filtrada por tenant de empresa e arquivos selecionados
 *
 * Arquitetura no pipeline RAG:
 *   embeddingService → [vetores] → qdrantService → Qdrant Cloud/Self-hosted
 *
 * @requires @qdrant/js-client-rest  SDK oficial do Qdrant para Node.js
 * @requires ./embeddingService      Fornece EMBEDDING_DIMENSION (384) para criar a coleção
 */
const { QdrantClient } = require('@qdrant/js-client-rest');
const { EMBEDDING_DIMENSION } = require('./embeddingService');

/**
 * Nome da coleção Qdrant (deve bater com QDRANT_COLLECTION no .env / painel Cloud).
 */
const COLLECTION_NAME = process.env.QDRANT_COLLECTION || 'documentos_pdf';

/**
 * Instância singleton do cliente Qdrant.
 * null até a primeira chamada a getQdrantClient().
 * @type {QdrantClient | null}
 */
let qdrantClient = null;

/**
 * Retorna a instância singleton do cliente Qdrant, inicializando-a se necessário.
 *
 * Lê QDRANT_URL e QDRANT_API_KEY do ambiente — nunca do código.
 * Lança erro imediato se as variáveis não estiverem configuradas (fail-fast).
 *
 * @security Credenciais lidas exclusivamente de process.env — padrão correto.
 *           Nunca passar URL ou API key como literais neste arquivo.
 *
 * @returns {QdrantClient} Instância compartilhada do cliente Qdrant
 * @throws {Error} Se QDRANT_URL ou QDRANT_API_KEY não estiverem definidas no ambiente
 */
function getQdrantClient() {
  if (qdrantClient) {
    return qdrantClient; // Reutiliza a instância existente (singleton)
  }

  const url = process.env.QDRANT_URL || '';
  const apiKey = process.env.QDRANT_API_KEY || '';

  if (!url || !apiKey) {
    // Fail-fast: melhor lançar aqui do que falhar silenciosamente na busca
    throw new Error('QDRANT_URL e QDRANT_API_KEY precisam estar configuradas no ambiente.');
  }

  qdrantClient = new QdrantClient({
    url,
    apiKey
  });

  return qdrantClient;
}

/**
 * Cria índices de payload no Qdrant para os campos `empresa_id`, `projeto_id` e `file_id`.
 *
 * Índices de payload são necessários para que filtros de busca (must: [...])
 * sejam executados eficientemente — sem eles, o Qdrant faz full scan dos vetores.
 * Tipo 'integer' otimiza comparações exatas (match.value / match.any).
 *
 * Esta função é idempotente: recriar um índice que já existe não causa erro.
 *
 * @param {QdrantClient} client - Instância do cliente Qdrant
 * @returns {Promise<void>}
 */
function isPayloadIndexAlreadyExistsError(err) {
  const s = String(err?.message || err?.data?.status?.error || err || '').toLowerCase();
  return (
    /already exists|duplicate|already been created|field already|index already/i.test(s) ||
    err?.status === 409
  );
}

async function ensurePayloadIndexes(client) {
  const fields = ['empresa_id', 'projeto_id', 'file_id', 'fileId'];

  for (const fieldName of fields) {
    try {
      await client.createPayloadIndex(COLLECTION_NAME, {
        wait: true,
        field_name: fieldName,
        field_schema: 'integer'
      });
    } catch (err) {
      if (isPayloadIndexAlreadyExistsError(err)) {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Garante que a coleção vetorial exista no Qdrant com a configuração correta.
 *
 * - Cria a coleção se não existir, com vetores de dimensão 384 e distância Cosine
 * - Recria os índices de payload após criação (ou re-aplica em colecões existentes)
 * - É idempotente: seguro chamar múltiplas vezes
 *
 * Distância Cosine é a escolha correta pois os vetores são normalizados (L2=1)
 * pelo embeddingService — equivalente a produto interno mas mais semântico.
 *
 * @returns {Promise<void>}
 */
async function ensureCollectionExists() {
  const client = getQdrantClient();
  const collections = await client.getCollections();

  const exists = collections.collections.some(
    (collection) => collection.name === COLLECTION_NAME
  );

  if (!exists) {
    await client.createCollection(COLLECTION_NAME, {
      vectors: {
        size: EMBEDDING_DIMENSION, // 384 — deve corresponder ao modelo em embeddingService.js
        distance: 'Cosine'         // Similaridade de cosseno para vetores normalizados
      }
    });
    console.log(`Colecao ${COLLECTION_NAME} criada no Qdrant.`);
  }

  // Garante índices mesmo em coleções já existentes (idempotente)
  await ensurePayloadIndexes(client);
}

/**
 * Remove todos os vetores de um arquivo específico no Qdrant.
 *
 * Chamado antes de re-indexar um PDF para garantir que vetores antigos do mesmo
 * documento não permaneçam no índice, causando duplicidade nos resultados de busca.
 *
 * O filtro base é `file_id` porque o ID do documento é globalmente único no sistema.
 *
 * @param {number|string} fileId  - ID do arquivo cujos vetores serão removidos
 * @returns {Promise<void>}
 */
async function deleteByFile(fileId) {
  try {
    const client = getQdrantClient();
    await client.delete(COLLECTION_NAME, {
      wait: true,
      filter: {
        must: [
          {
            should: [
              { key: 'file_id', match: { value: Number(fileId) } },
              { key: 'fileId', match: { value: Number(fileId) } }
            ]
          }
        ]
      }
    });
  } catch (err) {
    console.warn(`[Qdrant] deleteByFile(${fileId}):`, err?.message || err);
  }
}

/**
 * Remove todos os vetores de um projeto no Qdrant (tenant-safe).
 *
 * @param {number|string} projetoId
 * @param {number|string} empresaId
 * @returns {Promise<void>}
 */
async function deleteByProjetoAndEmpresa(projetoId, empresaId) {
  const client = getQdrantClient();

  await client.delete(COLLECTION_NAME, {
    wait: true,
    filter: {
      must: [
        { key: 'projeto_id', match: { value: Number(projetoId) } },
        { key: 'empresa_id', match: { value: Number(empresaId) } }
      ]
    }
  });
}

/**
 * Insere ou atualiza (upsert) um lote de pontos vetoriais no Qdrant.
 *
 * Cada ponto contém:
 *  - id:      UUID único do ponto
 *  - vector:  Vetor float32[] de 384 dimensões (gerado pelo embeddingService)
 *  - payload: Metadados { userId, fileId, fileName, chunkIndex, text, indexedAt }
 *
 * O `wait: true` garante durabilidade — a operação só retorna após confirmação
 * de que os pontos foram persistidos no Qdrant.
 *
 * @param {Array<{id: string, vector: number[], payload: object}>} points - Pontos a inserir
 * @returns {Promise<void>}
 */
/** Lotes menores evitam timeout / limite de corpo em Qdrant Cloud com PDFs grandes. */
const UPSERT_BATCH_SIZE = Number(process.env.QDRANT_UPSERT_BATCH || 48);

async function upsertChunks(points) {
  const client = getQdrantClient();

  if (!Array.isArray(points) || points.length === 0) {
    return;
  }

  const batchSize = Number.isFinite(UPSERT_BATCH_SIZE) && UPSERT_BATCH_SIZE > 0 ? UPSERT_BATCH_SIZE : 48;
  for (let i = 0; i < points.length; i += batchSize) {
    const slice = points.slice(i, i + batchSize);
    await client.upsert(COLLECTION_NAME, {
      wait: true,
      points: slice
    });
  }
}

/**
 * Busca semântica no Qdrant: encontra os chunks mais similares à pergunta do usuário.
 *
 * Filtragem de segurança:
 *  - empresaId: garante isolamento por tenant no índice vetorial
 *  - fileIds: restringe a busca apenas aos arquivos selecionados no frontend quando fornecido
 *
 * A similaridade é calculada por distância de Cosseno (configurada na coleção).
 * Retorna os `limit` pontos com maior score de similaridade.
 *
 * @param {object}   params
 * @param {number[]} params.vector   - Vetor da pergunta (gerado pelo embeddingService)
 * @param {number}   params.empresaId - ID da empresa (filtro obrigatório de isolamento)
 * @param {number[]} [params.fileIds=[]] - IDs dos arquivos a incluir na busca (filtro opcional)
 * @param {number}   [params.limit=3]   - Número máximo de chunks a retornar
 * @returns {Promise<Array<{id: string, score: number, payload: object}>>}
 *   Array de hits ordenados por score decrescente
 */
async function searchRelevantChunks({ vector, empresaId, fileIds = [], limit = 3 }) {
  const client = getQdrantClient();

  // Normaliza e valida os fileIds para evitar injeção de valores inválidos no filtro
  const normalizedFileIds = Array.isArray(fileIds)
    ? fileIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
    : [];

  const empresaFilter = empresaId != null && empresaId !== ''
    ? {
      key: 'empresa_id',
      match: { value: Number(empresaId) }
    }
    : null;

  const fileFilters = normalizedFileIds.length > 0 ? [
    {
      key: 'file_id',
      match: { any: normalizedFileIds }
    },
    {
      key: 'fileId',
      match: { any: normalizedFileIds }
    }
  ] : [];

  const executeSearch = async (filter) => {
    const results = await client.search(COLLECTION_NAME, {
      vector,
      limit,
      with_payload: true,
      filter
    });

    if (Array.isArray(results)) {
      return results;
    }

    return Array.isArray(results?.result) ? results.result : [];
  };

  const searchAttempts = [];

  if (normalizedFileIds.length > 0) {
    if (empresaFilter) {
      for (const fileFilter of fileFilters) {
        searchAttempts.push({ must: [empresaFilter, fileFilter] });
      }
    }

    for (const fileFilter of fileFilters) {
      searchAttempts.push({ must: [fileFilter] });
    }
  } else if (empresaFilter) {
    searchAttempts.push({ must: [empresaFilter] });
  } else {
    throw new Error('Nenhum filtro valido fornecido para a busca no Qdrant.');
  }

  for (const filter of searchAttempts) {
    const hits = await executeSearch(filter);
    if (hits.length > 0) {
      return hits;
    }
  }

  return [];
}

module.exports = {
  COLLECTION_NAME,
  ensureCollectionExists,
  deleteByFile,
  deleteByProjetoAndEmpresa,
  upsertChunks,
  searchRelevantChunks
};
