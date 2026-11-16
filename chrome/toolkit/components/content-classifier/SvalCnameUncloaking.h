/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_SvalCnameUncloaking_h
#define mozilla_SvalCnameUncloaking_h

#include <functional>

#include "mozilla/Atomics.h"
#include "mozilla/RefPtr.h"
#include "nsCOMPtr.h"
#include "nsIDNSListener.h"
#include "nsString.h"

class nsIChannel;

namespace mozilla {

class ContentClassifierResult;
class ContentClassifierService;

// A request no blocking rule or exception matched is classified again under
// the canonical name of its host, when DNS gives that host a CNAME on another
// site, so a tracker served from a subdomain of the page's own site is
// matched by the rules for the tracker. uBlock Origin's defaults for Firefox
// set the scope (`cnameIgnore1stParty`, `cnameIgnoreExceptions`,
// `cnameIgnoreRootDocument`, and the URL replayed as the scheme and the
// canonical host alone).
//
// The lookup goes through Gecko's resolver with the channel's own origin
// attributes and TRR mode, so it shares the host record the connection
// resolves, and a host the resolver holds answers from its cache. A request a
// rule blocked is never looked up.
class SvalCnameUncloaking final : public nsIDNSListener {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSIDNSLISTENER

  // Main thread. Null when aChannel's host is not looked up: classification
  // that does not block, a channel that never reaches the network, a
  // top-level document, a request to its own document's host, and any proxy.
  // Proxy resolution comes after classification, so a request is looked up
  // only when the proxy settings send every request direct
  // (nsIProtocolProxyService2::IsEffectivelyDirect): a proxy may hide from
  // the local resolver the hosts it fetches.
  static already_AddRefed<SvalCnameUncloaking> ForChannel(
      nsIChannel* aChannel, ContentClassifierService* aService,
      bool aPerformBlocking);

  // Main thread. Takes the callback that lets the channel go on, and returns
  // the one to call in its place.
  std::function<void()> Wrap(std::function<void()>&& aCallback);

  // The classifier's thread. Records whether the first classification found
  // no rule.
  void FirstClassified(const ContentClassifierResult& aResult);

 private:
  SvalCnameUncloaking(nsIChannel* aChannel, ContentClassifierService* aService,
                      const nsACString& aHost);
  ~SvalCnameUncloaking() = default;

  void AfterFirst();
  void LookUp();
  // aResult is the uncloaked request's, or null when it is let through.
  void Block(const ContentClassifierResult* aResult);
  void Continue();
  bool ChannelLive() const;

  nsCOMPtr<nsIChannel> mChannel;
  RefPtr<ContentClassifierService> mService;
  nsCString mHost;
  std::function<void()> mCallback;
  Atomic<bool> mUncloak{false};
};

}  // namespace mozilla

#endif  // mozilla_SvalCnameUncloaking_h
