/**
 * Cliente HTTP centralizado para o backend multi-tenant (Workspace Aberto).
 * Base: REACT_APP_API_URL ou '/api' (proxy reverso).
 */

export const API_URL = process.env.REACT_APP_API_URL || '/api';

// Header helper único para manter o envio de Bearer token consistente
// nas rotas protegidas consumidas pelo frontend.
const authHeader = (token) => (token ? { Authorization: `Bearer ${token}` } : {});

/**
 * @param {string} email
 * @param {string} password
 * @returns {Promise<Response>}
 */
export function login(email, password) {
  return fetch(`${API_URL}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

/**
 * Lista projetos e documentos do tenant.
 * GET /api/projects/list → { projetos: [], documentos: [] }
 *
 * @param {string} token JWT
 * @param {{ projetoId?: number }} [query]
 * @returns {Promise<Response>}
 */
export function fetchProjectsList(token, query = {}) {
  const params = new URLSearchParams();
  if (query.projetoId != null && query.projetoId !== '') {
    params.set('projetoId', String(query.projetoId));
  }
  const qs = params.toString();
  const url = qs ? `${API_URL}/projects/list?${qs}` : `${API_URL}/projects/list`;
  return fetch(url, {
    headers: { ...authHeader(token) },
  });
}

/**
 * @param {string} token
 * @param {string} name Nome do projeto
 * @returns {Promise<Response>}
 */
export function createProject(token, name) {
  return fetch(`${API_URL}/projects/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(token),
    },
    body: JSON.stringify({ name }),
  });
}

/**
 * Upload de documento (PDF) em um projeto.
 * FormData: file, projetoId
 *
 * @param {string} token
 * @param {File} file
 * @param {number|string} projetoId
 * @returns {Promise<Response>}
 */
export function uploadProjectDocument(token, file, projetoId) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('projetoId', projetoId);
  return fetch(`${API_URL}/projects/upload`, {
    method: 'POST',
    headers: { ...authHeader(token) },
    body: formData,
  });
}

/**
 * @param {string} token
 * @param {number|string} id
 * @param {string} name
 * @returns {Promise<Response>}
 */
export function updateProject(token, id, name) {
  return fetch(`${API_URL}/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(token),
    },
    body: JSON.stringify({ name }),
  });
}

/**
 * @param {string} token
 * @param {number|string} id
 * @param {string} name
 * @returns {Promise<Response>}
 */
export function updateDocument(token, id, name) {
  return fetch(`${API_URL}/documents/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      ...authHeader(token),
    },
    body: JSON.stringify({ nome_arquivo: name }),
  });
}

/**
 * @param {string} token
 * @param {number|string} id
 * @returns {Promise<Response>}
 */
export function deleteDocument(token, id) {
  return fetch(`${API_URL}/documents/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...authHeader(token) },
  });
}

/**
 * @param {string} token
 * @param {number|string} id
 * @returns {Promise<Response>}
 */
export function deleteProject(token, id) {
  return fetch(`${API_URL}/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...authHeader(token) },
  });
}
