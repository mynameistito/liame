//! Mail domain values shared by the native UI, store and protocol workers.
//! This crate deliberately has no GUI, network or operating-system dependencies.

use std::{fmt, num::NonZeroU32, num::NonZeroU64};

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IdentityError {
    EmptyAccount,
    InvalidMailbox,
    ZeroUidValidity,
    ZeroUid,
}

impl fmt::Display for IdentityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::EmptyAccount => "Account identifier must not be empty",
            Self::InvalidMailbox => {
                "Mailbox must not be empty or contain protocol control characters"
            }
            Self::ZeroUidValidity => "UIDVALIDITY must be nonzero",
            Self::ZeroUid => "Message UID must be nonzero",
        })
    }
}

impl std::error::Error for IdentityError {}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AccountId(String);

impl AccountId {
    pub fn new(value: impl Into<String>) -> Result<Self, IdentityError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(IdentityError::EmptyAccount);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A server mailbox name. Preserve spelling and separators; do not treat it as a path.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MailboxId(String);

impl MailboxId {
    pub fn new(value: impl Into<String>) -> Result<Self, IdentityError> {
        let value = value.into();
        if value.is_empty() || value.chars().any(|ch| matches!(ch, '\0' | '\r' | '\n')) {
            return Err(IdentityError::InvalidMailbox);
        }
        // IMAP reserves INBOX as case insensitive; other names retain their case.
        Ok(Self(if value.eq_ignore_ascii_case("INBOX") {
            "INBOX".into()
        } else {
            value
        }))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Identity of a message *within a particular generation* of a server mailbox.
/// Never use Message-ID, a conversation ID or UID alone as a cache key.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct MessageRef {
    pub account: AccountId,
    pub mailbox: MailboxId,
    pub uid_validity: NonZeroU64,
    pub uid: NonZeroU32,
}

impl MessageRef {
    pub fn new(
        account: AccountId,
        mailbox: MailboxId,
        uid_validity: u64,
        uid: u32,
    ) -> Result<Self, IdentityError> {
        Ok(Self {
            account,
            mailbox,
            uid_validity: NonZeroU64::new(uid_validity).ok_or(IdentityError::ZeroUidValidity)?,
            uid: NonZeroU32::new(uid).ok_or(IdentityError::ZeroUid)?,
        })
    }
}

/// SMTP acceptance is distinct from completion of Sent-folder bookkeeping.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DeliveryState {
    Queued,
    Sending,
    Accepted,
    Uncertain,
    Failed,
}

impl DeliveryState {
    /// A crash during submission cannot establish whether the server accepted it.
    pub fn after_restart(self) -> Self {
        match self {
            Self::Sending => Self::Uncertain,
            other => other,
        }
    }

    pub fn may_submit(self) -> bool {
        self == Self::Queued
    }
}
