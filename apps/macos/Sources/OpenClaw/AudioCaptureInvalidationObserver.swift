@preconcurrency import AppKit
@preconcurrency import AVFoundation
import Foundation

enum AudioCaptureInvalidationAction: Equatable, Sendable {
    case finalize(String)
    case restart
}

enum AudioCaptureInvalidationPolicy {
    static func action(isCapturing: Bool, transcript: String) -> AudioCaptureInvalidationAction {
        guard isCapturing else { return .restart }
        return .finalize(transcript.trimmingCharacters(in: .whitespacesAndNewlines))
    }
}

final class AudioCaptureInvalidationObserver {
    private let configurationCenter: NotificationCenter
    private let wakeCenter: NotificationCenter
    private let wakeObject: NSObject
    private var configurationObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?

    init(
        configurationCenter: NotificationCenter = .default,
        wakeCenter: NotificationCenter = NSWorkspace.shared.notificationCenter,
        wakeObject: NSObject = NSWorkspace.shared)
    {
        self.configurationCenter = configurationCenter
        self.wakeCenter = wakeCenter
        self.wakeObject = wakeObject
    }

    deinit {
        self.stop()
    }

    func start(engine: AVAudioEngine, onInvalidation: @escaping @Sendable () -> Void) {
        self.stop()
        self.configurationObserver = self.configurationCenter.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil)
        { _ in onInvalidation() }
        self.wakeObserver = self.wakeCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: self.wakeObject,
            queue: nil)
        { _ in onInvalidation() }
    }

    func stop() {
        if let configurationObserver {
            self.configurationCenter.removeObserver(configurationObserver)
        }
        if let wakeObserver {
            self.wakeCenter.removeObserver(wakeObserver)
        }
        self.configurationObserver = nil
        self.wakeObserver = nil
    }
}
