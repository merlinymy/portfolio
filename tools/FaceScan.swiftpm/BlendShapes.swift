import ARKit

/// ARKit's 52 blendshapes, paired with the camelCase names the website uses
/// (ARKit's own raw values look like "eyeBlink_L", so they're spelled out here).
enum BlendShapes {
    static let all: [(name: String, location: ARFaceAnchor.BlendShapeLocation)] = [
        ("eyeBlinkLeft", .eyeBlinkLeft),
        ("eyeLookDownLeft", .eyeLookDownLeft),
        ("eyeLookInLeft", .eyeLookInLeft),
        ("eyeLookOutLeft", .eyeLookOutLeft),
        ("eyeLookUpLeft", .eyeLookUpLeft),
        ("eyeSquintLeft", .eyeSquintLeft),
        ("eyeWideLeft", .eyeWideLeft),
        ("eyeBlinkRight", .eyeBlinkRight),
        ("eyeLookDownRight", .eyeLookDownRight),
        ("eyeLookInRight", .eyeLookInRight),
        ("eyeLookOutRight", .eyeLookOutRight),
        ("eyeLookUpRight", .eyeLookUpRight),
        ("eyeSquintRight", .eyeSquintRight),
        ("eyeWideRight", .eyeWideRight),
        ("jawForward", .jawForward),
        ("jawLeft", .jawLeft),
        ("jawRight", .jawRight),
        ("jawOpen", .jawOpen),
        ("mouthClose", .mouthClose),
        ("mouthFunnel", .mouthFunnel),
        ("mouthPucker", .mouthPucker),
        ("mouthLeft", .mouthLeft),
        ("mouthRight", .mouthRight),
        ("mouthSmileLeft", .mouthSmileLeft),
        ("mouthSmileRight", .mouthSmileRight),
        ("mouthFrownLeft", .mouthFrownLeft),
        ("mouthFrownRight", .mouthFrownRight),
        ("mouthDimpleLeft", .mouthDimpleLeft),
        ("mouthDimpleRight", .mouthDimpleRight),
        ("mouthStretchLeft", .mouthStretchLeft),
        ("mouthStretchRight", .mouthStretchRight),
        ("mouthRollLower", .mouthRollLower),
        ("mouthRollUpper", .mouthRollUpper),
        ("mouthShrugLower", .mouthShrugLower),
        ("mouthShrugUpper", .mouthShrugUpper),
        ("mouthPressLeft", .mouthPressLeft),
        ("mouthPressRight", .mouthPressRight),
        ("mouthLowerDownLeft", .mouthLowerDownLeft),
        ("mouthLowerDownRight", .mouthLowerDownRight),
        ("mouthUpperUpLeft", .mouthUpperUpLeft),
        ("mouthUpperUpRight", .mouthUpperUpRight),
        ("browDownLeft", .browDownLeft),
        ("browDownRight", .browDownRight),
        ("browInnerUp", .browInnerUp),
        ("browOuterUpLeft", .browOuterUpLeft),
        ("browOuterUpRight", .browOuterUpRight),
        ("cheekPuff", .cheekPuff),
        ("cheekSquintLeft", .cheekSquintLeft),
        ("cheekSquintRight", .cheekSquintRight),
        ("noseSneerLeft", .noseSneerLeft),
        ("noseSneerRight", .noseSneerRight),
        ("tongueOut", .tongueOut),
    ]

    static let names = all.map { $0.name }

    /// Gaze shapes don't count as "expression" when checking for a neutral face.
    static let gaze: Set<ARFaceAnchor.BlendShapeLocation> = [
        .eyeLookDownLeft, .eyeLookInLeft, .eyeLookOutLeft, .eyeLookUpLeft,
        .eyeLookDownRight, .eyeLookInRight, .eyeLookOutRight, .eyeLookUpRight,
    ]
}
