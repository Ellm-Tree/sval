// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The page this phone's own Workspace shows while it has no tabs (14l):
/// what the Workspace is for, then where things are, numbered to match the
/// markers over the bar's capsules (`BarMarkers`).
struct DeviceHome: View {
    @Environment(\.appearance) private var scheme
    @Environment(\.sheetTint) private var sheetTint
    let workspace: OutlineRow?
    let onNewTab: () -> Void

    private var device: String { UIDevice.current.model }

    var body: some View {
        let theme = Theme(scheme, tint: sheetTint)
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                WorkspaceTile(workspace: workspace, size: 64)
                    .padding(.bottom, 4)
                Text("Your \(device)'s Workspace")
                    .font(SvalFont.outfit(28, .bold, relativeTo: .title))
                    .foregroundStyle(theme.text)
                    .accessibilityAddTraits(.isHeader)
                Text("Tabs you open on this \(device) go in this Workspace. Your other devices list it under Devices.")
                    .font(.system(.body))
                    .foregroundStyle(theme.body)
                    .lineSpacing(3)
                Text("Where things are")
                    .font(SvalFont.outfit(17, .semibold, relativeTo: .headline))
                    .foregroundStyle(theme.text)
                    .padding(.top, 14)
                    .accessibilityAddTraits(.isHeader)
                VStack(alignment: .leading, spacing: 12) {
                    item(1, "Back and Forward.", theme)
                    item(2, "The address. Tap it to search or enter an address. The shield next to it opens this site's settings.", theme)
                    item(3, "New Tab.", theme)
                    item(4, "Your Workspace. Tap it to see this Workspace's tabs and your other Workspaces.", theme)
                }
                Button(action: onNewTab) {
                    Label("New Tab", systemImage: "plus")
                }
                .buttonStyle(.glassProminent)
                .controlSize(.large)
                .padding(.top, 14)
            }
            .padding(.horizontal, 28)
            .padding(.top, 72)
            .padding(.bottom, 140)
            .frame(maxWidth: 520, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(theme.sheet)
        .environment(\.colorScheme, theme.colorScheme)
    }

    private func item(_ number: Int, _ text: String, _ theme: Theme) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            BarMarker(number: number)
            Text(text)
                .font(.system(.body))
                .foregroundStyle(theme.body)
                .fixedSize(horizontal: false, vertical: true)
        }
        // The number ties the line to the capsule wearing it in the bar.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(number). \(text)")
    }
}

/// A numbered marker, as the intro's list and the bar's capsules wear it.
struct BarMarker: View {
    let number: Int

    var body: some View {
        Text("\(number)")
            .font(.system(.caption, weight: .bold))
            .monospacedDigit()
            .foregroundStyle(.white)
            .frame(width: 22, height: 22)
            .background(Theme.blue, in: .circle)
            .accessibilityHidden(true)
    }
}

/// The intro's markers just above each of the open bar's capsules, at
/// their places in `GlassFold`'s layout.
struct BarMarkers: View {
    let width: CGFloat

    var body: some View {
        let capsules = GlassFold<EmptyView>.rest(width: width)
        ZStack(alignment: .topLeading) {
            ForEach(capsules.indices, id: \.self) { index in
                BarMarker(number: index + 1)
                    .offset(x: capsules[index].midX - 11)
            }
        }
        .frame(width: width, height: 22, alignment: .topLeading)
        .allowsHitTesting(false)
    }
}
