import ARKit
import simd

// The three JSON formats the website loads (documented in tools/face/README.md):
//   face.json     – my neutral mesh + per-blendshape vertex deltas
//   <clip>.json   – a recorded performance: 52 weights + head rotation per frame
//   visemes.json  – the 52 weights for each of the 15 mouth shapes the lip-sync uses

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
        while frames.count <= slot {
            frames.append(weights)
            head.append(euler)
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
            }
        )
    }
}

/// Averages the 52 blendshape weights while one mouth shape is held still.
struct VisemeAccumulator {
    private var sums = [Float](repeating: 0, count: BlendShapes.all.count)
    private var frames = 0

    mutating func add(_ face: ARFaceAnchor) {
        for (i, shape) in BlendShapes.all.enumerated() {
            sums[i] += face.blendShapes[shape.location]?.floatValue ?? 0
        }
        frames += 1
    }

    /// Nil when too few tracked frames arrived to trust the average.
    func average() -> [Double]? {
        guard frames >= 15 else { return nil }
        return sums.map { short($0 / Float(frames), places: 3) }
    }
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
