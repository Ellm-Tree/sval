/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/*
 * Keep links in this tab: on a site with the rule on, a link to another page
 * of the site that asks for a new tab loads in the tab it is in.
 *
 * Sval's chrome sets the rule's site on a tab's top browsing context
 * (`svalKeepLinksSite`) as each top document loads, empty where the rule is
 * off. A content process decides here, before it asks the parent for a tab,
 * and a request it keeps takes the path `browser.link.open_newwindow` 1 takes
 * (`BrowserChild::ProvideWindow`).
 *
 * The request is kept when it comes from the tab's top document and the
 * address is of that site. A frame's request opens a new tab: loading in this
 * tab would navigate the top from a frame, which a sandboxed frame may be
 * barred from (`SANDBOXED_TOPLEVEL_NAVIGATION`). A request made with a
 * modifier key held is the user's, and opens where the key says. A script's
 * `window.open` is kept only with noopener: a script holding the new window
 * could otherwise write over the page that opened it. One asked for
 * with window features never reaches here as a tab
 * (`nsWindowWatcher::GetWindowOpenLocation`), so sign-in and payment popups
 * open as windows.
 */

#include "SvalKeepLinks.h"

#include "ThirdPartyUtil.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/Document.h"
#include "nsIURI.h"
#include "nsNetUtil.h"
#include "nsString.h"
#include "nsWindowWatcher.h"

namespace mozilla::dom {

bool SvalKeepsLinkInTab(BrowsingContext* aOpener, nsIURI* aURI,
                        const UserActivation::Modifiers& aModifiers,
                        bool aCalledFromJS, bool aForceNoOpener) {
  if (!aOpener || !aOpener->IsTop() || !aURI ||
      !net::SchemeIsHttpOrHttps(aURI)) {
    return false;
  }
  if (aCalledFromJS && !aForceNoOpener) {
    return false;
  }
  int32_t modifiedLocation = 0;
  if (nsWindowWatcher::IsWindowOpenLocationModified(aModifiers,
                                                    &modifiedLocation)) {
    return false;
  }
  const nsCString& site = aOpener->Top()->GetSvalKeepLinksSite();
  if (site.IsEmpty()) {
    return false;
  }
  Document* doc = aOpener->GetExtantDocument();
  ThirdPartyUtil* util = ThirdPartyUtil::GetInstance();
  if (!doc || !util) {
    return false;
  }
  nsAutoCString openerSite;
  nsAutoCString targetSite;
  if (NS_FAILED(doc->NodePrincipal()->GetBaseDomain(openerSite)) ||
      NS_FAILED(util->GetBaseDomain(aURI, targetSite))) {
    return false;
  }
  return openerSite == site && targetSite == site;
}

}  // namespace mozilla::dom
