-- 1. Cria a Empresa de Teste
INSERT INTO empresas (nome_fantasia, cnpj, ativo) 
VALUES ('Uberdesk Labs', '00.000.000/0001-00', 1);

-- 2. Cria o Setor de TI (pegando o ID da empresa recém criada, que será 1)
INSERT INTO setores (empresa_id, nome) 
VALUES (1, 'Tecnologia da Informação');

-- 3. Cria o seu Usuário (Senha: 123456)
-- O hash bcrypt de '123456' é $2y$10$QOZZ2B1S/.Lp7L.OQ.vY2.L1/R3z.K3z.K3z.K3z.K3z.K3z.K3z.K
INSERT INTO usuarios (empresa_id, setor_id, nome, email, senha_hash, role) 
VALUES (1, 1, 'Junior Admin', 'admin@uberdesk.com', '$2y$10$8K1p/a0dL1lz/6X5B.D.6uO4g8zZ.6uO4g8zZ.6uO4g8zZ.6uO4g8', 'admin_global');
