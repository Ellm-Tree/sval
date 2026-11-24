// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// The private session's background: the desktop's `--grad-private` with
/// the starfield (round 5).
struct PrivateBackdrop: View {
    var body: some View {
        RadialGradient(colors: [Color(hex: 0x2A1660), Theme.privateNight], center: .top, startRadius: 0, endRadius: 700)
            .overlay { Image("starfield").resizable().scaledToFill().opacity(0.7) }
            .ignoresSafeArea()
    }
}

/// A Workspace with no tab open, behind the bar, as the desktop's home
/// page draws one (`home.css`): Sval's mark over the starfield on a field
/// in the Workspace's colour, its tile and name, what its tabs do, and New
/// Tab. The private session's is the private palette's, and says what it
/// keeps and what it can't hide (13e).
struct EmptyHome: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme

    let workspace: OutlineRow?
    let onNewTab: () -> Void

    private var isPrivate: Bool { workspace.map { model.isPrivate($0.id) } ?? false }

    var body: some View {
        let theme = Theme(scheme, tint: model.tint(of: workspace))
        // The glow's colour: the Workspace's, or Sval's blue with none
        // (`--grad-night`, `--g-nh`).
        let glow = theme.tint?.swatch(dark: theme.dark) ?? Color(hex: Palette.navy)
        ScrollView {
            VStack(spacing: 16) {
                Image(isPrivate ? "mark-private" : (theme.dark ? "mark" : "mark-light"))
                    .resizable().scaledToFit()
                    .frame(width: 108, height: 108)
                    .shadow(color: (isPrivate ? Theme.privateViolet : glow).opacity(0.5), radius: 14)
                    // The field's glow, centred on the mark wherever the
                    // page puts it.
                    .background {
                        if !isPrivate {
                            RadialGradient(colors: [glow.opacity(theme.dark ? 0.6 : 0.18), .clear], center: .center,
                                           startRadius: 0, endRadius: 320)
                                .frame(width: 640, height: 640)
                                .allowsHitTesting(false)
                        }
                    }
                    .accessibilityHidden(true)
                HStack(spacing: 10) {
                    Group {
                        if isPrivate {
                            PrivateTile(size: 36)
                        } else {
                            WorkspaceTile(workspace: workspace, size: 36)
                        }
                    }
                    .accessibilityHidden(true)
                    Text(isPrivate ? "Private Workspace" : workspace.map(WorkspaceTile.name) ?? "")
                        .font(SvalFont.outfit(28, .bold, relativeTo: .title))
                        .foregroundStyle(theme.text)
                        .lineLimit(2)
                        .accessibilityAddTraits(.isHeader)
                }
                .padding(.top, 8)
                Text(isPrivate ? "Sval doesn't save anything from these tabs once the private Workspace is closed."
                               : "Tabs you open here show up on your other devices too.")
                    .font(.system(.body))
                    .lineSpacing(4)
                    .foregroundStyle(theme.body)
                    .multilineTextAlignment(.center)
                if isPrivate {
                    Label("Websites and your network may still see where you go.", systemImage: "exclamationmark.triangle.fill")
                        .font(.system(.subheadline))
                        .lineSpacing(3)
                        .foregroundStyle(theme.body)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(14)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .well(Theme.privateNight.opacity(0.55), edge: Theme.privateEdge.opacity(0.24), radius: 14)
                }
                Button("New Tab", systemImage: "plus", action: onNewTab)
                    .buttonStyle(.glassProminent)
                    .tint(isPrivate ? Theme.privateViolet : Theme.blue)
                    .controlSize(.large)
                    .padding(.top, 8)
            }
            .padding(.horizontal, 28)
            .padding(.vertical, 48)
            .frame(maxWidth: 520)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical, alignment: .center)
        }
        .scrollBounceBehavior(.basedOnSize)
        .background {
            if isPrivate {
                PrivateBackdrop()
            } else {
                HomeField(ground: theme.sheet, glow: glow, dark: theme.dark)
            }
        }
    }
}

/// The home page's field for a Workspace (`home.css`, `--home-field`): its
/// colour under the starfield, which the light scheme draws in the glow's
/// colour since white stars don't show on a light field. The glow itself
/// lies behind the mark (`EmptyHome`).
struct HomeField: View {
    let ground: Color
    let glow: Color
    let dark: Bool

    var body: some View {
        ground
            .overlay {
                if dark {
                    Image("starfield").resizable().scaledToFill().opacity(0.7)
                } else {
                    Image("starfield").renderingMode(.template).resizable().scaledToFill()
                        .foregroundStyle(glow.opacity(0.45))
                }
            }
            .ignoresSafeArea()
    }
}

/// What the app switcher and Control Centre see while a private tab is in
/// front: the private backdrop, the mark and "Private", and nothing of
/// the page or the bar (13f).
struct PrivateCoverView: View {
    var body: some View {
        ZStack {
            PrivateBackdrop()
            VStack(spacing: 12) {
                Image("mark-private").resizable().scaledToFit().frame(width: 52, height: 52)
                Text("Private").font(SvalFont.outfit(17, .semibold, relativeTo: .headline)).foregroundStyle(.white)
            }
        }
    }
}

extension Toast {
    /// Said once the private session has ended: no Undo, since that would
    /// mean keeping the tabs (13d2).
    static var privateClosed: Toast {
        var toast = Toast(text: "Private Workspace and data deleted")
        toast.symbol = "checkmark"
        toast.seconds = 3
        toast.notice = true
        return toast
    }
}
