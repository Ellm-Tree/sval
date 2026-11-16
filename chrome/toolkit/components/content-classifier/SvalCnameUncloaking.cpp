/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "mozilla/SvalCnameUncloaking.h"

#include "mozilla/Components.h"
#include "mozilla/ContentClassifierEngine.h"
#include "mozilla/ContentClassifierService.h"
#include "mozilla/StoragePrincipalHelper.h"
#include "mozilla/net/UrlClassifierCommon.h"
#include "mozIThirdPartyUtil.h"
#include "nsICachingChannel.h"
#include "nsICancelable.h"
#include "nsIChannel.h"
#include "nsIDNSRecord.h"
#include "nsIDNSService.h"
#include "nsILoadInfo.h"
#include "nsIPrincipal.h"
#include "nsIProtocolProxyService2.h"
#include "nsIProxiedChannel.h"
#include "nsIProxyInfo.h"
#include "nsIURI.h"
#include "nsIURIMutator.h"
#include "nsNetUtil.h"
#include "nsThreadUtils.h"

namespace mozilla {

NS_IMPL_ISUPPORTS(SvalCnameUncloaking, nsIDNSListener)

namespace {

// Whether the engines the channel would be blocked by include one that
// blocks. At Off, the cancel engines are the allowed domains alone.
bool AnyEngineBlocks(nsIChannel* aChannel) {
  nsTArray<nsCString> names;
  EnginesPrefsSnapshot::AppendFeatureNamesFromPref(
      NS_UsePrivateBrowsing(aChannel)
          ? "privacy.trackingprotection.content.protection.engines.pbmode"
          : "privacy.trackingprotection.content.protection.engines",
      names);
  for (const auto& name : names) {
    auto feature = ContentClassifierService::GetFeatureByName(name);
    if (feature && !feature->mExceptionOnly) {
      return true;
    }
  }
  return false;
}

}  // namespace

bool ContentClassifierService::HasCancelException(
    const ContentClassifierRequest& aRequest) {
  MutexAutoLock lock(mLock);
  if (mInitPhase != InitPhase::InitSucceeded || !aRequest.Valid()) {
    return false;
  }
  const nsTArray<RefPtr<ContentClassifierEngine>>& engines =
      aRequest.PrivateBrowsing() ? mCancelEnginesPBM : mCancelEngines;
  for (const auto& engine : engines) {
    if (engine->CheckNetworkRequest(aRequest, /* aPreviouslyMatched */ true)
            .Exception()) {
      return true;
    }
  }
  return false;
}

SvalCnameUncloaking::SvalCnameUncloaking(nsIChannel* aChannel,
                                         ContentClassifierService* aService,
                                         const nsACString& aHost)
    : mChannel(aChannel), mService(aService), mHost(aHost) {}

/* static */
already_AddRefed<SvalCnameUncloaking> SvalCnameUncloaking::ForChannel(
    nsIChannel* aChannel, ContentClassifierService* aService,
    bool aPerformBlocking) {
  MOZ_ASSERT(NS_IsMainThread());
  if (!aPerformBlocking || !aService || !aChannel) {
    return nullptr;
  }

  nsCOMPtr<nsILoadInfo> loadInfo = aChannel->LoadInfo();
  if (loadInfo->GetExternalContentPolicyType() ==
      ExtContentPolicy::TYPE_DOCUMENT) {
    return nullptr;
  }

  nsLoadFlags loadFlags = 0;
  (void)aChannel->GetLoadFlags(&loadFlags);
  if (loadFlags & (nsICachingChannel::LOAD_NO_NETWORK_IO |
                   nsICachingChannel::LOAD_ONLY_FROM_CACHE)) {
    return nullptr;
  }

  if (nsCOMPtr<nsIProxiedChannel> proxied = do_QueryInterface(aChannel)) {
    nsCOMPtr<nsIProxyInfo> proxyInfo;
    (void)proxied->GetProxyInfo(getter_AddRefs(proxyInfo));
    if (proxyInfo) {
      return nullptr;
    }
  }
  nsCOMPtr<nsIProtocolProxyService> proxyService =
      components::ProtocolProxy::Service();
  nsCOMPtr<nsIProtocolProxyService2> proxyService2 =
      do_QueryInterface(proxyService);
  if (!proxyService2 || !proxyService2->IsEffectivelyDirect()) {
    return nullptr;
  }

  if (!AnyEngineBlocks(aChannel)) {
    return nullptr;
  }

  nsCOMPtr<nsIURI> uri;
  nsAutoCString host;
  if (NS_FAILED(aChannel->GetURI(getter_AddRefs(uri))) || !uri ||
      NS_FAILED(uri->GetAsciiHost(host)) || host.IsEmpty()) {
    return nullptr;
  }

  if (nsCOMPtr<nsIPrincipal> loading = loadInfo->GetLoadingPrincipal()) {
    nsAutoCString documentHost;
    if (NS_SUCCEEDED(loading->GetAsciiHost(documentHost)) &&
        documentHost.Equals(host)) {
      return nullptr;
    }
  }

  return do_AddRef(new SvalCnameUncloaking(aChannel, aService, host));
}

void SvalCnameUncloaking::FirstClassified(
    const ContentClassifierResult& aResult) {
  MOZ_ASSERT(!NS_IsMainThread());
  mUncloak = aResult.GetStatus() == ContentClassifierResultStatus::Miss;
}

std::function<void()> SvalCnameUncloaking::Wrap(
    std::function<void()>&& aCallback) {
  mCallback = std::move(aCallback);
  RefPtr<SvalCnameUncloaking> self = this;
  return [self]() { self->AfterFirst(); };
}

bool SvalCnameUncloaking::ChannelLive() const {
  nsresult status = NS_OK;
  (void)mChannel->GetStatus(&status);
  return NS_SUCCEEDED(status);
}

void SvalCnameUncloaking::AfterFirst() {
  MOZ_ASSERT(NS_IsMainThread());
  // A consent manager or anti-fraud annotation exempts the channel from
  // blocking (UrlClassifierCommon::ShouldProcessWithProtectionFeature),
  // whichever name a rule matches.
  if (!mUncloak || !ChannelLive() ||
      !net::UrlClassifierCommon::ShouldProcessWithProtectionFeature(
          mChannel)) {
    Continue();
    return;
  }
  LookUp();
}

void SvalCnameUncloaking::LookUp() {
  nsCOMPtr<nsIDNSService> dns = components::DNS::Service();
  if (!dns) {
    Continue();
    return;
  }
  // The origin attributes and TRR mode nsHttpChannel::MaybeStartDNSPrefetch
  // resolves the channel's host with.
  OriginAttributes originAttributes;
  StoragePrincipalHelper::GetOriginAttributesForNetworkState(mChannel,
                                                             originAttributes);
  nsIRequest::TRRMode trrMode = nsIRequest::TRR_DEFAULT_MODE;
  (void)mChannel->GetTRRMode(&trrMode);
  nsIDNSService::DNSFlags flags = nsIDNSService::GetFlagsFromTRRMode(trrMode);
  flags |= nsIDNSService::RESOLVE_CANONICAL_NAME;

  nsCOMPtr<nsICancelable> lookup;
  nsresult rv = dns->AsyncResolveNative(
      mHost, nsIDNSService::RESOLVE_TYPE_DEFAULT, flags, nullptr, this,
      GetMainThreadSerialEventTarget(), originAttributes,
      getter_AddRefs(lookup));
  if (NS_FAILED(rv)) {
    Continue();
  }
}

NS_IMETHODIMP
SvalCnameUncloaking::OnLookupComplete(nsICancelable* aRequest,
                                      nsIDNSRecord* aRecord,
                                      nsresult aStatus) {
  MOZ_ASSERT(NS_IsMainThread());

  nsCOMPtr<nsIDNSAddrRecord> record = do_QueryInterface(aRecord);
  nsAutoCString canonicalName;
  if (NS_FAILED(aStatus) || !record ||
      NS_FAILED(record->GetCanonicalName(canonicalName)) ||
      canonicalName.IsEmpty() || canonicalName.Equals(mHost) ||
      !ChannelLive()) {
    Continue();
    return NS_OK;
  }

  nsCOMPtr<nsIURI> uri;
  nsCOMPtr<nsIURI> uncloaked;
  if (NS_FAILED(mChannel->GetURI(getter_AddRefs(uri))) || !uri ||
      NS_FAILED(NS_MutateURI(uri)
                    .SetUserPass(""_ns)
                    .SetHost(canonicalName)
                    .SetPathQueryRef("/"_ns)
                    .Finalize(uncloaked))) {
    Continue();
    return NS_OK;
  }

  nsCOMPtr<mozIThirdPartyUtil> thirdPartyUtil =
      components::ThirdPartyUtil::Service();
  bool otherSite = false;
  if (!thirdPartyUtil ||
      NS_FAILED(thirdPartyUtil->IsThirdPartyURI(uri, uncloaked, &otherSite)) ||
      !otherSite) {
    Continue();
    return NS_OK;
  }

  ContentClassifierRequest request(mChannel);
  ContentClassifierRequest uncloakedRequest(mChannel);
  if (!request.Valid() ||
      NS_FAILED(uncloaked->GetSpec(uncloakedRequest.mUrl)) ||
      NS_FAILED(uncloaked->GetAsciiHost(uncloakedRequest.mHost))) {
    Continue();
    return NS_OK;
  }
  // A request's party is decided for the host it names. Under the canonical
  // name it is third party unless that name is on the site of the document
  // that made it.
  if (!uncloakedRequest.mThirdParty) {
    bool thirdParty = true;
    nsCOMPtr<nsILoadInfo> loadInfo = mChannel->LoadInfo();
    if (nsCOMPtr<nsIPrincipal> loading = loadInfo->GetLoadingPrincipal()) {
      (void)loading->IsThirdPartyURI(uncloaked, &thirdParty);
    }
    uncloakedRequest.mThirdParty = thirdParty;
  }
  // An exception for the request's own address lets it through, as uBlock
  // Origin's `cnameIgnoreExceptions` does: the allowed domains and the
  // lists' fixes name the address a page uses. adblock-rust reports an
  // exception only for a request a rule matched, and
  // ContentClassifierEngine::CheckNetworkRequest passes over first-party
  // requests, so the address is checked as matched, with the party of the
  // uncloaked request it stands for.
  request.mThirdParty = uncloakedRequest.mThirdParty;

  RefPtr<SvalCnameUncloaking> self = this;
  nsresult rv = NS_DispatchBackgroundTask(NS_NewRunnableFunction(
      "SvalCnameUncloaking::Classify",
      [self, request = std::move(request),
       uncloakedRequest = std::move(uncloakedRequest)]() mutable {
        ContentClassifierResult result =
            self->mService->ClassifyForCancel(uncloakedRequest);
        const bool block =
            result.Hit() && !self->mService->HasCancelException(request);
        NS_DispatchToMainThread(NS_NewRunnableFunction(
            "SvalCnameUncloaking::Block",
            [self, block, result = std::move(result)]() {
              self->Block(block ? &result : nullptr);
            }));
      }));
  if (NS_FAILED(rv)) {
    Continue();
  }
  return NS_OK;
}

void SvalCnameUncloaking::Block(const ContentClassifierResult* aResult) {
  MOZ_ASSERT(NS_IsMainThread());
  if (aResult && ChannelLive()) {
    (void)mService->MaybeCancelChannel(mChannel, *aResult);
  }
  Continue();
}

void SvalCnameUncloaking::Continue() {
  MOZ_ASSERT(NS_IsMainThread());
  // Only one of the callbacks the classifier holds is called, but a copy
  // that is called second must not run the channel's continuation again.
  if (!mCallback) {
    return;
  }
  std::function<void()> callback = std::move(mCallback);
  mCallback = nullptr;
  callback();
}

}  // namespace mozilla
