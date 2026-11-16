// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! The client half of Kagi's Privacy Pass (Kagi Privacy Pass spec): batched
//! tokens over the privately verifiable VOPRF on ristretto255, token type
//! `0xF91A`.
//!
//! Issuance is two calls with a network round trip between them, which the
//! host makes. [`token_request`] turns Kagi's `WWW-Authenticate` challenge
//! into the body of the issuance POST and an opaque client state.
//! [`finalize`] turns Kagi's answer and that state into tokens. The state
//! carries the challenge, the nonces and the blinding scalars, because the
//! library's own per-token state cannot be serialised, and the request is
//! rebuilt from them exactly. Nothing here touches the network, a clock or
//! storage; the randomness comes from the host (`crypto.getRandomValues` on
//! wasm).
//!
//! Every value crosses as text, in the encodings Kagi's issuer reads and
//! writes: the request body and the response are base64url (padded) over
//! their TLS serialisation, and so is each token, which is what
//! `Authorization: PrivateToken token="…"` carries.
//!
//! The state holds the blinding scalars, so it lets anyone who holds it
//! link the tokens to the issuance request. The host keeps it in memory for
//! the one round trip and drops it.

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE;
use privacypass::auth::authenticate::{Challenge, parse_www_authenticate_header};
use privacypass::batched_tokens_ristretto255::client::Client;
use privacypass::batched_tokens_ristretto255::server::deserialize_public_key;
use privacypass::batched_tokens_ristretto255::{Group, Ristretto255, TokenResponse};
use privacypass::{Nonce, TokenType};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use tls_codec::Serialize as _;

/// Why a Privacy Pass call failed. The message never carries a token, a
/// state or a key.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PrivacyPassError {
    /// The header is not exactly one usable `PrivateToken` challenge of the
    /// batched ristretto255 type.
    #[error("the Privacy Pass challenge is not one this client can use")]
    InvalidChallenge,
    /// The state is not one [`token_request`] produced.
    #[error("the Privacy Pass client state is not one this client produced")]
    InvalidState,
    /// The issuer's answer does not decode, or does not verify under the
    /// challenge's key.
    #[error("the Privacy Pass token response does not verify")]
    InvalidResponse,
    /// A count of zero, which no issuer answers.
    #[error("a Privacy Pass token request needs at least one token")]
    EmptyRequest,
    /// The host has no entropy source (`docs/host-contract.md` §2).
    #[error("no randomness is available for a Privacy Pass token request")]
    NoEntropy,
}

impl PrivacyPassError {
    /// The stable code a host branches on.
    #[must_use]
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidChallenge => "invalid_challenge",
            Self::InvalidState => "invalid_state",
            Self::InvalidResponse => "invalid_response",
            Self::EmptyRequest => "invalid_argument",
            Self::NoEntropy => "no_entropy",
        }
    }
}

/// What [`token_request`] produces.
#[derive(Debug)]
pub struct TokenRequest {
    /// The issuance POST body.
    pub body: String,
    /// The opaque client state [`finalize`] needs.
    pub state: String,
}

/// The client state between the two calls. Hex for the byte strings,
/// because this is JSON and only ever read back here.
#[derive(Serialize, Deserialize)]
struct State {
    challenge: String,
    nonces: Vec<String>,
    blinds: Vec<String>,
}

type Scalar = <Ristretto255 as Group>::Scalar;

/// The one batched ristretto255 challenge in `www_authenticate`, and a
/// client for its key.
fn challenge(www_authenticate: &str) -> Result<(Challenge, Client), PrivacyPassError> {
    let value = http::HeaderValue::from_str(www_authenticate)
        .map_err(|_| PrivacyPassError::InvalidChallenge)?;
    let mut challenges =
        parse_www_authenticate_header(&value).map_err(|_| PrivacyPassError::InvalidChallenge)?;
    if challenges.len() != 1 {
        return Err(PrivacyPassError::InvalidChallenge);
    }
    let challenge = challenges.remove(0);
    // A `TokenChallenge` serialises with its type first, as a big-endian u16.
    let serialized = challenge
        .token_challenge()
        .serialize()
        .map_err(|_| PrivacyPassError::InvalidChallenge)?;
    if serialized.get(..2) != Some(&(TokenType::BatchedTokenRistretto255 as u16).to_be_bytes()) {
        return Err(PrivacyPassError::InvalidChallenge);
    }
    let public_key = deserialize_public_key(challenge.token_key())
        .map_err(|_| PrivacyPassError::InvalidChallenge)?;
    Ok((challenge, Client::new(public_key)))
}

/// A request for `count` tokens under the challenge in `www_authenticate`,
/// the value of the `WWW-Authenticate` header Kagi's `/pp/wwwa` answers
/// with.
///
/// # Errors
/// [`PrivacyPassError::InvalidChallenge`] unless the header holds exactly one
/// batched ristretto255 challenge with a valid key, and
/// [`PrivacyPassError::EmptyRequest`] for a count of zero.
pub fn token_request(www_authenticate: &str, count: u16) -> Result<TokenRequest, PrivacyPassError> {
    if count == 0 {
        return Err(PrivacyPassError::EmptyRequest);
    }
    let (parsed, client) = challenge(www_authenticate)?;

    // The nonces are drawn with the fallible call, so a host without
    // entropy gets an error back. Once that has succeeded the source is
    // there, and the scalar draws below, which can only panic, do not fail.
    let nonces = (0..count)
        .map(|_| {
            let mut nonce = Nonce::default();
            OsRng
                .try_fill_bytes(&mut nonce)
                .map_err(|_| PrivacyPassError::NoEntropy)?;
            Ok(nonce)
        })
        .collect::<Result<Vec<Nonce>, _>>()?;
    let blinds: Vec<Scalar> = (0..count)
        .map(|_| Ristretto255::random_scalar(&mut OsRng))
        .collect();

    let state = State {
        challenge: www_authenticate.to_owned(),
        nonces: nonces.iter().map(|n| crate::hex::encode(n)).collect(),
        blinds: blinds
            .iter()
            .map(|b| crate::hex::encode(&Ristretto255::serialize_scalar(*b)))
            .collect(),
    };
    let (request, _) = client
        .issue_token_request_with_params(parsed.token_challenge(), nonces, blinds)
        .map_err(|_| PrivacyPassError::InvalidChallenge)?;
    let body = request
        .tls_serialize_detached()
        .map_err(|_| PrivacyPassError::InvalidChallenge)?;

    Ok(TokenRequest {
        body: URL_SAFE.encode(body),
        // Serialising a struct of strings cannot fail.
        state: serde_json::to_string(&state).map_err(|_| PrivacyPassError::InvalidState)?,
    })
}

/// The tokens in `response`, the body of Kagi's answer to the request
/// [`token_request`] made along with `state`, each as the base64url text
/// the `Authorization` header carries.
///
/// An issuer may answer for fewer tokens than were asked; the batch proof
/// then covers the first ones, and only those are returned.
///
/// # Errors
/// [`PrivacyPassError::InvalidState`] for a state [`token_request`] did not
/// produce, and [`PrivacyPassError::InvalidResponse`] for an answer that
/// does not decode, answers for more tokens than were asked, or does not
/// verify under the challenge's key.
pub fn finalize(state: &str, response: &str) -> Result<Vec<String>, PrivacyPassError> {
    let state: State = serde_json::from_str(state).map_err(|_| PrivacyPassError::InvalidState)?;
    let (parsed, client) =
        challenge(&state.challenge).map_err(|_| PrivacyPassError::InvalidState)?;
    if state.nonces.len() != state.blinds.len() || state.nonces.is_empty() {
        return Err(PrivacyPassError::InvalidState);
    }
    let nonces = state
        .nonces
        .iter()
        .map(|n| {
            crate::hex::decode(n)
                .and_then(|bytes| Nonce::try_from(bytes).ok())
                .ok_or(PrivacyPassError::InvalidState)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let blinds = state
        .blinds
        .iter()
        .map(|b| {
            crate::hex::decode(b)
                .and_then(|bytes| Ristretto255::deserialize_scalar(&bytes).ok())
                .ok_or(PrivacyPassError::InvalidState)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let bytes = URL_SAFE
        .decode(response.trim())
        .map_err(|_| PrivacyPassError::InvalidResponse)?;
    let answered = answered_count(&bytes)?;
    let token_response =
        TokenResponse::try_from_bytes(&bytes).map_err(|_| PrivacyPassError::InvalidResponse)?;

    let (_, mut token_states) = client
        .issue_token_request_with_params(parsed.token_challenge(), nonces, blinds)
        .map_err(|_| PrivacyPassError::InvalidState)?;
    if answered == 0 || answered > token_states.len() {
        return Err(PrivacyPassError::InvalidResponse);
    }
    token_states.truncate(answered);

    client
        .issue_tokens(&token_response, &token_states)
        .map_err(|_| PrivacyPassError::InvalidResponse)?
        .into_iter()
        .map(|token| {
            token
                .tls_serialize_detached()
                .map(|bytes| URL_SAFE.encode(bytes))
                .map_err(|_| PrivacyPassError::InvalidResponse)
        })
        .collect()
}

/// How many evaluated elements a TLS-serialised `TokenResponse` holds. The
/// library keeps that list private, so this reads its length prefix: a
/// `u16` byte length of 32-byte elements, ahead of the 64-byte proof.
fn answered_count(bytes: &[u8]) -> Result<usize, PrivacyPassError> {
    const ELEMENT: usize = privacypass::batched_tokens_ristretto255::NE;
    const PROOF: usize = 2 * privacypass::batched_tokens_ristretto255::NS;
    let prefix: [u8; 2] = bytes
        .get(..2)
        .and_then(|p| p.try_into().ok())
        .ok_or(PrivacyPassError::InvalidResponse)?;
    let length = usize::from(u16::from_be_bytes(prefix));
    if !length.is_multiple_of(ELEMENT) || bytes.len() != 2 + length + PROOF {
        return Err(PrivacyPassError::InvalidResponse);
    }
    Ok(length / ELEMENT)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use privacypass::NonceStore;
    use privacypass::auth::authenticate::{TokenChallenge, build_www_authenticate_header};
    use privacypass::batched_tokens_ristretto255::server::{
        BatchedKeyStore, RedeemTokenError, Server, serialize_public_key,
    };
    use privacypass::batched_tokens_ristretto255::{
        BatchedToken, TokenRequest as WireRequest, VoprfServer,
    };
    use privacypass::{TruncatedTokenKeyId, auth::authorize::Token};
    use std::collections::BTreeMap;
    use std::future::Future;
    use std::sync::Mutex;
    use std::task::{Context, Poll, Waker};
    use tls_codec::Deserialize as _;

    /// Runs a future that never waits: the stores below answer at once.
    fn ready<F: Future>(future: F) -> F::Output {
        let mut future = std::pin::pin!(future);
        match future
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
        {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("an in-memory store never waits"),
        }
    }

    #[derive(Default)]
    struct Keys(Mutex<BTreeMap<TruncatedTokenKeyId, VoprfServer<Ristretto255>>>);

    #[async_trait::async_trait]
    impl BatchedKeyStore for Keys {
        async fn insert(&self, id: TruncatedTokenKeyId, server: VoprfServer<Ristretto255>) {
            self.0.lock().unwrap().insert(id, server);
        }
        async fn get(&self, id: &TruncatedTokenKeyId) -> Option<VoprfServer<Ristretto255>> {
            self.0.lock().unwrap().get(id).cloned()
        }
    }

    #[derive(Default)]
    struct Spent(Mutex<Vec<Nonce>>);

    #[async_trait::async_trait]
    impl NonceStore for Spent {
        async fn exists(&self, nonce: &Nonce) -> bool {
            self.0.lock().unwrap().contains(nonce)
        }
        async fn insert(&self, nonce: Nonce) {
            self.0.lock().unwrap().push(nonce);
        }
    }

    /// An issuer: the library's own server, its key store, and the
    /// `WWW-Authenticate` value it would challenge with.
    pub(crate) struct Issuer {
        server: Server,
        keys: Keys,
        pub(crate) header: String,
    }

    impl Issuer {
        pub(crate) fn new(token_type: TokenType) -> Self {
            let server = Server::new();
            let keys = Keys::default();
            let public_key = ready(server.create_keypair(&keys)).unwrap();
            let challenge = TokenChallenge::new(token_type, "kagi.com", None, &[]);
            let (_, value) =
                build_www_authenticate_header(&challenge, &serialize_public_key(public_key), None)
                    .unwrap();
            Self {
                server,
                keys,
                header: value.to_str().unwrap().to_owned(),
            }
        }

        /// The issuer's answer to a request body, as Kagi sends it.
        pub(crate) fn answer(&self, body: &str) -> String {
            let bytes = URL_SAFE.decode(body).unwrap();
            let request = WireRequest::tls_deserialize_exact(bytes).unwrap();
            let response = ready(self.server.issue_token_response(&self.keys, request)).unwrap();
            URL_SAFE.encode(response.tls_serialize_detached().unwrap())
        }

        fn redeem(&self, spent: &Spent, token: &str) -> Result<(), RedeemTokenError> {
            let token: BatchedToken =
                Token::tls_deserialize_exact(URL_SAFE.decode(token).unwrap()).unwrap();
            ready(self.server.redeem_token(&self.keys, spent, token))
        }
    }

    #[test]
    fn issued_tokens_redeem_once_each() {
        let issuer = Issuer::new(TokenType::BatchedTokenRistretto255);
        let request = token_request(&issuer.header, 5).unwrap();
        let tokens = finalize(&request.state, &issuer.answer(&request.body)).unwrap();
        assert_eq!(tokens.len(), 5);

        let spent = Spent::default();
        for token in &tokens {
            assert_eq!(issuer.redeem(&spent, token), Ok(()));
        }
        assert_eq!(
            issuer.redeem(&spent, &tokens[0]),
            Err(RedeemTokenError::DoubleSpending)
        );
    }

    #[test]
    fn a_short_answer_yields_the_tokens_it_covers() {
        let issuer = Issuer::new(TokenType::BatchedTokenRistretto255);
        let request = token_request(&issuer.header, 4).unwrap();
        // The issuer answers a request for the first two tokens alone.
        let mut wire = WireRequest::tls_deserialize_exact(URL_SAFE.decode(&request.body).unwrap())
            .unwrap()
            .tls_serialize_detached()
            .unwrap();
        // token_type (2) + truncated key id (1) + u16 length + 32 bytes each.
        let length = u16::from_be_bytes([wire[3], wire[4]]);
        assert_eq!(length, 4 * 32);
        wire[3..5].copy_from_slice(&(2u16 * 32).to_be_bytes());
        wire.truncate(5 + 2 * 32);
        let tokens = finalize(&request.state, &issuer.answer(&URL_SAFE.encode(wire))).unwrap();
        assert_eq!(tokens.len(), 2);

        let spent = Spent::default();
        for token in &tokens {
            assert_eq!(issuer.redeem(&spent, token), Ok(()));
        }
    }

    #[test]
    fn an_answer_under_another_key_does_not_verify() {
        let issuer = Issuer::new(TokenType::BatchedTokenRistretto255);
        let other = Issuer::new(TokenType::BatchedTokenRistretto255);
        let request = token_request(&issuer.header, 3).unwrap();
        let other_request = token_request(&other.header, 3).unwrap();
        assert_eq!(
            finalize(&request.state, &other.answer(&other_request.body)),
            Err(PrivacyPassError::InvalidResponse)
        );
    }

    #[test]
    fn a_challenge_must_be_one_batched_ristretto255_challenge() {
        let issuer = Issuer::new(TokenType::BatchedTokenRistretto255);
        let twice = format!("{}, {}", issuer.header, issuer.header);
        let private = Issuer::new(TokenType::PrivateToken);
        for header in [
            "",
            "Basic realm=\"kagi\"",
            twice.as_str(),
            private.header.as_str(),
        ] {
            assert_eq!(
                token_request(header, 1).unwrap_err(),
                PrivacyPassError::InvalidChallenge,
                "{header:?}"
            );
        }
        assert_eq!(
            token_request(&issuer.header, 0).unwrap_err(),
            PrivacyPassError::EmptyRequest
        );
    }

    #[test]
    fn a_damaged_state_or_answer_is_refused() {
        let issuer = Issuer::new(TokenType::BatchedTokenRistretto255);
        let request = token_request(&issuer.header, 2).unwrap();
        let answer = issuer.answer(&request.body);

        for state in ["", "{}", "{\"challenge\":\"\",\"nonces\":[],\"blinds\":[]}"] {
            assert_eq!(
                finalize(state, &answer),
                Err(PrivacyPassError::InvalidState),
                "{state:?}"
            );
        }
        let mut state: State = serde_json::from_str(&request.state).unwrap();
        state.blinds.pop();
        assert_eq!(
            finalize(&serde_json::to_string(&state).unwrap(), &answer),
            Err(PrivacyPassError::InvalidState)
        );

        let mut bytes = URL_SAFE.decode(&answer).unwrap();
        bytes.pop();
        for answer in ["", "not base64!", URL_SAFE.encode(&bytes).as_str()] {
            assert_eq!(
                finalize(&request.state, answer),
                Err(PrivacyPassError::InvalidResponse),
                "{answer:?}"
            );
        }
    }

    #[test]
    fn an_answer_of_no_tokens_more_tokens_or_extra_bytes_is_refused() {
        let issuer = Issuer::new(TokenType::BatchedTokenRistretto255);
        let request = token_request(&issuer.header, 2).unwrap();
        let answer = URL_SAFE.decode(issuer.answer(&request.body)).unwrap();

        // A zero length prefix, then the proof.
        let mut empty = vec![0u8, 0];
        empty.extend_from_slice(&answer[answer.len() - 64..]);
        let mut longer = answer.clone();
        longer.push(0);
        let more = token_request(&issuer.header, 3).unwrap();
        let three = URL_SAFE.decode(issuer.answer(&more.body)).unwrap();

        for bytes in [empty, longer, three] {
            assert_eq!(
                finalize(&request.state, &URL_SAFE.encode(&bytes)),
                Err(PrivacyPassError::InvalidResponse),
                "{} bytes",
                bytes.len()
            );
        }
    }

    #[test]
    fn each_failure_has_its_host_code() {
        let codes = [
            PrivacyPassError::InvalidChallenge,
            PrivacyPassError::InvalidState,
            PrivacyPassError::InvalidResponse,
            PrivacyPassError::EmptyRequest,
            PrivacyPassError::NoEntropy,
        ]
        .map(|e| e.code());
        assert_eq!(
            codes,
            [
                "invalid_challenge",
                "invalid_state",
                "invalid_response",
                "invalid_argument",
                "no_entropy"
            ]
        );
    }
}
