-- Script SQL para migrar o banco de dados da arquitetura antiga (setores/escopos) para a nova (empresa/projeto)
-- Execute estes comandos em sequência no MySQL para o banco 'dashbyte_chat'

-- Desabilitar verificação de FKs temporariamente
SET FOREIGN_KEY_CHECKS = 0;

-- 1. Remover tabela setores
DROP TABLE IF EXISTS setores;

-- 2. Remover coluna setor_id da tabela usuarios
ALTER TABLE usuarios DROP COLUMN setor_id;

-- 3. Renomear tabela pastas para projetos
RENAME TABLE pastas TO projetos;

-- 4. Remover colunas desnecessárias da tabela projetos
ALTER TABLE projetos DROP COLUMN setor_id;
ALTER TABLE projetos DROP COLUMN usuario_id;
ALTER TABLE projetos DROP COLUMN escopo;

-- 5. Renomear coluna pasta_id para projeto_id na tabela documentos
ALTER TABLE documentos CHANGE COLUMN pasta_id projeto_id INT NOT NULL;

-- Reabilitar verificação de FKs
SET FOREIGN_KEY_CHECKS = 1;

-- 6. Recriar foreign key constraints necessárias
ALTER TABLE projetos ADD CONSTRAINT fk_projetos_empresa FOREIGN KEY (empresa_id) REFERENCES empresas(id) ON DELETE CASCADE;
ALTER TABLE documentos ADD CONSTRAINT fk_documentos_projeto FOREIGN KEY (projeto_id) REFERENCES projetos(id) ON DELETE CASCADE;

-- 7. Limpar dados órfãos
DELETE FROM documentos WHERE projeto_id NOT IN (SELECT id FROM projetos);
DELETE FROM projetos WHERE empresa_id NOT IN (SELECT id FROM empresas);