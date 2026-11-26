// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit

/// A notice on glass, which may offer Undo for a few seconds.
struct Toast: Identifiable {
    let id = UUID()
    let text: String
    /// A glyph before the text, from the app's icons.
    var icon: String?
    var undo: (() -> Void)?
    /// The button's label, when it does something other than undo.
    var action = "Undo"
    /// A system glyph before the text, in place of `icon`.
    var symbol: String?
    /// How long it shows.
    var seconds: Double = 5
    /// A notice with nothing to act on: a capsule the width of its text on
    /// glass that takes no touches, which VoiceOver hears and never lands on.
    var notice = false
}

extension Toast {
    /// What closing tabs says: the tab's title for one, else how many.
    /// A private tab's title stays out of it, and its close has no Undo,
    /// which would mean keeping the tab (13d).
    static func closed(_ count: Int, title: String? = nil, undo: (() -> Void)? = nil) -> Toast {
        let text = if count == 1, let title { "Closed “\(title)”" }
            else if count == 1 { "Closed 1 tab" } else { "Closed \(count) tabs" }
        return Toast(text: text, undo: undo)
    }
}

/// What covers the main screen, which decides where a toast shows.
enum ToastCover: Equatable {
    /// Nothing: the page and its bar.
    case none
    /// The Workspace sheet, its sideways panel, or its popover.
    case workspace
    /// Any other sheet or full-screen cover over the main screen.
    case other
}

/// Where a toast shows on the screen.
enum ToastPlace: Hashable {
    /// At the top, over every sheet, where the Workspace sheet and panel
    /// leave the page showing.
    case top
    /// `lift` above the screen's foot, clear of the bar.
    case bottom(lift: CGFloat)
}

/// Shows the app's toasts and notices, one at a time, in a window of its
/// own over every sheet. A caller says what to show. Where it shows comes
/// from what covers the main screen and the bar's height, which the main
/// screen reports as they change.
@MainActor
@Observable
final class Toasts {
    /// The toast showing.
    private(set) var current: Toast?
    /// What covers the main screen.
    private(set) var cover: ToastCover = .none
    /// The bar's height, which changes as the bar folds and turns sideways.
    var barHeight: CGFloat = 0
    /// The Workspace's colour, which the glass takes as the bar's does.
    var tint: String?
    /// Whether the phone's appearance is dark.
    var dark = false

    var place: ToastPlace { Self.place(cover: cover, barHeight: barHeight) }

    /// Above the bar with nothing over the main screen, and at the top
    /// over any sheet, which would cover the screen's foot.
    static func place(cover: ToastCover, barHeight: CGFloat) -> ToastPlace {
        cover == .none ? .bottom(lift: barHeight + 12) : .top
    }

    /// The toast's frame in its window, the only part of the window that
    /// takes touches.
    @ObservationIgnored var frame: CGRect = .zero
    /// The wait before a toast goes by itself.
    @ObservationIgnored private(set) var timer: Task<Void, Never>?
    @ObservationIgnored private let wait: (Double) async -> Void
    @ObservationIgnored private let assistive: @MainActor () -> Bool
    @ObservationIgnored private let windowed: Bool
    @ObservationIgnored private var window: ToastWindow?

    /// `wait` sleeps for a toast's seconds, and `assistive` says whether
    /// VoiceOver or Switch Control runs. Without `windowed`, nothing is
    /// drawn.
    init(windowed: Bool = true,
         wait: @escaping (Double) async -> Void = { try? await Task.sleep(for: .seconds($0)) },
         assistive: @escaping @MainActor () -> Bool = { UIAccessibility.isVoiceOverRunning || UIAccessibility.isSwitchControlRunning }) {
        self.windowed = windowed
        self.wait = wait
        self.assistive = assistive
    }

    /// Shows `toast` in place of any showing. VoiceOver reads it out. One
    /// offering Undo stays while VoiceOver or Switch Control runs, since
    /// reaching its button takes longer than it shows for; the escape
    /// gesture puts it away.
    func show(_ toast: Toast) {
        timer?.cancel()
        timer = nil
        if windowed { attach() }
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        let animation = toast.notice ? (reduceMotion ? Motion.overlay : .spring(duration: 0.35)) : Motion.overlay
        withAnimation(animation) { current = toast }
        AccessibilityNotification.Announcement(toast.text).post()
        if toast.undo != nil, assistive() { return }
        let wait = wait
        timer = Task { [weak self] in
            await wait(toast.seconds)
            guard !Task.isCancelled else { return }
            self?.dismiss(toast.id)
        }
    }

    /// Puts `id` away, if it is still the toast showing.
    func dismiss(_ id: UUID) {
        guard let toast = current, toast.id == id else { return }
        timer?.cancel()
        timer = nil
        withAnimation(toast.notice ? .easeIn(duration: 0.25) : Motion.overlay, completionCriteria: .removed) {
            current = nil
        } completion: { [weak self] in
            guard let self, current == nil else { return }
            window?.isHidden = true
        }
    }

    /// Takes what covers the main screen. A toast showing moves to its new
    /// place.
    func covered(by cover: ToastCover) {
        guard cover != self.cover else { return }
        withAnimation(Motion.overlay) { self.cover = cover }
    }

    private func attach() {
        if window == nil {
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }
            let window = ToastWindow(windowScene: scene)
            window.toasts = self
            window.windowLevel = .alert
            let host = UIHostingController(rootView: ToastStage(toasts: self))
            host.view.backgroundColor = .clear
            window.rootViewController = host
            self.window = window
        }
        window?.isHidden = false
    }
}

/// The toasts' window, which takes only the touches on the toast showing
/// and lets the rest through to the windows under it.
private final class ToastWindow: UIWindow {
    weak var toasts: Toasts?

    override func point(inside point: CGPoint, with event: UIEvent?) -> Bool {
        guard let toasts, let toast = toasts.current, !toast.notice else { return false }
        return toasts.frame.contains(point)
    }
}

/// The toast showing, at its place.
private struct ToastStage: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let toasts: Toasts

    var body: some View {
        let place = toasts.place
        let top = place == .top
        let lift = if case .bottom(let lift) = place { lift } else { CGFloat(0) }
        VStack {
            if let toast = toasts.current {
                ToastView(toast: toast, colors: BarColors(token: toasts.tint, dark: toasts.dark)) {
                    toasts.dismiss(toast.id)
                }
                .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { toasts.frame = $0 }
                // At the top each toast comes in as the one before goes
                // out; at the foot a new one takes the old one's place.
                .id(top ? AnyHashable(toast.id) : AnyHashable("foot"))
                .transition(reduceMotion ? .opacity : .move(edge: top ? .top : .bottom).combined(with: .opacity))
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: top ? .top : .bottom)
        .padding(.top, top ? 8 : 0)
        .padding(.bottom, lift)
        .ignoresSafeArea(.container, edges: .bottom)
    }
}

struct ToastView: View {
    let toast: Toast
    let colors: BarColors
    let onDone: () -> Void

    var body: some View {
        let ink = colors.ink
        HStack(spacing: Space.rowGap) {
            if let icon = toast.icon {
                Image(icon).resizable().frame(width: 18, height: 18).foregroundStyle(ink)
            } else if let symbol = toast.symbol {
                Image(systemName: symbol).font(Glyph.besideCaption).foregroundStyle(ink)
            }
            Text(toast.text)
                .font(.system(.subheadline, weight: .medium))
                .foregroundStyle(ink)
                .lineLimit(2)
            if !toast.notice {
                Spacer(minLength: 4)
            }
            if let undo = toast.undo {
                Button(toast.action) {
                    undo()
                    onDone()
                }
                .font(.system(.subheadline, weight: .bold))
                .foregroundStyle(ink)
            }
        }
        .frame(minHeight: 48)
        .padding(.horizontal, Space.glassInset)
        .glassEffect(workspaceGlass(colors.layer, interactive: !toast.notice), in: .capsule)
        .padding(.horizontal, BarShape.side)
        .modifier(ToastAccess(notice: toast.notice, onDone: onDone))
    }
}

/// A toast's escape gesture, and a notice kept from VoiceOver's reach.
private struct ToastAccess: ViewModifier {
    let notice: Bool
    let onDone: () -> Void

    func body(content: Content) -> some View {
        if notice {
            content.accessibilityHidden(true)
        } else {
            content.accessibilityAction(.escape, onDone)
        }
    }
}
