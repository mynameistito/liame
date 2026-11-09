use liame_core::{AccountId, MailboxId, MessageRef};
use liame_store::{CachedMessage, Store, StoreError};
use std::num::NonZeroU64;

fn account(value: &str) -> AccountId {
    AccountId::new(value).unwrap()
}
fn inbox() -> MailboxId {
    MailboxId::new("INBOX").unwrap()
}
fn message(account_name: &str, uid: u32, generation: u64) -> CachedMessage {
    CachedMessage {
        reference: MessageRef::new(account(account_name), inbox(), generation, uid).unwrap(),
        message_id: Some(format!("<{uid}@example.invalid>")),
        sender: "Synthetic Sender <sender@example.invalid>".into(),
        subject: format!("Travel itinerary {uid}"),
        preview: "Train departure at noon".into(),
        date_ms: 1_700_000_000_000,
        seen: false,
        flagged: false,
    }
}
fn select(store: &mut Store, name: &str, generation: u64) {
    store
        .select_mailbox(
            &account(name),
            &inbox(),
            NonZeroU64::new(generation).unwrap(),
        )
        .unwrap();
}

#[test]
fn offline_mail_and_raw_mime_survive_reopen_with_stable_tied_date_pages() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("native-mail.db");
    let first = message("a", 1, 11);
    {
        let mut store = Store::open(&path).unwrap();
        select(&mut store, "a", 11);
        store
            .upsert_messages(&[first.clone(), message("a", 3, 11), message("a", 2, 11)])
            .unwrap();
        store
            .save_body(&first.reference, b"Subject: synthetic\r\n\r\nHello")
            .unwrap();
    }
    let store = Store::open(path).unwrap();
    let uids = |offset, limit| {
        store
            .list_messages(&account("a"), &inbox(), offset, limit)
            .unwrap()
            .iter()
            .map(|m| m.reference.uid.get())
            .collect::<Vec<_>>()
    };
    assert_eq!(uids(0, 2), [3, 2]);
    assert_eq!(uids(2, 2), [1]);
    assert_eq!(
        store.body(&first.reference).unwrap().unwrap(),
        b"Subject: synthetic\r\n\r\nHello"
    );
    assert_eq!(
        store.search(&account("a"), "itinerary", 20).unwrap().len(),
        3
    );
}

#[test]
fn generation_reset_removes_bodies_and_search_results_before_reusing_a_uid() {
    let mut store = Store::in_memory().unwrap();
    select(&mut store, "a", 11);
    let old = message("a", 7, 11);
    store.upsert_messages(std::slice::from_ref(&old)).unwrap();
    store.save_body(&old.reference, b"old body").unwrap();
    assert!(
        !store
            .select_mailbox(&account("a"), &inbox(), NonZeroU64::new(11).unwrap())
            .unwrap()
    );
    assert!(
        store
            .select_mailbox(&account("a"), &inbox(), NonZeroU64::new(12).unwrap())
            .unwrap()
    );
    assert!(matches!(
        store.body(&old.reference),
        Err(StoreError::StaleMailbox)
    ));
    assert!(matches!(
        store.save_body(&old.reference, b"late old fetch"),
        Err(StoreError::StaleMailbox)
    ));
    assert!(
        store
            .search(&account("a"), "itinerary", 20)
            .unwrap()
            .is_empty()
    );
    let mut new = message("a", 7, 12);
    new.subject = "Replacement message".into();
    store.upsert_messages(std::slice::from_ref(&new)).unwrap();
    assert_eq!(store.body(&new.reference).unwrap(), None);
    assert_eq!(
        store.list_messages(&account("a"), &inbox(), 0, 20).unwrap(),
        [new]
    );
}

#[test]
fn a_stale_batch_rolls_back_earlier_rows_and_search_updates() {
    let mut store = Store::in_memory().unwrap();
    select(&mut store, "a", 12);
    assert!(matches!(
        store.upsert_messages(&[message("a", 1, 12), message("a", 2, 11)]),
        Err(StoreError::StaleMailbox)
    ));
    assert!(
        store
            .list_messages(&account("a"), &inbox(), 0, 20)
            .unwrap()
            .is_empty()
    );
    assert!(
        store
            .search(&account("a"), "itinerary", 20)
            .unwrap()
            .is_empty()
    );
}

#[test]
fn account_removal_cascades_cache_and_fts_without_affecting_other_accounts() {
    let mut store = Store::in_memory().unwrap();
    select(&mut store, "a", 1);
    select(&mut store, "b", 1);
    let a = message("a", 1, 1);
    let b = message("b", 1, 1);
    store.upsert_messages(&[a.clone(), b.clone()]).unwrap();
    store.save_body(&a.reference, b"a").unwrap();
    store.save_body(&b.reference, b"b").unwrap();
    store.remove_account(&account("a")).unwrap();
    assert!(
        store
            .search(&account("a"), "itinerary", 20)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.search(&account("b"), "itinerary", 20).unwrap(),
        std::slice::from_ref(&b)
    );
    assert_eq!(store.body(&b.reference).unwrap(), Some(b"b".to_vec()));
    select(&mut store, "a", 1);
    assert_eq!(store.body(&a.reference).unwrap(), None);
}

#[test]
fn updates_keep_search_current_and_discard_body_when_message_id_changes() {
    let mut store = Store::in_memory().unwrap();
    select(&mut store, "a", 1);
    let mut value = message("a", 1, 1);
    store.upsert_messages(std::slice::from_ref(&value)).unwrap();
    store.save_body(&value.reference, b"body").unwrap();
    value.subject = "Concert invitation".into();
    value.seen = true;
    store.upsert_messages(std::slice::from_ref(&value)).unwrap();
    assert!(
        store
            .search(&account("a"), "itinerary", 20)
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        store.search(&account("a"), "concert", 20).unwrap(),
        [value.clone()]
    );
    assert_eq!(
        store.body(&value.reference).unwrap(),
        Some(b"body".to_vec())
    );
    value.message_id = Some("<different@example.invalid>".into());
    store.upsert_messages(std::slice::from_ref(&value)).unwrap();
    assert_eq!(store.body(&value.reference).unwrap(), None);
}

#[test]
fn user_search_text_cannot_inject_fts_syntax_or_escape_account_scope() {
    let mut store = Store::in_memory().unwrap();
    select(&mut store, "a", 1);
    store.upsert_messages(&[message("a", 1, 1)]).unwrap();
    for query in [
        "",
        "  ",
        "\" OR sender:*",
        "itinerary OR secret",
        "' UNION SELECT * --",
    ] {
        assert!(store.search(&account("a"), query, 20).unwrap().is_empty());
    }
    assert!(matches!(
        store.list_messages(&account("a"), &inbox(), 0, 501),
        Err(StoreError::InvalidPageSize)
    ));
}

#[test]
fn newer_and_legacy_databases_are_rejected_without_overwriting_them() {
    let directory = tempfile::tempdir().unwrap();
    let newer = directory.path().join("newer.db");
    {
        let connection = rusqlite::Connection::open(&newer).unwrap();
        connection.pragma_update(None, "user_version", 99).unwrap();
    }
    assert!(matches!(
        Store::open(&newer),
        Err(StoreError::NewerSchema(99))
    ));
    let legacy = directory.path().join("legacy.db");
    {
        let connection = rusqlite::Connection::open(&legacy).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE legacy(value TEXT); INSERT INTO legacy VALUES ('keep me');",
            )
            .unwrap();
    }
    assert!(matches!(
        Store::open(&legacy),
        Err(StoreError::UnversionedDatabase)
    ));
    let connection = rusqlite::Connection::open(legacy).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT value FROM legacy", [], |row| row
                .get::<_, String>(0))
            .unwrap(),
        "keep me"
    );
    assert_eq!(
        connection
            .pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
}
