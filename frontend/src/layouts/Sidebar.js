/**
 * @file Sidebar.js
 * @description Componente de navegação lateral que inclui o menu principal e a seção RAG.
 *
 * Responsabilidades:
 *  - Exibir navegação principal do painel.
 *  - Exibir o componente FileTree com seleção de PDFs para uso no chat.
 *  - Garantir que apenas documentos do tenant sejam visíveis no frontend.
 *
 * Fluxo:
 *  Rota de navegação selecionada → Sidebar renderiza FileTree → retorna listagem de documentos
 *
 * @requires react-router-dom Link, NavLink para navegação
 * @requires react-perfect-scrollbar Rolagem personalizada do menu lateral
 */
import React, { Component } from "react";
import { Link, NavLink } from "react-router-dom";
import PerfectScrollbar from "react-perfect-scrollbar";
import userAvatar from "../assets/img/img1.jpg";
import FileTree from "./FileTree";
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
                        onUpdateSize={() => this._scrollBarRef.updateScroll()}
                        selectedPdfIds={this.props.selectedPdfIds}
                        setSelectedPdfIds={this.props.setSelectedPdfIds}
                        uploadFolderId={this.props.uploadFolderId}
                        setUploadFolderId={this.props.setUploadFolderId}
                        filesReloadCounter={this.props.filesReloadCounter}
                        setFilesReloadCounter={this.props.setFilesReloadCounter}
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

        this.props.onUpdateSize();
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

        this.props.onUpdateSize();
    }

    render() {
        return (
            <React.Fragment>
                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>Dashboard</div>
                    {this.populateMenu(dashboardMenu)}
                </div>
                {/* --- NOSSA NOVA SEÇÃO DE ARQUIVOS --- */}
                <div className="nav-group show">
                    <div className="nav-label" onClick={this.toggleMenu}>Meus Documentos (RAG)</div>
                    <ul className="nav nav-sidebar">
                        <li className="nav-item">
                            {/* Passamos o onUpdateSize para o scroll funcionar se a lista for grande */}
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
                {/* ----------------------------------- */}
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
    // Close sidebar footer menu when clicked outside of it
    let tar = e.target;
    let sidebar = document.querySelector(".sidebar");
    if (!tar.closest(".sidebar-footer") && sidebar) {
        sidebar.classList.remove("footer-menu-show");
    }

    // Hide sidebar offset when clicked outside of sidebar
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