function chunkText(text, options = {}) {
  const chunkSize = Number(options.chunkSize) || 1000;
  const overlap = Number(options.overlap) || 200;

  if (chunkSize <= 0) {
    throw new Error('chunkSize deve ser maior que zero.');
  }
  if (overlap < 0 || overlap >= chunkSize) {
    throw new Error('overlap deve ser maior ou igual a zero e menor que chunkSize.');
  }

  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!source) {
    return [];
  }

  const chunks = [];
  let start = 0;

  while (start < source.length) {
    const end = Math.min(start + chunkSize, source.length);
    const slice = source.slice(start, end).trim();

    if (slice) {
      chunks.push(slice);
    }

    if (end >= source.length) {
      break;
    }

    start = end - overlap;
  }

  return chunks;
}

module.exports = {
  chunkText
};
