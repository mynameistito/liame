//! Local mail cache. Run on a storage worker, never in a GPUI render callback.
//! The connection owns transactions and is not shared between account workers.

use liame_core::{AccountId, IdentityError, MailboxId, MessageRef};
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior, params};
use std::{fmt, num::NonZeroU64, path::Path, time::Duration};

const SCHEMA_VERSION: i64 = 1;
const MESSAGE_COLUMNS: &str = "account, mailbox, uid_validity, uid, message_id, sender, subject, preview, date_ms, seen, flagged";

#[derive(Debug)]
pub enum StoreError {
    Database(rusqlite::Error),
    Identity(IdentityError),
    NewerSchema(i64),
    UnversionedDatabase,
    StaleMailbox,
    MissingMessage,
    InvalidPageSize,
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Database(_) => f.write_str("Local mail database operation failed"),
            Self::Identity(error) => error.fmt(f),
            Self::NewerSchema(version) => write!(
                f,
                "Mail cache schema {version} requires a newer application"
            ),
            Self::UnversionedDatabase => {
                f.write_str("Refusing to initialize a nonempty unversioned database")
            }
            Self::StaleMailbox => {
                f.write_str("Mailbox generation changed; refresh before retrying")
            }
            Self::MissingMessage => f.write_str("Message is not cached"),
            Self::InvalidPageSize => f.write_str("Page size must be between 1 and 500"),
        }
    }
}

impl std::error::Error for StoreError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Database(error) => Some(error),
            Self::Identity(error) => Some(error),
            _ => None,
        }
    }
}
impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Database(error)
    }
}
impl From<IdentityError> for StoreError {
    fn from(error: IdentityError) -> Self {
        Self::Identity(error)
    }
}

pub type Result<T> = std::result::Result<T, StoreError>;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CachedMessage {
    pub reference: MessageRef,
    pub message_id: Option<String>,
    pub sender: String,
    pub subject: String,
    pub preview: String,
    pub date_ms: i64,
    pub seen: bool,
    pub flagged: bool,
}

pub struct Store {
    connection: Connection,
}

impl Store {
    /// Opens a dedicated native cache. Never pass the legacy Electron mail.db.
    /// The caller must provide a private application-data directory.
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Self::initialize(connection)
    }

    pub fn in_memory() -> Result<Self> {
        Self::initialize(Connection::open_in_memory()?)
    }

    fn initialize(mut connection: Connection) -> Result<Self> {
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "foreign_keys", true)?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version: i64 =
            transaction.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(StoreError::NewerSchema(version));
        }
        if version == 0 {
            let tables: i64 = transaction.query_row(
                "SELECT count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'",
                [],
                |row| row.get(0),
            )?;
            if tables != 0 {
                return Err(StoreError::UnversionedDatabase);
            }
            transaction.execute_batch(include_str!("schema.sql"))?;
            transaction.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        transaction.commit()?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "NORMAL")?;
        Ok(Self { connection })
    }

    /// Called after SELECT confirms the current server UIDVALIDITY. A reset
    /// invalidates summaries, raw MIME and search entries in a single transaction.
    pub fn select_mailbox(
        &mut self,
        account: &AccountId,
        mailbox: &MailboxId,
        validity: NonZeroU64,
    ) -> Result<bool> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous: Option<String> = transaction
            .query_row(
                "SELECT uid_validity FROM mailbox_state WHERE account=?1 AND mailbox=?2",
                params![account.as_str(), mailbox.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let validity = validity.to_string();
        let reset = previous.as_ref().is_some_and(|value| value != &validity);
        if reset {
            transaction.execute(
                "DELETE FROM mailbox_state WHERE account=?1 AND mailbox=?2",
                params![account.as_str(), mailbox.as_str()],
            )?;
        }
        transaction.execute("INSERT INTO mailbox_state(account, mailbox, uid_validity) VALUES (?1,?2,?3) ON CONFLICT(account,mailbox) DO NOTHING",
            params![account.as_str(), mailbox.as_str(), validity])?;
        transaction.commit()?;
        Ok(reset)
    }

    /// Rejects an entire stale batch before writing any part of it.
    pub fn upsert_messages(&mut self, messages: &[CachedMessage]) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for message in messages {
            ensure_current(&transaction, &message.reference)?;
            // Changed content for a reused identity must not retain an old MIME body.
            transaction.execute("DELETE FROM bodies WHERE message IN (SELECT id FROM messages WHERE account=?1 AND mailbox=?2 AND uid=?3 AND message_id IS NOT ?4)",
                params![message.reference.account.as_str(), message.reference.mailbox.as_str(), message.reference.uid.get(), message.message_id])?;
            transaction.execute(
                "INSERT INTO messages(account,mailbox,uid_validity,uid,message_id,sender,subject,preview,date_ms,seen,flagged)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                 ON CONFLICT(account,mailbox,uid) DO UPDATE SET message_id=excluded.message_id,
                 sender=excluded.sender,subject=excluded.subject,preview=excluded.preview,date_ms=excluded.date_ms,seen=excluded.seen,flagged=excluded.flagged",
                params![message.reference.account.as_str(), message.reference.mailbox.as_str(), message.reference.uid_validity.to_string(), message.reference.uid.get(),
                    message.message_id, message.sender, message.subject, message.preview, message.date_ms, message.seen, message.flagged])?;
        }
        transaction.commit()?;
        Ok(())
    }

    pub fn list_messages(
        &self,
        account: &AccountId,
        mailbox: &MailboxId,
        offset: u32,
        limit: u32,
    ) -> Result<Vec<CachedMessage>> {
        check_limit(limit)?;
        let mut statement = self.connection.prepare(&format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE account=?1 AND mailbox=?2 ORDER BY date_ms DESC, uid DESC LIMIT ?3 OFFSET ?4"))?;
        statement
            .query_map(
                params![account.as_str(), mailbox.as_str(), limit, offset],
                decode_message,
            )?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    /// Literal phrase search; user text is never interpreted as FTS operators.
    pub fn search(
        &self,
        account: &AccountId,
        query: &str,
        limit: u32,
    ) -> Result<Vec<CachedMessage>> {
        check_limit(limit)?;
        if query.trim().is_empty() {
            return Ok(Vec::new());
        }
        let phrase = format!("\"{}\"", query.replace('"', "\"\""));
        let mut statement = self.connection.prepare(&format!("SELECT {MESSAGE_COLUMNS} FROM messages WHERE account=?1 AND id IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?2) ORDER BY date_ms DESC, mailbox, uid DESC LIMIT ?3"))?;
        statement
            .query_map(params![account.as_str(), phrase, limit], decode_message)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }

    pub fn save_body(&mut self, reference: &MessageRef, source: &[u8]) -> Result<()> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        ensure_current(&transaction, reference)?;
        let id = message_id(&transaction, reference)?.ok_or(StoreError::MissingMessage)?;
        transaction.execute("INSERT INTO bodies(message,source) VALUES (?1,?2) ON CONFLICT(message) DO UPDATE SET source=excluded.source", params![id,source])?;
        transaction.commit()?;
        Ok(())
    }

    pub fn body(&self, reference: &MessageRef) -> Result<Option<Vec<u8>>> {
        ensure_current(&self.connection, reference)?;
        // Resolve identity and body in one snapshot. A concurrent mailbox reset
        // may reuse an integer row ID; looking it up separately can return the
        // replacement message's body.
        Ok(self
            .connection
            .query_row(
                "SELECT bodies.source FROM bodies JOIN messages ON messages.id=bodies.message
             WHERE account=?1 AND mailbox=?2 AND uid_validity=?3 AND uid=?4",
                params![
                    reference.account.as_str(),
                    reference.mailbox.as_str(),
                    reference.uid_validity.to_string(),
                    reference.uid.get()
                ],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn remove_account(&mut self, account: &AccountId) -> Result<()> {
        self.connection.execute(
            "DELETE FROM mailbox_state WHERE account=?1",
            [account.as_str()],
        )?;
        Ok(())
    }
}

fn check_limit(limit: u32) -> Result<()> {
    if !(1..=500).contains(&limit) {
        return Err(StoreError::InvalidPageSize);
    }
    Ok(())
}

fn ensure_current(connection: &Connection, reference: &MessageRef) -> Result<()> {
    let valid: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM mailbox_state WHERE account=?1 AND mailbox=?2 AND uid_validity=?3)",
        params![reference.account.as_str(), reference.mailbox.as_str(), reference.uid_validity.to_string()], |row| row.get(0))?;
    if !valid {
        return Err(StoreError::StaleMailbox);
    }
    Ok(())
}

fn message_id(connection: &Connection, reference: &MessageRef) -> Result<Option<i64>> {
    Ok(connection.query_row("SELECT id FROM messages WHERE account=?1 AND mailbox=?2 AND uid_validity=?3 AND uid=?4",
        params![reference.account.as_str(), reference.mailbox.as_str(), reference.uid_validity.to_string(), reference.uid.get()], |row| row.get(0)).optional()?)
}

fn decode_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<CachedMessage> {
    let identity =
        || -> std::result::Result<MessageRef, Box<dyn std::error::Error + Send + Sync>> {
            Ok(MessageRef::new(
                AccountId::new(row.get::<_, String>(0)?)?,
                MailboxId::new(row.get::<_, String>(1)?)?,
                row.get::<_, String>(2)?.parse()?,
                row.get(3)?,
            )?)
        };
    let reference = identity().map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, error)
    })?;
    Ok(CachedMessage {
        reference,
        message_id: row.get(4)?,
        sender: row.get(5)?,
        subject: row.get(6)?,
        preview: row.get(7)?,
        date_ms: row.get(8)?,
        seen: row.get(9)?,
        flagged: row.get(10)?,
    })
}
