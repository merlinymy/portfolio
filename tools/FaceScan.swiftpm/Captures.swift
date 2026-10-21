import Foundation

/// One recorded expression clip. The website plays one per face state (plan §5.7), keyed by `name`.
struct ClipKind: Identifiable, Equatable {
    let name: String
    let title: String
    let seconds: TimeInterval
    let symbol: String
    /// Shown during the countdown and while recording.
    let direction: String

    var id: String { name }
    var fileName: String { "\(name).json" }
}

/// One pose held still in a guided sequence: a mouth shape or a gaze direction.
struct HeldPose: Identifiable {
    /// The website's key for this pose (Oculus viseme ids for mouth shapes).
    let id: String
    /// Shown large while you hold the pose: the sound to make, or the direction to look.
    let label: String
    let direction: String
    /// Shown under the label, e.g. "as in “father”".
    var hint: String? = nil
}

/// A guided sequence of held poses, each averaged over 1.5 s.
enum PoseSet: Equatable {
    case mouth, gaze

    var poses: [HeldPose] {
        switch self {
        case .mouth: Captures.visemes
        case .gaze: Captures.gazes
        }
    }
}

/// One front-camera photo of your face at a given head angle, for texturing the mesh.
struct TextureShot: Identifiable {
    let name: String
    let direction: String

    var id: String { name }
    var imageFile: String { "texture-\(name).jpg" }
}

/// Everything the app captures. The website reads these files by name (tools/face/README.md).
enum Captures {
    static let faceFile = "face.json"
    static let visemeFile = "visemes.json"
    static let gazeFile = "gaze.json"
    static let textureFile = "texture.json"

    static let clips: [ClipKind] = [
        ClipKind(name: "idle", title: "Idle", seconds: 20, symbol: "eye",
                 direction: "Relax and look around naturally, like you're waiting for someone to speak."),
        ClipKind(name: "listening", title: "Listening", seconds: 15, symbol: "ear",
                 direction: "Listen attentively, like someone is asking you a question. Small nods are good."),
        ClipKind(name: "thinking", title: "Thinking", seconds: 10, symbol: "lightbulb",
                 direction: "Think about a tricky question. Glance up or to the side."),
        ClipKind(name: "talking", title: "Talking", seconds: 30, symbol: "waveform",
                 direction: "Answer an interview question out loud, naturally. Only your brows, blinks and head motion are used."),
        ClipKind(name: "sleeping", title: "Sleeping", seconds: 20, symbol: "moon.zzz",
                 direction: "Close your eyes and breathe slowly, like you're dozing off."),
    ]

    /// The 15 Oculus visemes: every mouth shape English speech needs. The label is the one sound to
    /// hold, not the whole example word: saying the word makes you hold whichever sound it ends on.
    static let visemes: [HeldPose] = [
        HeldPose(id: "sil", label: "rest", direction: "Lips gently together, jaw relaxed, like you're not speaking.",
                 hint: "silence"),
        HeldPose(id: "PP", label: "P · B · M", direction: "Press your lips together and hold, before the sound pops out.",
                 hint: "as at the start of “pop”"),
        HeldPose(id: "FF", label: "F · V", direction: "Rest your top teeth on your lower lip and hold the “fff”.",
                 hint: "as in “fan”"),
        HeldPose(id: "TH", label: "TH", direction: "Put your tongue tip between your teeth and hold the “th”.",
                 hint: "as in “think”"),
        HeldPose(id: "DD", label: "T · D", direction: "Mouth slightly open, tongue tip behind your top teeth.",
                 hint: "as at the start of “day”"),
        HeldPose(id: "kk", label: "K · G", direction: "Mouth slightly open, back of your tongue raised.",
                 hint: "as at the start of “cat”"),
        HeldPose(id: "CH", label: "CH · SH", direction: "Push your lips forward, teeth close together, and hold the “shh”.",
                 hint: "as in “chair”"),
        HeldPose(id: "SS", label: "S · Z", direction: "Teeth almost together, lips relaxed, and hold the hiss.",
                 hint: "as in “sun”"),
        HeldPose(id: "nn", label: "N · L", direction: "Mouth slightly open, tongue tip up behind your teeth.",
                 hint: "as at the start of “no”"),
        HeldPose(id: "RR", label: "R", direction: "Lips slightly rounded and pushed forward, hold the “rrr”.",
                 hint: "as at the start of “red”"),
        HeldPose(id: "aa", label: "AH", direction: "Drop your jaw wide open and hold the “ahh”.",
                 hint: "as in “father”"),
        HeldPose(id: "E", label: "EH", direction: "Mouth half open, lips relaxed, and hold the “ehh”.",
                 hint: "as in “bed”"),
        HeldPose(id: "ih", label: "EE", direction: "Spread your lips wide, teeth close, and hold the “eee”.",
                 hint: "as in “see”"),
        HeldPose(id: "oh", label: "OH", direction: "Round your lips into an O and hold the “ohh”.",
                 hint: "as in “go”"),
        HeldPose(id: "ou", label: "OO", direction: "Push your lips into a small circle and hold the “ooo”.",
                 hint: "as in “blue”"),
    ]

    /// Five gaze directions, to learn how far your eyes and eyelids move when following a pointer.
    static let gazes: [HeldPose] = [
        HeldPose(id: "center", label: "center", direction: "Keep your head still and look straight into the camera."),
        HeldPose(id: "left", label: "left", direction: "Without moving your head, look as far to your left as is comfortable."),
        HeldPose(id: "right", label: "right", direction: "Now look as far to your right as is comfortable."),
        HeldPose(id: "up", label: "up", direction: "Now look up, as far as is comfortable."),
        HeldPose(id: "down", label: "down", direction: "Now look down, as far as is comfortable."),
    ]

    static let textureShots: [TextureShot] = [
        TextureShot(name: "front", direction: "Look straight at the camera with a relaxed face."),
        TextureShot(name: "left", direction: "Keep your face relaxed and turn your head a little to your left."),
        TextureShot(name: "right", direction: "Now turn your head a little to your right."),
    ]

    static var fileNames: [String] {
        [faceFile, visemeFile, gazeFile, textureFile]
            + clips.map(\.fileName)
            + textureShots.map(\.imageFile)
    }
}
