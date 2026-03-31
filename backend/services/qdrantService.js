/**
 * @file qdrantService.js
 * @description Camada de acesso ao banco de dados vetorial Qdrant.
 *
 * Responsabilidades:
 *  - Gerenciar o cliente Qdrant como singleton (evita múltiplas conexões)
 *  - Garantir que a coleção e os índices de payload existam antes de operar
 *  - Realizar upsert de chunks vetorizados com metadados
 *  - Executar busca semântica filtrada por usuário e arquivo
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
 * @constant {string} Nome da coleção Qdrant onde os chunks de PDFs são armazenados.
 * Deve corresponder ao valor de QDRANT_COLLECTION no docker-compose.yml.
 * TODO: RedOps Fix — Externalizar para process.env.QDRANT_COLLECTION para suportar
 *   múltiplos ambientes (dev/staging/prod) sem alteração de código.
 */
const COLLECTION_NAME = 'documentos_pdf';

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
 * Cria índices de payload no Qdrant para os campos `userId` e `fileId`.
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
async function ensurePayloadIndexes(client) {
  const fields = ['userId', 'fileId'];

  for (const fieldName of fields) {
    await client.createPayloadIndex(COLLECTION_NAME, {
      wait: true,          // Aguarda a criação ser confirmada antes de retornar
      field_name: fieldName,
      field_schema: 'integer' // userId e fileId são sempre inteiros
    });
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
 * Remove todos os vetores de um arquivo específico de um usuário no Qdrant.
 *
 * Chamado antes de re-indexar um PDF para garantir que vetores antigos (de uploads
 * anteriores do mesmo arquivo) não permaneçam no índice, causando duplicidade
 * nos resultados de busca.
 *
 * O filtro duplo (userId + fileId) garante isolamento entre usuários — um usuário
 * não pode deletar vetores de outro mesmo que envie o mesmo fileId.
 *
 * @param {number|string} userId  - ID do usuário dono dos vetores
 * @param {number|string} fileId  - ID do arquivo cujos vetores serão removidos
 * @returns {Promise<void>}
 */
async function deleteByUserAndFile(userId, fileId) {
  const client = getQdrantClient();

  await client.delete(COLLECTION_NAME, {
    wait: true, // Aguarda confirmação de deleção antes de prosseguir com o upsert
    filter: {
      must: [
        { key: 'userId', match: { value: Number(userId) } },
        { key: 'fileId', match: { value: Number(fileId) } }
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
async function upsertChunks(points) {
  const client = getQdrantClient();

  if (!Array.isArray(points) || points.length === 0) {
    return; // Não faz chamada de rede desnecessária para array vazio
  }

  await client.upsert(COLLECTION_NAME, {
    wait: true, // Garante que os vetores estão disponíveis para busca antes de retornar
    points
  });
}

/**
 * Busca semântica no Qdrant: encontra os chunks mais similares à pergunta do usuário.
 *
 * Filtragem de segurança:
 *  - userId: garante isolamento entre usuários (usuário A não vê docs do usuário B)
 *  - fileIds: filtra apenas os arquivos selecionados pelo usuário no frontend
 *
 * A similaridade é calculada por distância de Cosseno (configurada na coleção).
 * Retorna os `limit` pontos com maior score de similaridade.
 *
 * @param {object}   params
 * @param {number[]} params.vector   - Vetor da pergunta (gerado pelo embeddingService)
 * @param {number}   params.userId   - ID do usuário (filtro obrigatório de isolamento)
 * @param {number[]} [params.fileIds=[]] - IDs dos arquivos a incluir na busca (filtro opcional)
 * @param {number}   [params.limit=3]   - Número máximo de chunks a retornar
 * @returns {Promise<Array<{id: string, score: number, payload: object}>>}
 *   Array de hits ordenados por score decrescente
 */
async function searchRelevantChunks({ vector, userId, fileIds = [], limit = 3 }) {
  const client = getQdrantClient();

  // Filtro base: userId é sempre obrigatório para isolar dados por usuário
  const must = [
    {
      key: 'userId',
      match: {
        value: Number(userId) // Garante tipo inteiro — evita mismatch de tipo no filtro
      }
    }
  ];

  // Normaliza e valida os fileIds para evitar injeção de valores inválidos no filtro
  const normalizedFileIds = Array.isArray(fileIds)
    ? fileIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0)
    : [];

  if (normalizedFileIds.length > 0) {
    must.push({
      key: 'fileId',
      match: {
        any: normalizedFileIds // Filtra chunks de qualquer um dos arquivos selecionados
      }
    });
  }

  const results = await client.search(COLLECTION_NAME, {
    vector,
    limit,
    with_payload: true, // Retorna o payload completo (incluindo o texto do chunk)
    filter: {
      must // Todos os filtros em `must` devem ser satisfeitos (AND lógico)
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
