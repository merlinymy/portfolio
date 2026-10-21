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

/// One mouth shape for lip-sync. `id` is the Oculus viseme name the website uses.
struct Viseme: Identifiable {
    let id: String
    /// The word shown large while you make the shape.
    let example: String
    let direction: String
}

/// Everything the app captures. The website reads these files by name (tools/face/README.md).
enum Captures {
    static let faceFile = "face.json"
    static let visemeFile = "visemes.json"

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

    /// The 15 Oculus visemes: every mouth shape English speech needs.
    static let visemes: [Viseme] = [
        Viseme(id: "sil", example: "rest", direction: "Close your lips gently and relax, like you're not speaking."),
        Viseme(id: "PP", example: "pop", direction: "Press your lips together, like the start of “pop”."),
        Viseme(id: "FF", example: "fan", direction: "Rest your top teeth on your lower lip, like “fan”."),
        Viseme(id: "TH", example: "think", direction: "Put your tongue tip between your teeth, like “think”."),
        Viseme(id: "DD", example: "day", direction: "Open slightly with your tongue behind your top teeth, like “day”."),
        Viseme(id: "kk", example: "cat", direction: "Open slightly and raise the back of your tongue, like “cat”."),
        Viseme(id: "CH", example: "chair", direction: "Push your lips forward a little with your teeth close, like “chair”."),
        Viseme(id: "SS", example: "sun", direction: "Bring your teeth almost together, lips relaxed, like “sun”."),
        Viseme(id: "nn", example: "no", direction: "Open slightly with your tongue up, like “no”."),
        Viseme(id: "RR", example: "red", direction: "Round your lips slightly, like “red”."),
        Viseme(id: "aa", example: "father", direction: "Drop your jaw wide open, like “father”."),
        Viseme(id: "E", example: "bed", direction: "Open your mouth with your lips spread a little, like “bed”."),
        Viseme(id: "ih", example: "see", direction: "Spread your lips wide with your teeth close, like “see”."),
        Viseme(id: "oh", example: "go", direction: "Round your lips into an O, like “go”."),
        Viseme(id: "ou", example: "blue", direction: "Push your lips into a small circle, like “blue”."),
    ]

    static var fileNames: [String] { [faceFile, visemeFile] + clips.map(\.fileName) }
}
