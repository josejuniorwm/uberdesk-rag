/**
 * @file Sidebar.js
 * @description Componente de navegação lateral que inclui o menu principal e a seção RAG.
 *
 * Responsabilidades:
 *  - Exibir navegação principal do painel.
 *  - Exibir o componente FileTree com seleção de PDFs para uso no chat.
 *  - Exibir histórico de chats com criação e exclusão de sessões.
 *  - Garantir que apenas dados do tenant sejam visíveis no frontend.
 */
import React, { Component } from "react";
import { Link, NavLink } from "react-router-dom";
import PerfectScrollbar from "react-perfect-scrollbar";
import userAvatar from "../assets/img/img1.jpg";
import FileTree from "./FileTree";
import { API_URL } from "../services/api";
import {
    dashboardMenu,
    applicationsMenu,
    pagesMenu,
    uiElementsMenu
} from "../data/Menu";

export default class Sidebar extends Component {
    toggleFooterMenu = (e) => {
        e.preventDefault();

        let parent = e.target.closest(".sidebar");
        parent.classList.toggle("footer-menu-show");
    }

    handleLogout = (e) => {
        e.preventDefault();
        localStorage.removeItem("token");
        localStorage.removeItem("user");
        window.location.assign("/signin");
    }

    getLoggedUser = () => {
        try {
            const storedUser = localStorage.getItem("user");
            return storedUser ? JSON.parse(storedUser) : null;
        } catch (_) {
            return null;
        }
    }

    render() {
        const userData = this.getLoggedUser();
        const userName = userData?.nome || userData?.name || userData?.username || userData?.email || "Usuário";

        return (
            <div className="sidebar">
                <div className="sidebar-header">
                    <Link to="/" className="sidebar-logo">Uberdesk RAG</Link>
                </div>
                <PerfectScrollbar className="sidebar-body" ref={ref => this._scrollBarRef = ref}>
                    <SidebarMenu
                        onUpdateSize={() => this._scrollBarRef?.updateScroll?.()}
                        selectedPdfIds={this.props.selectedPdfIds}
                        setSelectedPdfIds={this.props.setSelectedPdfIds}
                        uploadFolderId={this.props.uploadFolderId}
                        setUploadFolderId={this.props.setUploadFolderId}
                        filesReloadCounter={this.props.filesReloadCounter}
                        setFilesReloadCounter={this.props.setFilesReloadCounter}
                           currentSessionId={this.props.currentSessionId}
                           setCurrentSessionId={this.props.setCurrentSessionId}
                                setMessages={this.props.setMessages}
                    />
                </PerfectScrollbar>
                <div className="sidebar-footer">
                    <div className="sidebar-footer-top">
                        <div className="sidebar-footer-thumb">
                            <img src={userAvatar} alt="" />
                        </div>
                        <div className="sidebar-footer-body">
                            <h6><Link to="/pages/profile">{userName}</Link></h6>
                        </div>
                        <Link onClick={this.toggleFooterMenu} to="" className="dropdown-link"><i className="ri-arrow-down-s-line"></i></Link>
                    </div>
                    <div className="sidebar-footer-menu">
                        <nav className="nav">
                            <Link to="/pages/profile"><i className="ri-profile-line"></i> View Profile</Link>
                            <Link onClick={this.handleLogout} to="" className="text-danger"><i className="ri-logout-box-r-line"></i> Log Out</Link>
                        </nav>
                    </div>
                </div>
            </div>
        )
    }
}

class SidebarMenu extends Component {
    chatLoadRequestSeq = 0;

    state = {
        chatSessions: [],
        chatsLoading: false
    };

    componentDidMount() {
        this.loadChatSessions();
    }

    requestUpdateSize = () => {
        if (typeof this.props.onUpdateSize === 'function') {
            this.props.onUpdateSize();
        }
    }

    getToken = () => localStorage.getItem("token");

    loadChatMessages = async (chatId) => {
        const token = this.getToken();
        if (!token || !chatId) return;
        const requestSeq = ++this.chatLoadRequestSeq;

        if (typeof this.props.setMessages === 'function') {
            this.props.setMessages([]);
        }

        try {
            const response = await fetch(`${API_URL}/chats/${chatId}/mensagens`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json().catch(() => ([]));

            if (!response.ok) {
                console.error('[Sidebar/Chats] Falha ao carregar mensagens da sessão:', data?.error || response.status);
                alert(data?.error || 'Não foi possível carregar as mensagens deste chat.');
                return;
            }

            const formattedMessages = (Array.isArray(data) ? data : []).map((msg) => ({
                sender: msg.sender === 'assistant' ? 'bot' : (msg.sender || 'bot'),
                text: msg.text || msg.conteudo || '',
                time: msg.time || (msg.created_at
                    ? new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                    : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }))
            }));

            if (requestSeq !== this.chatLoadRequestSeq) {
                return;
            }

            if (typeof this.props.setMessages === 'function') {
                this.props.setMessages(formattedMessages);
            }
        } catch (err) {
            console.error('[Sidebar/Chats] Erro de rede ao carregar mensagens da sessão:', err);
            alert('Erro de conexão ao carregar mensagens do chat.');
        }
    }

    loadChatSessions = async () => {
        const token = this.getToken();
        if (!token) return;

        this.setState({ chatsLoading: true });
        try {
            const response = await fetch(`${API_URL}/chats`, {
                headers: { Authorization: `Bearer ${token}` }
            });
            const data = await response.json().catch(() => ([]));

            if (!response.ok) {
                console.error('[Sidebar/Chats] Falha ao listar chats:', data?.error || response.status);
                this.setState({ chatsLoading: false });
                return;
            }

            this.setState({
                chatSessions: Array.isArray(data) ? data.slice(0, 5) : [],
                chatsLoading: false
            }, this.requestUpdateSize);
        } catch (err) {
            console.error('[Sidebar/Chats] Erro de rede ao listar chats:', err);
            this.setState({ chatsLoading: false });
        }
    }

    handleCreateChat = async (e) => {
        e.preventDefault();
        const token = this.getToken();
        if (!token) {
            alert('Token de autenticação não encontrado. Por favor, faça login novamente.');
            return;
        }

        this.chatLoadRequestSeq += 1;
        if (typeof this.props.setMessages === 'function') {
            this.props.setMessages([]);
        }
        if (this.props.setCurrentSessionId) {
            this.props.setCurrentSessionId(null);
        }

        try {
            const response = await fetch(`${API_URL}/chats`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`
                },
                body: JSON.stringify({ titulo: `Chat ${new Date().toLocaleString()}` })
            });

            const data = await response.json().catch((parseErr) => {
                console.error('[Sidebar/Chats] Erro ao parsear resposta JSON:', parseErr);
                return {};
            });

            if (!response.ok) {
                console.error('[Sidebar/Chats] Erro na resposta:', { status: response.status, data });
                alert(`Erro ao criar chat: ${data.error || 'Resposta inválida da API'}`);
                return;
            }

            const newChatId = Number(data?.id);
            if (!Number.isInteger(newChatId) || newChatId <= 0) {
                console.error('[Sidebar/Chats] ID inválido retornado ao criar chat:', data);
                alert('A API retornou um ID de chat inválido. Tente novamente.');
                return;
            }

            await this.loadChatSessions();

            // Chat novo deve abrir vazio.
            if (typeof this.props.setMessages === 'function') {
                this.props.setMessages([]);
            }
            if (this.props.setCurrentSessionId) {
                this.props.setCurrentSessionId(newChatId);
            }
        } catch (err) {
            console.error('[Sidebar/Chats] Erro ao criar chat:', err);
            alert(`Erro de conexão: ${err.message || 'Erro desconhecido ao criar novo chat'}`);
        }
    }
    handleDeleteChat = async (chatId, chatTitle) => {
        const token = this.getToken();
        if (!token) return;
        if (!window.confirm(`Excluir o chat "${chatTitle}"?`)) return;

        try {
            const response = await fetch(`${API_URL}/chats/${chatId}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                alert(data.error || 'Não foi possível excluir o chat.');
                return;
            }
            this.setState((prev) => ({
                chatSessions: prev.chatSessions.filter((chat) => Number(chat.id) !== Number(chatId))
            }), () => {
                this.requestUpdateSize();
                // Se o chat excluído era o ativo, limpa a seleção
                if (this.props.currentSessionId && Number(this.props.currentSessionId) === Number(chatId)) {
                    if (this.props.setCurrentSessionId) this.props.setCurrentSessionId(null);
                }
            });
        } catch (err) {
            console.error('[Sidebar/Chats] Erro ao excluir chat:', err);
            alert('Erro de conexão ao excluir chat.');
        }
    }

    populateMenu = (m) => {
        const menu = m.map((m, key) => {
            let sm;
            if (m.submenu) {
                sm = m.submenu.map((sm, key) => {
                    return (
                        <NavLink to={sm.link} className="nav-sub-link" key={key}>{sm.label}</NavLink>
                    )
                })
            }

            return (
                <li key={key} className={`nav-item`}>
                    {(!sm) ? (
                        <NavLink to={m.link} className="nav-link">
                            <i className={m.icon}></i> <span>{m.label}</span>
                        </NavLink>
                    ) : (
                        <div onClick={this.toggleSubMenu} className="nav-link has-sub">
                            <i className={m.icon}></i> <span>{m.label}</span>
                        </div>
                    )}

                    {m.submenu && (
                        <nav className="nav nav-sub">{sm}</nav>
                    )}
                </li>
            )
        });

        return (
            <ul className="nav nav-sidebar">
                {menu}
            </ul>
        );
    }

    // Toggle menu group
    toggleMenu = (e) => {
        e.preventDefault();

        let parent = e.target.closest('.nav-group');
        parent.classList.toggle('show');

        this.requestUpdateSize();
    }

    // Toggle submenu while closing siblings' submenu
    toggleSubMenu = (e) => {
        e.preventDefault();

        let parent = e.target.closest('.nav-item');
        let node = parent.parentNode.firstChild;

        while (node) {
            if (node !== parent && node.nodeType === Node.ELEMENT_NODE)
                node.classList.remove('show');
            node = node.nextElementSibling || node.nextSibling;
        }

        parent.classList.toggle('show');

        this.requestUpdateSize();
    }

    render() {
        const { chatSessions, chatsLoading } = this.state;

        return (
            <React.Fragment>
                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>Dashboard</div>
                    {this.populateMenu(dashboardMenu)}
                </div>
                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>Meus Documentos (RAG)</div>
                    <ul className="nav nav-sidebar">
                        <li className="nav-item">
                            <FileTree
                                onUpdateSize={this.props.onUpdateSize}
                                selectedPdfIds={this.props.selectedPdfIds}
                                setSelectedPdfIds={this.props.setSelectedPdfIds}
                                uploadFolderId={this.props.uploadFolderId}
                                setUploadFolderId={this.props.setUploadFolderId}
                                reloadCounter={this.props.filesReloadCounter}
                                setFilesReloadCounter={this.props.setFilesReloadCounter}
                            />
                        </li>
                    </ul>
                </div>

                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>Histórico de Chats</div>
                    <div style={{ padding: '4px 12px 6px 12px' }}>
                        <button
                            type="button"
                            onClick={this.handleCreateChat}
                            style={{
                                border: '1px solid #d0d7de',
                                borderRadius: '6px',
                                background: '#fff',
                                color: '#334155',
                                fontSize: '11px',
                                padding: '2px 8px',
                                cursor: 'pointer'
                            }}
                        >
                            + Novo Chat
                        </button>
                    </div>
                    <ul className="nav nav-sidebar" style={{ display: 'block', padding: '0 10px 6px 10px' }}>
                        {chatsLoading && (
                            <li className="nav-item" style={{ padding: '4px 8px', color: '#6b7280', fontSize: '12px' }}>
                                Carregando chats...
                            </li>
                        )}

                        {!chatsLoading && chatSessions.length === 0 && (
                            <li className="nav-item" style={{ padding: '4px 8px', color: '#6b7280', fontSize: '12px' }}>
                                Nenhum chat salvo.
                            </li>
                        )}

                        {!chatsLoading && chatSessions.map((chat) => (
                            <li key={chat.id} className="nav-item" style={{ marginBottom: '2px' }}>
                                    <div
                                        onClick={async () => {
                                            if (typeof this.props.setMessages === 'function') {
                                                this.props.setMessages([]);
                                            }
                                            if (this.props.setCurrentSessionId) {
                                                this.props.setCurrentSessionId(chat.id);
                                            }
                                            await this.loadChatMessages(chat.id);
                                        }}
                                        style={{
                                            display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderRadius: '6px',
                                            cursor: 'pointer',
                                            backgroundColor: this.props.currentSessionId && Number(this.props.currentSessionId) === Number(chat.id) ? '#f1f5f9' : 'transparent'
                                        }}
                                    >
                                        <i className="ri-message-3-line" style={{ fontSize: '14px', color: this.props.currentSessionId && Number(this.props.currentSessionId) === Number(chat.id) ? '#be123c' : '#6b7280', marginRight: 0, width: 'auto' }}></i>
                                    <span
                                        style={{
                                            flex: 1,
                                            minWidth: 0,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                                color: this.props.currentSessionId && Number(this.props.currentSessionId) === Number(chat.id) ? '#be123c' : '#334155',
                                                fontWeight: this.props.currentSessionId && Number(this.props.currentSessionId) === Number(chat.id) ? '600' : 'normal',
                                            fontSize: '12px'
                                        }}
                                        title={chat.titulo}
                                    >
                                        {chat.titulo}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            this.handleDeleteChat(chat.id, chat.titulo);
                                        }}
                                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, lineHeight: 1 }}
                                        title="Excluir chat"
                                    >
                                        <i className="ri-delete-bin-line" style={{ fontSize: '13px', color: '#be123c' }}></i>
                                    </button>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>Applications</div>
                    {this.populateMenu(applicationsMenu.filter(item => item.label !== 'File Manager'))}
                </div>
                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>Pages</div>
                    {this.populateMenu(pagesMenu)}
                </div>
                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>UI Elements</div>
                    {this.populateMenu(uiElementsMenu)}
                </div>
            </React.Fragment>
        )
    }
}

window.addEventListener("click", function (e) {
    let tar = e.target;
    let sidebar = document.querySelector(".sidebar");
    if (!tar.closest(".sidebar-footer") && sidebar) {
        sidebar.classList.remove("footer-menu-show");
    }

    if (!tar.closest(".sidebar") && !tar.closest(".menu-link")) {
        document.querySelector("body").classList.remove("sidebar-show");
    }
});

window.addEventListener("load", function () {
    let skinMode = localStorage.getItem("sidebar-skin");
    let HTMLTag = document.querySelector("html");

    if (skinMode) {
        HTMLTag.setAttribute("data-sidebar", skinMode);
    }
});
