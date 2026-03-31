/**
 * @file qdrantClient.js
 * @description Ponto de entrada alternativo para o serviço Qdrant (alias de qdrantService.js).
 *
 * Este arquivo existe por compatibilidade de nomenclatura — permite que imports antigos
 * que referenciem 'qdrantClient' continuem funcionando sem alteração.
 *
 * Fluxo vetorial RAG (resumo dos passos delegados ao qdrantService):
 *  Step 1: getQdrantClient()       — Inicializa o singleton do cliente (URL + API key do ENV)
 *  Step 2: ensureCollectionExists() — Cria a coleção 'documentos_pdf' e seus índices de payload
 *  Step 3: upsertChunks()          — Insere vetores + metadados após ingestão do PDF
 *  Step 4: searchRelevantChunks()  — Busca semântica filtrada por userId e fileIds
 *
 * TODO: RedOps Fix — Se este arquivo não tiver outros consumers além de imports legados,
 *   consolidar em um único ponto de entrada (qdrantService.js) e remover este alias.
 */
module.exports = require('./qdrantService');
