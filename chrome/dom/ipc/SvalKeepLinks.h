/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_dom_SvalKeepLinks_h
#define mozilla_dom_SvalKeepLinks_h

#include "mozilla/dom/UserActivation.h"

class nsIURI;

namespace mozilla::dom {

class BrowsingContext;

/**
 * Whether a page's request for a new tab loads in its own tab instead, under
 * Keep links in this tab (SvalKeepLinks.cpp).
 *
 * @param aOpener The browsing context of the document asking.
 * @param aURI The address it asks to open.
 */
bool SvalKeepsLinkInTab(BrowsingContext* aOpener, nsIURI* aURI,
                        const UserActivation::Modifiers& aModifiers,
                        bool aCalledFromJS, bool aForceNoOpener);

}  // namespace mozilla::dom

#endif  // mozilla_dom_SvalKeepLinks_h
