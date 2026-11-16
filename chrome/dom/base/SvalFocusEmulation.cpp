/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/*
 * Focus emulation: a top-level content browsing context whose
 * `svalFocusEmulated` field is set behaves, from its pages' point of view, as
 * the focused tab of a focused window, while it is not in the active window.
 *
 * Gecko keeps one focused window and one focused element per process and
 * mirrors them to the parent, so a second focused tab cannot be had by
 * moving that focus. Emulation leaves it alone: it sends no IPC, focuses no
 * widget and never touches `mFocusedWindow` or `mFocusedElement`. It reads
 * the focus each window already records (`SetFocusedElement`, which
 * `SetFocusInner` keeps up to date for a window that is not active) and
 * gives that element the element states and the focus and blur events the
 * focus manager gives an element in the active window, through the focus
 * manager's own `NotifyFocusStateChange` and `SendFocusOrBlurEvent`.
 *
 * Real focus wins: while the tab is in the active window, Gecko's own focus
 * handling applies and emulation does nothing.
 *
 * Only the documents of this process are seen. In a process that hosts an
 * out-of-process frame of the tab, that frame's own tree is treated as the
 * whole tab.
 */

#include "mozilla/AutoRestore.h"
#include "mozilla/PresShell.h"
#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/Document.h"
#include "mozilla/dom/Element.h"
#include "nsFocusManager.h"
#include "nsGlobalWindowInner.h"
#include "nsPIDOMWindow.h"
#include "nsThreadUtils.h"

using mozilla::Maybe;
using mozilla::Nothing;
using mozilla::PresShell;
using mozilla::Some;
using mozilla::dom::BrowsingContext;
using mozilla::dom::Document;
using mozilla::dom::Element;

void BrowsingContext::DidSet(FieldIndex<IDX_SvalFocusEmulated>,
                             bool aOldValue) {
  const bool emulated = GetSvalFocusEmulated();
  if (emulated == aOldValue || !XRE_IsContentProcess()) {
    return;
  }
  // A field changes while a transaction is applied, where no script may
  // run; the events go once it is done.
  NS_DispatchToMainThread(NS_NewRunnableFunction(
      "SvalFocusEmulationChanged",
      [bc = RefPtr{this}, emulated]() MOZ_CAN_RUN_SCRIPT_BOUNDARY {
        RefPtr<BrowsingContext> top = bc;
        if (RefPtr<nsFocusManager> fm = nsFocusManager::GetFocusManager()) {
          fm->SvalFocusEmulationChanged(top, emulated);
        }
      }));
}

nsPIDOMWindowOuter* nsFocusManager::SvalEmulatedRoot(BrowsingContext* aBC) {
  if (!aBC || !XRE_IsContentProcess() || !aBC->IsInProcess()) {
    return nullptr;
  }
  BrowsingContext* top = aBC->Top();
  if (!top->GetSvalFocusEmulated() || IsInActiveWindow(aBC)) {
    return nullptr;
  }
  BrowsingContext* root = aBC;
  while (root->GetParent() && root->GetParent()->IsInProcess()) {
    root = root->GetParent();
  }
  return root->GetDOMWindow();
}

already_AddRefed<Element> nsFocusManager::SvalEmulatedFocus(
    BrowsingContext* aBC) {
  nsPIDOMWindowOuter* root = SvalEmulatedRoot(aBC);
  if (!root) {
    return nullptr;
  }
  nsCOMPtr<nsPIDOMWindowOuter> focusedWindow;
  RefPtr<Element> focused = GetFocusedDescendant(root, eIncludeAllDescendants,
                                                 getter_AddRefs(focusedWindow));
  return focused.forget();
}

Maybe<bool> nsFocusManager::SvalEmulatedHasFocus(BrowsingContext* aBC) {
  nsPIDOMWindowOuter* root = SvalEmulatedRoot(aBC);
  if (!root) {
    return Nothing();
  }
  nsCOMPtr<nsPIDOMWindowOuter> focusedWindow;
  GetFocusedDescendant(root, eIncludeAllDescendants,
                       getter_AddRefs(focusedWindow));
  return Some(focusedWindow &&
              IsSameOrAncestor(aBC, focusedWindow->GetBrowsingContext()));
}

void nsFocusManager::SvalEmulateFocusMove(BrowsingContext* aBC,
                                          Element* aBefore, int32_t aFlags) {
  if (!SvalEmulatedRoot(aBC)) {
    return;
  }
  RefPtr<Element> after = SvalEmulatedFocus(aBC);
  if (after == aBefore) {
    return;
  }
  // As `BlurImpl` and then `Focus` do it: the old element loses its states,
  // then hears blur, then the new one gains them and hears focus.
  mozilla::AutoRestore<bool> emulating(mSvalEmulating);
  mSvalEmulating = true;
  if (RefPtr<Element> before = aBefore) {
    RefPtr<Document> doc = before->GetComposedDoc();
    if (RefPtr<PresShell> presShell = doc ? doc->GetPresShell() : nullptr) {
      NotifyFocusStateChange(before, after, 0, /* aGettingFocus = */ false,
                             false);
      SendFocusOrBlurEvent(mozilla::eBlur, presShell, doc, before, false, false,
                           after);
    }
    // A blur handler that moved focus on has had that move heard already.
    RefPtr<Element> now = SvalEmulatedFocus(aBC);
    if (now != after) {
      return;
    }
  }
  if (after && after->IsInComposedDoc()) {
    RefPtr<Document> doc = after->GetComposedDoc();
    nsCOMPtr<nsPIDOMWindowOuter> window = doc->GetWindow();
    if (RefPtr<PresShell> presShell = doc->GetPresShell();
        presShell && window) {
      NotifyFocusStateChange(
          after, nullptr, aFlags, /* aGettingFocus = */ true,
          SvalShouldMatchFocusVisible(window, *after, aFlags));
      SendFocusOrBlurEvent(mozilla::eFocus, presShell, doc, after, false, false,
                           aBefore);
    }
  }
}

void nsFocusManager::SvalFocusEmulationChanged(BrowsingContext* aTop,
                                               bool aEmulated) {
  if (!XRE_IsContentProcess() || aTop->IsDiscarded() ||
      aTop->GetSvalFocusEmulated() != aEmulated || IsInActiveWindow(aTop)) {
    return;
  }
  mozilla::AutoRestore<bool> emulating(mSvalEmulating);
  mSvalEmulating = true;
  // Each tree of this process's documents in the tab: the tab's own, or
  // each out-of-process frame of it this process hosts.
  nsTArray<RefPtr<BrowsingContext>> roots;
  aTop->PreOrderWalk([&](BrowsingContext* aBC) {
    if (aBC->IsInProcess() &&
        (!aBC->GetParent() || !aBC->GetParent()->IsInProcess())) {
      roots.AppendElement(aBC);
    }
  });
  for (const RefPtr<BrowsingContext>& root : roots) {
    nsCOMPtr<nsPIDOMWindowOuter> rootWindow = root->GetDOMWindow();
    if (!rootWindow) {
      continue;
    }
    nsCOMPtr<nsPIDOMWindowOuter> window;
    RefPtr<Element> element = GetFocusedDescendant(
        rootWindow, eIncludeAllDescendants, getter_AddRefs(window));
    if (!window) {
      continue;
    }
    RefPtr<Document> doc = window->GetExtantDoc();
    RefPtr<PresShell> presShell = doc ? doc->GetPresShell() : nullptr;
    RefPtr<nsGlobalWindowInner> inner =
        nsGlobalWindowInner::Cast(window->GetCurrentInnerWindow());
    if (!presShell || !inner) {
      continue;
    }
    // The focused element's state says whether the page already has the
    // focus asked for: the field's change and the window being lowered
    // both ask for it, and real focus may have moved it meanwhile.
    if (element && element->GetComposedDoc() == doc &&
        element->State().HasState(mozilla::dom::ElementState::FOCUS) ==
            aEmulated) {
      continue;
    }
    // The order a window being raised (`WindowRaised`, `Focus`) and lowered
    // (`BlurImpl` leaving the document) fires them in.
    if (aEmulated) {
      SendFocusOrBlurEvent(mozilla::eFocus, presShell, doc, doc, true);
      SendFocusOrBlurEvent(mozilla::eFocus, presShell, doc, inner, true);
      if (element && element->GetComposedDoc() == doc) {
        const int32_t method = window->GetFocusMethod();
        NotifyFocusStateChange(
            element, nullptr, method, /* aGettingFocus = */ true,
            SvalShouldMatchFocusVisible(window, *element, method));
        SendFocusOrBlurEvent(mozilla::eFocus, presShell, doc, element, true);
      }
    } else {
      if (element && element->GetComposedDoc() == doc) {
        NotifyFocusStateChange(element, nullptr, 0, /* aGettingFocus = */ false,
                               false);
        SendFocusOrBlurEvent(mozilla::eBlur, presShell, doc, element, true);
      }
      SendFocusOrBlurEvent(mozilla::eBlur, presShell, doc, doc, true);
      SendFocusOrBlurEvent(mozilla::eBlur, presShell, doc, inner, true);
    }
  }
}
