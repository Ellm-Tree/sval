// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import Observation
import XCTest
@testable import Sval

/// Two devices' documents and a folder between them, as the tests of the
/// tree store drive them.
@MainActor
final class TwoDevices {
    let phone = SvalDocument(), desktop = SvalDocument()
    private let key = Data(repeating: 7, count: 32)
    private let phoneId = Data(repeating: 1, count: 16), desktopId = Data(repeating: 2, count: 16)
    private var folder: [String: Data] = [:]
    private var now = 1_000.0

    static func id(_ n: Int) -> String { String(format: "00000000-0000-4000-8000-%012d", n) }

    func phoneEdits(_ ops: String) {
        now += 1_000
        _ = try? phone.applyBatch(opsJson: ops, deviceId: phoneId, now: now)
    }

    /// The desktop's edit, published to the folder.
    func desktopEdits(_ ops: String) {
        now += 1_000
        _ = try? desktop.applyBatch(opsJson: ops, deviceId: desktopId, now: now)
        pass(desktop, desktopId)
    }

    /// The phone's pass against the folder.
    func phoneSyncs() {
        pass(phone, phoneId)
    }

    private func pass(_ document: SvalDocument, _ device: Data) {
        now += 1_000
        let files = folder.map { PeerFile(path: $0.key, bytes: $0.value) }
        let result = try! document.sync(key: key, deviceId: device, workspace: "workspaces", files: files, now: now,
                                         shared: true)
        if let path = result.writePath, let bytes = result.writeBytes { folder[path] = bytes }
    }
}

/// The tree store, refreshed from a plain document after every step,
/// against a whole read of that document.
@MainActor
final class TreeStoreTests: XCTestCase {
    private func assertWhole(_ store: TreeStore, _ document: SvalDocument, own: [OutlineRow], _ step: String) {
        let rows = document.outline() + own
        XCTAssertEqual(store.index.rows, rows, step)
        let whole = OutlineIndex(rows)
        for row in rows {
            XCTAssertEqual(store.box(row.id)?.row, whole.row(row.id), step)
            XCTAssertEqual(store.index.children(of: row.id), whole.children(of: row.id), step)
            XCTAssertEqual(store.index.workspace(of: row.id), whole.workspace(of: row.id), step)
            XCTAssertEqual(store.index.tabs(in: row.id), whole.tabs(in: row.id), step)
            XCTAssertTrue(store.index.inside(row.id) == whole.inside(row.id), step)
        }
    }

    /// Whether reading `box`'s row during `body` is told of a change.
    private func notifies(_ box: RowBox, during body: () -> Void) -> Bool {
        var told = false
        withObservationTracking { _ = box.row } onChange: { told = true }
        body()
        return told
    }

    func testTheStoreEqualsAWholeReadAfterEveryStep() async {
        let devices = TwoDevices()
        let store = TreeStore()
        let id = TwoDevices.id
        let privateSession = SvalDocument()
        var own: [OutlineRow] = []
        let steps: [(String, TreeStore.Change?, () -> Void)] = [
            ("the desktop's tree arrives", .structure, {
                devices.desktopEdits(#"""
                    [{"kind":"addWorkspace","name":"Work","id":"\#(id(1))"},
                     {"kind":"addGroup","parent":"\#(id(1))","name":"Docs","id":"\#(id(2))"},
                     {"kind":"addTab","parent":"\#(id(2))","name":"One","url":"https://one.example/","id":"\#(id(3))"},
                     {"kind":"addTab","parent":"\#(id(1))","name":"Two","url":"https://two.example/","id":"\#(id(4))"}]
                    """#)
                devices.phoneSyncs()
            }),
            ("a rename here", .content, {
                devices.phoneEdits(#"[{"kind":"rename","id":"\#(id(3))","name":"Uno"}]"#)
            }),
            ("a label here", .content, {
                devices.phoneEdits(#"[{"kind":"setLabel","id":"\#(id(4))","label":"Mine"}]"#)
            }),
            ("a rename merged", .content, {
                devices.desktopEdits(#"[{"kind":"rename","id":"\#(id(4))","name":"Dos"}]"#)
                devices.phoneSyncs()
            }),
            ("a move here", .structure, {
                devices.phoneEdits(#"[{"kind":"moveNode","id":"\#(id(3))","newParent":"\#(id(1))"}]"#)
            }),
            ("a private session", .structure, {
                _ = try? privateSession.applyBatch(
                    opsJson: #"[{"kind":"addWorkspace","name":"Private","id":"\#(id(9))"}]"#,
                    deviceId: Data(repeating: 3, count: 16), now: 1)
                own = privateSession.outline()
            }),
            ("a close here", .structure, {
                devices.phoneEdits(#"[{"kind":"remove","id":"\#(id(4))"}]"#)
            }),
            ("nothing", TreeStore.Change.none, {}),
            ("a refused edit", TreeStore.Change.none, {
                devices.phoneEdits(#"[{"kind":"remove","id":"\#(id(77))"}]"#)
            }),
            ("a group closed elsewhere", nil, {
                devices.desktopEdits(#"[{"kind":"remove","id":"\#(id(2))"}]"#)
                devices.phoneSyncs()
            }),
            ("more renames than the document remembers", .structure, {
                for n in 0..<70 {
                    devices.phoneEdits(#"[{"kind":"rename","id":"\#(id(1))","name":"W\#(n)"}]"#)
                }
            }),
        ]
        // What the pages and the previews kept follow: which rows there
        // are, where, and of what kind.
        func shape(_ index: OutlineIndex) -> [String] {
            index.rows.map { "\($0.id) \($0.parentId ?? "") \($0.depth) \($0.kind)" }
        }
        for (name, expected, step) in steps {
            step()
            let before = shape(store.index)
            let change = await store.refresh(from: devices.phone, own: own)
            if let expected { XCTAssertEqual(change, expected, name) }
            if change != .structure { XCTAssertEqual(shape(store.index), before, name) }
            assertWhole(store, devices.phone, own: own, name)
        }
    }

    /// A content change writes the boxes of the rows it changed alone, and
    /// a rebuild keeps every box, writing only those whose row changed.
    func testOnlyTheBoxesOfChangedRowsChange() async {
        let devices = TwoDevices()
        let store = TreeStore()
        let id = TwoDevices.id
        devices.phoneEdits(#"""
            [{"kind":"addWorkspace","name":"Work","id":"\#(id(1))"},
             {"kind":"addTab","parent":"\#(id(1))","name":"One","url":"https://one.example/","id":"\#(id(3))"},
             {"kind":"addTab","parent":"\#(id(1))","name":"Two","url":"https://two.example/","id":"\#(id(4))"}]
            """#)
        await store.refresh(from: devices.phone, own: [])
        let work = store.box(id(1))!, one = store.box(id(3))!
        devices.phoneEdits(#"[{"kind":"rename","id":"\#(id(3))","name":"Uno"}]"#)
        var change = TreeStore.Change.none
        let read = devices.phone.treeRead(since: store.revision)
        XCTAssertFalse(notifies(work) { change = store.install(read, own: []) })
        XCTAssertEqual(change, .content)
        devices.phoneEdits(#"[{"kind":"remove","id":"\#(id(4))"}]"#)
        let closed = devices.phone.treeRead(since: store.revision)
        XCTAssertFalse(notifies(one) { change = store.install(closed, own: []) })
        XCTAssertEqual(change, .structure)
        XCTAssertTrue(store.box(id(1)) === work && store.box(id(3)) === one)
        XCTAssertEqual(one.row.name, "Uno")
    }

    /// A read older than the rows held is never installed over them.
    func testAnOlderReadIsNotInstalled() async {
        let devices = TwoDevices()
        let store = TreeStore()
        let id = TwoDevices.id
        devices.phoneEdits(#"[{"kind":"addWorkspace","name":"Work","id":"\#(id(1))"}]"#)
        await store.refresh(from: devices.phone, own: [])
        let held = store.revision
        devices.phoneEdits(#"[{"kind":"rename","id":"\#(id(1))","name":"Old"}]"#)
        let older = devices.phone.treeRead(since: held)
        devices.phoneEdits(#"[{"kind":"addTab","parent":"\#(id(1))","name":"T","url":"https://t.example/","id":"\#(id(2))"}]"#)
        await store.refresh(from: devices.phone, own: [])
        XCTAssertEqual(store.install(older, own: []), .none)
        assertWhole(store, devices.phone, own: [], "after the older read")
        XCTAssertEqual(store.install(devices.phone.treeRead(since: nil), own: []), .none)
    }
}
