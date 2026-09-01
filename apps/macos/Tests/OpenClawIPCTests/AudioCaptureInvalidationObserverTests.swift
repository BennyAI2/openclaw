import AppKit
import AVFoundation
import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct AudioCaptureInvalidationObserverTests {
    @Test func observesEngineChangesAndWorkspaceWakeUntilStopped() {
        let configurationCenter = NotificationCenter()
        let wakeCenter = NotificationCenter()
        let wakeObject = NSObject()
        let engine = AVAudioEngine()
        let recorder = InvalidationRecorder()
        let observer = AudioCaptureInvalidationObserver(
            configurationCenter: configurationCenter,
            wakeCenter: wakeCenter,
            wakeObject: wakeObject)

        observer.start(engine: engine) {
            recorder.record()
        }
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: engine)
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: wakeObject)
        #expect(recorder.count == 2)

        observer.stop()
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: engine)
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: wakeObject)
        #expect(recorder.count == 2)
    }

    @Test func ignoresOtherEnginesAndWakeObjects() {
        let configurationCenter = NotificationCenter()
        let wakeCenter = NotificationCenter()
        let wakeObject = NSObject()
        let observedEngine = AVAudioEngine()
        let recorder = InvalidationRecorder()
        let observer = AudioCaptureInvalidationObserver(
            configurationCenter: configurationCenter,
            wakeCenter: wakeCenter,
            wakeObject: wakeObject)

        observer.start(engine: observedEngine) {
            recorder.record()
        }
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: AVAudioEngine())
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: NSObject())
        #expect(recorder.count == 0)
    }

    @Test(arguments: [
        (true, "  partial command  ", AudioCaptureInvalidationAction.finalize("partial command")),
        (true, "   ", AudioCaptureInvalidationAction.finalize("")),
        (false, "stale", AudioCaptureInvalidationAction.restart),
    ])
    func preservesActiveCapture(
        isCapturing: Bool,
        transcript: String,
        expected: AudioCaptureInvalidationAction)
    {
        #expect(AudioCaptureInvalidationPolicy.action(
            isCapturing: isCapturing,
            transcript: transcript) == expected)
    }
}

private final class InvalidationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    var count: Int {
        self.lock.withLock { self.value }
    }

    func record() {
        self.lock.withLock { self.value += 1 }
    }
}
