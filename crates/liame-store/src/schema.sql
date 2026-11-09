CREATE TABLE mailbox_state (
    account TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    uid_validity TEXT NOT NULL,
    PRIMARY KEY (account, mailbox)
) STRICT;

CREATE TABLE messages (
    id INTEGER PRIMARY KEY,
    account TEXT NOT NULL,
    mailbox TEXT NOT NULL,
    uid_validity TEXT NOT NULL,
    uid INTEGER NOT NULL CHECK (uid > 0 AND uid <= 4294967295),
    message_id TEXT,
    sender TEXT NOT NULL,
    subject TEXT NOT NULL,
    preview TEXT NOT NULL,
    date_ms INTEGER NOT NULL,
    seen INTEGER NOT NULL CHECK (seen IN (0, 1)),
    flagged INTEGER NOT NULL CHECK (flagged IN (0, 1)),
    UNIQUE (account, mailbox, uid),
    FOREIGN KEY (account, mailbox) REFERENCES mailbox_state(account, mailbox) ON DELETE CASCADE
) STRICT;
CREATE INDEX messages_by_date ON messages(account, mailbox, date_ms DESC, uid DESC);

CREATE TABLE bodies (
    message INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
    source BLOB NOT NULL
) STRICT;

CREATE VIRTUAL TABLE messages_fts USING fts5(sender, subject, preview, content='messages', content_rowid='id');
CREATE TRIGGER messages_insert AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, sender, subject, preview) VALUES (new.id, new.sender, new.subject, new.preview);
END;
CREATE TRIGGER messages_delete AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, sender, subject, preview) VALUES ('delete', old.id, old.sender, old.subject, old.preview);
END;
CREATE TRIGGER messages_update AFTER UPDATE OF sender, subject, preview ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, sender, subject, preview) VALUES ('delete', old.id, old.sender, old.subject, old.preview);
    INSERT INTO messages_fts(rowid, sender, subject, preview) VALUES (new.id, new.sender, new.subject, new.preview);
END;
