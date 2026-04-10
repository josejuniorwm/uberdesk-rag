-- 1. Desativa checagem de chaves para poder dropar sem erro
SET FOREIGN_KEY_CHECKS = 0;

-- 2. Limpa tudo o que existe (antigo e novo)
DROP TABLE IF EXISTS mensagens;
DROP TABLE IF EXISTS documentos;
DROP TABLE IF EXISTS projetos;
DROP TABLE IF EXISTS usuarios;
DROP TABLE IF EXISTS empresas;
DROP TABLE IF EXISTS setores;
DROP TABLE IF EXISTS pastas;

-- 3. Criação das Tabelas na Nova Arquitetura

CREATE TABLE empresas (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nome_fantasia VARCHAR(255) NOT NULL,
    cnpj VARCHAR(20),
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE usuarios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    nome VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL UNIQUE,
    senha_hash VARCHAR(255) NOT NULL,
    role ENUM('admin_global', 'admin_empresa', 'usuario') DEFAULT 'usuario',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

CREATE TABLE projetos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    nome VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE
);

CREATE TABLE documentos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    projeto_id INT NOT NULL,
    nome_arquivo VARCHAR(255) NOT NULL,
    caminho_storage VARCHAR(500) NOT NULL,
    status ENUM('pendente', 'indexado', 'erro_indexacao') DEFAULT 'pendente',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE
);

CREATE TABLE mensagens (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    user_id INT NOT NULL,
    sender ENUM('user', 'bot') NOT NULL,
    text TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES usuarios(id) ON DELETE CASCADE
);

-- 4. Reativa checagem de chaves
SET FOREIGN_KEY_CHECKS = 1;

-- 5. SEED DE DADOS PARA TESTE

-- Cria a Empresa
INSERT INTO empresas (nome_fantasia, cnpj, ativo) 
VALUES ('Uberdesk Labs', '00.000.000/0001-00', 1);

-- Cria o Usuário Admin da Empresa (Senha: 123456)
INSERT INTO usuarios (empresa_id, nome, email, senha_hash, role) 
VALUES (1, 'Junior Admin', 'admin@uberdesk.com', '$2y$10$8K1p/a0dL1lz/6X5B.D.6uO4g8zZ.6uO4g8zZ.6uO4g8zZ.6uO4g8', 'admin_empresa');
