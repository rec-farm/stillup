ALTER TABLE runs ADD COLUMN assertions jsonb NOT NULL DEFAULT '[]'::jsonb;
