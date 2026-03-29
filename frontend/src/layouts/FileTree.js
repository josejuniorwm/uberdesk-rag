import React, { useState, useEffect, useRef } from 'react';

const API_URL = process.env.REACT_APP_API_URL || '/api';

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

const FileTree = ({ onUpdateSize, selectedPdfIds = [], setSelectedPdfIds }) => {
    const [files, setFiles] = useState([]);
    const [loading, setLoading] = useState(true);
    const [editingId, setEditingId] = useState(null);
    const [editingName, setEditingName] = useState('');
    const [newFolderName, setNewFolderName] = useState('');
    const [showNewFolder, setShowNewFolder] = useState(false);
    const [movingId, setMovingId] = useState(null);
    const [expandedFolders, setExpandedFolders] = useState([]);
    const [hoveredId, setHoveredId] = useState(null);
    const editRef = useRef(null);
    const uploadRefs = useRef({});

    useEffect(() => { loadFiles(); }, []);

    useEffect(() => {
        if (editingId && editRef.current) editRef.current.focus();
    }, [editingId]);

    const token = () => localStorage.getItem('token');

    const loadFiles = async () => {
        try {
            // Busca toda a arvore de arquivos do usuario autenticado.
            const response = await fetch(`${API_URL}/files/all`, {
                headers: { 'Authorization': `Bearer ${token()}` }
            });
            const data = await response.json();
            if (Array.isArray(data)) setFiles(data);
            setLoading(false);
            if (onUpdateSize) onUpdateSize();
        } catch (error) {
            console.error("Erro ao carregar arquivos:", error);
            setLoading(false);
        }
    };

    const handleRenameStart = (file) => {
        setEditingId(file.id);
        setEditingName(file.name);
    };

    const handleRenameConfirm = async (id) => {
        if (!editingName.trim()) return;
        try {
            // Renomeia arquivo/pasta no backend.
            await fetch(`${API_URL}/files/rename/${id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token()}` },
                body: JSON.stringify({ newName: editingName.trim() })
            });
            setEditingId(null);
            loadFiles();
        } catch (err) {
            console.error("Erro ao renomear:", err);
        }
    };

    const handleDelete = async (id) => {
        if (!window.confirm("Confirma exclusão?")) return;
        try {
            // Remove arquivo/pasta selecionado.
            await fetch(`${API_URL}/files/${id}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token()}` }
            });
            loadFiles();
        } catch (err) {
            console.error("Erro ao deletar:", err);
        }
    };

    const handleCreateFolder = async () => {
        if (!newFolderName.trim()) return;
        try {
            // Cria nova pasta na raiz (ou pasta atual, se houver parentId no backend).
            await fetch(`${API_URL}/files/mkdir`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token()}` },
                body: JSON.stringify({ folderName: newFolderName.trim() })
            });
            setNewFolderName('');
            setShowNewFolder(false);
            loadFiles();
        } catch (err) {
            console.error("Erro ao criar pasta:", err);
        }
    };

    const handleMoveStart = (id) => {
        setMovingId(movingId === id ? null : id);
    };

    const handleToggleFolder = (id) => {
        setExpandedFolders(prev =>
            prev.includes(id)
                ? prev.filter(folderId => folderId !== id)
                : [...prev, id]
        );
    };

    const handleMoveTo = async (targetId) => {
        try {
            // Move item para outra pasta atualizando parent_id.
            await fetch(`${API_URL}/files/move/${movingId}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token()}` },
                body: JSON.stringify({ newParentId: targetId })
            });
            setMovingId(null);
            loadFiles();
        } catch (err) {
            console.error("Erro ao mover:", err);
        }
    };

    const handleUpload = async (e, parentId) => {
        const file = e.target.files[0];
        if (!file) return;
        const formData = new FormData();
        formData.append('file', file);
        if (parentId) formData.append('parentId', parentId);
        try {
            // Envia PDF para armazenamento e indexacao RAG no backend.
            await fetch(`${API_URL}/files/upload`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token()}` },
                body: formData
            });
            loadFiles();
        } catch (err) {
            console.error("Erro ao enviar arquivo:", err);
        }
        e.target.value = null;
    };

    const isPdfFile = (file) => file.is_directory === 0 && String(file.name || '').toLowerCase().endsWith('.pdf');

    const togglePdfSelection = (fileId) => {
        if (!setSelectedPdfIds) return;
        setSelectedPdfIds(prev => (
            prev.includes(fileId)
                ? prev.filter(id => id !== fileId)
                : [...prev, fileId]
        ));
    };

    const folders = files.filter(f => f.is_directory === 1 && !f.parent_id);
    const rootFiles = files.filter(f => f.is_directory === 0 && !f.parent_id);
    const hasChildren = (folderId) => files.some(f => f.parent_id === folderId);
    const childFiles = (folderId) => files.filter(f => f.parent_id === folderId);

    const btnStyle = {
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '0 3px', fontSize: '13px', lineHeight: 1
    };

    const treeRowStyle = {
        cursor: 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '2px 6px',
        borderRadius: '4px',
        minWidth: 0
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
        minWidth: 0
    };

    const treeActionsStyle = {
        display: 'flex',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: '4px'
    };

    const shouldShowActions = (id) => hoveredId === id || editingId === id || movingId === id;

    if (loading) return <div className="nav-link"><small>Carregando arquivos...</small></div>;

    return (
        <ul className="nav" style={{ display: 'block', paddingLeft: '0' }}>

            <li className="nav-item">
                {showNewFolder ? (
                    <div style={{ display: 'flex', alignItems: 'center', padding: '2px 4px' }}>
                        <input
                            autoFocus
                            value={newFolderName}
                            onChange={e => setNewFolderName(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setShowNewFolder(false); }}
                            style={{ flex: 1, fontSize: '12px', border: '1px solid #ccc', borderRadius: '3px', padding: '1px 4px' }}
                            placeholder="Nome da pasta"
                        />
                        <button style={{ ...btnStyle, color: '#198754' }} onClick={handleCreateFolder} title="Confirmar"><i className="ri-check-line" /></button>
                        <button style={{ ...btnStyle, color: '#dc3545' }} onClick={() => setShowNewFolder(false)} title="Cancelar"><i className="ri-close-line" /></button>
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

            {folders.map(file => (
                <li key={file.id} className="nav-item">
                    {movingId && movingId !== file.id && (
                        <div
                            style={{ background: '#fff3cd', borderRadius: '3px', padding: '1px 6px', fontSize: '11px', cursor: 'pointer', marginBottom: '2px' }}
                            onClick={() => handleMoveTo(file.id)}
                        >
                            <i className="ri-corner-down-right-line" /> Mover para "{file.name}"
                        </div>
                    )}
                    <div
                        style={treeRowStyle}
                        onMouseEnter={() => setHoveredId(file.id)}
                        onMouseLeave={() => setHoveredId(prev => (prev === file.id ? null : prev))}
                    >
                        <div style={treeLeftStyle}>
                            <i
                                className="ri-arrow-right-s-line"
                                onClick={() => hasChildren(file.id) && handleToggleFolder(file.id)}
                                style={{
                                    fontSize: '13px',
                                    flexShrink: 0,
                                    opacity: hasChildren(file.id) ? 1 : 0,
                                    cursor: hasChildren(file.id) ? 'pointer' : 'default',
                                    transform: expandedFolders.includes(file.id) ? 'rotate(90deg)' : 'none',
                                    transition: 'transform 0.15s ease',
                                    marginRight: '1px'
                                }}
                            />
                            <i className="ri-folder-fill text-warning" style={{ fontSize: '14px', flexShrink: 0 }} />
                            {editingId === file.id ? (
                                <input
                                    ref={editRef}
                                    value={editingName}
                                    onChange={e => setEditingName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleRenameConfirm(file.id); if (e.key === 'Escape') setEditingId(null); }}
                                    onBlur={() => handleRenameConfirm(file.id)}
                                    style={{ flex: 1, fontSize: '12px', border: '1px solid #ccc', borderRadius: '3px', padding: '1px 4px' }}
                                />
                            ) : (
                                <span style={treeNameStyle}>{file.name}</span>
                            )}
                        </div>
                        <input
                            type="file"
                            accept=".pdf"
                            style={{ display: 'none' }}
                            ref={el => uploadRefs.current[file.id] = el}
                            onChange={e => handleUpload(e, file.id)}
                        />
                        {shouldShowActions(file.id) && (
                            <div style={treeActionsStyle}>
                                <button style={{ ...btnStyle, color: '#198754' }} onClick={() => uploadRefs.current[file.id].click()} title="Enviar arquivo para esta pasta"><i className="ri-add-line" /></button>
                                <button style={{ ...btnStyle, color: '#0d6efd' }} onClick={() => handleRenameStart(file)} title="Renomear"><i className="ri-pencil-line" /></button>
                                <button style={{ ...btnStyle, color: '#dc3545' }} onClick={() => handleDelete(file.id)} title="Excluir"><i className="ri-delete-bin-line" /></button>
                            </div>
                        )}
                    </div>
                    {hasChildren(file.id) && expandedFolders.includes(file.id) && (
                        <ul className="nav" style={{ display: 'block', paddingLeft: '18px' }}>
                            {childFiles(file.id).map(child => (
                                <li key={child.id} className="nav-item">
                                    <div
                                        style={treeRowStyle}
                                        onMouseEnter={() => setHoveredId(child.id)}
                                        onMouseLeave={() => setHoveredId(prev => (prev === child.id ? null : prev))}
                                    >
                                        <div style={treeLeftStyle}>
                                            {isPdfFile(child) && (
                                                <Checkbox
                                                    checked={selectedPdfIds.includes(child.id)}
                                                    onChange={() => togglePdfSelection(child.id)}
                                                />
                                            )}
                                            <i className="ri-file-pdf-fill text-danger" style={{ fontSize: '14px', flexShrink: 0 }} />
                                            {editingId === child.id ? (
                                                <input
                                                    ref={editRef}
                                                    value={editingName}
                                                    onChange={e => setEditingName(e.target.value)}
                                                    onKeyDown={e => { if (e.key === 'Enter') handleRenameConfirm(child.id); if (e.key === 'Escape') setEditingId(null); }}
                                                    onBlur={() => handleRenameConfirm(child.id)}
                                                    style={{ flex: 1, fontSize: '12px', border: '1px solid #ccc', borderRadius: '3px', padding: '1px 4px' }}
                                                />
                                            ) : (
                                                <span style={treeNameStyle}>{child.name}</span>
                                            )}
                                        </div>
                                        {shouldShowActions(child.id) && (
                                            <div style={treeActionsStyle}>
                                                <button style={{ ...btnStyle, color: '#0d6efd' }} onClick={() => handleRenameStart(child)} title="Renomear"><i className="ri-pencil-line" /></button>
                                                <button style={{ ...btnStyle, color: movingId === child.id ? '#fd7e14' : '#6c757d' }} onClick={() => handleMoveStart(child.id)} title="Mover"><i className="ri-drag-move-line" /></button>
                                                <button style={{ ...btnStyle, color: '#dc3545' }} onClick={() => handleDelete(child.id)} title="Excluir"><i className="ri-delete-bin-line" /></button>
                                            </div>
                                        )}
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </li>
            ))}

            {rootFiles.map(file => (
                <li key={file.id} className="nav-item">
                    <div
                        style={treeRowStyle}
                        onMouseEnter={() => setHoveredId(file.id)}
                        onMouseLeave={() => setHoveredId(prev => (prev === file.id ? null : prev))}
                    >
                        <div style={treeLeftStyle}>
                            {isPdfFile(file) && (
                                <Checkbox
                                    checked={selectedPdfIds.includes(file.id)}
                                    onChange={() => togglePdfSelection(file.id)}
                                />
                            )}
                            <i className="ri-file-pdf-fill text-danger" style={{ fontSize: '14px', flexShrink: 0 }} />
                            {editingId === file.id ? (
                                <input
                                    ref={editRef}
                                    value={editingName}
                                    onChange={e => setEditingName(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') handleRenameConfirm(file.id); if (e.key === 'Escape') setEditingId(null); }}
                                    onBlur={() => handleRenameConfirm(file.id)}
                                    style={{ flex: 1, fontSize: '12px', border: '1px solid #ccc', borderRadius: '3px', padding: '1px 4px' }}
                                />
                            ) : (
                                <span style={treeNameStyle}>{file.name}</span>
                            )}
                        </div>
                        {shouldShowActions(file.id) && (
                            <div style={treeActionsStyle}>
                                <button style={{ ...btnStyle, color: '#0d6efd' }} onClick={() => handleRenameStart(file)} title="Renomear"><i className="ri-pencil-line" /></button>
                                {folders.length > 0 && (
                                    <button style={{ ...btnStyle, color: movingId === file.id ? '#fd7e14' : '#6c757d' }} onClick={() => handleMoveStart(file.id)} title="Mover"><i className="ri-drag-move-line" /></button>
                                )}
                                <button style={{ ...btnStyle, color: '#dc3545' }} onClick={() => handleDelete(file.id)} title="Excluir"><i className="ri-delete-bin-line" /></button>
                            </div>
                        )}
                    </div>
                </li>
            ))}

            {movingId && (
                <li className="nav-item">
                    <div
                        style={{ background: '#f8d7da', borderRadius: '3px', padding: '1px 6px', fontSize: '11px', cursor: 'pointer' }}
                        onClick={() => handleMoveTo(null)}
                    >
                        <i className="ri-corner-left-up-line" /> Mover para raiz
                    </div>
                </li>
            )}

            {files.length === 0 && (
                <li>
                    <div style={{ padding: '2px 6px', fontSize: '12px', color: '#6c757d' }}><small>Nenhum arquivo</small></div>
                </li>
            )}
        </ul>
    );
};

export default FileTree;
