import React, { useEffect, useState, useRef } from "react";
import Header from "../layouts/Header";
import Footer from "../layouts/Footer";
import { Form } from "react-bootstrap";
import { Link, useOutletContext } from "react-router-dom";
import PerfectScrollbar from "react-perfect-scrollbar";
import Avatar from "../components/Avatar";

// Imagens
import imgUser from "../assets/img/img16.jpg"; 
import imgAI from "../assets/img/img14.jpg";

const API_URL = process.env.REACT_APP_API_URL || '/api';

export default function Chat() {
  const outletContext = useOutletContext() || {};
  const selectedPdfIds = outletContext.selectedPdfIds || [];

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);

  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const activeRequestControllerRef = useRef(null);
  
  const token = localStorage.getItem("token");

  const buildChatMessage = (sender, text) => ({
    sender,
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });

  const parseJsonSafely = (value) => {
    if (!value) return {};

    try {
      return JSON.parse(value);
    } catch (error) {
      console.error("Erro ao interpretar resposta JSON:", error);
      return {};
    }
  };

  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;

    const maxHeight = 120;
    el.style.height = "0px";
    const nextHeight = Math.min(Math.max(el.scrollHeight, 24), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  // --- LÓGICA DE ARQUIVOS ---
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
      // Upload de PDF para o backend: persiste arquivo e dispara indexacao vetorial.
      const response = await fetch(`${API_URL}/files/upload`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData
      });

      const rawBody = await response.text();
      const data = parseJsonSafely(rawBody);

      if (response.ok) {
        const uploadMessage = data.indexingWarning
          ? `Arquivo "${file.name}" enviado, mas a indexação vetorial falhou. Reenvie o PDF ou use outro arquivo antes de consultar o chat.`
          : `Arquivo "${file.name}" recebido e indexado com sucesso no servidor.`;

        setMessages(prev => [...prev, buildChatMessage('bot', uploadMessage)]);
      } else {
        throw new Error(data.error || "Falha no upload");
      }
    } catch (error) {
      console.error("Erro no upload:", error);
      alert("Erro ao enviar arquivo para o servidor dedicado.");
    } finally {
      setIsTyping(false);
      e.target.value = null; 
    }
  };

  // --- BUSCAR HISTÓRICO ---
  useEffect(() => {
    const loadMessages = async () => {
      try {
        // Carrega o historico de mensagens autenticado para reconstruir o contexto visual do chat.
        const response = await fetch(`${API_URL}/messages`, {
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
        console.error("Erro ao carregar mensagens:", err);
      }
    };
    if (token) loadMessages();
  }, [token]);

  // --- ENVIAR MENSAGEM ---
  const handleSendMessage = async (e) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isTyping || isGenerating) return;

    if (!token) {
      setMessages(prev => [...prev, buildChatMessage('bot', 'Sua sessão expirou. Faça login novamente para continuar.')]);
      return;
    }

    if (!selectedPdfIds.length) {
      setMessages(prev => [...prev, buildChatMessage('bot', 'Selecione pelo menos 1 PDF na barra lateral (Meus Documentos) para usar o RAG.')]);
      return;
    }

    const normalizedPdfIds = selectedPdfIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);

    const userMsgText = inputText.trim();
    setInputText("");
    setIsTyping(true);
    setIsGenerating(true);

    // Controlador de cancelamento para interromper a requisicao se o usuario clicar em "parar".
    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;

    // Adiciona a mensagem do usuário na tela imediatamente
    setMessages(prev => [...prev, buildChatMessage('user', userMsgText)]);

    try {
      // Consulta RAG: envia pergunta + PDFs selecionados para recuperar contexto e gerar resposta.
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        signal: requestController.signal,
        headers: { 
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          text: userMsgText,
          selectedPdfIds: normalizedPdfIds
        })
      });

      const rawBody = await response.text();
      const data = parseJsonSafely(rawBody);

      if (response.ok) {
        setMessages(prev => [...prev, buildChatMessage('bot', data.answer || data.text || data.reply || 'Não recebi resposta da IA.')]);
        return;
      }

      if (response.status === 400) {
        const noContextError = typeof data.error === 'string' && data.error.toLowerCase().includes('contexto relevante');
        const friendlyMessage = noContextError
          ? 'Não encontrei informações sobre isso nos PDFs selecionados. O arquivo pode ainda não ter sido indexado ou pode ser inválido. Tente reenviar o PDF ou selecione outro documento.'
          : (data.error || 'Não foi possível concluir a consulta com os PDFs selecionados.');

        setMessages(prev => [...prev, buildChatMessage('bot', friendlyMessage)]);
        return;
      }

      throw new Error(data.error || 'Falha ao processar a mensagem no servidor.');
    } catch (error) {
      if (error.name === "AbortError") {
        setMessages(prev => [...prev, buildChatMessage('bot', '⏹️ Resposta interrompida.')]);
      } else {
        console.error("Erro ao enviar mensagem:", error);
        setMessages(prev => [...prev, buildChatMessage('bot', 'Erro: não foi possível concluir a consulta aos documentos.')]);
      }
    } finally {
      activeRequestControllerRef.current = null;
      setIsTyping(false);
      setIsGenerating(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  };

  const handleStopResponse = (e) => {
    if (e) e.preventDefault();
    if (activeRequestControllerRef.current) {
      // Cancela a chamada em andamento no frontend e notifica o backend via abort do fetch.
      activeRequestControllerRef.current.abort();
      activeRequestControllerRef.current = null;
    }
  };

  // Auto-scroll para a última mensagem
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  useEffect(() => {
    resizeInput();
  }, [inputText]);

  useEffect(() => {
    return () => {
      if (activeRequestControllerRef.current) {
        // Cleanup: evita requisicao pendurada ao sair da tela do chat.
        activeRequestControllerRef.current.abort();
      }
    };
  }, []);

  return (
    <React.Fragment>
      <Header />
      <div className="main main-app p-3 p-lg-4">
        <div className="chat-panel msg-show no-chat-sidebar">
          <div className="chat-body">
            
            {/* Cabeçalho do Chat */}
            <div className="chat-body-header">
              <div className="chat-item">
                <Avatar img={imgAI} status="online" />
                <div className="chat-item-body">
                  <h6 className="mb-1">Uberdesk IA - RAG Dedicado</h6>
                  <span>{isGenerating ? "Buscando nos documentos..." : isTyping ? "Digitando..." : "Online"}</span>
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

            {/* Rodapé de Entrada (Estilo WhatsApp) */}
            <div className="chat-body-footer" style={{ borderTop: '1px solid #e2e5ec', padding: '10px 15px', backgroundColor: '#fff' }}>
              <div className="d-flex align-items-end w-100" style={{ gap: '8px' }}>
                
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  style={{ display: 'none' }} 
                  accept=".pdf" 
                  onChange={handleFileChange} 
                />

                <div
                  className="msg-box d-flex align-items-end"
                  style={{
                    flex: '1 1 auto',
                    minWidth: 0,
                    border: '1px solid #e2e5ec',
                    borderRadius: '20px',
                    padding: '6px 10px',
                    minHeight: '40px',
                    maxHeight: '132px',
                    backgroundColor: '#f8f9fc'
                  }}
                >
                  
                  <Link to="#" className="text-secondary p-1" onClick={isGenerating ? (e) => e.preventDefault() : handleFileClick} style={{ fontSize: '20px', textDecoration: 'none', pointerEvents: isGenerating ? 'none' : 'auto', opacity: isGenerating ? 0.5 : 1 }}>
                    <i className="ri-attachment-2"></i>
                  </Link>

                  <Form.Control 
                    as="textarea"
                    rows={1}
                    ref={inputRef}
                    placeholder="Escreva sua mensagem ou suba um PDF..." 
                    value={inputText}
                    disabled={isTyping || isGenerating}
                    onChange={(e) => setInputText(e.target.value)}
                    onInput={resizeInput}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    style={{
                      border: 'none',
                      background: 'transparent',
                      boxShadow: 'none',
                      minWidth: 0,
                      resize: 'none',
                      overflowY: 'hidden',
                      lineHeight: '1.35',
                      padding: '2px 5px',
                      maxHeight: '120px'
                    }}
                  />
                </div>

                <div
                  style={{ flexShrink: 0, whiteSpace: 'nowrap', color: '#6c757d', fontSize: '12px' }}
                  title={selectedPdfIds.length ? `IDs: ${selectedPdfIds.join(', ')}` : 'Nenhum PDF selecionado'}
                >
                  {`PDFs: ${selectedPdfIds.length}`}
                </div>

                <Link 
                  to="#" 
                  onClick={isGenerating ? handleStopResponse : handleSendMessage}
                  className="d-flex align-items-center justify-content-center" 
                  style={{ 
                    width: '40px', 
                    height: '40px', 
                    borderRadius: '50%', 
                    backgroundColor: isGenerating ? '#dc3545' : (inputText.trim() && !isTyping ? '#0d6efd' : '#e2e5ec'),
                    color: isGenerating || (inputText.trim() && !isTyping) ? '#fff' : '#8392a5',
                    fontSize: '18px',
                    textDecoration: 'none',
                    transition: 'all 0.2s ease-in-out',
                    cursor: isGenerating || (inputText.trim() && !isTyping) ? 'pointer' : 'default'
                  }}
                >
                  <i className={isGenerating ? "ri-stop-fill" : "ri-send-plane-2-line"}></i>
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