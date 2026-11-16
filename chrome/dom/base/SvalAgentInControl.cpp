/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/*
 * A tab an agent controls: a top-level content browsing context whose
 * `svalAgentInControl` field is set. None of the user's input reaches its
 * pages. Sval's chrome stops what passes through the window that shows the
 * tab; this keeps out the input that reaches a page some other way:
 *
 * - Media keys, and the system's own media controls, which act on the main
 *   controller `MediaControlService` picks from its active controllers. The
 *   tab's `MediaController` is deactivated as the field is set and is not
 *   activated while it holds (`MediaController::ShouldActivateController`),
 *   so the keys go to another tab's media.
 * - Gamepads. `GamepadManager` gives the tab's windows nothing, as it gives a
 *   background window nothing: no events and no state for `getGamepads()`.
 * - A document Picture-in-Picture window the tab's page opened, which takes
 *   the user's input for that page. It closes as the field is set, and none
 *   opens while it holds (`DocumentPictureInPicture::RequestWindow`).
 */

#include "mozilla/dom/BrowsingContext.h"
#include "mozilla/dom/CanonicalBrowsingContext.h"
#include "mozilla/dom/DocumentPictureInPicture.h"
#include "mozilla/dom/MediaController.h"
#include "nsGlobalWindowInner.h"
#include "nsPIDOMWindow.h"
#include "nsPIDOMWindowInlines.h"
#include "nsThreadUtils.h"
#include "nsXULAppAPI.h"

namespace mozilla::dom {

bool BrowsingContext::SvalAgentControls(nsGlobalWindowInner* aWindow) {
  BrowsingContext* bc = aWindow ? aWindow->GetBrowsingContext() : nullptr;
  return bc && bc->Top()->GetSvalAgentInControl();
}

void BrowsingContext::DidSet(FieldIndex<IDX_SvalAgentInControl>,
                             bool aOldValue) {
  const bool inControl = GetSvalAgentInControl();
  if (inControl == aOldValue) {
    return;
  }
  // A field changes while a transaction is applied, where no script may
  // run; the controller's events and a window's close go once it is done.
  NS_DispatchToMainThread(NS_NewRunnableFunction(
      "SvalAgentInControlChanged",
      [bc = RefPtr{this}, inControl]() MOZ_CAN_RUN_SCRIPT_BOUNDARY {
        if (bc->IsDiscarded()) {
          return;
        }
        if (XRE_IsParentProcess()) {
          CanonicalBrowsingContext* canonical = bc->Canonical();
          if (canonical->HasCreatedMediaController()) {
            RefPtr<MediaController> controller =
                canonical->GetMediaController();
            controller->SvalAgentInControlChanged();
          }
          return;
        }
        if (!inControl) {
          return;
        }
        nsPIDOMWindowOuter* outer = bc->GetDOMWindow();
        nsPIDOMWindowInner* inner =
            outer ? outer->GetCurrentInnerWindow() : nullptr;
        DocumentPictureInPicture* pip =
            inner ? nsGlobalWindowInner::Cast(inner)
                        ->GetExtantDocumentPictureInPicture()
                  : nullptr;
        if (RefPtr<nsGlobalWindowInner> window =
                pip ? pip->GetWindow() : nullptr) {
          window->Close();
        }
      }));
}

void MediaController::SvalAgentInControlChanged() {
  if (!mShutdown) {
    UpdateActivatedStateIfNeeded();
  }
}

bool MediaController::SvalAgentInControl() const {
  RefPtr<BrowsingContext> bc = BrowsingContext::Get(Id());
  return bc && bc->GetSvalAgentInControl();
}

}  // namespace mozilla::dom
