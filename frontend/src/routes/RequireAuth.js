import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';

const RequireAuth = ({ children }) => {
  // 🔑 Busca o Token que salvamos no Signin.js
  const token = localStorage.getItem("token");
  const location = useLocation();

  if (!token) {
    // ✋ Não tem token? Manda de volta para o Login
    // salvando a página que ele tentou acessar para depois do login
    return <Navigate to="/signin" state={{ from: location }} replace />;
  }

  return children;
};

export default RequireAuth;