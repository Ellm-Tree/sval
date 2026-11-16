// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

//! Page rules (element hiding and scriptlets) from the same engines that
//! block requests: a document's rules from every engine that blocks in its
//! window's kind, merged into the one answer the content classifier service
//! keeps for the address, the generic selectors for a page's class and id
//! names, and the scriptlet library every engine shares.

use std::collections::HashSet;
use std::sync::Arc;

use adblock::resources::{InMemoryResourceStorage, Resource, ResourceImpl, ResourceStorageBackend};
use nserror::{nsresult, NS_ERROR_INVALID_ARG, NS_OK};
use nsstring::{nsACString, nsCString};
use thin_vec::ThinVec;

use crate::ContentClassifierFFIEngine;

/// Appends each of `values` that `merged` does not hold yet, so an entry two
/// engines both give appears once, where the first engine put it.
fn union(merged: &mut ThinVec<nsCString>, values: HashSet<String>) {
    let fresh: Vec<String> = {
        let held: HashSet<&[u8]> = merged.iter().map(|v| &v[..]).collect();
        values
            .into_iter()
            .filter(|v| !held.contains(v.as_bytes()))
            .collect()
    };
    merged.extend(fresh.into_iter().map(nsCString::from));
}

/// Adds `engine`'s page rules for `url`, adblock-rust's
/// `UrlSpecificResources`, after those of the engines asked before it:
/// hiding selectors, procedural actions (each JSON-encoded, as adblock-rust
/// gives them) and exceptions join their lists once each, scriptlet code is
/// appended, and `generichide` holds when any engine sets it.
#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_add_page_rules(
    engine: *const ContentClassifierFFIEngine,
    url: &nsACString,
    selectors: *mut ThinVec<nsCString>,
    procedural_actions: *mut ThinVec<nsCString>,
    exceptions: *mut ThinVec<nsCString>,
    script: *mut nsCString,
    generichide: *mut bool,
) -> nsresult {
    if engine.is_null()
        || selectors.is_null()
        || procedural_actions.is_null()
        || exceptions.is_null()
        || script.is_null()
        || generichide.is_null()
    {
        return NS_ERROR_INVALID_ARG;
    }
    let resources = (*engine)
        .engine
        .url_cosmetic_resources(&String::from_utf8_lossy(url.as_ref()));
    union(&mut *selectors, resources.hide_selectors);
    union(&mut *procedural_actions, resources.procedural_actions);
    union(&mut *exceptions, resources.exceptions);
    (*script).append(&resources.injected_script);
    *generichide |= resources.generichide;
    NS_OK
}

fn to_strings(values: &ThinVec<nsCString>) -> Vec<String> {
    values
        .iter()
        .map(|v| String::from_utf8_lossy(v.as_ref()).into_owned())
        .collect()
}

/// The generic hiding selectors for class and id names seen on a page,
/// leaving out `exceptions` from the page's `UrlSpecificResources`.
#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_hidden_class_id_selectors(
    engine: *const ContentClassifierFFIEngine,
    classes: &ThinVec<nsCString>,
    ids: &ThinVec<nsCString>,
    exceptions: &ThinVec<nsCString>,
    out_selectors: *mut ThinVec<nsCString>,
) -> nsresult {
    if engine.is_null() || out_selectors.is_null() {
        return NS_ERROR_INVALID_ARG;
    }
    let engine = &(*engine).engine;
    let exceptions: HashSet<String> = to_strings(exceptions).into_iter().collect();
    let selectors =
        engine.hidden_class_id_selectors(to_strings(classes), to_strings(ids), &exceptions);
    let out = &mut *out_selectors;
    for selector in selectors {
        out.push(nsCString::from(selector));
    }
    NS_OK
}

/// The scriptlet library, parsed and stored once from a JSON array of
/// adblock-rust `Resource`s. Every engine reads the one storage.
pub struct ContentClassifierFFIResources {
    storage: Arc<InMemoryResourceStorage>,
}

/// An engine's handle on the shared library.
struct SharedResourceStorage(Arc<InMemoryResourceStorage>);

impl ResourceStorageBackend for SharedResourceStorage {
    fn get_resource(&self, resource_ident: &str) -> Option<ResourceImpl> {
        self.0.get_resource(resource_ident)
    }
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_resources_from_json(
    json: &nsACString,
    out_resources: *mut *mut ContentClassifierFFIResources,
) -> nsresult {
    if out_resources.is_null() {
        return NS_ERROR_INVALID_ARG;
    }
    match serde_json::from_slice::<Vec<Resource>>(json.as_ref()) {
        Ok(resources) => {
            let storage = Arc::new(InMemoryResourceStorage::from_resources(resources));
            *out_resources = Box::into_raw(Box::new(ContentClassifierFFIResources { storage }));
            NS_OK
        }
        Err(_) => NS_ERROR_INVALID_ARG,
    }
}

#[no_mangle]
pub unsafe extern "C" fn content_classifier_resources_destroy(
    resources: *mut ContentClassifierFFIResources,
) {
    if !resources.is_null() {
        drop(Box::from_raw(resources));
    }
}

/// Points the engine's resources at the scriptlet library, which it shares
/// with every other engine, so this copies nothing.
#[no_mangle]
pub unsafe extern "C" fn content_classifier_engine_use_resources(
    engine: *mut ContentClassifierFFIEngine,
    resources: *const ContentClassifierFFIResources,
) -> nsresult {
    if engine.is_null() || resources.is_null() {
        return NS_ERROR_INVALID_ARG;
    }
    (*engine)
        .engine
        .use_resource_storage(SharedResourceStorage(Arc::clone(&(*resources).storage)));
    NS_OK
}
