import React, { useEffect, useState, useRef } from "react";
import Header from "../layouts/Header";
import Footer from "../layouts/Footer";
import { Form } from "react-bootstrap";
import { Link } from "react-router-dom";
import PerfectScrollbar from "react-perfect-scrollbar";
import Avatar from "../components/Avatar";

// Imagens
import imgUser from "../assets/img/img16.jpg"; 
import imgAI from "../assets/img/img14.jpg";

export default function Chat() {
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false); 

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null); 
  
  const token = localStorage.getItem("token");

  // --- LÓGICA DE ARQUIVOS (CORRIGIDA) ---
  const handleFileClick = (e) => {
    e.preventDefault();
    fileInputRef.current.click(); 
  };

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsTyping(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('http://172.18.142.28:3001/api/files/upload', {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData
      });

      const data = await response.json();
      if (response.ok) {
        setMessages(prev => [...prev, { 
          sender: 'bot', 
          text: `✅ Arquivo "${file.name}" recebido com sucesso!`, 
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
        }]);
      }
    } catch (error) {
      console.error("Erro no upload:", error);
    } finally {
      setIsTyping(false);
      e.target.value = null; 
    }
  };

  // --- BUSCAR HISTÓRICO ---
  useEffect(() => {
    const loadMessages = async () => {
      try {
        const response = await fetch('http://172.18.142.28:3001/api/messages', {
          headers: { "Authorization": `Bearer ${token}` }
        });
        const data = await response.json();
        if (response.ok) {
          const formatted = data.map(msg => ({
            sender: msg.sender, 
            text: msg.text,
            time: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }));
          setMessages(formatted);
        }
      } catch (err) {
        console.error("Erro ao carregar:", err);
      }
    };
    if (token) loadMessages();
  }, [token]);

  // --- ENVIAR MENSAGEM ---
  const handleSendMessage = async (e) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isTyping) return;

    const userMsgText = inputText;
    setInputText("");
    setIsTyping(true);

    setMessages(prev => [...prev, { 
      sender: 'user', 
      text: userMsgText, 
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
    }]);

    try {
      const response = await fetch('http://172.18.142.28:3001/api/messages', {
        method: "POST",
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ text: userMsgText })
      });

      const data = await response.json();

      if (response.ok) {
        setMessages(prev => [...prev, { 
          sender: 'bot', 
          text: data.reply, 
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) 
        }]);
      }
    } catch (error) {
      console.error("Erro:", error);
    } finally {
      setIsTyping(false);
      inputRef.current?.focus();
    }
  };

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <React.Fragment>
      <Header />
      <div className="main main-app p-3 p-lg-4">
        <div className="chat-panel msg-show">
          <div className="chat-body">
            
            {/* Cabeçalho */}
            <div className="chat-body-header">
              <div className="chat-item">
                <Avatar img={imgAI} status="online" />
                <div className="chat-item-body">
                  <h6 className="mb-1">Dashbyte IA</h6>
                  <span>{isTyping ? "Digitando..." : "Online"}</span>
                </div>
              </div>
            </div>

            {/* Conteúdo das Mensagens */}
            <PerfectScrollbar 
              className="chat-body-content" 
              containerRef={(ref) => (scrollRef.current = ref)}
            >
              {messages.map((msg, index) => (
                <div key={index} className={`msg-item ${msg.sender === 'user' ? 'reverse' : ''}`}>
                  <Avatar img={msg.sender === 'user' ? imgUser : imgAI} />
                  <div className="msg-body">
                    <div className="msg-bubble">
                      {msg.text}
                      <span>{msg.time}</span>
                    </div>
                  </div>
                </div>
              ))}
            </PerfectScrollbar>

            {/* 🚀 Rodapé Estilo WhatsApp (Sem embolar ícones) */}
            <div className="chat-body-footer" style={{ borderTop: '1px solid #e2e5ec', padding: '10px 15px', backgroundColor: '#fff' }}>
              <div className="d-flex align-items-center w-100">
                
                {/* Input de arquivo invisível (mantemos igual) */}
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  style={{ display: 'none' }} 
                  accept=".pdf" 
                  onChange={handleFileChange} 
                />

                {/* 1. Container Principal (Anexo + Texto) */}
                {/* Usamos flex-grow-1 para este container ocupar todo o espaço disponível */}
                <div className="msg-box flex-grow-1 d-flex align-items-center me-3" style={{ border: '1px solid #e2e5ec', borderRadius: '20px', padding: '0 10px', height: '40px', backgroundColor: '#f8f9fc' }}>
                  
                  {/* Ícone de Anexo (Clipe) - Agora com padding para não encostar na borda */}
                  <Link to="#" className="text-secondary p-1" onClick={handleFileClick} style={{ fontSize: '20px', textDecoration: 'none' }}>
                    <i className="ri-attachment-2"></i>
                  </Link>

                  {/* Campo de Digitação - Sem borda própria para parecer um campo só */}
                  <Form.Control 
                    ref={inputRef}
                    type="text" 
                    placeholder="Escreva sua mensagem ou suba um PDF..." 
                    value={inputText}
                    onChange={(e) => setInputText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                    style={{ border: 'none', background: 'transparent', boxShadow: 'none', height: '100%', paddingLeft: '5px' }}
                  />
                </div>

                {/* 2. Botão de Enviar (Setinha) - FORA do campo de texto, estilo WhatsApp */}
                <Link 
                  to="#" 
                  onClick={handleSendMessage} 
                  className="d-flex align-items-center justify-content-center" 
                  style={{ 
                    width: '40px', 
                    height: '40px', 
                    borderRadius: '50%', 
                    backgroundColor: inputText.trim() && !isTyping ? '#0d6efd' : '#e2e5ec', // Muda de cor se tiver texto
                    color: inputText.trim() && !isTyping ? '#fff' : '#8392a5',
                    fontSize: '18px',
                    textDecoration: 'none',
                    transition: 'all 0.2s ease-in-out',
                    cursor: inputText.trim() && !isTyping ? 'pointer' : 'default'
                  }}
                >
                  <i className="ri-send-plane-2-line"></i>
                </Link>
              </div>
            </div>
          </div>
        </div>
        <Footer />
      </div>
    </React.Fragment>
  );
}