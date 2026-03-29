import React from "react";
import { Button, Card, Col, Form, Row } from "react-bootstrap";
import { Link } from "react-router-dom";

export default function Signup() {
  return (
    <div className="page-sign">
      <Card className="card-sign">
        <Card.Header>
          <Link to="/" className="header-logo mb-4">Uberdesk RAG</Link>
          <Card.Title>Sign Up</Card.Title>
          <Card.Text>Crie sua conta para acessar o Uberdesk RAG.</Card.Text>
        </Card.Header>
        <Card.Body>
          <div className="mb-3">
            <Form.Label>Email</Form.Label>
            <Form.Control type="text" placeholder="Digite seu email" />
          </div>
          <div className="mb-3">
            <Form.Label>Senha</Form.Label>
            <Form.Control type="password" placeholder="Digite sua senha" />
          </div>
          <div className="mb-3">
            <Form.Label>Nome completo</Form.Label>
            <Form.Control type="text" placeholder="Digite seu nome completo" />
          </div>
          <div className="mb-4">
            <small>By clicking <strong>Create Account</strong> below, you agree to our terms of service and privacy statement.</small>
          </div>
          <Button variant="primary" className="btn-sign">Create Account</Button>

          <div className="divider"><span>or sign up using</span></div>

          <Row className="gx-2">
            <Col><Button variant="" className="btn-facebook"><i className="ri-facebook-fill"></i> Facebook</Button></Col>
            <Col><Button variant="" className="btn-google"><i className="ri-google-fill"></i> Google</Button></Col>
          </Row>
        </Card.Body>
        <Card.Footer>
          Already have an account? <Link to="/pages/signin">Sign In</Link>
        </Card.Footer>
      </Card>
    </div>
  );
}