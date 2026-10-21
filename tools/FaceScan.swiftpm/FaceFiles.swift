import ARKit
import simd
import UIKit

// The three JSON formats the website loads (documented in tools/face/README.md):
//   face.json     – my neutral mesh + per-blendshape vertex deltas
//   <clip>.json   – a recorded performance: 52 weights + head rotation per frame
//   visemes.json  – the 52 weights for each of the 15 mouth shapes the lip-sync uses
//   gaze.json     – weights and eye rotations while looking center, left, right, up and down
//   texture.json  – where every vertex landed in each texture-*.jpg photo

struct FaceMeshFile: Encodable {
    struct Eyes: Encodable {
        let left: [Double]
        let right: [Double]
        let radius: Double
    }

    struct Target: Encodable {
        let indices: [Int]
        let deltas: [Double]
    }

    var format = "face-mesh"
    var version = 1
    var source = "arkit-truedepth"
    var units = "m"
    let vertices: [Double]
    let triangles: [Int]
    /// ARKit's texture coordinates, [u0, v0, u1, …], one pair per vertex.
    let uvs: [Double]
    let eyes: Eyes
    let blendshapes: [String: Target]
}

struct FaceClipFile: Encodable {
    var format = "face-clip"
    var version = 1
    let name: String
    let fps: Int
    let names: [String]
    let frames: [[Double]]
    /// Euler angles (x, y, z order, radians) relative to the clip's average pose.
    let head: [[Double]]
    /// Per frame, each eye's rotation relative to the face: [lx, ly, lz, rx, ry, rz], radians,
    /// three.js "XYZ" order.
    let eyes: [[Double]]
    /// Per frame, the point both eyes converge on, in face space (meters).
    let lookAt: [[Double]]
}

/// One held pose, averaged: the 52 weights, both eyes' rotations, and where the eyes converge.
struct Pose: Encodable {
    let weights: [Double]
    /// [lx, ly, lz, rx, ry, rz]: each eye's rotation relative to the face, radians, three.js "XYZ".
    let eyes: [Double]
    /// The point both eyes converge on, in face space (meters).
    let lookAt: [Double]
}

struct GazeFile: Encodable {
    var format = "face-gaze"
    var version = 1
    /// Gaze direction ids in capture order.
    let order: [String]
    /// The 52 blendshape names, in the order every pose lists its weights.
    let names: [String]
    /// Direction id → the averaged pose while looking that way.
    let poses: [String: Pose]
}

struct VisemeFile: Encodable {
    var format = "face-visemes"
    var version = 1
    /// Viseme ids in capture order.
    let order: [String]
    /// The 52 blendshape names, in the order every pose lists its weights.
    let names: [String]
    /// Viseme id → 52 weights, averaged while the mouth shape was held.
    let poses: [String: [Double]]
}

struct TextureFile: Encodable {
    struct Shot: Encodable {
        let name: String
        let image: String
        let width: Int
        let height: Int
        /// Camera position in face space, to tell which vertices faced the camera.
        let cameraInFace: [Double]
        /// Where each mesh vertex landed in the image, in pixels: [x0, y0, x1, y1, …].
        let pixels: [Double]
    }

    var format = "face-texture"
    var version = 1
    let shots: [Shot]
}

/// Projects every vertex of the tracked face into the camera image, so a script can later paint
/// the photo onto the mesh's UV layout.
func makeTextureShot(name: String, image: String, face: ARFaceAnchor, camera: ARCamera) -> TextureFile.Shot {
    let size = camera.imageResolution
    let pixels = face.geometry.vertices.flatMap { vertex -> [Double] in
        let world = face.transform * SIMD4(vertex, 1)
        // The captured image is stored in the sensor's own orientation, landscape right.
        let point = camera.projectPoint(SIMD3(world.x, world.y, world.z),
                                        orientation: .landscapeRight, viewportSize: size)
        return [(Double(point.x) * 10).rounded() / 10, (Double(point.y) * 10).rounded() / 10]
    }
    let cameraInFace = face.transform.inverse * camera.transform.columns.3
    return .init(name: name, image: image, width: Int(size.width), height: Int(size.height),
                 cameraInFace: [cameraInFace.x, cameraInFace.y, cameraInFace.z].map { short($0) },
                 pixels: pixels)
}

/// Rounds in Double so JSONEncoder writes short numbers ("0.01234", not
/// "0.012340000085532665"), keeping the files small.
func short(_ value: Float, places: Int = 5) -> Double {
    let scale = pow(10, Double(places))
    return (Double(value) * scale).rounded() / scale
}

/// Averages neutral-face frames into one clean mesh.
struct ScanAccumulator {
    let targetFrames: Int
    private(set) var acceptedFrames = 0
    private var vertexSum: [SIMD3<Float>] = []
    private var leftEyeSum = SIMD3<Float>(repeating: 0)
    private var rightEyeSum = SIMD3<Float>(repeating: 0)
    private var triangles: [Int16] = []
    private var uvs: [SIMD2<Float>] = []

    init(targetFrames: Int) {
        self.targetFrames = targetFrames
    }

    var isComplete: Bool { acceptedFrames >= targetFrames }

    /// Returns false when the face isn't neutral enough to use.
    mutating func add(_ face: ARFaceAnchor) -> Bool {
        let expression = face.blendShapes
            .filter { !BlendShapes.gaze.contains($0.key) }
            .map { $0.value.floatValue }
            .max() ?? 0
        guard expression < 0.3 else { return false }

        let vertices = face.geometry.vertices
        if vertexSum.isEmpty {
            vertexSum = vertices
            triangles = face.geometry.triangleIndices
            uvs = face.geometry.textureCoordinates
        } else {
            guard vertices.count == vertexSum.count else { return false }
            for i in vertices.indices { vertexSum[i] += vertices[i] }
        }
        leftEyeSum += translation(of: face.leftEyeTransform)
        rightEyeSum += translation(of: face.rightEyeTransform)
        acceptedFrames += 1
        return true
    }

    func makeFile() -> FaceMeshFile {
        let n = Float(acceptedFrames)
        let vertices = vertexSum.flatMap { v in [v.x, v.y, v.z].map { short($0 / n) } }
        let left = leftEyeSum / n
        let right = rightEyeSum / n
        return FaceMeshFile(
            vertices: vertices,
            triangles: triangles.map(Int.init),
            uvs: uvs.flatMap { [short($0.x), short($0.y)] },
            eyes: .init(
                left: [left.x, left.y, left.z].map { short($0) },
                right: [right.x, right.y, right.z].map { short($0) },
                radius: 0.012
            ),
            blendshapes: Self.blendshapeTargets()
        )
    }

    /// Per-blendshape vertex offsets: ARKit's face model with that shape at 1.0,
    /// minus the model at rest. Same topology as the scan, so they apply directly.
    static func blendshapeTargets() -> [String: FaceMeshFile.Target] {
        var rest: [ARFaceAnchor.BlendShapeLocation: NSNumber] = [:]
        for shape in BlendShapes.all { rest[shape.location] = 0 }
        guard let neutral = ARFaceGeometry(blendShapes: rest) else { return [:] }

        var targets: [String: FaceMeshFile.Target] = [:]
        for shape in BlendShapes.all {
            var weights = rest
            weights[shape.location] = 1
            guard let posed = ARFaceGeometry(blendShapes: weights),
                  posed.vertices.count == neutral.vertices.count else { continue }
            var indices: [Int] = []
            var deltas: [Double] = []
            for i in posed.vertices.indices {
                let d = posed.vertices[i] - neutral.vertices[i]
                guard simd_length(d) > 1e-4 else { continue }
                indices.append(i)
                deltas += [short(d.x), short(d.y), short(d.z)]
            }
            targets[shape.name] = .init(indices: indices, deltas: deltas)
        }
        return targets
    }
}

/// Records blendshape weights and head rotation at a fixed frame rate.
struct ClipRecorder {
    let name: String
    let duration: TimeInterval
    let fps = 30
    private var startTime: TimeInterval?
    private var initialRotation: simd_float3x3?
    private var frames: [[Double]] = []
    private var head: [SIMD3<Float>] = []
    private var eyes: [[Double]] = []
    private var lookAt: [[Double]] = []

    init(name: String, duration: TimeInterval) {
        self.name = name
        self.duration = duration
    }

    func progress(at time: TimeInterval) -> Double {
        guard let startTime else { return 0 }
        return min(1, (time - startTime) / duration)
    }

    /// Adds the pose at `time` and returns true once the clip has reached its duration. Frames stay
    /// on a fixed `fps` grid: slots missed while tracking dropped out repeat this pose, so playback
    /// runs at the speed you actually moved.
    mutating func add(_ face: ARFaceAnchor, at time: TimeInterval) -> Bool {
        if startTime == nil { startTime = time }
        let slot = Int((time - startTime!) * Double(fps))
        guard slot >= frames.count else { return false }

        let weights = BlendShapes.all.map { short(face.blendShapes[$0.location]?.floatValue ?? 0, places: 3) }
        let rotation = rotationPart(of: face.transform)
        if initialRotation == nil { initialRotation = rotation }
        let euler = eulerXYZ(initialRotation!.transpose * rotation)
        let eyeRow = eyeAngles(of: face).map { short($0, places: 4) }
        let gaze = face.lookAtPoint
        let lookRow = [gaze.x, gaze.y, gaze.z].map { short($0, places: 4) }
        while frames.count <= slot {
            frames.append(weights)
            head.append(euler)
            eyes.append(eyeRow)
            lookAt.append(lookRow)
        }

        return progress(at: time) >= 1
    }

    var frameCount: Int { frames.count }

    func makeFile() -> FaceClipFile {
        let mean = head.reduce(SIMD3<Float>(repeating: 0), +) / Float(max(head.count, 1))
        return FaceClipFile(
            name: name,
            fps: fps,
            names: BlendShapes.names,
            frames: frames,
            head: head.map { h in
                let centered = h - mean
                return [centered.x, centered.y, centered.z].map { short($0, places: 4) }
            },
            eyes: eyes,
            lookAt: lookAt
        )
    }
}

/// Averages a pose (weights, eye rotations, gaze point) while it's held still.
struct PoseAccumulator {
    private var weights = [Float](repeating: 0, count: BlendShapes.all.count)
    private var eyes = [Float](repeating: 0, count: 6)
    private var lookAt = SIMD3<Float>(repeating: 0)
    private var frames = 0

    mutating func add(_ face: ARFaceAnchor) {
        for (i, shape) in BlendShapes.all.enumerated() {
            weights[i] += face.blendShapes[shape.location]?.floatValue ?? 0
        }
        for (i, angle) in eyeAngles(of: face).enumerated() { eyes[i] += angle }
        lookAt += face.lookAtPoint
        frames += 1
    }

    /// Nil when too few tracked frames arrived to trust the average.
    func average() -> Pose? {
        guard frames >= 15 else { return nil }
        let n = Float(frames)
        let gaze = lookAt / n
        return Pose(
            weights: weights.map { short($0 / n, places: 3) },
            eyes: eyes.map { short($0 / n, places: 4) },
            lookAt: [gaze.x, gaze.y, gaze.z].map { short($0, places: 4) }
        )
    }
}

/// Each eye's rotation relative to the face, as three.js "XYZ" Euler angles: [lx, ly, lz, rx, ry, rz].
func eyeAngles(of face: ARFaceAnchor) -> [Float] {
    let left = eulerXYZ(rotationPart(of: face.leftEyeTransform))
    let right = eulerXYZ(rotationPart(of: face.rightEyeTransform))
    return [left.x, left.y, left.z, right.x, right.y, right.z]
}

private func translation(of m: simd_float4x4) -> SIMD3<Float> {
    SIMD3(m.columns.3.x, m.columns.3.y, m.columns.3.z)
}

private func rotationPart(of m: simd_float4x4) -> simd_float3x3 {
    simd_float3x3(
        SIMD3(m.columns.0.x, m.columns.0.y, m.columns.0.z),
        SIMD3(m.columns.1.x, m.columns.1.y, m.columns.1.z),
        SIMD3(m.columns.2.x, m.columns.2.y, m.columns.2.z)
    )
}

/// Euler angles in three.js "XYZ" order, so the website can apply them directly.
private func eulerXYZ(_ m: simd_float3x3) -> SIMD3<Float> {
    // m[column][row]
    let m11 = m[0][0], m12 = m[1][0], m13 = m[2][0]
    let m22 = m[1][1], m23 = m[2][1]
    let m32 = m[1][2], m33 = m[2][2]
    let y = asin(max(-1, min(1, m13)))
    if abs(m13) < 0.9999999 {
        return SIMD3(atan2(-m23, m33), y, atan2(-m12, m11))
    }
    return SIMD3(atan2(m32, m22), y, 0)
}
