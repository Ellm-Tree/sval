/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_extensions_SvalBlockedSites_h
#define mozilla_extensions_SvalBlockedSites_h

#include "nsStringFwd.h"
#include "nsTArrayForwardDeclare.h"

class nsICookieJarSettings;
class nsILoadInfo;
class nsPIDOMWindowOuter;

namespace mozilla::extensions {

class AtomSet;

// Whether a tab whose top-level document is on aHost is blocked by aSites.
// Each entry names a site or a host and covers the names under it, and a name
// written "~name" is one the extension runs on under a blocked name above
// it. The entry of the most specific name decides, so no Public Suffix List
// lookup is needed. An entry "*" is a name above every host.
bool SvalHostInSites(const AtomSet& aSites, const nsACString& aHost);

// Whether aSites holds an entry "%id", one for each Workspace the extension
// is available in. With none, it is available in every Workspace.
bool SvalHasWorkspaces(const nsTArray<nsString>& aSites);

// Whether a tab in the Workspace aWorkspace, empty for none, is outside the
// Workspaces aSites names. Only meaningful where SvalHasWorkspaces holds.
bool SvalWorkspaceBlocked(const AtomSet& aSites, const nsACString& aWorkspace);

// The Workspace of the tab a load belongs to: its top-level browsing
// context's SvalWorkspace. Empty where the context is not known here.
void SvalWorkspaceOfLoad(nsILoadInfo* aLoadInfo, nsACString& aWorkspace);

// The Workspace of aWindow's tab.
void SvalWorkspaceOfWindow(nsPIDOMWindowOuter* aWindow, nsACString& aWorkspace);

// The host of the top-level document of the tab a load belongs to. In the
// parent, the top-level document of the window the load came from; else the
// load's top-level principal, which the parent sets on every frame load
// (LoadInfo's WindowGlobalParent constructor). Where neither is there, the
// site of the cookie jar settings' partition key, which every frame of the
// tab inherits and which holds only the base domain.
void SvalTopLevelHost(nsILoadInfo* aLoadInfo, nsICookieJarSettings* aSettings,
                      nsACString& aHost);

// The host of the top-level document of aWindow's tab, read from the nearest
// document in this process that knows it: the top-level document itself, or
// a frame's load's top-level principal. A frame's process need not hold the
// top-level document. Where none knows it, the partition key's site.
void SvalTopLevelHostOfWindow(nsPIDOMWindowOuter* aWindow, nsACString& aHost);

}  // namespace mozilla::extensions

#endif  // mozilla_extensions_SvalBlockedSites_h
