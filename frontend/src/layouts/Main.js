/**
 * @file Main.js
 * @description Layout principal do aplicativo React.
 *
 * Responsabilidades:
 *  - Monta a interface de sidebar + área de rota filha via Outlet.
 *  - Compartilha estados de seleção de PDFs e upload entre sidebar e chat.
 *  - Mantém o contexto de tenant no frontend: selectedPdfIds e uploadFolderId.
 *
 * Fluxo de dados:
 *  Sidebar / FileTree → alterna PDFs selecionados e pasta de upload
 *      ↓
 *  Main → propaga contexto via Outlet para componentes como Chat
 */
import React, { useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import Sidebar from "./Sidebar";

export default function Main() {
  // Estado global da área autenticada do RAG.
  // A sidebar altera esses valores e o Chat consome o mesmo estado via Outlet context.
  const [selectedPdfIds, setSelectedPdfIds] = useState([]);
  const [uploadFolderId, setUploadFolderId] = useState(null);
  const [filesReloadCounter, setFilesReloadCounter] = useState(0);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [messages, setMessages] = useState([]);

  const offsets = ["/apps/email", "/apps/calendar"];
  const { pathname } = useLocation();
  const bc = document.body.classList;

  // Algumas rotas legadas do template usam offset visual da sidebar.
  (offsets.includes(pathname)) ? bc.add("sidebar-offset") : bc.remove("sidebar-offset");

  // Fecha a sidebar ao navegar em telas menores para evitar overlay preso.
  bc.remove("sidebar-show");

  // Mantém a navegação consistente ao trocar entre telas protegidas.
  window.scrollTo(0, 0);

  return (
    <React.Fragment>
      <Sidebar
        selectedPdfIds={selectedPdfIds}
        setSelectedPdfIds={setSelectedPdfIds}
        uploadFolderId={uploadFolderId}
        setUploadFolderId={setUploadFolderId}
        filesReloadCounter={filesReloadCounter}
        setFilesReloadCounter={setFilesReloadCounter}
        currentSessionId={currentSessionId}
        setCurrentSessionId={setCurrentSessionId}
        setMessages={setMessages}
      />
      <Outlet context={{
        selectedPdfIds,
        setSelectedPdfIds,
        uploadFolderId,
        setUploadFolderId,
        filesReloadCounter,
        setFilesReloadCounter,
        currentSessionId,
        setCurrentSessionId,
        messages,
        setMessages
      }} />
    </React.Fragment>
  )
}