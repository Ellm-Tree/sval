// SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
// Copyright 2026 Ellm Tree, Inc.

import WebKit
import XCTest
@testable import Sval

/// A visit's Allow Video and Audio covers its site's pages for an hour,
/// as a desktop visit does (decision 0132).
final class MediaVisitTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_800_000_000)
    private var visit: Page.Visit { Page.Visit(site: "example.com", since: start) }

    func testItCoversEveryPageOfItsSite() {
        XCTAssertTrue(visit.covers("example.com", at: start + 60))
        XCTAssertTrue(visit.covers("www.example.com", at: start + 60))
        XCTAssertTrue(visit.covers("video.example.com", at: start + 60))
    }

    func testItCoversNoOtherSite() {
        XCTAssertFalse(visit.covers("example.org", at: start + 60))
        XCTAssertFalse(visit.covers("example.com.evil.test", at: start + 60))
    }

    func testItEndsAfterAnHour() {
        XCTAssertTrue(visit.covers("example.com", at: start + 3599))
        XCTAssertFalse(visit.covers("example.com", at: start + 3600))
    }
}

/// What a top-level load does with a page made for one video and audio
/// choice, at a site with another (`mediaLoad`).
@MainActor
final class MediaLoadTests: XCTestCase {
    private func load(_ type: WKNavigationType, appLoading: Bool = false, method: String? = "GET",
                      covered: Bool = false, choice: SiteRules.Media = .block, madeFor: SiteRules.Media = .allow,
                      canRemake: Bool = true) -> Page.MediaLoad {
        Page.mediaLoad(type, appLoading: appLoading, method: method, covered: covered, choice: choice,
                       madeFor: madeFor, canRemake: canRemake)
    }

    func testALinkFollowedToASiteWithAnotherChoiceMakesANewPage() {
        XCTAssertEqual(load(.linkActivated), .remake)
    }

    func testSvalsOwnLoadMakesANewPage() {
        XCTAssertEqual(load(.other, appLoading: true), .remake)
    }

    func testALinkToASiteWithTheSameChoiceKeepsThePage() {
        XCTAssertEqual(load(.linkActivated, choice: .allow), .keep(.allow))
    }

    /// A page's own script load, a reload and Back and Forward keep the
    /// page, guarded by the site's choice.
    func testALoadTheUserDidNotAskForKeepsThePageGuarded() {
        XCTAssertEqual(load(.other), .keep(.block))
        XCTAssertEqual(load(.reload), .keep(.block))
        XCTAssertEqual(load(.backForward), .keep(.block))
    }

    func testAPostKeepsThePage() {
        XCTAssertEqual(load(.linkActivated, method: "POST"), .keep(.block))
    }

    func testALoadAVisitCoversIsAllowed() {
        XCTAssertEqual(load(.linkActivated, covered: true), .keep(.allow))
        XCTAssertEqual(load(.reload, covered: true), .keep(.allow))
    }

    func testAPageNothingCanRemakeIsKept() {
        XCTAssertEqual(load(.linkActivated, canRemake: false), .keep(.block))
    }
}

/// Sval suspends a page's media for each of its reasons, and tells WebKit
/// once as the first comes and once as the last goes, since WebKit counts
/// its suspensions.
final class MediaSuspensionTests: XCTestCase {
    func testOnlyTheFirstReasonSuspends() {
        var held = Page.Suspensions()
        XCTAssertTrue(held.add(.deny))
        XCTAssertFalse(held.add(.hold))
        XCTAssertFalse(held.add(.hold))
        XCTAssertEqual(held.reasons, [.deny, .hold])
    }

    func testOnlyTheLastReasonGoingResumes() {
        var held = Page.Suspensions()
        _ = held.add(.deny)
        _ = held.add(.privacy)
        XCTAssertFalse(held.remove([.privacy]))
        XCTAssertFalse(held.remove([.hold]), "a reason not held changes nothing")
        XCTAssertTrue(held.remove([.deny]))
        XCTAssertFalse(held.remove([.deny]), "nothing is left to resume")
        XCTAssertTrue(held.add(.hold), "and the next reason suspends again")
    }

    func testReasonsGoingTogetherResumeOnce() {
        var held = Page.Suspensions()
        _ = held.add(.hold)
        _ = held.add(.privacy)
        XCTAssertTrue(held.remove([.hold, .privacy]))
    }
}

/// A page's media controls are for media the user can see or hear: a
/// muted video off the screen plays on without them.
final class PlayingFramesTests: XCTestCase {
    func testMediaShownAndHeardIsPerceived() {
        var frames = PlayingFrames()
        XCTAssertTrue(frames.report("a", playing: true, muted: false, unseen: false))
        XCTAssertTrue(frames.perceived)
        XCTAssertFalse(frames.allMuted)
    }

    func testMutedMediaInViewIsPerceivedMuted() {
        var frames = PlayingFrames()
        XCTAssertTrue(frames.report("a", playing: true, muted: true, unseen: false))
        XCTAssertTrue(frames.perceived)
        XCTAssertTrue(frames.allMuted)
    }

    func testUnseenMediaPlaysWithoutControls() {
        var frames = PlayingFrames()
        XCTAssertFalse(frames.report("a", playing: true, muted: true, unseen: true))
        XCTAssertFalse(frames.perceived)
        XCTAssertFalse(frames.isEmpty, "it still plays, so a pause covers it")
    }

    func testUnseenMediaComingIntoViewGetsControls() {
        var frames = PlayingFrames()
        _ = frames.report("a", playing: true, muted: true, unseen: true)
        XCTAssertTrue(frames.report("a", playing: true, muted: true, unseen: false))
        XCTAssertTrue(frames.perceived)
    }

    /// An unseen frame's sound says nothing of what the user hears.
    func testOnlyFramesInViewSayWhetherAllIsMuted() {
        var frames = PlayingFrames()
        _ = frames.report("seen", playing: true, muted: true, unseen: false)
        XCTAssertFalse(frames.report("hidden", playing: true, muted: true, unseen: true))
        XCTAssertTrue(frames.allMuted)
        XCTAssertTrue(frames.report("other", playing: true, muted: false, unseen: false))
        XCTAssertFalse(frames.allMuted)
    }

    func testTheLastFrameInViewStoppingEndsWhatIsPerceived() {
        var frames = PlayingFrames()
        _ = frames.report("seen", playing: true, muted: false, unseen: false)
        _ = frames.report("hidden", playing: true, muted: true, unseen: true)
        XCTAssertTrue(frames.report("seen", playing: false, muted: false, unseen: false))
        XCTAssertFalse(frames.perceived)
        XCTAssertFalse(frames.isEmpty)
    }

    func testTheSameReportAgainChangesNothing() {
        var frames = PlayingFrames()
        _ = frames.report("a", playing: true, muted: false, unseen: false)
        XCTAssertFalse(frames.report("a", playing: true, muted: false, unseen: false))
    }
}
