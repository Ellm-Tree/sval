// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! A refusal as every host receives it: a stable code to branch on, the
//! check that refused an argument, and a message for people
//! (`docs/host-contract.md` §8).

use crate::tree::MoveError;
use crate::types::Error;

/// A failure as a host receives it: a stable `code` to branch on, for an
/// `invalid_argument` a `reason` saying which check refused, and a `message`
/// for people (`docs/host-contract.md` §8). Kept free of `JsValue` so the checks
/// that return it run under plain `cargo test`.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Failure {
    pub(crate) code: &'static str,
    pub(crate) reason: Option<Reason>,
    pub(crate) message: String,
}

impl Failure {
    /// A failure with a code of its own, which needs no reason.
    pub(crate) fn coded(code: &'static str, message: String) -> Self {
        Failure {
            code,
            reason: None,
            message,
        }
    }
}

/// Which check refused an argument no call could accept. A host and its tests
/// branch on [`Reason::as_str`], the `reason` property of the thrown error,
/// because the message may be reworded (`docs/host-contract.md` §8).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Reason {
    TimestampNotFinite,
    TimestampOutOfRange,
    BadNodeId,
    BadDeviceId,
    EmptyAgentLabel,
    BadColor,
    NotAWorkspace,
    BadShardName,
    EmptySettingKey,
    SettingNotJson,
    BadFavoriteKind,
    BadFavoriteGuid,
    BadSweep,
    BadArchivedTabs,
    BadBatch,
    VisitWithoutUrl,
    SharesNotOnASplit,
    SharesCountMismatch,
    ShareNotPositive,
    SharesNotHundred,
    LocalWithoutUrl,
    TtlNotFinite,
    ExpiryOutOfRange,
    PathsFilesMismatch,
    FileNotBytes,
    BadAutoArchiveChoice,
    NotATab,
    NotArchivable,
    AgentWorkspace,
    NotAnEntry,
    WrongIdCount,
    NoTokensRequested,
}

impl Reason {
    /// The name a host reads in the error's `reason` property.
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Reason::TimestampNotFinite => "timestamp_not_finite",
            Reason::TimestampOutOfRange => "timestamp_out_of_range",
            Reason::BadNodeId => "bad_node_id",
            Reason::BadDeviceId => "bad_device_id",
            Reason::EmptyAgentLabel => "empty_agent_label",
            Reason::BadColor => "bad_color",
            Reason::NotAWorkspace => "not_a_workspace",
            Reason::BadShardName => "bad_shard_name",
            Reason::EmptySettingKey => "empty_setting_key",
            Reason::SettingNotJson => "setting_not_json",
            Reason::BadFavoriteKind => "bad_favorite_kind",
            Reason::BadFavoriteGuid => "bad_favorite_guid",
            Reason::BadSweep => "bad_sweep",
            Reason::BadArchivedTabs => "bad_archived_tabs",
            Reason::BadBatch => "bad_batch",
            Reason::VisitWithoutUrl => "visit_without_url",
            Reason::SharesNotOnASplit => "shares_not_on_a_split",
            Reason::SharesCountMismatch => "shares_count_mismatch",
            Reason::ShareNotPositive => "share_not_positive",
            Reason::SharesNotHundred => "shares_not_hundred",
            Reason::LocalWithoutUrl => "local_without_url",
            Reason::TtlNotFinite => "ttl_not_finite",
            Reason::ExpiryOutOfRange => "expiry_out_of_range",
            Reason::PathsFilesMismatch => "paths_files_mismatch",
            Reason::FileNotBytes => "file_not_bytes",
            Reason::BadAutoArchiveChoice => "bad_auto_archive_choice",
            Reason::NotATab => "not_a_tab",
            Reason::NotArchivable => "not_archivable",
            Reason::AgentWorkspace => "agent_workspace",
            Reason::NotAnEntry => "not_an_entry",
            Reason::WrongIdCount => "wrong_id_count",
            Reason::NoTokensRequested => "no_tokens_requested",
        }
    }
}

/// An argument a check refused, with why. Every one reaches the host as
/// `invalid_argument`: the host passed something no call could accept.
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Invalid {
    pub(crate) reason: Reason,
    pub(crate) message: String,
}

impl Invalid {
    pub(crate) fn new(reason: Reason, message: impl Into<String>) -> Self {
        Invalid {
            reason,
            message: message.into(),
        }
    }
}

impl From<Invalid> for Failure {
    fn from(invalid: Invalid) -> Self {
        Failure {
            code: "invalid_argument",
            reason: Some(invalid.reason),
            message: invalid.message,
        }
    }
}

impl From<Error> for Failure {
    fn from(err: Error) -> Self {
        Failure::coded(err.code(), err.to_string())
    }
}

impl From<MoveError> for Failure {
    fn from(err: MoveError) -> Self {
        Failure::coded(err.code(), err.to_string())
    }
}

impl From<crate::archive::ArchiveError> for Failure {
    fn from(err: crate::archive::ArchiveError) -> Self {
        use crate::archive::ArchiveError as A;
        let reason = match err {
            A::BadChoice(_) => Reason::BadAutoArchiveChoice,
            A::NotATab(_) => Reason::NotATab,
            A::NotArchivable(_) => Reason::NotArchivable,
            A::NotAWorkspace(_) => Reason::NotAWorkspace,
            A::AgentWorkspace(_) => Reason::AgentWorkspace,
            A::NotAnEntry(_) => Reason::NotAnEntry,
            A::WrongIdCount { .. } => Reason::WrongIdCount,
            A::NoSuchNode(_) | A::NoWorkspace(_) | A::IdInUse(_) => {
                return Failure::coded(err.code(), err.to_string());
            }
        };
        Invalid::new(reason, err.to_string()).into()
    }
}

impl From<crate::privacy_pass::PrivacyPassError> for Failure {
    fn from(err: crate::privacy_pass::PrivacyPassError) -> Self {
        match err {
            crate::privacy_pass::PrivacyPassError::EmptyRequest => {
                Invalid::new(Reason::NoTokensRequested, err.to_string()).into()
            }
            _ => Failure::coded(err.code(), err.to_string()),
        }
    }
}

impl From<serde_json::Error> for Failure {
    fn from(err: serde_json::Error) -> Self {
        Error::from(err).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- typed reasons ------------------------------------------------

    /// A reason's name is its variant's, in snake case, so the names a host
    /// reads (`docs/host-contract.md` §8) follow from the enum.
    #[test]
    fn a_reason_is_named_for_its_variant() {
        use Reason::*;
        for reason in [
            TimestampNotFinite,
            TimestampOutOfRange,
            BadNodeId,
            BadDeviceId,
            EmptyAgentLabel,
            BadColor,
            NotAWorkspace,
            BadShardName,
            EmptySettingKey,
            SettingNotJson,
            BadFavoriteKind,
            BadFavoriteGuid,
            BadSweep,
            BadArchivedTabs,
            BadBatch,
            VisitWithoutUrl,
            SharesNotOnASplit,
            SharesCountMismatch,
            ShareNotPositive,
            SharesNotHundred,
            LocalWithoutUrl,
            TtlNotFinite,
            ExpiryOutOfRange,
            PathsFilesMismatch,
            FileNotBytes,
            BadAutoArchiveChoice,
            NotATab,
            NotArchivable,
            AgentWorkspace,
            NotAnEntry,
            WrongIdCount,
            NoTokensRequested,
        ] {
            let mut snake = String::new();
            for (i, c) in format!("{reason:?}").chars().enumerate() {
                if c.is_ascii_uppercase() && i > 0 {
                    snake.push('_');
                }
                snake.push(c.to_ascii_lowercase());
            }
            assert_eq!(reason.as_str(), snake);
        }
    }

    #[test]
    fn an_archive_refusal_of_an_argument_carries_its_reason() {
        use crate::archive::ArchiveError as A;
        let id = crate::types::test_support::test_id();
        for (err, reason) in [
            (A::BadChoice("1y".into()), Reason::BadAutoArchiveChoice),
            (A::NotATab(id), Reason::NotATab),
            (A::NotArchivable(id), Reason::NotArchivable),
            (A::NotAWorkspace(id), Reason::NotAWorkspace),
            (A::AgentWorkspace(id), Reason::AgentWorkspace),
            (A::NotAnEntry(id), Reason::NotAnEntry),
            (
                A::WrongIdCount {
                    needed: 2,
                    given: 1,
                },
                Reason::WrongIdCount,
            ),
        ] {
            let failure = Failure::from(err);
            assert_eq!(
                (failure.code, failure.reason),
                ("invalid_argument", Some(reason))
            );
        }
        for (err, code) in [
            (A::NoSuchNode(id), "no_such_node"),
            (A::NoWorkspace(id), "no_such_parent"),
            (A::IdInUse(id), "id_in_use"),
        ] {
            let failure = Failure::from(err);
            assert_eq!((failure.code, failure.reason), (code, None));
        }
    }

    #[test]
    fn a_token_request_for_no_tokens_carries_its_reason() {
        use crate::privacy_pass::PrivacyPassError as P;
        let failure = Failure::from(P::EmptyRequest);
        assert_eq!(
            (failure.code, failure.reason),
            ("invalid_argument", Some(Reason::NoTokensRequested))
        );
        let failure = Failure::from(P::InvalidState);
        assert_eq!((failure.code, failure.reason), ("invalid_state", None));
    }
}
