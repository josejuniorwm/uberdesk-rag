const express = require('express');
const cors = require('cors');

const app = express();

// O CORS é o segurança da porta: ele permite que o seu site (React) converse com esta API
app.use(cors()); 

// Permite que o servidor entenda o formato JSON que o React está enviando
app.use(express.json()); 

// Esta é a ROTA EXATA que o seu Chat.js está chamando
app.post('/chat', async (req, res) => {
    // Captura o que voce digitou no Uberdesk RAG
    const { message, userId } = req.body; 

    console.log(`[NOVA MENSAGEM] Cliente: ${userId} | Texto: ${message}`);

    try {
        // PASSO 1: Aqui faremos a busca no Qdrant (Porta 6333) no futuro
        // PASSO 2: Aqui enviaremos o contexto para o Gemini pensar

        // Por enquanto, vamos fazer um "eco" para provar que a comunicação funcionou:
        const respostaIA = `Olá! Eu sou a API Node.js. Recebi sua mensagem: "${message}". Meus conectores para o Qdrant e Gemini estão prontos para serem ativados!`;

        // Devolve a resposta para a tela do Uberdesk
        res.json({ reply: respostaIA });

    } catch (error) {
        console.error("Erro no processamento:", error);
        res.status(500).json({ reply: "Ops, ocorreu um erro no cérebro da IA." });
    }
});

// Liga o servidor na porta 3000
const PORT = 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor da IA rodando perfeitamente na porta ${PORT}`);
    console.log(`📡 Aguardando conexão do Uberdesk...`);
});