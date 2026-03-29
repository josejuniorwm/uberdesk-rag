// Compatibilidade de nomenclatura: este arquivo expõe o cliente/serviços do Qdrant
// e documenta os passos principais do fluxo vetorial usado pelo RAG.
//
// Step 1: inicializar cliente singleton (URL + API key)
// Step 2: garantir colecao e indices de payload
// Step 3: upsert de chunks vetorizados com metadados
// Step 4: busca semantica filtrada por userId e fileIds

module.exports = require('./qdrantService');
