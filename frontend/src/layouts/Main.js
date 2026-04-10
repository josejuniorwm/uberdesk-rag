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
  const [selectedPdfIds, setSelectedPdfIds] = useState([]);
  const [uploadFolderId, setUploadFolderId] = useState(null);
  const [filesReloadCounter, setFilesReloadCounter] = useState(0);

  const offsets = ["/apps/email", "/apps/calendar"];
  const { pathname } = useLocation();
  const bc = document.body.classList;

  // set sidebar to offset
  (offsets.includes(pathname)) ? bc.add("sidebar-offset") : bc.remove("sidebar-offset");

  // auto close sidebar when switching pages in mobile
  bc.remove("sidebar-show");

  // scroll to top when switching pages
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
      />
      <Outlet context={{
        selectedPdfIds,
        setSelectedPdfIds,
        uploadFolderId,
        setUploadFolderId,
        filesReloadCounter,
        setFilesReloadCounter
      }} />
    </React.Fragment>
  )
}