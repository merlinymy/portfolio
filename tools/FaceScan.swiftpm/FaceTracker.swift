import ARKit
import CoreImage
import ImageIO
import SceneKit
import SwiftUI

/// Runs TrueDepth face tracking, shows the live mesh as a wireframe, and turns captures into the
/// website's face files (listed in Captures, formats in tools/face/README.md).
final class FaceTracker: NSObject, ObservableObject, ARSCNViewDelegate, ARSessionDelegate {
    enum Activity: Equatable {
        case idle
        case countdown(Int)
        case scanning
        case recording(ClipKind)
        /// Pose `index` of a held-pose sequence; `holding` once its frames are being averaged.
        case pose(PoseSet, index: Int, holding: Bool)
        /// Photo `index` of Captures.textureShots.
        case texture(index: Int)
    }

    @Published private(set) var isSupported = ARFaceTrackingConfiguration.isSupported
    @Published private(set) var isTracking = false
    @Published private(set) var activity: Activity = .idle
    @Published private(set) var progress: Double = 0
    @Published private(set) var message = "Point the front camera at your face."
    @Published private(set) var exports: [URL] = []

    let sceneView = ARSCNView()
    private var scan: ScanAccumulator?
    private var recorder: ClipRecorder?
    private var heldPose: PoseAccumulator?
    /// The running countdown or mouth-shape walkthrough, so Cancel can stop it.
    private var sequence: Task<Void, Never>?
    private var rejectedFrames = 0
    private var isRunning = false
    /// When ARKit last reported the face tracked (see updateTracking).
    private var lastTrackedTime: TimeInterval = 0
    private let imageContext = CIContext()

    override init() {
        super.init()
        sceneView.delegate = self
        sceneView.session.delegate = self
        sceneView.automaticallyUpdatesLighting = false
        sceneView.rendersContinuously = true
        exports = Self.existingExports()
    }

    func start() {
        guard isSupported else {
            message = "This device has no TrueDepth camera (needs iPhone X or newer)."
            return
        }
        // onAppear and the scene becoming active both call this at launch; run the session once.
        guard !isRunning else { return }
        let configuration = ARFaceTrackingConfiguration()
        configuration.isLightEstimationEnabled = false
        configuration.maximumNumberOfTrackedFaces = 1
        sceneView.session.run(configuration, options: [.resetTracking, .removeExistingAnchors])
        isRunning = true
    }

    func pause() {
        isRunning = false
        sceneView.session.pause()
    }

    func hasExport(_ filename: String) -> Bool {
        exports.contains { $0.lastPathComponent == filename }
    }

    // MARK: Actions

    /// Counts down, then averages ~2 s of neutral-face frames into face.json.
    func startScan() {
        guard activity == .idle else { return }
        activity = .countdown(3)
        sequence = Task { @MainActor in
            guard await countdown("Relaxed, neutral face. Look at the camera.") else { return }
            rejectedFrames = 0
            progress = 0
            scan = ScanAccumulator(targetFrames: 120)
            activity = .scanning
            message = "Hold still…"
        }
    }

    /// Counts down, then records blendshapes + head motion for one clip.
    func startRecording(_ clip: ClipKind) {
        guard activity == .idle else { return }
        activity = .countdown(3)
        sequence = Task { @MainActor in
            guard await countdown(clip.direction) else { return }
            progress = 0
            recorder = ClipRecorder(name: clip.name, duration: clip.seconds)
            activity = .recording(clip)
            message = clip.direction
        }
    }

    /// The 15 mouth shapes: 2 s to form each one, then 1.5 s holding it. Saves visemes.json.
    func startVisemes() {
        let shapes = Captures.visemes
        startPoses(.mouth, intro: "\(shapes.count) mouth shapes next. Make just the big sound and hold it while the bar fills. Don't say the whole word.",
                   settle: 2) { [self] poses in
            save(VisemeFile(order: shapes.map(\.id), names: BlendShapes.names, poses: poses.mapValues(\.weights)),
                 as: Captures.visemeFile)
        }
    }

    /// Five gaze directions with the head still: 1.5 s to look, then 1.5 s holding. Saves gaze.json.
    func startGaze() {
        let looks = Captures.gazes
        startPoses(.gaze, intro: "Keep your head still and move only your eyes.", settle: 1.5) { [self] poses in
            save(GazeFile(order: looks.map(\.id), names: BlendShapes.names, poses: poses),
                 as: Captures.gazeFile)
        }
    }

    /// Walks through a held-pose sequence: `settle` seconds to get into each pose, then 1.5 s holding
    /// it while its values are averaged. Calls `finish` once every pose is done.
    private func startPoses(_ set: PoseSet, intro: String, settle: Double,
                            finish: @escaping @MainActor ([String: Pose]) -> Void) {
        guard activity == .idle else { return }
        activity = .countdown(3)
        sequence = Task { @MainActor in
            guard await countdown(intro) else { return }
            var averaged: [String: Pose] = [:]
            for (index, pose) in set.poses.enumerated() {
                activity = .pose(set, index: index, holding: false)
                message = pose.direction
                progress = Double(index) / Double(set.poses.count)
                guard await pause(seconds: settle) else { return }
                heldPose = PoseAccumulator()
                activity = .pose(set, index: index, holding: true)
                guard await pause(seconds: 1.5) else { return }
                let result = heldPose?.average()
                heldPose = nil
                guard let result else {
                    abandon("Lost your face during “\(pose.label)”. Try again in better light.")
                    return
                }
                averaged[pose.id] = result
            }
            finish(averaged)
        }
    }

    /// Takes one front-camera photo per head angle in Captures.textureShots, recording where every
    /// mesh vertex landed in it. Saves the photos as JPEGs plus texture.json.
    func startTexture() {
        guard activity == .idle else { return }
        activity = .countdown(3)
        sequence = Task { @MainActor in
            let shots = Captures.textureShots
            guard await countdown(shots[0].direction) else { return }
            var taken: [TextureFile.Shot] = []
            var photos: [(file: String, data: Data)] = []
            for (index, shot) in shots.enumerated() {
                activity = .texture(index: index)
                message = shot.direction
                progress = Double(index) / Double(shots.count)
                guard await pause(seconds: 2) else { return }

                // Wait up to a second for a frame where the face is tracked.
                var capture: (frame: ARFrame, face: ARFaceAnchor)?
                for _ in 0..<10 {
                    if let frame = sceneView.session.currentFrame,
                       let face = frame.anchors.compactMap({ $0 as? ARFaceAnchor }).first,
                       face.isTracked {
                        capture = (frame, face)
                        break
                    }
                    guard await pause(seconds: 0.1) else { return }
                }
                guard let capture else {
                    abandon("Couldn't see your face for the \(shot.name) photo. Try again.")
                    return
                }
                do {
                    photos.append((shot.imageFile, try jpegData(capture.frame.capturedImage)))
                } catch {
                    abandon("Couldn't encode the \(shot.name) photo: \(error.localizedDescription)")
                    return
                }
                taken.append(makeTextureShot(name: shot.name, image: shot.imageFile,
                                             face: capture.face, camera: capture.frame.camera))
            }
            // Write the photos only once all of them exist, so a cancelled run never leaves new
            // photos next to an old texture.json that describes different ones.
            do {
                for photo in photos {
                    try photo.data.write(to: Self.exportDirectory.appendingPathComponent(photo.file),
                                         options: .atomic)
                }
            } catch {
                abandon("Couldn't save the texture photos: \(error.localizedDescription)")
                return
            }
            save(TextureFile(shots: taken), as: Captures.textureFile)
        }
    }

    func stopRecording() {
        guard let recorder, recorder.frameCount > 30 else {
            cancel()
            return
        }
        finish(recorder)
    }

    func cancel() {
        sequence?.cancel()
        sequence = nil
        scan = nil
        recorder = nil
        heldPose = nil
        activity = .idle
        progress = 0
        message = "Cancelled."
    }

    /// Ends a capture sequence early, showing `text` as the status message.
    private func abandon(_ text: String) {
        sequence = nil
        activity = .idle
        progress = 0
        message = text
    }

    /// Shows 3, 2, 1 under `prompt`. Returns false if cancelled meanwhile.
    @MainActor
    private func countdown(_ prompt: String) async -> Bool {
        message = prompt
        for n in stride(from: 3, through: 1, by: -1) {
            activity = .countdown(n)
            guard await pause(seconds: 1) else { return false }
        }
        return true
    }

    /// Sleeps, returning false if the running sequence was cancelled meanwhile.
    private func pause(seconds: Double) async -> Bool {
        try? await Task.sleep(for: .seconds(seconds))
        return !Task.isCancelled
    }

    // MARK: ARSCNViewDelegate (SceneKit render thread)

    func renderer(_ renderer: SCNSceneRenderer, nodeFor anchor: ARAnchor) -> SCNNode? {
        guard anchor is ARFaceAnchor,
              let device = renderer.device,
              let geometry = ARSCNFaceGeometry(device: device) else { return nil }
        let material = geometry.firstMaterial
        material?.fillMode = .lines
        material?.lightingModel = .constant
        material?.diffuse.contents = UIColor.systemOrange
        return SCNNode(geometry: geometry)
    }

    func renderer(_ renderer: SCNSceneRenderer, didUpdate node: SCNNode, for anchor: ARAnchor) {
        guard let face = anchor as? ARFaceAnchor,
              let geometry = node.geometry as? ARSCNFaceGeometry else { return }
        geometry.update(from: face.geometry)
    }

    // MARK: ARSessionDelegate (main queue)

    func session(_ session: ARSession, didUpdate anchors: [ARAnchor]) {
        guard let face = anchors.compactMap({ $0 as? ARFaceAnchor }).first else { return }
        let time = session.currentFrame?.timestamp ?? CACurrentMediaTime()
        updateTracking(face.isTracked, at: time)
        guard face.isTracked else { return }

        if var current = scan {
            if current.add(face) {
                progress = Double(current.acceptedFrames) / Double(current.targetFrames)
            } else {
                rejectedFrames += 1
                if rejectedFrames % 30 == 0 { message = "Relax your face a little more." }
            }
            scan = current
            if current.isComplete {
                scan = nil
                save(current.makeFile(), as: Captures.faceFile)
            }
        }

        if var current = recorder {
            let done = current.add(face, at: time)
            progress = current.progress(at: time)
            recorder = current
            if done { finish(current) }
        }

        if case .pose(_, _, holding: true) = activity {
            heldPose?.add(face)
        }
    }

    /// ARKit often loses the face for a few frames at a time, so the dot and the buttons only switch
    /// off after half a second without it. Captures still skip every untracked frame.
    private func updateTracking(_ tracked: Bool, at time: TimeInterval) {
        if tracked {
            lastTrackedTime = time
            if !isTracking { isTracking = true }
        } else if isTracking, time - lastTrackedTime > 0.5 {
            isTracking = false
        }
    }

    func session(_ session: ARSession, didFailWithError error: Error) {
        cancel()
        message = "Tracking failed: \(error.localizedDescription)"
    }

    func sessionWasInterrupted(_ session: ARSession) {
        isTracking = false
    }

    // MARK: Files

    private func finish(_ clip: ClipRecorder) {
        recorder = nil
        save(clip.makeFile(), as: "\(clip.name).json")
    }

    private func save<T: Encodable>(_ file: T, as filename: String) {
        sequence = nil
        activity = .idle
        progress = 0
        do {
            let url = Self.exportDirectory.appendingPathComponent(filename)
            try JSONEncoder().encode(file).write(to: url, options: .atomic)
            exports = Self.existingExports()
            message = "Saved \(filename). Share it to your Mac."
        } catch {
            message = "Couldn't save \(filename): \(error.localizedDescription)"
        }
    }

    /// Encodes a camera frame as JPEG data.
    private func jpegData(_ pixelBuffer: CVPixelBuffer) throws -> Data {
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        let quality = [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.92]
        guard let colorSpace = CGColorSpace(name: CGColorSpace.sRGB),
              let data = imageContext.jpegRepresentation(of: image, colorSpace: colorSpace, options: quality)
        else { throw CocoaError(.fileWriteUnknown) }
        return data
    }

    private static var exportDirectory: URL {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    }

    private static func existingExports() -> [URL] {
        Captures.fileNames
            .map { exportDirectory.appendingPathComponent($0) }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
    }
}
