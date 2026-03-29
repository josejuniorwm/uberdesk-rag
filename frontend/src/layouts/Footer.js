import React from "react";
import { Link } from "react-router-dom";

export default function Footer() {
  return (
    <div className="main-footer">
      <span>&copy; 2026. Uberdesk RAG. Todos os direitos reservados.</span>
      <span>Plataforma: <Link to="/" target="_self">Uberdesk</Link></span>
    </div>
  )
}