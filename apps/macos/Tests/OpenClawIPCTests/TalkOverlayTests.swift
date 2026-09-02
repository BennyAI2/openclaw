import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TalkOverlayTests {
    @Test(arguments: [false, true])
    func `latest presentation intent survives an interrupted dismissal`(dismissAgain: Bool) async throws {
        _ = NSApplication.shared
        let controller = TalkOverlayController()
        controller.present()
        let window = try #require(NSApplication.shared.windows.first {
            ($0.contentView as? NSHostingView<TalkOverlayView>)?.rootView.controller === controller
        })
        defer { window.orderOut(nil) }

        controller.dismiss()
        controller.present()
        if dismissAgain { controller.dismiss() }
        try await Task.sleep(for: .milliseconds(400))

        #expect(controller.model.isVisible == !dismissAgain)
        #expect(window.isVisible == !dismissAgain)
        #expect(window.alphaValue == (dismissAgain ? 0 : 1))
    }
}
