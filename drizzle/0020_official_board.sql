-- A non-login principal preserves the existing ownership foreign keys without an email or credentials.
INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
VALUES ('00000000-0000-4000-8000-000000000001', 'StreamBullets system', '', 0, 0, 0);
--> statement-breakpoint
-- A conflicting handle fails the migration instead of taking over an existing page.
INSERT INTO streamers (id, owner_id, handle, name, about, is_official)
VALUES ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001',
  'streambullets', 'StreamBullets', '', 1);
--> statement-breakpoint
CREATE TRIGGER system_account_insert BEFORE INSERT ON account
WHEN NEW.user_id = '00000000-0000-4000-8000-000000000001'
BEGIN SELECT RAISE(ABORT, 'The system principal cannot sign in.'); END;
--> statement-breakpoint
CREATE TRIGGER system_account_update BEFORE UPDATE OF user_id ON account
WHEN NEW.user_id = '00000000-0000-4000-8000-000000000001'
BEGIN SELECT RAISE(ABORT, 'The system principal cannot sign in.'); END;
--> statement-breakpoint
CREATE TRIGGER system_session_insert BEFORE INSERT ON session
WHEN NEW.user_id = '00000000-0000-4000-8000-000000000001'
BEGIN SELECT RAISE(ABORT, 'The system principal cannot sign in.'); END;
--> statement-breakpoint
CREATE TRIGGER system_session_update BEFORE UPDATE OF user_id ON session
WHEN NEW.user_id = '00000000-0000-4000-8000-000000000001'
BEGIN SELECT RAISE(ABORT, 'The system principal cannot sign in.'); END;
--> statement-breakpoint
CREATE TRIGGER official_board_identity BEFORE UPDATE OF id, owner_id, handle, is_official ON streamers
WHEN OLD.id = '00000000-0000-4000-8000-000000000002'
AND (NEW.id <> OLD.id OR NEW.owner_id <> OLD.owner_id OR NEW.handle <> OLD.handle OR NEW.is_official <> 1)
BEGIN SELECT RAISE(ABORT, 'The official board identity cannot change.'); END;
