// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import SwiftUI
import UIKit
import WebKit

/// Remove from This Site on the iPhone (element picker spec): the person
/// taps an element, chooses how much of the page around it to hide, and the
/// rule goes into My filters, which sync and block as the desktop's do.
///
/// The page is measured by `script`, run in the app's own script world
/// (`.defaultClient`), so the page sees neither its functions nor its
/// state. The outline and the card are the app's own views over the page,
/// and a tap on the page while picking reaches the picker alone
/// (`PickSurface`).
@MainActor
@Observable
final class ElementPick: Identifiable {
    /// One depth stop: the element tapped, or one of its ancestors.
    struct Stop: Decodable, Equatable {
        /// What the slider calls it: Image, Link, Box and the like.
        let name: String
        let selector: String
        /// How many elements on the page the selector matches.
        let count: Int
    }

    let id = UUID()
    let view: WKWebView
    /// The page's host and site (`SiteRules.scope(of:)`, `SiteRules.site(of:)`).
    let host: String
    let site: String
    /// What the rule names: the host, or the whole site where the host is a
    /// name of its own under it.
    var scope: String
    /// The stops for the element last tapped, nearest first.
    private(set) var stops: [Stop] = []
    var depth = 0 {
        didSet { if depth != oldValue { Task { await measure() } } }
    }
    /// Where the current stop's matches are, in the web view's points.
    private(set) var rects: [CGRect] = []

    init?(view: WKWebView) {
        guard let host = view.url?.host(), AppModel.opensHere(view.url?.absoluteString ?? ""),
              let scope = SiteRules.scope(of: host), let site = SiteRules.site(of: host) else { return nil }
        self.view = view
        self.host = host
        self.site = site
        self.scope = scope
    }

    var stop: Stop? { stops.indices.contains(depth) ? stops[depth] : nil }
    /// The host's own scope, where the rule can name it alone or the whole
    /// site; nil where the host is the site.
    var hostScope: String? { SiteRules.scope(of: host).flatMap { $0 == site ? nil : $0 } }
    var line: String? { stop.map { "\(scope)##\($0.selector)" } }

    /// Picks the element at `point`, in the web view's points.
    func pick(at point: CGPoint) async {
        let found: [Stop]? = await call("pick(x, y, place)", ["x": point.x, "y": point.y, "place": place])
        stops = found ?? []
        depth = 0
        Diagnostics.log("picker: \(found == nil ? "the page didn't answer" : "\(stops.count) stop(s)")")
        await measure()
    }

    /// Finds the current stop's matches again, after the page moved.
    func measure() async {
        guard !stops.isEmpty else {
            rects = []
            return
        }
        let found: [[Double]]? = await call("rects(index, place)", ["index": depth, "place": place])
        rects = (found ?? []).compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
    }

    /// Scrolls the page by a drag of `move` points, and finds the current
    /// stop's matches where they moved to.
    func scroll(by move: CGVector) async {
        let found: [[Double]]? = await call("scroll(dx, dy, index, place)",
                                            ["dx": move.dx, "dy": move.dy, "index": depth, "place": place])
        rects = (found ?? []).compactMap { $0.count == 4 ? CGRect(x: $0[0], y: $0[1], width: $0[2], height: $0[3]) : nil }
    }

    /// Hides `selector` in the open page at once, before the compiled rules
    /// reach it. Returns what `unhide` takes back.
    func hide(_ selector: String) async -> String? {
        await call("hide(selector)", ["selector": selector])
    }

    func unhide(_ id: String) async {
        let _: Bool? = await call("unhide(id)", ["id": id])
    }

    /// Where the page is in the web view: its width, and the room above and
    /// beside it that the scroll view keeps clear, under the status bar.
    private var place: [String: Double] {
        let inset = view.scrollView.adjustedContentInset
        return ["width": view.bounds.width - inset.left - inset.right, "left": inset.left, "top": inset.top]
    }

    /// How many elements on the page in `view` each selector matches, nil
    /// for one the page can't read, for the site menu's removal rules.
    static func counts(_ selectors: [String], in view: WKWebView) async -> [Int?] {
        await call("counts(selectors)", ["selectors": selectors], in: view) ?? selectors.map { _ in nil }
    }

    /// Shows the matches of `selector` again where Remove hid them in the
    /// open page. A rule the page loaded with stays until it loads again.
    static func showAgain(_ selector: String, in view: WKWebView) async {
        let _: Bool? = await call("showAgain(selector)", ["selector": selector], in: view)
    }

    private func call<T: Decodable>(_ expression: String, _ arguments: [String: Any]) async -> T? {
        await Self.call(expression, arguments, in: view)
    }

    /// Runs one of `script`'s functions, which answers in JSON.
    private static func call<T: Decodable>(_ expression: String, _ arguments: [String: Any],
                                           in view: WKWebView) async -> T? {
        let body = script + "\nreturn JSON.stringify(globalThis.__svalPicker.\(expression));"
        guard let json = try? await view.callAsyncJavaScript(body, arguments: arguments, contentWorld: .defaultClient)
                as? String else { return nil }
        return try? JSONDecoder().decode(T.self, from: Data(json.utf8))
    }

    /// The picker's side in the page, a port of the desktop's
    /// `SvalElementCandidates.sys.mjs` and `usableSelector`: the stops and
    /// their selectors, the matches' rects, and the sheet that hides a rule
    /// at once. Points are the web view's, from `place`: the page's width
    /// over the visual viewport's is its scale, and the visual viewport's
    /// offset is where it is in the layout viewport that `elementsFromPoint`
    /// reads.
    static let script = #"""
    (() => {
      if (globalThis.__svalPicker) return;
      const NAMES = { img: "Image", picture: "Image", a: "Link", iframe: "Frame", video: "Video",
        audio: "Audio", aside: "Sidebar", nav: "Navigation", header: "Header", footer: "Footer",
        section: "Section", article: "Section", button: "Button", dialog: "Dialog" };
      const MIN_SIDE = 8, MAX_STOPS = 6, MAX_VALUE_LENGTH = 40, MAX_RECTS = 200;
      const NOT_IDENTIFYING = new Set(["class", "id", "style", "role", "tabindex", "type", "width",
        "height", "href", "src", "srcset", "alt", "title", "value", "content", "xmlns"]);
      let probe = null;
      let chosen = [];
      let sheets = 0;
      const usableSelector = selector => {
        if (/[{}\n\r]|\/\*|\*\//.test(selector) || selector.length > 1024) return false;
        try { (probe ??= document.createElement("div")).matches(selector); return true; } catch { return false; }
      };
      const nameOf = el => el.getAttribute("role") === "dialog" ? "Dialog"
        : Object.hasOwn(NAMES, el.localName) ? NAMES[el.localName] : "Box";
      const classSelector = el => [...el.classList].map(name => `.${CSS.escape(name)}`).join("");
      const quoted = value => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\a ")}"`;
      const identifyingAttributes = el => {
        const names = el.getAttributeNames().filter(name => !NOT_IDENTIFYING.has(name)
          && !(name.startsWith("on") && name in el) && !name.startsWith("aria-"));
        return [...names.filter(n => n.startsWith("data-")), ...names.filter(n => !n.startsWith("data-"))];
      };
      const usable = (el, selector) => usableSelector(selector) && el.matches(selector);
      const countOf = (root, selector) => { try { return root.querySelectorAll(selector).length; } catch { return Infinity; } };
      const attributeSelector = el => {
        const root = el.getRootNode(), tag = CSS.escape(el.localName);
        for (const name of identifyingAttributes(el)) {
          const bare = `${tag}[${CSS.escape(name)}]`;
          if (!usable(el, bare)) continue;
          const value = el.getAttribute(name);
          if (!value || value.length > MAX_VALUE_LENGTH) return bare;
          const withValue = `${tag}[${CSS.escape(name)}=${quoted(value)}]`;
          if (!usable(el, withValue)) return bare;
          return countOf(root, bare) > countOf(root, withValue) ? withValue : bare;
        }
        return null;
      };
      const anchorSelector = el => {
        for (const candidate of [el.classList.length ? classSelector(el) : null, el.id ? `#${CSS.escape(el.id)}` : null]) {
          if (candidate && usableSelector(candidate)) return candidate;
        }
        return null;
      };
      const positionSelector = el => {
        let index = 1;
        for (let node = el.previousElementSibling; node; node = node.previousElementSibling) {
          if (node.localName === el.localName) index++;
        }
        return `${CSS.escape(el.localName)}:nth-of-type(${index})`;
      };
      const pathSelector = el => {
        const parts = [];
        for (let node = el; node; node = node.parentElement) {
          const anchor = node === el ? null : anchorSelector(node);
          if (anchor) { parts.unshift(anchor); break; }
          if (node !== el && node.localName === "body") { parts.unshift("body"); break; }
          parts.unshift(positionSelector(node));
        }
        return parts.join(" > ");
      };
      const selectorFor = el => {
        for (const strategy of [() => el.classList.length ? classSelector(el) : null,
          () => el.id ? `#${CSS.escape(el.id)}` : null, () => attributeSelector(el)]) {
          const selector = strategy();
          if (selector && usable(el, selector)) return selector;
        }
        return pathSelector(el);
      };
      const isRoot = el => el.localName === "html" || el.localName === "body";
      const stopsOf = el => {
        if (isRoot(el)) return [];
        const result = [el];
        for (let node = el.parentElement; node && result.length < MAX_STOPS && !isRoot(node); node = node.parentElement) {
          result.push(node);
        }
        return result;
      };
      const hostOf = el => {
        let node = el;
        for (let root = node.getRootNode(); root.nodeType === 11 && root.host; root = node.getRootNode()) node = root.host;
        return node;
      };
      const pointable = el => {
        const rect = el.getBoundingClientRect();
        return !isRoot(el) && rect.width >= MIN_SIDE && rect.height >= MIN_SIDE;
      };
      const view = place => {
        const v = globalThis.visualViewport, scale = place.width / v.width;
        return { scale, left: v.offsetLeft - place.left / scale, top: v.offsetTop - place.top / scale };
      };
      globalThis.__svalPicker = {
        pick(x, y, place) {
          const { scale, left, top } = view(place);
          const el = document.elementsFromPoint(left + x / scale, top + y / scale).map(hostOf).find(pointable);
          chosen = el ? stopsOf(el).map(node => ({ node, selector: selectorFor(node) })) : [];
          return chosen.map(({ node, selector }) => ({
            name: nameOf(node), selector, count: Math.min(countOf(document, selector), 9999) }));
        },
        rects(index, place) {
          const stop = chosen[index];
          if (!stop) return [];
          const { scale, left, top } = view(place);
          let matches = [];
          try { matches = [...document.querySelectorAll(stop.selector)]; } catch {}
          const nodes = [stop.node, ...matches.filter(node => node !== stop.node)].slice(0, MAX_RECTS);
          return nodes.map(node => node.getBoundingClientRect()).filter(r => r.width && r.height)
            .map(r => [(r.left - left) * scale, (r.top - top) * scale, r.width * scale, r.height * scale]);
        },
        scroll(dx, dy, index, place) {
          const { scale } = view(place);
          globalThis.scrollBy(-dx / scale, -dy / scale);
          return this.rects(index, place);
        },
        hide(selector) {
          if (!usableSelector(selector)) return null;
          const style = document.createElement("style");
          style.id = `sval-removed-${++sheets}-${Math.random().toString(36).slice(2)}`;
          style.dataset.svalSelector = selector;
          style.textContent = `${selector} { display: none !important; }`;
          (document.head ?? document.documentElement).append(style);
          return style.id;
        },
        unhide(id) { document.getElementById(id)?.remove(); return true; },
        showAgain(selector) {
          for (const style of document.querySelectorAll("style[id^='sval-removed-']")) {
            if (style.dataset.svalSelector === selector) style.remove();
          }
          return true;
        },
        counts(selectors) {
          return selectors.map(selector => usableSelector(selector) ? countOf(document, selector) : null)
            .map(n => n === Infinity ? null : n);
        },
      };
    })();
    """#
}

/// What lies over the page while picking: a tap picks the element under
/// it, a drag scrolls the page, and the page itself gets neither, so a
/// link or a button is picked and never followed. The current stop's
/// matches are outlined.
struct PickSurface: UIViewRepresentable {
    let pick: ElementPick
    var tint: UIColor

    func makeUIView(context: Context) -> SurfaceView {
        let surface = SurfaceView()
        surface.pick = pick
        return surface
    }

    func updateUIView(_ surface: SurfaceView, context: Context) {
        surface.pick = pick
        surface.tint = tint
        surface.draw(pick.rects)
    }

    final class SurfaceView: UIView {
        var pick: ElementPick?
        var tint: UIColor = .tintColor
        private var shapes = CAShapeLayer()
        private var scrolling = false
        private var pending = CGVector.zero

        override init(frame: CGRect) {
            super.init(frame: frame)
            backgroundColor = .clear
            layer.addSublayer(shapes)
            addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))
            addGestureRecognizer(UIPanGestureRecognizer(target: self, action: #selector(panned)))
            isAccessibilityElement = true
            accessibilityLabel = "Page"
            accessibilityHint = "Tap what you want to remove."
        }

        required init?(coder: NSCoder) { fatalError() }

        func draw(_ rects: [CGRect]) {
            guard let view = pick?.view else { return }
            let path = UIBezierPath()
            for rect in rects {
                path.append(UIBezierPath(roundedRect: view.convert(rect, to: self), cornerRadius: 4))
            }
            shapes.frame = bounds
            shapes.path = path.cgPath
            shapes.fillColor = tint.withAlphaComponent(0.18).cgColor
            shapes.strokeColor = tint.cgColor
            shapes.lineWidth = 2
        }

        @objc private func tapped(_ tap: UITapGestureRecognizer) {
            guard let pick else { return }
            let point = tap.location(in: pick.view)
            Task { await pick.pick(at: point) }
        }

        /// Scrolls the page by the drag. The page scrolls itself, since the
        /// scroll view's offset set from here is put back by WebKit; drags
        /// that come while it does are added up for the next scroll.
        @objc private func panned(_ pan: UIPanGestureRecognizer) {
            let move = pan.translation(in: self)
            pan.setTranslation(.zero, in: self)
            pending.dx += move.x
            pending.dy += move.y
            scrollPending()
        }

        private func scrollPending() {
            guard let pick, !scrolling, pending != .zero else { return }
            let move = pending
            pending = .zero
            scrolling = true
            Task {
                await pick.scroll(by: move)
                scrolling = false
                scrollPending()
            }
        }
    }
}

/// The card over the page while picking, in the Workspace's glass as the
/// media card is: what to tap, then the element chosen, how much around
/// it, how many it hides, and Remove. It rests at the screen's foot over
/// the bar, or at its top, and a drag moves it between the two so it can
/// clear what is being picked.
struct PickCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.appearance) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Bindable var pick: ElementPick
    /// How far above the screen's foot the card rests: clear of the bar.
    let bottomRoom: CGFloat
    let onCancel: () -> Void
    let onRemove: () -> Void

    @State private var atTop = false
    @State private var drag: CGFloat = 0

    private var colors: BarColors {
        BarColors(token: model.tint(of: model.browser.workspaceId.flatMap(model.row)), dark: scheme == .dark)
    }

    var body: some View {
        VStack(spacing: 0) {
            if !atTop { Spacer(minLength: 0) }
            card
                .offset(y: drag)
                .gesture(DragGesture(minimumDistance: 8)
                    .onChanged { drag = $0.translation.height }
                    .onEnded { end in
                        // A drag or a flick past `room` takes it to the
                        // other end.
                        let moved = end.predictedEndTranslation.height
                        let room: CGFloat = 120
                        withAnimation(reduceMotion ? nil : Motion.overlay) {
                            if atTop && moved > room { atTop = false } else if !atTop && moved < -room { atTop = true }
                            drag = 0
                        }
                    })
                .accessibilityAction(named: atTop ? "Move to Bottom" : "Move to Top") {
                    withAnimation(reduceMotion ? nil : Motion.overlay) { atTop.toggle() }
                }
            if atTop { Spacer(minLength: 0) }
        }
        .padding(.bottom, atTop ? 0 : bottomRoom + 8)
        .padding(.top, atTop ? 8 : 0)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(pick.stop?.name ?? "Tap what you want to remove")
                        .font(.system(.body, weight: .semibold))
                    if let stop = pick.stop {
                        Text(stop.count == 1 ? "Removes 1 element on this page" : "Removes \(stop.count) elements on this page")
                            .font(.system(.footnote))
                            .foregroundStyle(colors.muted)
                            .monospacedDigit()
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                CloseCircle(label: "Cancel", diameter: 32, glass: workspaceGlass(colors.layer), action: onCancel)
            }
            if let stop = pick.stop {
                if pick.stops.count > 1 {
                    Slider(value: Binding(get: { Double(pick.depth) }, set: { pick.depth = Int($0.rounded()) }),
                           in: 0...Double(pick.stops.count - 1), step: 1) {
                        Text("How much to remove")
                    } minimumValueLabel: {
                        Image(systemName: "square.inset.filled").accessibilityLabel("Less")
                    } maximumValueLabel: {
                        Image(systemName: "square.dashed.inset.filled").accessibilityLabel("More")
                    }
                    .tint(colors.accent)
                    .accessibilityValue(stop.name)
                }
                Text(pick.line ?? "")
                    .font(.footnote.monospaced())
                    .foregroundStyle(colors.muted)
                    .lineLimit(2)
                    .truncationMode(.middle)
                HStack(spacing: 12) {
                    if let hostScope = pick.hostScope {
                        Menu {
                            Picker("Remove from", selection: $pick.scope) {
                                Text("Only on \(hostScope)").tag(hostScope)
                                Text("Everywhere on \(pick.site)").tag(pick.site)
                            }
                        } label: {
                            Label(pick.scope == pick.site ? "All of \(pick.site)" : hostScope, systemImage: "chevron.up.chevron.down")
                                .labelStyle(.titleAndIcon)
                                .lineLimit(1)
                        }
                        .buttonStyle(.glass)
                    }
                    Spacer(minLength: 0)
                    Button("Remove", systemImage: "eraser", action: onRemove)
                        .buttonStyle(.glassProminent)
                        // The app's main-action blue, as New Tab's.
                        .tint(Theme.blue)
                }
            }
        }
        .glassCard(colors)
        // Over the page, as the media card is: VoiceOver stays in it, and
        // the escape gesture cancels.
        .accessibilityAddTraits(.isModal)
        .accessibilityAction(.escape, onCancel)
    }
}
