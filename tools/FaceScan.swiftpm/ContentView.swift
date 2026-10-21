import ARKit
import SwiftUI

struct ContentView: View {
    @StateObject private var tracker = FaceTracker()
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack(alignment: .bottom) {
            FaceSceneView(sceneView: tracker.sceneView)
                .ignoresSafeArea()

            prompt

            controls
                .padding()
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24))
                .padding()
        }
        .onAppear { tracker.start() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { tracker.start() } else { tracker.pause() }
        }
    }

    /// The large centered prompt: the countdown number, or the mouth shape to make.
    @ViewBuilder private var prompt: some View {
        switch tracker.activity {
        case .countdown(let n):
            Text("\(n)")
                .font(.system(size: 96, weight: .bold, design: .rounded))
                .foregroundStyle(.orange)
                .frame(maxHeight: .infinity)
        case .viseme(let index, let holding):
            let viseme = Captures.visemes[index]
            VStack(spacing: 8) {
                Text(viseme.example)
                    .font(.system(size: 56, weight: .bold, design: .rounded))
                Text(holding ? "Hold still" : "Make the shape")
                    .font(.title3.weight(.semibold))
                    .foregroundStyle(holding ? .green : .orange)
                Text("\(index + 1) of \(Captures.visemes.count)")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            .padding()
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 20))
            .frame(maxHeight: .infinity, alignment: .top)
            .padding(.top, 60)
        default:
            EmptyView()
        }
    }

    private var controls: some View {
        VStack(spacing: 14) {
            HStack(spacing: 8) {
                Circle()
                    .fill(tracker.isTracking ? Color.green : Color.red)
                    .frame(width: 10, height: 10)
                Text(tracker.message)
                    .font(.callout)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }

            if tracker.activity != .idle {
                ProgressView(value: tracker.progress)
                    .tint(.orange)
            }

            switch tracker.activity {
            case .recording:
                Button("Stop and save", role: .destructive) { tracker.stopRecording() }
                    .buttonStyle(.borderedProminent)
            case .scanning, .countdown, .viseme:
                Button("Cancel", role: .cancel) { tracker.cancel() }
                    .buttonStyle(.bordered)
            case .idle:
                captureButtons
                    .disabled(!tracker.isTracking)
            }

            if !tracker.exports.isEmpty && tracker.activity == .idle {
                ShareLink(items: tracker.exports) {
                    Label("Share \(tracker.exports.count) of \(Captures.fileNames.count) files",
                          systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.orange)
            }
        }
    }

    private var captureButtons: some View {
        VStack(spacing: 10) {
            Button {
                tracker.startScan()
            } label: {
                captureLabel("1. Scan neutral face", symbol: "face.dashed", file: Captures.faceFile)
            }
            .buttonStyle(.borderedProminent)

            Text("2. Expression clips")
                .font(.caption)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(Captures.clips) { clip in
                    Button {
                        tracker.startRecording(clip)
                    } label: {
                        captureLabel("\(clip.title) · \(Int(clip.seconds))s", symbol: clip.symbol, file: clip.fileName)
                    }
                }
            }
            .buttonStyle(.bordered)

            Button {
                tracker.startVisemes()
            } label: {
                captureLabel("3. Mouth shapes (\(Captures.visemes.count))", symbol: "mouth", file: Captures.visemeFile)
            }
            .buttonStyle(.bordered)
        }
    }

    /// A capture button's label, which turns into a checkmark once its file exists.
    private func captureLabel(_ title: String, symbol: String, file: String) -> some View {
        Label(title, systemImage: tracker.hasExport(file) ? "checkmark.circle.fill" : symbol)
            .frame(maxWidth: .infinity)
    }
}

/// Hosts the tracker's ARSCNView, which draws the live face mesh as a wireframe.
struct FaceSceneView: UIViewRepresentable {
    let sceneView: ARSCNView

    func makeUIView(context: Context) -> ARSCNView { sceneView }

    func updateUIView(_ uiView: ARSCNView, context: Context) {}
}
