/**
 * @file chunkingService.js
 * @description Módulo de fragmentação de texto (Text Chunking) para o pipeline RAG.
 *
 * O chunking é a etapa que transforma um texto longo extraído de um PDF em fragmentos
 * menores (chunks) que serão individualmente vetorizados e indexados no Qdrant.
 *
 * Estratégia: Sliding Window com overlap
 *   ┌─────────────────────────────────────────────────────┐
 *   │ [  chunk 0  ]                                        │
 *   │         [  chunk 1  ]    ← overlap com chunk 0       │
 *   │                 [  chunk 2  ]  ← overlap com chunk 1 │
 *   └─────────────────────────────────────────────────────┘
 *
 * O overlap garante que trechos de texto que caem na fronteira entre dois chunks
 * sejam capturados corretamente durante a busca semântica, evitando perda de contexto
 * que ocorreria com divisão sem sobreposição.
 *
 * Limitação atual: a divisão é por número de caracteres, não por sentenças ou parágrafos.
 * TODO: RedOps Fix — Implementar chunking semântico (por sentença/parágrafo) para
 *   chunks mais coerentes linguisticamente, melhorando a qualidade do contexto RAG.
 */

/**
 * Divide um texto em chunks (fragmentos) com sobreposição configurável.
 *
 * Algoritmo (sliding window):
 *  1. Normaliza quebras de linha (\r\n → \n) e remove espaços nas bordas
 *  2. Avança `start` de (chunkSize - overlap) a cada iteração
 *  3. O último chunk pode ser menor que chunkSize (resto da divisão)
 *
 * @param {string} text            - Texto completo a ser fatiado
 * @param {object} [options={}]    - Configurações do chunking
 * @param {number} [options.chunkSize=1000] - Tamanho máximo de cada chunk em caracteres
 * @param {number} [options.overlap=200]    - Número de caracteres sobrepostos entre chunks consecutivos
 * @returns {string[]} Array de chunks de texto; retorna [] se o texto de entrada for vazio
 * @throws {Error} Se chunkSize <= 0 ou overlap < 0 ou overlap >= chunkSize
 *
 * @example
 * const chunks = chunkText('texto longo...', { chunkSize: 500, overlap: 100 });
 * // chunks[0] = texto[0..500]
 * // chunks[1] = texto[400..900]  ← overlap de 100 chars com chunks[0]
 */
function chunkText(text, options = {}) {
  const chunkSize = Number(options.chunkSize) || 1000;
  const overlap = Number(options.overlap) || 200;

  // Validação de invariantes: garante que os parâmetros são matematicamente válidos
  if (chunkSize <= 0) {
    throw new Error('chunkSize deve ser maior que zero.');
  }
  if (overlap < 0 || overlap >= chunkSize) {
    // overlap >= chunkSize causaria loop infinito (start nunca avançaria)
    throw new Error('overlap deve ser maior ou igual a zero e menor que chunkSize.');
  }

  // Normalização: trata undefined/null como string vazia e padroniza quebras de linha
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) {
    return []; // Texto vazio — nenhum chunk gerado
  }

  const chunks = [];
  let start = 0;

  while (start < source.length) {
    const end = Math.min(start + chunkSize, source.length);
    const slice = source.slice(start, end).trim();

    if (slice) {
      chunks.push(slice); // Ignora slices que resultam em apenas whitespace após trim
    }

    if (end >= source.length) {
      break; // Chegou ao final do texto
    }

    // Avança start subtraindo o overlap para criar sobreposição com o próximo chunk
    start = end - overlap;
  }

  return chunks;
}

module.exports = {
  chunkText
};
