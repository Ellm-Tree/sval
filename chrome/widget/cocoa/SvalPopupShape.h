/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#ifndef SvalPopupShape_h
#define SvalPopupShape_h

#import <Cocoa/Cocoa.h>

#include "nsIWidget.h"

/**
 * The system's menu backdrop for a popup window, in the shape it was given
 * (nsIWidget::SetWindowShape), to take a shaped window's place under its
 * content: on macOS 26, glass for each of the shape's parts in one container
 * that joins them; earlier, the menu material masked to the shape's rings.
 * `aFrame` is the window's content frame in points and `aScale` its backing
 * scale. Returns a view the caller owns, or nil where the shape has nothing
 * to draw.
 */
NSView* SvalShapedBackdropView(NSRect aFrame,
                               const nsIWidget::WindowShape& aShape,
                               CGFloat aScale);

#endif  // SvalPopupShape_h
