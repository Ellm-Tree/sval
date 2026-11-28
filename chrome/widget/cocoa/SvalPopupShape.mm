/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

#include "SvalPopupShape.h"

#include <vector>

// Glass views this far apart or nearer flow into one shape
// (NSGlassEffectContainerView.spacing), so a stem and its body join.
static const CGFloat kJoinSpacing = 12.0;

NSView* SvalShapedBackdropView(NSRect aFrame,
                               const nsIWidget::WindowShape& aShape,
                               CGFloat aScale) {
  if (aShape.IsEmpty() || aScale <= 0) {
    return nil;
  }
  const CGFloat height = aFrame.size.height;

  if (@available(macOS 26.0, *)) {
    if (aShape.mParts.IsEmpty()) {
      return nil;
    }
    NSView* wrapper = [[NSView alloc] initWithFrame:aFrame];
    auto* container =
        [[NSGlassEffectContainerView alloc] initWithFrame:wrapper.bounds];
    container.spacing = kJoinSpacing;
    container.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    NSView* glass = [[NSView alloc] initWithFrame:container.bounds];
    for (const auto& part : aShape.mParts) {
      // The view's origin is its bottom left; the shape's is its top left.
      const CGFloat x = part.mRect.x / aScale;
      const CGFloat y = part.mRect.y / aScale;
      const CGFloat w = part.mRect.width / aScale;
      const CGFloat h = part.mRect.height / aScale;
      auto* piece = [[NSGlassEffectView alloc]
          initWithFrame:NSMakeRect(x, height - y - h, w, h)];
      piece.cornerRadius = part.mRadius / aScale;
      [glass addSubview:piece];
      [piece release];
    }
    container.contentView = glass;
    [glass release];
    [wrapper addSubview:container];
    [container release];
    return wrapper;
  }

  std::vector<std::vector<NSPoint>> rings;
  for (const auto& ring : aShape.mRings) {
    std::vector<NSPoint> points;
    for (const auto& point : ring) {
      points.push_back(NSMakePoint(point.x / aScale, point.y / aScale));
    }
    rings.push_back(std::move(points));
  }
  auto* effectView = [[NSVisualEffectView alloc] initWithFrame:aFrame];
  effectView.material = NSVisualEffectMaterialMenu;
  // A menu's window is never key, so its vibrancy is told to look active.
  effectView.state = NSVisualEffectStateActive;
  effectView.blendingMode = NSVisualEffectBlendingModeBehindWindow;
  effectView.maskImage = [NSImage imageWithSize:aFrame.size
                                        flipped:YES
                                 drawingHandler:^BOOL(NSRect) {
                                   NSBezierPath* path =
                                       [NSBezierPath bezierPath];
                                   path.windingRule = NSWindingRuleEvenOdd;
                                   for (const auto& ring : rings) {
                                     [path moveToPoint:ring.front()];
                                     for (size_t i = 1; i < ring.size(); i++) {
                                       [path lineToPoint:ring[i]];
                                     }
                                     [path closePath];
                                   }
                                   [[NSColor blackColor] set];
                                   [path fill];
                                   return YES;
                                 }];
  return effectView;
}
