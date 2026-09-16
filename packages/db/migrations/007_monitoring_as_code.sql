ALTER TABLE monitors ADD COLUMN code_project text;
ALTER TABLE monitors ADD COLUMN code_key text;
ALTER TABLE monitors ADD CONSTRAINT monitors_code_owner_pair CHECK ((code_project IS NULL) = (code_key IS NULL));
CREATE UNIQUE INDEX monitors_code_identity ON monitors(code_project, code_key) WHERE code_project IS NOT NULL;
