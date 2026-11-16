/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "mozilla/extensions/SvalBlockedSites.h"

#include "mozilla/OriginAttributes.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/WindowGlobalParent.h"
#include "mozilla/extensions/MatchPattern.h"
#include "nsIChannel.h"
#include "nsICookieJarSettings.h"
#include "nsILoadInfo.h"
#include "nsIPrincipal.h"
#include "nsPIDOMWindow.h"
#include "nsString.h"
#include "nsXULAppAPI.h"

namespace mozilla::extensions {

bool SvalHostInSites(const AtomSet& aSites, const nsACString& aHost) {
  if (aHost.IsEmpty()) {
    return false;
  }
  nsAutoCString host(aHost);
  // A fully qualified host ("example.com.") is the same site as without its
  // final dot.
  if (StringEndsWith(host, "."_ns)) {
    host.Truncate(host.Length() - 1);
  }
  while (!host.IsEmpty()) {
    if (aSites.Contains(host)) {
      return true;
    }
    if (aSites.Contains("~"_ns + host)) {
      return false;
    }
    int32_t dot = host.FindChar('.');
    if (dot < 0) {
      return false;
    }
    host.Cut(0, dot + 1);
  }
  return false;
}

// A content principal's host; false for any other principal.
static bool HostOf(nsIPrincipal* aPrincipal, nsACString& aHost) {
  aHost.Truncate();
  return aPrincipal && aPrincipal->GetIsContentPrincipal() &&
         NS_SUCCEEDED(aPrincipal->GetAsciiHost(aHost)) && !aHost.IsEmpty();
}

static void SiteOfPartitionKey(nsICookieJarSettings* aSettings,
                               nsACString& aSite) {
  aSite.Truncate();
  if (!aSettings) {
    return;
  }
  nsAutoString partitionKey;
  if (NS_FAILED(aSettings->GetPartitionKey(partitionKey)) ||
      partitionKey.IsEmpty()) {
    return;
  }
  nsAutoString scheme;
  nsAutoString baseDomain;
  int32_t port;
  bool foreignByAncestorContext;
  if (OriginAttributes::ParsePartitionKey(partitionKey, scheme, baseDomain,
                                          port, foreignByAncestorContext)) {
    CopyUTF16toUTF8(baseDomain, aSite);
  }
}

void SvalTopLevelHost(nsILoadInfo* aLoadInfo, nsICookieJarSettings* aSettings,
                      nsACString& aHost) {
  if (aLoadInfo) {
    if (XRE_IsParentProcess()) {
      RefPtr<dom::WindowGlobalParent> window =
          dom::WindowGlobalParent::GetByInnerWindowId(
              aLoadInfo->GetInnerWindowID());
      if (window &&
          HostOf(window->TopWindowContext()->DocumentPrincipal(), aHost)) {
        return;
      }
    }
    if (HostOf(aLoadInfo->GetTopLevelPrincipal(), aHost)) {
      return;
    }
  }
  SiteOfPartitionKey(aSettings, aHost);
}

void SvalTopLevelHostOfWindow(nsPIDOMWindowOuter* aWindow, nsACString& aHost) {
  for (nsPIDOMWindowOuter* window = aWindow; window;) {
    dom::Document* doc = window->GetExtantDoc();
    dom::BrowsingContext* context = window->GetBrowsingContext();
    if (!doc || !context) {
      break;
    }
    if (context->IsTop()) {
      if (HostOf(doc->NodePrincipal(), aHost)) {
        return;
      }
      break;
    }
    if (nsCOMPtr<nsIChannel> channel = doc->GetChannel()) {
      nsCOMPtr<nsILoadInfo> loadInfo = channel->LoadInfo();
      if (HostOf(loadInfo->GetTopLevelPrincipal(), aHost)) {
        return;
      }
    }
    window = context->GetParent()->GetDOMWindow();
  }
  dom::Document* doc = aWindow->GetExtantDoc();
  SiteOfPartitionKey(doc ? doc->CookieJarSettings() : nullptr, aHost);
}

}  // namespace mozilla::extensions
