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
  let overlap = Number(options.overlap);

  if (Number.isNaN(overlap)) {
    overlap = Math.ceil(chunkSize * 0.1);
  }

  // Validação de invariantes: garante que os parâmetros são matematicamente válidos
  if (chunkSize <= 0) {
    throw new Error('chunkSize deve ser maior que zero.');
  }
  const minOverlap = Math.max(overlap, Math.ceil(chunkSize * 0.1));
  if (minOverlap < 0 || minOverlap >= chunkSize) {
    throw new Error('overlap deve ser maior ou igual a zero e menor que chunkSize.');
  }

  // Normalização: trata undefined/null como string vazia e padroniza quebras de linha
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) {
    return []; // Texto vazio — nenhum chunk gerado
  }

  const separators = ['\n\n', '\n', '. ', '? ', '! ', ' ', ''];
  const chunks = [];
  let start = 0;

  const findSplitPosition = (from, to) => {
    for (const sep of separators) {
      if (!sep) {
        continue;
      }
      const pos = source.lastIndexOf(sep, to - 1);
      if (pos >= from) {
        return pos + sep.length;
      }
    }
    return to;
  };

  while (start < source.length) {
    const maxEnd = Math.min(start + chunkSize, source.length);
    let splitPos = maxEnd;

    if (maxEnd < source.length) {
      splitPos = findSplitPosition(start, maxEnd);
      if (splitPos <= start) {
        splitPos = maxEnd;
      }
    }

    const chunk = source.slice(start, splitPos).trim();
    if (chunk) {
      chunks.push(chunk);
    }

    if (splitPos >= source.length) {
      break;
    }

    start = Math.max(splitPos - minOverlap, start + 1);
  }

  return chunks;
}

module.exports = {
  chunkText
};
