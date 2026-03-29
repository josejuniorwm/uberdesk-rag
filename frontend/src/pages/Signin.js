import React, { useState } from "react";
import { Button, Card, Form, Spinner } from "react-bootstrap";
import { Link, useNavigate } from "react-router-dom";

// Base da API servida pelo mesmo domínio via Nginx (/api -> backend)
const API_URL = process.env.REACT_APP_API_URL || '/api';

export default function Signin() {
  const [email, setEmail] = useState(""); 
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  
  const navigate = useNavigate();

  const handleSignIn = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      // Chamada de autenticacao: envia credenciais e recebe JWT + dados do usuario.
      const response = await fetch(`${API_URL}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (response.ok) {
        // Salva o Token e os dados do usuário para as próximas requisições
        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));

        navigate("/apps/chat");
      } else {
        alert(data.error || "Erro ao entrar. Verifique suas credenciais.");
      }
    } catch (error) {
      console.error("Erro na conexão:", error);
      alert("Não consegui falar com a API. Verifique se o proxy /api está ativo no Nginx e se o backend na porta 3001 está em execução.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-sign">
      <Card className="card-sign">
        <Card.Header className="text-center">
          <Link to="/" className="header-logo mb-4">Uberdesk RAG</Link>
          <Card.Title>Sign In</Card.Title>
          <Card.Text>Acesse o seu painel de atendimento dedicado.</Card.Text>
        </Card.Header>
        <Card.Body>
          <Form onSubmit={handleSignIn}>
            <div className="mb-4">
              <Form.Label>Email</Form.Label>
              <Form.Control 
                type="text" 
                placeholder="Seu e-mail" 
                value={email}
                onChange={(e) => setEmail(e.target.value)} 
                required
              />
            </div>
            <div className="mb-4">
              <Form.Label>Senha</Form.Label>
              <Form.Control 
                type="password" 
                placeholder="Sua senha" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </div>
            <Button type="submit" variant="primary" className="btn-sign w-100" disabled={loading}>
              {loading ? <Spinner size="sm" animation="border" /> : "Entrar"}
            </Button>
          </Form>
        </Card.Body>
        <Card.Footer className="text-center text-secondary fs-sm">
          Acesso restrito à infraestrutura dedicada.
        </Card.Footer>
      </Card>
    </div>
  );
}