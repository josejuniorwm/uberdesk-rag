import React from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import Main from './layouts/Main';
import NotFound from "./pages/NotFound";
import RequireAuth from "./routes/RequireAuth";

import publicRoutes from "./routes/PublicRoutes";
import protectedRoutes from "./routes/ProtectedRoutes";

// import css
import "./assets/css/remixicon.css";

// import scss
import "./scss/style.scss";


// set skin on load
window.addEventListener("load", function () {
  let skinMode = localStorage.getItem("skin-mode");
  let HTMLTag = document.querySelector("html");

  if (skinMode) {
    HTMLTag.setAttribute("data-skin", skinMode);
  }
});

export default function App() {
  return (
    <React.Fragment>
      <BrowserRouter>
        <Routes>
          {/* 1. Raiz sempre para signin (página pública) */}
          <Route path="/" element={<Navigate to="/signin" replace />} />

          {/* 2. Block de rotas protegidas (after signin) */}
          <Route path="/*" element={<RequireAuth><Main /></RequireAuth>}>
            {protectedRoutes.map((route, index) => (
              <Route path={route.path} element={route.element} key={index} />
            ))}
          </Route>

          {/* Rotas Públicas (Login, Sign-up) ficam FORA do bloco de proteção */}
          {publicRoutes.map((route, index) => (
            <Route path={route.path} element={route.element} key={index} />
          ))}

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </React.Fragment>
  );
}