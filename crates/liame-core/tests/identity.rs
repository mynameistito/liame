use liame_core::{AccountId, DeliveryState, IdentityError, MailboxId, MessageRef};
use std::collections::HashSet;

fn message(account: &str, mailbox: &str, generation: u64) -> MessageRef {
    MessageRef::new(
        AccountId::new(account).unwrap(),
        MailboxId::new(mailbox).unwrap(),
        generation,
        7,
    )
    .unwrap()
}

#[test]
fn reused_uids_are_isolated_by_account_folder_and_generation() {
    let messages = HashSet::from([
        message("a", "INBOX", 1),
        message("b", "INBOX", 1),
        message("a", "Sent", 1),
        message("a", "INBOX", 2),
    ]);
    assert_eq!(messages.len(), 4);
    assert!(messages.contains(&message("a", "inbox", 1)));
}

#[test]
fn mailbox_names_preserve_unicode_separators_and_case_except_inbox() {
    assert_eq!(MailboxId::new("inbox"), MailboxId::new("INBOX"));
    assert_ne!(MailboxId::new("Sent"), MailboxId::new("sent"));
    assert_eq!(
        MailboxId::new("旅行/My Folder").unwrap().as_str(),
        "旅行/My Folder"
    );
    for invalid in ["", "INBOX\r\nLOGOUT", "bad\0name"] {
        assert_eq!(MailboxId::new(invalid), Err(IdentityError::InvalidMailbox));
    }
}

#[test]
fn zero_protocol_identifiers_and_empty_accounts_are_rejected() {
    assert_eq!(AccountId::new("  "), Err(IdentityError::EmptyAccount));
    let account = AccountId::new("a").unwrap();
    let mailbox = MailboxId::new("INBOX").unwrap();
    assert_eq!(
        MessageRef::new(account.clone(), mailbox.clone(), 0, 1),
        Err(IdentityError::ZeroUidValidity)
    );
    assert_eq!(
        MessageRef::new(account, mailbox, 1, 0),
        Err(IdentityError::ZeroUid)
    );
}

#[test]
fn restart_never_blindly_resubmits_an_ambiguous_or_accepted_delivery() {
    assert_eq!(
        DeliveryState::Sending.after_restart(),
        DeliveryState::Uncertain
    );
    for state in [
        DeliveryState::Sending,
        DeliveryState::Accepted,
        DeliveryState::Uncertain,
        DeliveryState::Failed,
    ] {
        assert!(!state.after_restart().may_submit());
    }
    assert!(DeliveryState::Queued.after_restart().may_submit());
}
