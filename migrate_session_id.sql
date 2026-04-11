-- Migração: padronizar vínculo de sessão na tabela messages para session_id
-- Objetivo: substituir qualquer uso legado de sessao_id por session_id

SET @db_name = DATABASE();

-- 1) Renomeia sessao_id -> session_id quando necessário
SELECT COUNT(*) INTO @has_sessao_id
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'messages'
  AND COLUMN_NAME = 'sessao_id';

SELECT COUNT(*) INTO @has_session_id
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'messages'
  AND COLUMN_NAME = 'session_id';

SET @sql_rename = IF(
  @has_sessao_id > 0 AND @has_session_id = 0,
  'ALTER TABLE messages CHANGE COLUMN sessao_id session_id INT NULL',
  'SELECT "[migrate_session_id] rename skipped"'
);
PREPARE stmt FROM @sql_rename;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2) Garante índice em session_id
SELECT COUNT(*) INTO @has_session_id_after
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'messages'
  AND COLUMN_NAME = 'session_id';

SELECT COUNT(*) INTO @has_idx_session_id
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'messages'
  AND INDEX_NAME = 'idx_messages_session_id';

SET @sql_index = IF(
  @has_session_id_after > 0 AND @has_idx_session_id = 0,
  'ALTER TABLE messages ADD INDEX idx_messages_session_id (session_id)',
  'SELECT "[migrate_session_id] index skipped"'
);
PREPARE stmt FROM @sql_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3) Garante FK messages.session_id -> sessoes_chat.id
SELECT COUNT(*) INTO @has_sessoes_chat
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'sessoes_chat';

SELECT COUNT(*) INTO @has_fk_session
FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'messages'
  AND COLUMN_NAME = 'session_id'
  AND REFERENCED_TABLE_NAME = 'sessoes_chat'
  AND REFERENCED_COLUMN_NAME = 'id';

SET @sql_fk = IF(
  @has_session_id_after > 0 AND @has_sessoes_chat > 0 AND @has_fk_session = 0,
  'ALTER TABLE messages ADD CONSTRAINT fk_messages_session_id FOREIGN KEY (session_id) REFERENCES sessoes_chat(id) ON DELETE SET NULL',
  'SELECT "[migrate_session_id] fk skipped"'
);
PREPARE stmt FROM @sql_fk;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 4) Resultado final para auditoria rápida
SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = @db_name
  AND TABLE_NAME = 'messages'
  AND COLUMN_NAME IN ('session_id', 'sessao_id');
