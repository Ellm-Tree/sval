/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef mozilla_SvalClassifierPageRules_h
#define mozilla_SvalClassifierPageRules_h

#include "mozilla/ContentClassifierEngine.h"
#include "nsIContentClassifierPageRules.h"
#include "nsISupportsImpl.h"
#include "nsString.h"
#include "nsTArray.h"

namespace mozilla {

class ContentClassifierEngine;

// The scriptlet library, parsed once and shared by every engine.
class SvalClassifierResources final {
 public:
  NS_INLINE_DECL_THREADSAFE_REFCOUNTING(SvalClassifierResources)

  static already_AddRefed<SvalClassifierResources> FromJson(
      const nsACString& aJson);

  const ContentClassifierFFIResources* Get() const { return mResources; }

 private:
  explicit SvalClassifierResources(ContentClassifierFFIResources* aRaw)
      : mResources(aRaw) {}
  ~SvalClassifierResources();

  ContentClassifierFFIResources* mResources;
};

// The page-rules lookups on an engine. ContentClassifierEngine names this
// class its friend, so these read the engine it keeps private. Callers hold
// the service's lock, as for ContentClassifierEngine::CheckNetworkRequest.
class SvalClassifierEngine final {
 public:
  static nsresult AddPageRules(ContentClassifierEngine& aEngine,
                               const nsACString& aUrl,
                               nsTArray<nsCString>& aSelectors,
                               nsTArray<nsCString>& aProceduralActions,
                               nsTArray<nsCString>& aExceptions,
                               nsCString& aScript, bool& aGenerichide);
  static nsresult HiddenClassIdSelectors(ContentClassifierEngine& aEngine,
                                         const nsTArray<nsCString>& aClasses,
                                         const nsTArray<nsCString>& aIds,
                                         const nsTArray<nsCString>& aExceptions,
                                         nsTArray<nsCString>& aSelectors);
  static nsresult UseResources(ContentClassifierEngine& aEngine,
                               const SvalClassifierResources& aResources);
};

// A document's page rules, merged from the engines in the order they are
// added. Nothing changes them once ContentClassifierService has cached them,
// so frames on any thread share one.
class SvalClassifierPageRules final : public nsIContentClassifierPageRules {
 public:
  NS_DECL_THREADSAFE_ISUPPORTS
  NS_DECL_NSICONTENTCLASSIFIERPAGERULES

  // Merges aEngine's rules for aUrl after the engines added before it.
  // Callers hold the service's lock, as for the engine's other lookups.
  void Add(ContentClassifierEngine& aEngine, const nsACString& aUrl);

 private:
  ~SvalClassifierPageRules() = default;

  nsTArray<nsCString> mSelectors;
  nsTArray<nsCString> mProceduralActions;
  nsTArray<nsCString> mExceptions;
  nsCString mScript;
  bool mGenerichide = false;
};

}  // namespace mozilla

#endif  // mozilla_SvalClassifierPageRules_h
