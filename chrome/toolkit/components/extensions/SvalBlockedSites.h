/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_extensions_SvalBlockedSites_h
#define mozilla_extensions_SvalBlockedSites_h

#include "nsStringFwd.h"

class nsICookieJarSettings;
class nsILoadInfo;
class nsPIDOMWindowOuter;

namespace mozilla::extensions {

class AtomSet;

// Whether a tab whose top-level document is on aHost is blocked by aSites.
// Each entry names a site or a host and covers the names under it, and a name
// written "~name" is one the extension runs on under a blocked name above
// it. The entry of the most specific name decides, so no Public Suffix List
// lookup is needed.
bool SvalHostInSites(const AtomSet& aSites, const nsACString& aHost);

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
