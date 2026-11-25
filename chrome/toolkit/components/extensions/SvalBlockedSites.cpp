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
      break;
    }
    host.Cut(0, dot + 1);
  }
  return aSites.Contains("*"_ns);
}

static constexpr char16_t kWorkspaceMark = u'%';

bool SvalHasWorkspaces(const nsTArray<nsString>& aSites) {
  for (const nsString& entry : aSites) {
    if (!entry.IsEmpty() && entry.First() == kWorkspaceMark) {
      return true;
    }
  }
  return false;
}

bool SvalWorkspaceBlocked(const AtomSet& aSites, const nsACString& aWorkspace) {
  return !aSites.Contains("%"_ns + aWorkspace);
}

static void WorkspaceOf(dom::BrowsingContext* aContext,
                        nsACString& aWorkspace) {
  aWorkspace.Truncate();
  if (aContext) {
    aContext->Top()->GetSvalWorkspace(aWorkspace);
  }
}

void SvalWorkspaceOfLoad(nsILoadInfo* aLoadInfo, nsACString& aWorkspace) {
  uint64_t id = 0;
  if (aLoadInfo) {
    id = aLoadInfo->GetFrameBrowsingContextID();
    if (!id) {
      id = aLoadInfo->GetAssociatedBrowsingContextID();
    }
    if (!id) {
      id = aLoadInfo->GetBrowsingContextID();
    }
  }
  RefPtr<dom::BrowsingContext> context = dom::BrowsingContext::Get(id);
  WorkspaceOf(context, aWorkspace);
}

void SvalWorkspaceOfWindow(nsPIDOMWindowOuter* aWindow,
                           nsACString& aWorkspace) {
  WorkspaceOf(aWindow ? aWindow->GetBrowsingContext() : nullptr, aWorkspace);
}

// A web page's host; false for any other principal. A site rule names a web
// site, so an extension's own page, which has a content principal of its
// own, is on no site.
static bool HostOf(nsIPrincipal* aPrincipal, nsACString& aHost) {
  aHost.Truncate();
  return aPrincipal && aPrincipal->GetIsContentPrincipal() &&
         (aPrincipal->SchemeIs("http") || aPrincipal->SchemeIs("https")) &&
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
