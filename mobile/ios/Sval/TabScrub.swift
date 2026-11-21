// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI

/// What a hold on the address does as the finger moves: the hold opens the
/// strip, a slide moves through it, and lifting goes to the tab under it.
enum ScrubPhase {
    case began
    case moved(CGPoint)
    case ended
}

/// One page the strip can go to: a pin's page or a tab, with the group
/// at the Workspace's top level that holds the tab, if one does.
enum ScrubItem: Identifiable {
    case pin(PinRow, key: String)
    case tab(OutlineRow, group: OutlineRow?)

    /// The page's key in `Browser`, which its picture is kept under too.
    var id: String {
        switch self {
        case .pin(_, let key): key
        case .tab(let row, _): row.id
        }
    }

    var group: OutlineRow? {
        if case .tab(_, let group) = self { return group }
        return nil
    }

    @MainActor var title: String {
        switch self {
        case .pin(let pin, _): pin.name
        case .tab(let row, _): row.displayTitle
        }
    }
}

/// A scrub under way: the Workspace's pages, pins first and then its tabs
/// in tree order, so each stays at the same place from one scrub to the
/// next.
struct TabScrub {
    let items: [ScrubItem]
    /// Where the page in front sits, which lifting there leaves in front.
    let start: Int
    private(set) var index: Int
    /// Where the finger was as the strip opened, which the slide is
    /// measured from.
    private(set) var origin: CGPoint?
    /// The pages the finger's slide has moved.
    private var slid = 0
    /// The pages the strip has run on its own while the finger rests near
    /// the screen's edge. It also takes back any slide or run past either
    /// end, so turning back moves at once.
    private var carried = 0.0

    init(items: [ScrubItem], start: Int) {
        self.items = items
        self.start = start
        index = start
    }

    /// How far the finger slides for each page.
    static let step: CGFloat = 32
    /// How near the screen's edge the finger rests for the strip to run on.
    static let edge: CGFloat = 72
    /// The pages a second the strip runs at, as the finger enters the edge
    /// and at the screen's very edge.
    static let slowest = 3.0, fastest = 22.0

    /// The pages of Workspace `workspace` the phone can show.
    @MainActor
    static func items(in workspace: String, model: AppModel) -> [ScrubItem] {
        let pins = (model.pinsByWorkspace[workspace] ?? [])
            .filter { $0.kind == "favorite" && $0.url != nil }
            .map { ScrubItem.pin($0, key: Browser.pinKey($0.guid, in: workspace)) }
        // A tab whose address only another device can open is left out, as
        // the grid greys it.
        let tabs = model.tabs(in: workspace)
            .filter { Browser.openable($0) != nil || $0.url == nil }
            .map { ScrubItem.tab($0, group: topGroup(of: $0, model: model)) }
        return pins + tabs
    }

    /// The group directly under the Workspace that holds `row`. The tree
    /// keeps a group's tabs together, nested groups' included, so its
    /// cards lie side by side.
    @MainActor
    private static func topGroup(of row: OutlineRow, model: AppModel) -> OutlineRow? {
        var found: OutlineRow?
        var parent = row.parentId.flatMap(model.row)
        while let at = parent, at.kind != "workspace" {
            if at.kind == "group" { found = at }
            parent = at.parentId.flatMap(model.row)
        }
        return found
    }

    /// The finger at `point`.
    mutating func move(to point: CGPoint) {
        guard let origin else {
            origin = point
            return
        }
        slid = Int(((point.x - origin.x) / Self.step).rounded())
        settle()
    }

    /// Runs the strip `pages` on, toward the end the finger rests at.
    mutating func run(_ pages: Double) {
        carried += pages
        settle()
    }

    private mutating func settle() {
        let wanted = start + slid + Int(carried)
        let held = min(max(wanted, 0), items.count - 1)
        carried -= Double(wanted - held)
        index = held
    }
}

/// The strip of pages that rises over the bar while the address is held: a
/// carousel with the page under the finger in front, and its neighbours
/// stacked behind it, smaller and turned away the further they sit. The
/// strip takes the front card's group's colour and name, or the
/// Workspace's colour when the card is in no group.
struct TabScrubStrip: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let scrub: TabScrub
    let theme: Theme
    let colors: BarColors

    private struct Placed {
        let position: Int
        let item: ScrubItem
    }

    /// A Workspace with many tabs shows more of them, smaller. A card keeps
    /// the shape of the pictures `PagePreviews` takes, so a picture shows
    /// whole.
    private var many: Bool { scrub.items.count > 7 }
    private var card: CGSize {
        let width: CGFloat = many ? 116 : 150
        return CGSize(width: width, height: width / PagePreviews.aspect)
    }
    /// How many cards show either side of the front one.
    private var reach: Int { many ? 5 : 3 }

    /// A card's size `distance` places from the one in front.
    private func scale(_ distance: Int) -> CGFloat {
        distance == 0 ? 1 : max(0.5, 0.8 - 0.08 * CGFloat(abs(distance) - 1))
    }

    /// How far a card's centre sits from the front card's: the first card
    /// either side tucked half behind it, and each further one behind that.
    private func offset(_ distance: Int) -> CGFloat {
        guard distance != 0 else { return 0 }
        let x = card.width * (0.52 + 0.3 * CGFloat(abs(distance) - 1))
        return distance < 0 ? -x : x
    }

    var body: some View {
        VStack(spacing: 0) {
            groupName
                .padding(.top, 14)
                .padding(.bottom, 10)
                .frame(maxWidth: .infinity)
                .background(surface)
            ZStack {
                // Cards come and go only two places past the outermost one
                // that shows, where they are clear and parked one place
                // out. A card SwiftUI removes mid-animation fades where it
                // stood, and one that shows would be left hanging there.
                let window = max(scrub.index - reach - 2, 0)...min(scrub.index + reach + 2, scrub.items.count - 1)
                ForEach(window.map { Placed(position: $0, item: scrub.items[$0]) },
                        id: \.item.id) { placed in
                    let distance = placed.position - scrub.index
                    let shown = abs(distance) <= reach
                    let at = shown ? distance : (reach + 1) * distance.signum()
                    cardView(placed.item)
                        .scaleEffect(reduceMotion ? 1 : scale(at))
                        .rotation3DEffect(.degrees(reduceMotion ? 0 : Double(-at.signum()) * 32),
                                          axis: (x: 0, y: 1, z: 0), perspective: 0.5)
                        .offset(x: offset(at))
                        .opacity(shown ? 1 : 0)
                        // Each card's movement is its own, kept off the
                        // strip's as it opens and closes.
                        .geometryGroup()
                        .zIndex(Double(100 - abs(distance)))
                        .transition(.identity)
                }
            }
            .frame(height: card.height + 24)
            .frame(maxWidth: .infinity)
            .background { band }
            VStack(spacing: 10) {
                Text(scrub.items[scrub.index].title)
                    .font(.system(.subheadline, weight: .semibold))
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
                    .padding(.horizontal, 24)
                ScrubPlace(count: scrub.items.count, current: scrub.index, ink: theme.text)
            }
            .padding(.top, 10)
            .padding(.bottom, 16)
            .frame(maxWidth: .infinity)
            .background(surface)
        }
        .frame(maxWidth: .infinity)
        .clipShape(.rect(cornerRadius: 36))
        // Clear glass in the bar's tint, so the page shows through the
        // cards' row as it does through the bar.
        .glassEffect(.clear.tint(colors.layer.opacity(BarColors.glassTint)), in: .rect(cornerRadius: 36))
        .animation(reduceMotion ? nil : .spring(duration: 0.35, bounce: 0.12), value: scrub.index)
        .accessibilityHidden(true)
    }

    /// The header's and footer's ground: the Workspace sheet's rows', so
    /// their text reads in the sheet's colours over any page.
    private var surface: some View {
        theme.cell.opacity(0.85)
    }

    /// Behind the cards, the front card's group's colour, muted, edged
    /// above and below in the colour itself.
    @ViewBuilder private var band: some View {
        if let groupTint {
            groupTint.opacity(0.28)
                .overlay(alignment: .top) { groupTint.opacity(0.7).frame(height: 1.5) }
                .overlay(alignment: .bottom) { groupTint.opacity(0.7).frame(height: 1.5) }
        }
    }

    /// The front card's group, as the grid's group header shows it. The
    /// line keeps its height when the card is in no group, so the strip
    /// doesn't jump.
    private var groupName: some View {
        let group = scrub.items[scrub.index].group
        return HStack(spacing: 8) {
            if let group {
                if let emoji = group.emoji, !emoji.isEmpty {
                    Text(emoji).accessibilityIgnoresInvertColors()
                } else {
                    Image(systemName: "folder.fill")
                        .foregroundStyle(groupTint ?? theme.text)
                }
                Text(group.displayTitle)
                    .foregroundStyle(theme.text)
                    .lineLimit(1)
            }
        }
        .font(.system(.title2, weight: .semibold))
        .frame(height: 30)
        .padding(.horizontal, 24)
    }

    /// The front card's group's colour, if it is in a group that has one.
    private var groupTint: Color? {
        scrub.items[scrub.index].group.flatMap(tint)
    }

    private func tint(_ group: OutlineRow) -> Color? {
        group.color.flatMap(WorkspaceTint.init(rawValue:))?.swatch(dark: theme.dark)
    }

    @ViewBuilder private func cardView(_ item: ScrubItem) -> some View {
        Group {
            switch item {
            case .tab(let row, _):
                CardPicture(row: row, height: card.height, elsewhere: false, theme: theme,
                            loading: false)
            case .pin(let pin, let key):
                pinPicture(pin, key: key)
            }
        }
        .frame(width: card.width, height: card.height)
        .shadow(color: .black.opacity(0.18), radius: 8, y: 3)
    }

    /// A pin's card: its page's picture, or its site's icon, as a tab's
    /// card shows one (`CardPicture`).
    private func pinPicture(_ pin: PinRow, key: String) -> some View {
        Color.clear
            .background(theme.cell)
            .overlay(alignment: .top) {
                if let picture = PagePreviews.shared.picture(for: key) {
                    Image(uiImage: picture).resizable().scaledToFill()
                        .accessibilityIgnoresInvertColors()
                } else {
                    SiteTile(url: pin.url, name: pin.name, size: 44)
                        .frame(maxHeight: .infinity)
                }
            }
            .clipShape(.rect(cornerRadius: 14))
            .overlay {
                RoundedRectangle(cornerRadius: 14).strokeBorder(CardPicture.ring(theme), lineWidth: 1)
            }
    }
}

/// Where the front card sits among the Workspace's pages: dots, as the
/// Workspace swipe shows, while they fit, and a track with the place
/// marked past that.
struct ScrubPlace: View {
    let count: Int
    let current: Int
    let ink: Color

    var body: some View {
        if count <= 30 {
            PageDots(count: count, current: current, on: ink, off: ink.opacity(0.35), height: 6)
        } else {
            Capsule()
                .fill(ink.opacity(0.3))
                .frame(width: 180, height: 6)
                .overlay(alignment: .leading) {
                    Capsule()
                        .fill(ink)
                        .frame(width: 24, height: 6)
                        .offset(x: (180 - 24) * CGFloat(current) / CGFloat(max(count - 1, 1)))
                }
        }
    }
}

/// The scrub's taps: a firm one as the strip opens, and a light one at
/// each page the finger moves onto.
struct ScrubFeedback: ViewModifier {
    /// The page under the finger, while a scrub is under way.
    let index: Int?

    func body(content: Content) -> some View {
        content
            .sensoryFeedback(.impact(weight: .medium), trigger: index != nil) { _, held in held }
            .sensoryFeedback(.selection, trigger: index) { old, new in old != nil && new != nil }
    }
}
