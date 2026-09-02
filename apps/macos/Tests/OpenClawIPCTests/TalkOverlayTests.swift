import AppKit
import QuartzCore
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

        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            NSAnimationContext.runAnimationGroup { _ in
                controller.dismiss()
                controller.present()
                if dismissAgain { controller.dismiss() }
            } completionHandler: {
                // The factory queues its dismissal completion on MainActor after AppKit finishes.
                Task { @MainActor in continuation.resume() }
            }
            // Commit animations without relying on the test runner's next run-loop iteration.
            CATransaction.flush()
        }

        #expect(controller.model.isVisible == !dismissAgain)
        #expect(window.isVisible == !dismissAgain)
        #expect(window.alphaValue == (dismissAgain ? 0 : 1))
    }
}
