import React, { useState } from "react";
import { Button, Card, Form, Spinner } from "react-bootstrap";
import { Link, useNavigate } from "react-router-dom";

export default function Signin() {
  const [email, setEmail] = useState(""); // Já com o novo user que criamos
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  
  const navigate = useNavigate();

  const handleSignIn = async (e) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await fetch("http://172.18.142.28:3001/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });

      const data = await response.json();

      if (response.ok) {
        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));
        navigate("/apps/chat");
      } else {
        alert(data.error || "Erro ao entrar. Verifique suas credenciais.");
      }
    } catch (error) {
      console.error("Erro na conexão:", error);
      alert("Não consegui falar com o servidor. O backend (porta 3001) está ligado?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="page-sign">
      <Card className="card-sign">
        <Card.Header className="text-center">
          <Link to="/" className="header-logo mb-4">dashbyte</Link>
          <Card.Title>Sign In</Card.Title>
          <Card.Text>Acesse o seu painel de atendimento.</Card.Text>
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
              />
            </div>
            <div className="mb-4">
              <Form.Label>Senha</Form.Label>
              <Form.Control 
                type="password" 
                placeholder="Sua senha" 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <Button type="submit" variant="primary" className="btn-sign w-100" disabled={loading}>
              {loading ? <Spinner size="sm" animation="border" /> : "Entrar"}
            </Button>
          </Form>
        </Card.Body>
        <Card.Footer className="text-center text-secondary fs-sm">
          Acesso restrito à administração.
        </Card.Footer>
      </Card>
    </div>
  );
}