/**
 * @file Chat.js
 * @description Componente principal da interface de chat RAG do Uberdesk.
 *
 * Responsabilidades:
 *  - Exibir histórico de mensagens (usuário + bot) carregado da API
 *  - Enviar perguntas ao backend com os IDs dos PDFs selecionados
 *  - Exibir feedback visual de estado (digitando, gerando, erro)
 *  - Suportar upload de PDF inline com feedback de indexação
 *  - Cancelar requisições em andamento (AbortController)
 *
 * Fluxo de dados (Frontend → Backend → Frontend):
 *  ┌────────────────────────────────────────────────────────────────────┐
 *  │ Usuário digita pergunta + seleciona PDFs na FileTree (OutletContext)│
 *  │       ↓                                                             │
 *  │ handleSendMessage → POST /api/chat { text, selectedPdfIds }         │
 *  │       ↓                                                             │
 *  │ Backend: embedding → Qdrant → Groq → resposta                      │
 *  │       ↓                                                             │
 *  │ setMessages([...prev, { sender: 'bot', text: data.answer }])        │
 *  └────────────────────────────────────────────────────────────────────┘
 *
 * Integração com FileTree:
 *  Os IDs dos PDFs selecionados chegam via OutletContext, injetado pelo
 *  componente pai (App.js / rota protegida). O Chat não gerencia a seleção
 *  de arquivos diretamente — apenas consome o estado compartilhado.
 *
 * @requires react                  Hooks: useState, useEffect, useRef
 * @requires react-router-dom       useOutletContext para receber selectedPdfIds do pai
 * @requires react-bootstrap        Form.Control para o textarea de entrada
 * @requires react-perfect-scrollbar Auto-scroll da janela de mensagens
 */
import React, { useEffect, useState, useRef, useMemo } from "react";
import Header from "../layouts/Header";
import Footer from "../layouts/Footer";
import { Form } from "react-bootstrap";
import { Link, useOutletContext } from "react-router-dom";
import PerfectScrollbar from "react-perfect-scrollbar";
import Avatar from "../components/Avatar";
import { API_URL, uploadProjectDocument, fetchProjectsList } from "../services/api";

// TODO: RedOps Fix — Substituir imagens hardcoded por avatares dinâmicos do perfil do usuário
import imgUser from "../assets/img/img16.jpg";
import imgAI from "../assets/img/img14.jpg";

/**
 * Componente Chat — Interface principal do assistente RAG.
 *
 * @component
 * @returns {JSX.Element} Janela de chat completa com cabeçalho, mensagens e input
 */
export default function Chat() {
  /**
   * selectedPdfIds vem do componente pai via OutletContext (rota filha do React Router).
   * Contém os IDs dos PDFs marcados pelo usuário na FileTree da sidebar.
   * O chat usa esses IDs para filtrar a busca semântica no Qdrant.
   * @type {number[]}
   */
  const outletContext = useOutletContext() || {};
  const selectedPdfIds = outletContext.selectedPdfIds || [];
  const uploadFolderId = outletContext.uploadFolderId || null;
  const setFilesReloadCounter = outletContext.setFilesReloadCounter;
  const currentSessionId = outletContext.currentSessionId ?? null;
  const setCurrentSessionId = outletContext.setCurrentSessionId;
  const messages = useMemo(
    () => (Array.isArray(outletContext.messages) ? outletContext.messages : []),
    [outletContext.messages]
  );
  const setMessages = outletContext.setMessages;

  /** @type {[Array<{sender: string, text: string, time: string}>, Function]} Histórico de mensagens */
  // O estado de mensagens é centralizado no Main para permitir updates pela Sidebar.

  /** @type {[string, Function]} Conteúdo atual do textarea de entrada */
  const [inputText, setInputText] = useState("");

  /** @type {[boolean, Function]} true enquanto aguarda resposta da API (upload ou upload de PDF) */
  const [isTyping, setIsTyping] = useState(false);

  /** @type {[boolean, Function]} true enquanto o LLM está gerando a resposta (após envio da pergunta) */
  const [isGenerating, setIsGenerating] = useState(false);

  /** Dados de projetos/documentos para resolver IDs selecionados em nomes legíveis no rodapé. */
  const [projectRows, setProjectRows] = useState([]);
  const [documentRows, setDocumentRows] = useState([]);

  /** @type {React.RefObject} Referência ao container de scroll para auto-scroll */
  const scrollRef = useRef(null);

  /** @type {React.RefObject} Referência ao textarea para resize automático e re-focus */
  const inputRef = useRef(null);

  /** @type {React.RefObject} Referência ao input[type=file] oculto para upload de PDF */
  const fileInputRef = useRef(null);

  /**
   * Armazena o AbortController da requisição de chat em andamento.
   * Permite cancelar a geração via botão "Stop" ou ao desmontar o componente.
   * @type {React.RefObject<AbortController | null>}
   */
  const activeRequestControllerRef = useRef(null);

  /**
   * JWT armazenado no localStorage após login.
   * Enviado como Bearer token em todas as requisições autenticadas.
   *
   * @security localStorage é vulnerável a XSS. Considerar httpOnly cookies para
   *   armazenamento de tokens de autenticação em produção.
   * TODO: RedOps Fix — Migrar token para cookie httpOnly gerenciado pelo backend.
   */
  const token = localStorage.getItem("token");

  /**
   * Cria um objeto de mensagem padronizado para exibição no chat.
   *
   * @param {'user'|'bot'} sender - Origem da mensagem
   * @param {string} text         - Conteúdo da mensagem
   * @returns {{sender: string, text: string, time: string}}
   */
  const buildChatMessage = (sender, text) => ({
    sender,
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  });

  /**
   * Faz parse seguro de uma string JSON retornada pela API.
   * Retorna objeto vazio em caso de falha, evitando crash no try/catch do caller.
   *
   * @param {string} value - String JSON a ser parseada
   * @returns {object} Objeto parseado ou {} em caso de erro
   */
  const parseJsonSafely = (value) => {
    if (!value) return {};

    try {
      return JSON.parse(value);
    } catch (error) {
      console.error("Erro ao interpretar resposta JSON:", error);
      return {};
    }
  };

  /**
   * Redimensiona automaticamente o textarea conforme o usuário digita.
   * Limita a altura máxima a 120px e ativa overflow quando o conteúdo excede esse limite.
   */
  const resizeInput = () => {
    const el = inputRef.current;
    if (!el) return;

    const maxHeight = 120;
    el.style.height = "0px"; // Reset para recalcular scrollHeight corretamente
    const nextHeight = Math.min(Math.max(el.scrollHeight, 24), maxHeight);
    el.style.height = `${nextHeight}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  // ---------------------------------------------------------------------------
  // HANDLERS DE ARQUIVO (Upload de PDF)
  // ---------------------------------------------------------------------------

  /**
   * Abre o seletor de arquivo nativo ao clicar no ícone de anexo.
   * O input[type=file] real é mantido oculto por limitações de estilização.
   *
   * @param {React.SyntheticEvent} e
   */
  const handleFileClick = (e) => {
    e.preventDefault();
    if (!uploadFolderId) {
      alert('Selecione um projeto de destino na barra lateral antes de enviar um PDF.');
      return;
    }
    fileInputRef.current.click();
  };

  /**
   * Handler de upload de PDF.
   *
   * Fluxo:
   *  1. Usuário seleciona arquivo via input oculto
   *  2. FormData é construído e enviado para POST /api/projects/upload
   *  3. Backend salva no disco, registra no MySQL e indexa no Qdrant (ragService.ingestPdfFile)
   *  4. Resposta indica sucesso ou falha de indexação (indexingWarning)
   *  5. Mensagem de feedback é adicionada ao chat
   *
   * @param {React.ChangeEvent<HTMLInputElement>} e
   */
  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setIsTyping(true);

    try {
      const response = await uploadProjectDocument(token, file, uploadFolderId);

      const rawBody = await response.text();
      const data = parseJsonSafely(rawBody);

      if (response.ok) {
        const uploadMessage = data.indexingWarning
          ? `Arquivo "${file.name}" enviado, mas a indexação vetorial falhou. Reenvie o PDF ou use outro arquivo antes de consultar o chat.`
          : `Arquivo "${file.name}" recebido e indexado com sucesso no servidor.`;

        setMessages(prev => [...prev, buildChatMessage('bot', uploadMessage)]);
        if (setFilesReloadCounter) {
          setFilesReloadCounter(prev => prev + 1);
        }
      } else {
        throw new Error(data.error || "Falha no upload");
      }
    } catch (error) {
      console.error("Erro no upload:", error);
      alert("Erro ao enviar arquivo para o servidor dedicado.");
    } finally {
      setIsTyping(false);
      e.target.value = null; // Reseta o input para permitir re-upload do mesmo arquivo
    }
  };

  // ---------------------------------------------------------------------------
  // CARREGAMENTO DO HISTÓRICO DE MENSAGENS
  // ---------------------------------------------------------------------------

  /**
   * Carrega o histórico de mensagens do usuário ao montar o componente.
   *
   * Faz GET /api/messages com autenticação JWT e reconstrói o estado local
   * para exibir conversas anteriores ao usuário.
   *
   * Dependência: [token] — re-executa apenas se o token mudar (ex: login/logout).
   */
  useEffect(() => {
    let isCancelled = false;
    const controller = new AbortController();

    const loadMessages = async () => {
      setMessages([]); // Limpa imediatamente ao trocar de sessão
      if (!currentSessionId) {
        return;
      }

      try {
        const response = await fetch(`${API_URL}/messages?session_id=${currentSessionId}`, {
          signal: controller.signal,
          cache: 'no-store',
          headers: { "Authorization": `Bearer ${token}` }
        });
        const data = await response.json();

        if (isCancelled) return;

        if (response.ok) {
          const formatted = data.map(msg => ({
            sender: msg.sender,
            text: msg.text,
            time: new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }));
          setMessages(formatted);
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.error("Erro ao carregar mensagens:", err);
      }
    };
    if (token) loadMessages();

    return () => {
      isCancelled = true;
      controller.abort();
    };
  }, [token, currentSessionId, setMessages]);



  /**
   * Carrega projetos/documentos para montar o contexto visual:
   * [Nome da Pasta] > [Nome do Arquivo]
   */
  useEffect(() => {
    const loadContextRows = async () => {
      try {
        const response = await fetchProjectsList(token);
        const data = await response.json().catch(() => ({}));
        if (!response.ok) return;

        const projetos = Array.isArray(data?.projetos) ? data.projetos : [];
        const documentos = Array.isArray(data?.documentos) ? data.documentos : [];

        setProjectRows(projetos);
        setDocumentRows(documentos);
      } catch (err) {
        console.error("Erro ao carregar contexto de arquivos do chat:", err);
      }
    };

    if (token) {
      loadContextRows();
    }
  }, [token, outletContext.filesReloadCounter]);

  const selectedContextItems = selectedPdfIds
    .map((id) => {
      const numericId = Number(id);
      const doc = documentRows.find((d) => Number(d.id) === numericId);
      if (!doc) {
        return { key: `doc-${id}`, text: `Arquivo #${id}` };
      }

      const folderId = Number(doc.projeto_id ?? doc.pasta_id ?? doc.projetoId);
      const folder = projectRows.find((p) => Number(p.id) === folderId);
      const folderName = folder?.nome || folder?.name || `Pasta #${folderId}`;
      const fileName = doc?.nome_arquivo || doc?.name || `Arquivo #${id}`;

      return {
        key: `doc-${numericId}`,
        text: `📁 ${folderName} > 📄 ${fileName}`
      };
    })
    .filter(Boolean);

  const uploadFolderName = projectRows.find((p) => Number(p.id) === Number(uploadFolderId))?.nome
    || projectRows.find((p) => Number(p.id) === Number(uploadFolderId))?.name
    || (uploadFolderId ? `Pasta #${uploadFolderId}` : '');

  // ---------------------------------------------------------------------------
  // ENVIO DE MENSAGEM (PIPELINE RAG COMPLETO)
  // ---------------------------------------------------------------------------

  /**
   * Envia a pergunta do usuário ao backend e exibe a resposta do LLM.
   *
   * Fluxo:
   *  1. Valida pré-condições (texto não vazio, token presente, PDFs selecionados)
   *  2. Exibe a mensagem do usuário imediatamente na tela (UI otimista)
   *  3. POSTs para /api/chat com { text, selectedPdfIds }
   *  4. Trata respostas HTTP 200 (sucesso), 400 (sem contexto), outros erros
   *  5. Exibe resposta do bot ou mensagem de erro apropriada
   *
   * O AbortController permite ao usuário cancelar a geração clicando em "Stop",
   * o que propaga o sinal até a chamada fetch para a Groq no backend.
   *
   * @param {React.SyntheticEvent} [e] - Evento de submit (opcional)
   */
  const handleSendMessage = async (e) => {
    if (e) e.preventDefault();
    if (!inputText.trim() || isTyping || isGenerating) return;

    if (!token) {
      // Sessão expirada — JWT não encontrado no localStorage
      setMessages(prev => [...prev, buildChatMessage('bot', 'Sua sessão expirou. Faça login novamente para continuar.')]);
      return;
    }

    if (!selectedPdfIds.length) {
      // Guard: sem PDFs selecionados, o backend não tem como filtrar o Qdrant
      setMessages(prev => [...prev, buildChatMessage('bot', 'Selecione pelo menos 1 PDF na barra lateral (Meus Documentos) para usar o RAG.')]);
      return;
    }

    // Sanitização dos IDs: garante que apenas inteiros positivos sejam enviados
    const normalizedPdfIds = selectedPdfIds
      .map((id) => Number(id))
      .filter((id) => Number.isInteger(id) && id > 0);

    let activeSessionId = Number(currentSessionId);
    if (!Number.isInteger(activeSessionId) || activeSessionId <= 0) {
      activeSessionId = null;
    }

    if (!activeSessionId) {
      try {
        const createSessionResponse = await fetch(`${API_URL}/chats`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
          },
          body: JSON.stringify({ titulo: `Chat ${new Date().toLocaleString()}` })
        });

        const createSessionBody = await createSessionResponse.text();
        const createSessionData = parseJsonSafely(createSessionBody);

        if (!createSessionResponse.ok) {
          throw new Error(createSessionData.error || 'Não foi possível criar uma sessão de chat para enviar a mensagem.');
        }

        activeSessionId = Number(createSessionData.id);
        if (!Number.isInteger(activeSessionId) || activeSessionId <= 0) {
          throw new Error('A API retornou uma sessão inválida.');
        }

        if (typeof setCurrentSessionId === 'function') {
          setCurrentSessionId(activeSessionId);
        }
      } catch (sessionError) {
        console.error('Erro ao criar sessão antes de enviar mensagem:', sessionError);
        setMessages(prev => [...prev, buildChatMessage('bot', 'Não foi possível iniciar uma sessão de chat. Tente novamente.')]);
        return;
      }
    }

    const userMsgText = inputText.trim();
    setInputText("");
    setIsTyping(true);
    setIsGenerating(true);

    // AbortController: permite cancelar a requisição em andamento
    const requestController = new AbortController();
    activeRequestControllerRef.current = requestController;

    // Exibe a mensagem do usuário imediatamente (UI otimista — sem esperar resposta)
    setMessages(prev => [...prev, buildChatMessage('user', userMsgText)]);

    try {
      /**
       * POST /api/chat — Dispara o pipeline RAG completo no backend:
       *  1. Embedding da pergunta
       *  2. Busca semântica no Qdrant (filtrada por normalizedPdfIds)
       *  3. Geração de resposta via Groq LLM
       *  4. Persistência no MySQL
       */
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        signal: requestController.signal, // Propaga cancelamento para o fetch do backend→Groq
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({
          text: userMsgText,
          selectedPdfIds: normalizedPdfIds,
          session_id: activeSessionId
        })
      });

      const rawBody = await response.text();
      const data = parseJsonSafely(rawBody);

      if (response.ok) {
        // Suporta múltiplos campos de resposta para compatibilidade com versões do backend
        setMessages(prev => [...prev, buildChatMessage('bot', data.answer || data.text || data.reply || 'Não recebi resposta da IA.')]);
        return;
      }

      if (response.status === 400) {
        // 400 com "contexto relevante" = PDFs indexados mas sem correspondência semântica
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
        // Cancelamento intencional pelo usuário via botão "Stop"
        setMessages(prev => [...prev, buildChatMessage('bot', '⏹️ Resposta interrompida.')]);
      } else {
        console.error("Erro ao enviar mensagem:", error);
        setMessages(prev => [...prev, buildChatMessage('bot', 'Erro: não foi possível concluir a consulta aos documentos.')]);
      }
    } finally {
      activeRequestControllerRef.current = null;
      setIsTyping(false);
      setIsGenerating(false);
      setTimeout(() => inputRef.current?.focus(), 100); // Re-foca o input após resposta
    }
  };

  /**
   * Cancela a requisição de geração em andamento.
   * Chama abort() no AbortController ativo, que propaga o sinal até o fetch backend→Groq.
   *
   * @param {React.SyntheticEvent} [e]
   */
  const handleStopResponse = (e) => {
    if (e) e.preventDefault();
    if (activeRequestControllerRef.current) {
      activeRequestControllerRef.current.abort();
      activeRequestControllerRef.current = null;
    }
  };

  // ---------------------------------------------------------------------------
  // EFEITOS COLATERAIS (Auto-scroll, Resize, Cleanup)
  // ---------------------------------------------------------------------------

  /** Auto-scroll para a última mensagem sempre que o array de mensagens muda */
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  /** Redimensiona o textarea sempre que o conteúdo muda */
  useEffect(() => {
    resizeInput();
  }, [inputText]);

  /**
   * Cleanup ao desmontar o componente: cancela qualquer requisição pendente.
   * Evita memory leaks e setState em componentes desmontados.
   */
  useEffect(() => {
    return () => {
      if (activeRequestControllerRef.current) {
        activeRequestControllerRef.current.abort();
      }
    };
  }, []);

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <React.Fragment>
      <Header />
      <div className="main main-app p-3 p-lg-4" style={{ height: '100dvh', minHeight: '100dvh' }}>
        <div className="chat-panel msg-show no-chat-sidebar" style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          <div className="chat-body" style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>

            {/* Cabeçalho do Chat — exibe status dinâmico baseado no estado de geração */}
            <div className="chat-body-header">
              <div className="chat-item">
                <Avatar img={imgAI} status="online" />
                <div className="chat-item-body">
                  {/* TODO: RedOps Fix — 'Uberdesk IA' deve ser configurável via ENV ou painel admin */}
                  <h6 className="mb-1">Uberdesk IA - RAG Dedicado</h6>
                  <span>{isGenerating ? "Buscando nos documentos..." : isTyping ? "Digitando..." : "Online"}</span>
                </div>
              </div>
            </div>

            {/* Lista de Mensagens com auto-scroll via PerfectScrollbar */}
            <PerfectScrollbar
              className="chat-body-content"
              containerRef={(ref) => (scrollRef.current = ref)}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}
            >
              {messages.map((msg, index) => (
                // key por índice — aceitável para lista append-only sem reordenação
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

            {/* Rodapé de Entrada — Área de composição de mensagem */}
            <div
              className="chat-body-footer"
              style={{
                borderTop: '1px solid #e2e5ec',
                padding: '10px 15px',
                paddingBottom: 'env(safe-area-inset-bottom, 15px)',
                backgroundColor: '#fff',
                flexShrink: 0,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'stretch',
                gap: '8px',
                height: 'auto',
                minHeight: '60px'
              }}
            >
              <div
                style={{
                  width: '100%',
                  color: '#6c757d',
                  fontSize: '12px',
                  lineHeight: 1.35,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '4px',
                  paddingBottom: '8px'
                }}
              >
                {selectedContextItems.length > 0 ? (
                  selectedContextItems.map((item) => (
                    <div key={item.key} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.text}>
                      {item.text}
                    </div>
                  ))
                ) : uploadFolderName ? (
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={`📁 ${uploadFolderName}`}>
                    {`📁 ${uploadFolderName}`}
                  </div>
                ) : (
                  <div>Nenhum arquivo selecionado.</div>
                )}
              </div>

              <div className="d-flex align-items-end w-100" style={{ gap: '8px' }}>

                {/* Input de arquivo oculto — acionado via handleFileClick no ícone de anexo */}
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
                    backgroundColor: '#f8f9fc',
                    margin: 0
                  }}
                >

                  {/* Textarea com resize automático — Enter envia, Shift+Enter quebra linha */}
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

                {/*
                  Botão de ação principal:
                   - Azul + ícone de envio: quando há texto e não está gerando
                   - Vermelho + ícone de stop: durante geração (cancela via AbortController)
                   - Cinza: sem texto ou durante upload
                */}
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