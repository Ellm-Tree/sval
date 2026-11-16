/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "SvalClassifierPageRules.h"

#include "mozilla/ContentClassifierEngine.h"

namespace mozilla {

/* static */
already_AddRefed<SvalClassifierResources> SvalClassifierResources::FromJson(
    const nsACString& aJson) {
  ContentClassifierFFIResources* raw = nullptr;
  if (NS_FAILED(content_classifier_resources_from_json(&aJson, &raw))) {
    return nullptr;
  }
  return do_AddRef(new SvalClassifierResources(raw));
}

SvalClassifierResources::~SvalClassifierResources() {
  content_classifier_resources_destroy(mResources);
}

/* static */
nsresult SvalClassifierEngine::AddPageRules(
    ContentClassifierEngine& aEngine, const nsACString& aUrl,
    nsTArray<nsCString>& aSelectors, nsTArray<nsCString>& aProceduralActions,
    nsTArray<nsCString>& aExceptions, nsCString& aScript, bool& aGenerichide) {
  if (!aEngine.mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }
  return content_classifier_engine_add_page_rules(
      aEngine.mEngine, &aUrl, &aSelectors, &aProceduralActions, &aExceptions,
      &aScript, &aGenerichide);
}

/* static */
nsresult SvalClassifierEngine::HiddenClassIdSelectors(
    ContentClassifierEngine& aEngine, const nsTArray<nsCString>& aClasses,
    const nsTArray<nsCString>& aIds, const nsTArray<nsCString>& aExceptions,
    nsTArray<nsCString>& aSelectors) {
  if (!aEngine.mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }
  return content_classifier_engine_hidden_class_id_selectors(
      aEngine.mEngine, &aClasses, &aIds, &aExceptions, &aSelectors);
}

/* static */
nsresult SvalClassifierEngine::UseResources(
    ContentClassifierEngine& aEngine,
    const SvalClassifierResources& aResources) {
  if (!aEngine.mEngine) {
    return NS_ERROR_NOT_INITIALIZED;
  }
  return content_classifier_engine_use_resources(aEngine.mEngine,
                                                 aResources.Get());
}

NS_IMPL_ISUPPORTS(SvalClassifierPageRules, nsIContentClassifierPageRules)

void SvalClassifierPageRules::Add(ContentClassifierEngine& aEngine,
                                  const nsACString& aUrl) {
  // An engine that cannot answer adds nothing; the others still do.
  (void)SvalClassifierEngine::AddPageRules(aEngine, aUrl, mSelectors,
                                           mProceduralActions, mExceptions,
                                           mScript, mGenerichide);
}

NS_IMETHODIMP SvalClassifierPageRules::GetSelectors(
    nsTArray<nsCString>& aSelectors) {
  aSelectors = mSelectors.Clone();
  return NS_OK;
}

NS_IMETHODIMP SvalClassifierPageRules::GetProceduralActions(
    nsTArray<nsCString>& aProceduralActions) {
  aProceduralActions = mProceduralActions.Clone();
  return NS_OK;
}

NS_IMETHODIMP SvalClassifierPageRules::GetExceptions(
    nsTArray<nsCString>& aExceptions) {
  aExceptions = mExceptions.Clone();
  return NS_OK;
}

NS_IMETHODIMP SvalClassifierPageRules::GetScript(nsACString& aScript) {
  aScript = mScript;
  return NS_OK;
}

NS_IMETHODIMP SvalClassifierPageRules::GetGenerichide(bool* aGenerichide) {
  *aGenerichide = mGenerichide;
  return NS_OK;
}

}  // namespace mozilla
