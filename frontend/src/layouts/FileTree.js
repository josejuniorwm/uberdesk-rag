/**
 * @file FileTree.js
 * @description Componente de árvore de projetos e documentos para seleção e upload de PDFs.
 *
 * Responsabilidades:
 *  - Carregar e renderizar projetos do backend.
 *  - Permitir seleção de PDFs para o chat RAG.
 *  - Permitir upload de PDF diretamente em projetos.
 *  - Permitir criação de novos projetos.
 *
 * Fluxo:
 *  Main/Sidebar → repassa selectedPdfIds e uploadFolderId
 *      ↓
 *  FileTree → faz fetch em /api/projects/list e atualiza estados compartilhados
 */
import React, { useState, useEffect, useRef } from 'react';
import {
    fetchProjectsList,
    createProject,
    uploadProjectDocument,
    updateProject,
    deleteProject,
    updateDocument,
    deleteDocument
} from '../services/api';

/** Ícones na sidebar escura: contraste sem quebrar o tema. */
const actionIconStyle = {
    color: '#475569',
    fontSize: '13px',
    fontWeight: 700,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    visibility: 'visible',
    opacity: 1
};

/** Extrai lista de projetos de vários formatos de resposta (API nova + legado). */
function extractProjetosArray(data) {
    if (!data || typeof data !== 'object') return [];
    if (Array.isArray(data)) return [];
    const raw =
        data.projetos ??
        data.pastas ??
        data.folders ??
        data.projects;
    return Array.isArray(raw) ? raw : [];
}

function normalizeProjeto(row) {
    if (!row || typeof row !== 'object') return null;
    const id = Number(row.id);
    if (!Number.isFinite(id)) return null;
    const nome = row.nome ?? row.name ?? row.folderName ?? '';
    return { ...row, id, nome };
}

function normalizeDocumento(row) {
    if (!row || typeof row !== 'object') {
        console.warn('[normalizeDocumento] Documento inválido:', row);
        return null;
    }
    const id = Number(row.id);
    if (!Number.isFinite(id)) {
        console.warn('[normalizeDocumento] ID inválido:', row.id);
        return null;
    }
    const projetoId = Number(row.projeto_id ?? row.pasta_id ?? row.projetoId);
    const normalized = { ...row, id, projeto_id: projetoId };
    console.log('[normalizeDocumento] Normalizado com sucesso:', normalized);
    return normalized;
}

const Checkbox = ({ checked, onChange }) => (
    <label
        style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: '14px',
            height: '14px',
            margin: 0,
            cursor: 'pointer'
        }}
    >
        <input
            type="checkbox"
            checked={checked}
            onChange={onChange}
            style={{
                appearance: 'none',
                WebkitAppearance: 'none',
                width: '14px',
                height: '14px',
                border: checked ? '1px solid #f6c23e' : '1px solid #6c757d',
                borderRadius: '3px',
                backgroundColor: checked ? '#f6c23e' : 'transparent',
                boxShadow: checked ? 'inset 0 0 0 2px #111' : 'none',
                cursor: 'pointer'
            }}
        />
    </label>
);

/**
 * Componente FileTree que exibe a árvore de projetos/documentos e gerencia a seleção de PDFs.
 *
 * @param {object} props
 * @param {function} props.onUpdateSize  - Callback para ajustar rolagem após alterar a lista
 * @param {number[]} props.selectedPdfIds - IDs atualmente selecionados para consulta RAG
 * @param {function} props.setSelectedPdfIds - Atualiza os PDFs selecionados no contexto pai
 * @param {number|null} props.uploadFolderId - ID do projeto destino para uploads
 * @param {function} props.setUploadFolderId - Atualiza o projeto de upload no contexto pai
 * @param {number} props.reloadCounter - Contador para recarregar a lista quando mudar
 * @param {function} [props.setFilesReloadCounter] - Incrementa para sincronizar o chat após upload
 * @returns {JSX.Element}
 */
const FileTree = ({
    onUpdateSize,
    selectedPdfIds = [],
    setSelectedPdfIds,
    uploadFolderId,
    setUploadFolderId,
    reloadCounter,
    setFilesReloadCounter
}) => {
    const [folders, setFolders] = useState([]);
    const [documents, setDocuments] = useState([]);
    const [loading, setLoading] = useState(true);
    const [newFolderName, setNewFolderName] = useState('');
    const [showNewFolder, setShowNewFolder] = useState(false);
    const [expandedFolders, setExpandedFolders] = useState([]);
    const [createError, setCreateError] = useState('');
    const [listError, setListError] = useState('');
    const [renamingFolderId, setRenamingFolderId] = useState(null);
    const [renamingFileId, setRenamingFileId] = useState(null);
    const [renameDraft, setRenameDraft] = useState('');
    const [fileRenameDraft, setFileRenameDraft] = useState('');
    const [hoveredRowId, setHoveredRowId] = useState(null);
    const [hoveredActionId, setHoveredActionId] = useState(null);
    const uploadRefs = useRef({});
    /** Projetos recém-criados que ainda não voltaram na listagem (ex.: latência ou cache). */
    const pendingCreatesRef = useRef([]);

    useEffect(() => { loadFiles(); }, [reloadCounter]);

    const token = () => localStorage.getItem('token');

    const getFileById = (fileId) => documents.find((doc) => Number(doc.id) === Number(fileId));

    const handleRenameFile = (file) => {
        setRenamingFileId(file.id);
        setFileRenameDraft(file.nome_arquivo || '');
        setRenamingFolderId(null);
    };

    const handleRenameFileSave = async (fileId) => {
        const trimmed = fileRenameDraft.trim();
        if (!trimmed) {
            setRenamingFileId(null);
            return;
        }

        try {
            const response = await updateDocument(token(), fileId, trimmed);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                alert(data.error || 'Não foi possível renomear o arquivo.');
                return;
            }
            setRenamingFileId(null);
            setFileRenameDraft('');
            await loadFiles();
        } catch (err) {
            console.error('Erro ao renomear arquivo:', err);
            alert('Erro de conexão ao renomear o arquivo.');
        }
    };

    const handleDeleteFile = async (fileId, fileName) => {
        if (!window.confirm(`Excluir o arquivo "${fileName}"? Esta ação não pode ser desfeita.`)) {
            return;
        }

        try {
            const response = await deleteDocument(token(), fileId);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                alert(data.error || 'Não foi possível excluir o arquivo.');
                return;
            }
            if (setSelectedPdfIds) {
                setSelectedPdfIds((prev) => prev.filter((id) => Number(id) !== Number(fileId)));
            }
            if (setFilesReloadCounter) {
                setFilesReloadCounter((c) => c + 1);
            }
            await loadFiles();
        } catch (err) {
            console.error('Erro ao excluir arquivo:', err);
            alert('Erro de conexão ao excluir o arquivo.');
        }
    };

    const childFiles = (projectId) =>
        documents.filter(doc => Number(doc.projeto_id) === Number(projectId));
    const childFilesIndexados = (projectId) =>
        childFiles(projectId).filter(doc => doc.status === 'indexado');
    const hasChildren = (projectId) => childFiles(projectId).length > 0;
    const getFolderDocIds = (projectId) => childFilesIndexados(projectId).map(doc => doc.id);
    const isFolderSelected = (projectId) => {
        const ids = getFolderDocIds(projectId);
        return ids.length > 0 && ids.every(id => selectedPdfIds.includes(id));
    };

    const loadFiles = async () => {
        try {
            const response = await fetchProjectsList(token());
            let data;
            try {
                data = await response.json();
            } catch (parseErr) {
                console.error('Resposta da lista de projetos não é JSON:', parseErr);
                setListError('Resposta inválida do servidor ao listar projetos.');
                setLoading(false);
                if (onUpdateSize) onUpdateSize();
                return;
            }

            if (!response.ok) {
                console.error('Erro ao listar projetos:', data?.error || response.status);
                setListError(data?.error || `Erro ${response.status} ao carregar projetos.`);
                setLoading(false);
                if (onUpdateSize) onUpdateSize();
                return;
            }

            setListError('');

            let nextFolders = [];
            let nextDocs = [];

            if (Array.isArray(data)) {
                nextFolders = data.filter(item => item.is_directory === 1).map(normalizeProjeto).filter(Boolean);
                nextDocs = data.filter(item => item.is_directory === 0).map(normalizeDocumento).filter(Boolean);
            } else if (data && typeof data === 'object') {
                const projetosRaw = extractProjetosArray(data);
                nextFolders = projetosRaw.map(normalizeProjeto).filter(Boolean);
                const docsRaw = Array.isArray(data.documentos) ? data.documentos : [];
                nextDocs = docsRaw.map(normalizeDocumento).filter(Boolean);
            }

            const serverIds = new Set(nextFolders.map((f) => f.id));
            pendingCreatesRef.current = pendingCreatesRef.current.filter((p) => !serverIds.has(p.id));
            for (const p of pendingCreatesRef.current) {
                if (!nextFolders.some((f) => Number(f.id) === Number(p.id))) {
                    nextFolders.push(p);
                }
            }

            setFolders(nextFolders);
            setDocuments(nextDocs);

            console.log('[FileTree] Documentos carregados:', nextDocs);
            console.log('[FileTree] Pastas carregadas:', nextFolders);

            if (setSelectedPdfIds && selectedPdfIds.length > 0) {
                const validSelected = nextDocs
                    .filter(doc => doc.status === 'indexado')
                    .map(doc => doc.id);
                const filtered = selectedPdfIds.filter(id => validSelected.includes(id));
                if (filtered.length !== selectedPdfIds.length) {
                    setSelectedPdfIds(filtered);
                }
            }

            if (!uploadFolderId && setUploadFolderId && nextFolders.length > 0) {
                setUploadFolderId(nextFolders[0].id);
            }

            setLoading(false);
            if (onUpdateSize) onUpdateSize();
        } catch (error) {
            console.error("Erro ao carregar arquivos:", error);
            setListError('Falha de rede ao carregar projetos.');
            setLoading(false);
        }
    };

    const handleCreateFolder = async () => {
        const trimmed = newFolderName.trim();
        if (!trimmed) {
            return;
        }
        try {
            const response = await createProject(token(), trimmed);

            const errorData = await response.json().catch(() => ({}));

            if (!response.ok) {
                setCreateError(errorData.error || `Erro ${response.status}: ${response.statusText}`);
                return;
            }

            const newId = Number(errorData.id);
            if (Number.isFinite(newId)) {
                pendingCreatesRef.current = [...pendingCreatesRef.current, { id: newId, nome: trimmed }];
                if (!uploadFolderId && setUploadFolderId) {
                    setUploadFolderId(newId);
                }
            }

            setNewFolderName('');
            setShowNewFolder(false);
            setCreateError('');
            await loadFiles();
        } catch (err) {
            console.error("Erro ao criar projeto:", err);
            setCreateError('Erro de conexão. Verifique sua internet.');
        }
    };

    const handleUpload = async (e, projetoId) => {
        const file = e.target.files[0];
        if (!file) return;
        if (!projetoId) {
            e.target.value = null;
            return;
        }
        try {
            const response = await uploadProjectDocument(token(), file, projetoId);
            let data = {};
            try {
                data = JSON.parse(await response.text());
            } catch {
                data = {};
            }

            await loadFiles();
            setExpandedFolders((prev) => (prev.includes(projetoId) ? prev : [...prev, projetoId]));
            if (setFilesReloadCounter) {
                setFilesReloadCounter((c) => c + 1);
            }

            if (!response.ok) {
                alert(data.error || `Falha no upload (${response.status}). Verifique se o arquivo é PDF e tente novamente.`);
            }
        } catch (err) {
            console.error("Erro ao enviar arquivo:", err);
            alert('Erro de rede ao enviar o arquivo.');
        }
        e.target.value = null;
    };

    const handleRenameSave = async (folderId) => {
        const trimmed = renameDraft.trim();
        if (!trimmed) {
            setRenamingFolderId(null);
            return;
        }
        try {
            const response = await updateProject(token(), folderId, trimmed);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                alert(data.error || 'Não foi possível renomear.');
                return;
            }
            setRenamingFolderId(null);
            await loadFiles();
        } catch (err) {
            console.error(err);
            alert('Erro de rede ao renomear.');
        }
    };

    const handleDeleteFolder = async (folderId, folderName) => {
        if (!window.confirm(`Excluir a pasta "${folderName}" e todos os PDFs dentro dela? Esta ação não pode ser desfeita.`)) {
            return;
        }
        const removedDocIds = getFolderDocIds(folderId);
        try {
            const response = await deleteProject(token(), folderId);
            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                alert(data.error || 'Não foi possível excluir a pasta.');
                return;
            }
            if (setSelectedPdfIds && removedDocIds.length) {
                setSelectedPdfIds((prev) => prev.filter((id) => !removedDocIds.includes(id)));
            }
            if (setUploadFolderId && Number(uploadFolderId) === Number(folderId)) {
                setUploadFolderId(null);
            }
            setRenamingFolderId((id) => (id === folderId ? null : id));
            await loadFiles();
            if (setFilesReloadCounter) {
                setFilesReloadCounter((c) => c + 1);
            }
        } catch (err) {
            console.error(err);
            alert('Erro de rede ao excluir.');
        }
    };

    const handleFolderSelection = (folderId) => {
        if (!setSelectedPdfIds) return;
        const folderDocIds = getFolderDocIds(folderId);
        if (!folderDocIds.length) return;

        const isSelected = folderDocIds.every(id => selectedPdfIds.includes(id));
        if (isSelected) {
            setSelectedPdfIds(prev => prev.filter(id => !folderDocIds.includes(id)));
        } else {
            setSelectedPdfIds(prev => Array.from(new Set([...prev, ...folderDocIds])));
        }
    };

    const togglePdfSelection = (fileId) => {
        if (!setSelectedPdfIds) return;
        const file = documents.find((doc) => Number(doc.id) === Number(fileId));
        if (file && file.status !== 'indexado') {
            return;
        }
        setSelectedPdfIds(prev => (
            prev.includes(fileId)
                ? prev.filter(id => id !== fileId)
                : [...prev, fileId]
        ));
    };

    const btnStyle = {
        background: '#f8fafc',
        border: '1px solid #cbd5e1',
        borderRadius: '4px',
        cursor: 'pointer',
        padding: '0 4px',
        fontSize: '11px',
        lineHeight: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(33, 37, 41, 0.85)',
        visibility: 'visible',
        opacity: 1,
        transition: 'background-color 120ms ease, transform 120ms ease',
        minWidth: '22px',
        height: '21px'
    };

    const treeRowStyle = {
        cursor: 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '4px 8px',
        borderRadius: '6px',
        minWidth: 0,
        backgroundColor: 'rgba(255, 255, 255, 0.92)',
        border: '1px solid rgba(0, 0, 0, 0.08)',
        transition: 'background-color 120ms ease, border-color 120ms ease'
    };

    const treeLeftStyle = {
        display: 'flex',
        alignItems: 'center',
        flex: 1,
        minWidth: 0,
        gap: '4px'
    };

    const treeNameStyle = {
        fontSize: '12px',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        lineHeight: 1.25,
        flex: 1,
        minWidth: 0,
        color: 'inherit'
    };

    const treeActionsStyle = {
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        gap: '2px',
        marginLeft: '8px',
        visibility: 'visible',
        opacity: 1
    };

    const hoverRowStyle = {
        backgroundColor: 'rgba(255,255,255,0.08)',
        borderColor: 'rgba(0,0,0,0.08)'
    };

    const getRowStyle = (rowType, rowId, extraStyle = {}) => ({
        ...treeRowStyle,
        ...(hoveredRowId === `${rowType}-${rowId}` ? hoverRowStyle : {}),
        ...extraStyle
    });

    if (loading) return <div className="nav-link"><small>Carregando arquivos...</small></div>;

    return (
        <ul className="nav" style={{ display: 'block', paddingLeft: '0' }}>
            <li className="nav-item">
                {showNewFolder ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', padding: '2px 4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center' }}>
                            <input
                                autoFocus
                                value={newFolderName}
                                onChange={e => { setNewFolderName(e.target.value); setCreateError(''); }}
                                onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
                                style={{ flex: 1, fontSize: '12px', border: '1px solid #ccc', borderRadius: '3px', padding: '1px 4px' }}
                                placeholder="Nome da pasta"
                            />
                            <button type="button" style={{ ...btnStyle, color: '#198754' }} onClick={handleCreateFolder} title="Confirmar"><i className="ri-check-line" /></button>
                            <button type="button" style={{ ...btnStyle, color: '#dc3545' }} onClick={() => { setShowNewFolder(false); setCreateError(''); }} title="Cancelar"><i className="ri-close-line" /></button>
                        </div>
                        {createError && (
                            <div style={{ fontSize: '11px', color: '#dc3545', background: '#f8d7da', padding: '2px 6px', borderRadius: '3px' }}>
                                {createError}
                            </div>
                        )}
                    </div>
                ) : (
                    <div
                        style={{ cursor: 'pointer', color: '#6c757d', fontSize: '12px', padding: '2px 6px', display: 'flex', alignItems: 'center', gap: '4px' }}
                        onClick={() => setShowNewFolder(true)}
                    >
                        <i className="ri-folder-add-line" style={{ marginRight: '3px' }} />
                        <span>Nova pasta</span>
                    </div>
                )}
            </li>

            {folders.map(folder => (
                <li key={folder.id} className="nav-item">
                    <div
                        style={getRowStyle('folder', folder.id)}
                        onMouseEnter={() => setHoveredRowId(`folder-${folder.id}`)}
                        onMouseLeave={() => setHoveredRowId(null)}
                    >
                        <div style={treeLeftStyle}>
                            <Checkbox
                                checked={isFolderSelected(folder.id)}
                                onChange={() => handleFolderSelection(folder.id)}
                            />
                            <i
                                role="button"
                                tabIndex={0}
                                className="ri-arrow-right-s-line"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    if (!hasChildren(folder.id)) return;
                                    setExpandedFolders((prev) =>
                                        prev.includes(folder.id)
                                            ? prev.filter((id) => id !== folder.id)
                                            : [...prev, folder.id]
                                    );
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        if (!hasChildren(folder.id)) return;
                                        setExpandedFolders((prev) =>
                                            prev.includes(folder.id)
                                                ? prev.filter((id) => id !== folder.id)
                                                : [...prev, folder.id]
                                        );
                                    }
                                }}
                                style={{
                                    fontSize: '13px',
                                    flexShrink: 0,
                                    opacity: hasChildren(folder.id) ? 1 : 0.25,
                                    cursor: hasChildren(folder.id) ? 'pointer' : 'default',
                                    transform: expandedFolders.includes(folder.id) ? 'rotate(90deg)' : 'none',
                                    transition: 'transform 0.15s ease',
                                    marginRight: '1px'
                                }}
                            />
                            <i className="ri-folder-fill text-warning" style={{ fontSize: '14px', flexShrink: 0 }} />
                            {renamingFolderId === folder.id ? (
                                <input
                                    autoFocus
                                    value={renameDraft}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleRenameSave(folder.id);
                                        if (e.key === 'Escape') setRenamingFolderId(null);
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    style={{
                                        ...treeNameStyle,
                                        flex: 1,
                                        minWidth: 0,
                                        border: '1px solid rgba(255,255,255,0.25)',
                                        borderRadius: '4px',
                                        padding: '2px 6px',
                                        background: 'rgba(0,0,0,0.25)',
                                        color: 'inherit'
                                    }}
                                />
                            ) : (
                                <span style={treeNameStyle}>{folder.nome}</span>
                            )}
                        </div>
                        <input
                            type="file"
                            accept=".pdf,application/pdf"
                            style={{ display: 'none' }}
                            ref={(el) => { uploadRefs.current[folder.id] = el; }}
                            onChange={(e) => handleUpload(e, folder.id)}
                        />
                        <div style={treeActionsStyle} onClick={(e) => e.stopPropagation()}>
                            {renamingFolderId === folder.id ? (
                                <>
                                    <button type="button" style={btnStyle} onClick={() => handleRenameSave(folder.id)} title="Salvar nome">
                                        <i className="ri-check-line" style={{ ...actionIconStyle, color: '#75b798' }} />
                                    </button>
                                    <button type="button" style={btnStyle} onClick={() => setRenamingFolderId(null)} title="Cancelar">
                                        <i className="ri-close-line" style={{ ...actionIconStyle, color: '#f1aeb5' }} />
                                    </button>
                                </>
                            ) : (
                                <>
                                    <button
                                        type="button"
                                        style={btnStyle}
                                        onClick={() => uploadRefs.current[folder.id]?.click()}
                                        onMouseEnter={() => setHoveredActionId(`upload-${folder.id}`)}
                                        onMouseLeave={() => setHoveredActionId(null)}
                                        title="Enviar PDF"
                                    >
                                        <i
                                            className="ri-upload-line"
                                            style={{
                                                ...actionIconStyle,
                                                color: hoveredActionId === `upload-${folder.id}` ? '#55141b' : '#475569'
                                            }}
                                        />
                                    </button>
                                    <button
                                        type="button"
                                        style={btnStyle}
                                        onClick={() => { setRenamingFolderId(folder.id); setRenameDraft(folder.nome); }}
                                        onMouseEnter={() => setHoveredActionId(`rename-folder-${folder.id}`)}
                                        onMouseLeave={() => setHoveredActionId(null)}
                                        title="Renomear pasta"
                                    >
                                        <i
                                            className="ri-edit-line"
                                            style={{
                                                ...actionIconStyle,
                                                color: hoveredActionId === `rename-folder-${folder.id}` ? '#55141b' : '#475569'
                                            }}
                                        />
                                    </button>
                                    <button
                                        type="button"
                                        style={btnStyle}
                                        onClick={() => handleDeleteFolder(folder.id, folder.nome)}
                                        onMouseEnter={() => setHoveredActionId(`delete-folder-${folder.id}`)}
                                        onMouseLeave={() => setHoveredActionId(null)}
                                        title="Excluir pasta"
                                    >
                                        <i
                                            className="ri-delete-bin-line"
                                            style={{
                                                ...actionIconStyle,
                                                color: hoveredActionId === `delete-folder-${folder.id}` ? '#55141b' : '#be123c'
                                            }}
                                        />
                                    </button>
                                </>
                            )}
                        </div>
                    </div>

                    {hasChildren(folder.id) && expandedFolders.includes(folder.id) && (
                        <ul className="nav" style={{ display: 'block', paddingLeft: '18px' }}>
                            {childFiles(folder.id).map(child => {
                                const isIndexado = child.status === 'indexado';
                                const isRenaming = renamingFileId === child.id;
                                console.log(`[FILE-RENDER] Arquivo: ${child.nome_arquivo || child.nome || child.name || "Documento PDF"}, ID: ${child.id}, Renomendo: ${isRenaming}`);
                                return (
                                    <li key={child.id} className="nav-item">
                                        {/* Início da renderização do item do Arquivo */}
                                        <div style={{ display: 'flex', alignItems: 'center', opacity: isIndexado ? 1 : 0.6 }}>
                                            <Checkbox
                                                checked={selectedPdfIds.includes(child.id)}
                                                onChange={() => togglePdfSelection(child.id)}
                                                disabled={!isIndexado}
                                            />
                                            <div
                                                style={{
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    padding: '5px',
                                                    marginLeft: '8px',
                                                    width: '100%',
                                                    borderRadius: '4px',
                                                    cursor: isIndexado ? 'pointer' : 'not-allowed'
                                                }}
                                                onClick={() => {
                                                    if (!isIndexado) return;
                                                    togglePdfSelection(child.id);
                                                }}
                                            >
                                                {/* Lado Esquerdo: Ícone e Nome */}
                                                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', minWidth: 0, flex: 1 }}>
                                                    {/* Ícone do PDF Vermelho */}
                                                    <svg style={{ width: '16px', height: '16px', color: '#ef4444', flexShrink: 0 }} fill="currentColor" viewBox="0 0 24 24"><path d="M6 2c-1.103 0-2 .897-2 2v16c0 1.103.897 2 2 2h12c1.103 0 2-.897 2-2V8l-6-6H6zm10 14h-4v4l-4-4 4-4v4h4z"/></svg>
                                                    {isRenaming ? (
                                                        <input
                                                            autoFocus
                                                            value={fileRenameDraft}
                                                            onChange={(e) => setFileRenameDraft(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === 'Enter') {
                                                                    e.preventDefault();
                                                                    handleRenameFileSave(child.id);
                                                                }
                                                                if (e.key === 'Escape') {
                                                                    setRenamingFileId(null);
                                                                }
                                                            }}
                                                            onClick={(e) => e.stopPropagation()}
                                                            style={{
                                                                flex: 1,
                                                                minWidth: 0,
                                                                border: '1px solid #cbd5e1',
                                                                borderRadius: '3px',
                                                                padding: '2px 4px',
                                                                background: '#fff',
                                                                color: '#334155',
                                                                fontSize: '12px'
                                                            }}
                                                        />
                                                    ) : (
                                                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#334155' }}>{child.nome_arquivo}</span>
                                                    )}
                                                    {!isIndexado && (
                                                        <small style={{ color: '#d97706', marginLeft: '4px', whiteSpace: 'nowrap' }}>({child.status?.replace('_', ' ') || 'processando'})</small>
                                                    )}
                                                </div>

                                                {/* Lado Direito: Botões de Ação (sempre visíveis) */}
                                                <div style={{ display: 'flex', gap: '8px', marginLeft: 'auto' }} onClick={(e) => e.stopPropagation()}>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleRenameFile(child)}
                                                        onMouseEnter={() => setHoveredActionId(`rename-file-${child.id}`)}
                                                        onMouseLeave={() => setHoveredActionId(null)}
                                                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                                                    >
                                                        <i
                                                            className="ri-edit-line"
                                                            style={{
                                                                color: hoveredActionId === `rename-file-${child.id}` ? '#55141b' : '#475569',
                                                                fontSize: '13px'
                                                            }}
                                                        ></i>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleDeleteFile(child.id, child.nome_arquivo)}
                                                        onMouseEnter={() => setHoveredActionId(`delete-file-${child.id}`)}
                                                        onMouseLeave={() => setHoveredActionId(null)}
                                                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                                                    >
                                                        <i
                                                            className="ri-delete-bin-line"
                                                            style={{
                                                                color: hoveredActionId === `delete-file-${child.id}` ? '#55141b' : '#be123c',
                                                                fontSize: '13px'
                                                            }}
                                                        ></i>
                                                    </button>
                                                </div>
                                            </div>
                                        </div>
                                        {/* Fim da renderização do item do Arquivo */}
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </li>
            ))}

            {listError && (
                <li className="nav-item">
                    <div style={{ padding: '6px', fontSize: '11px', color: '#842029', background: '#f8d7da', borderRadius: '4px', margin: '4px 0' }}>
                        {listError}
                    </div>
                </li>
            )}

            {folders.length === 0 && !listError && (
                <li>
                    <div style={{ padding: '2px 6px', fontSize: '12px', color: '#6c757d' }}><small>Nenhuma pasta ainda</small></div>
                </li>
            )}
        </ul>
    );
};

export default FileTree;
