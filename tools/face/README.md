# Face capture

How to capture your face for the website with the iPhone app in `tools/FaceScan.swiftpm`, and the
formats of the files it produces.

## Run the app on your iPhone

1. Open `tools/FaceScan.swiftpm` in Xcode.
2. Plug in an iPhone with Face ID; the app needs its front TrueDepth camera. If the iPhone asks,
   turn on Developer Mode in Settings → Privacy & Security → Developer Mode.
3. In Xcode, pick your iPhone as the run destination. If Xcode reports a signing problem, choose
   your team in the app's Signing settings: `Package.swift` names team `5R593RC487`.
4. Press Run. The first time, the iPhone may ask you to trust the developer in Settings → General →
   VPN & Device Management.

## Capture

**Setup:**
- Prop the phone at eye level, about 30–40 cm away, and don't hold it. Head movement is recorded
  relative to the phone, so a moving phone reads as a moving head.
- Use soft, even light on your face, with no bright window behind you. Take glasses off if you can.

Each capture starts with a 3-2-1 countdown, and its button shows a checkmark once the file is saved.
Capturing again overwrites the file.

**Tracking dropouts are normal.** ARKit, Apple's face-tracking system, often loses a face for a few
frames at a time:
- The status dot turns red, and the buttons grey out, only after half a second without your face.
- The orange wireframe is ARKit's raw view, so it may still flicker briefly.
- Captures skip untracked frames. A clip holds the last pose through a dropout, so its timing stays
  true.

Launching the app from the Mac with its log streaming (`devicectl --console`) slows it enough to
make dropouts constant. Open it from the home screen for real captures.

| Step | Button | Time | What to do |
|---|---|---|---|
| 1 | Scan neutral face | about 5 s | Relaxed face, mouth closed, eyes open, looking at the camera. Frames with any expression are skipped; if it says "Relax your face a little more", soften your brows and mouth. |
| 2 | Idle | 20 s | Relax and look around naturally, like you're waiting for someone to speak. |
| 2 | Listening | 15 s | Listen attentively, like someone is asking you a question. Small nods are good. |
| 2 | Thinking | 10 s | Think about a tricky question. Glance up or to the side. |
| 2 | Talking | 30 s | Answer an interview question out loud. Only your brows, blinks and head movement are used; the mouth comes from lip-sync. |
| 2 | Sleeping | 20 s | Close your eyes and breathe slowly, like you're dozing off. Shown when the server is offline. |
| 3 | Mouth shapes | about 1 min | 15 shapes. For each one you get 2 s to form it, then hold it still for 1.5 s while the bar fills. Exaggerate a little. If one goes wrong, run the whole set again. |

## Get the files to the Mac

Tap **Share**, AirDrop the files to this Mac, and move them into `tools/face/raw/`. Git ignores that
folder; the website's build turns it into `apps/site/public/face/`.

## Voice sample (for the voice clone, phase 3)

While you're set up, record yourself reading the text below with Voice Memos, in a quiet room, at a
normal speaking pace. It takes about 35 seconds.
- **Read it exactly.** The voice model needs the exact transcript of the sample, and this text is
  that transcript.
- **Save it privately** as `knowledge/voice/sample.m4a`. `knowledge/` is ignored by git, and a voice
  sample shouldn't be public.

> I'm Merlin. I build AI tools for experts outside tech, from the data pipeline to the interface
> they use, and I care most about whether the answers are actually right. I started in geology at
> UC Santa Cruz and got hooked on code analyzing seismic data. After a master's in analytics and a
> software job at a startup, I'm now finishing a master's in computer science at Northeastern,
> graduating January 2028. My proudest work is a research assistant for a postdoctoral
> biochemistry researcher. It helped him write a grant proposal that won half a million dollars.

## File formats

**Coordinates.** All positions are in meters, in ARKit's face space:
- **Origin:** inside the head, behind the nose.
- **Axes:** +x toward the viewer's right (your own left), +y up, +z out of the face toward the
  camera.
- **In three.js:** this is the space a face uses when it looks at a camera placed on +z, so no
  mirroring or axis swap is needed.

**Blendshapes.** These are ARKit's 52 named face sliders, such as `jawOpen` or `eyeBlinkLeft`. Each
runs from 0 (not at all) to 1 (fully). Every file that lists slider values uses the same 52 names
in the same order, given by its `names` field.

### `face.json`: your neutral face

| Field | Meaning |
|---|---|
| `format`, `version` | `"face-mesh"`, `1` |
| `source`, `units` | `"arkit-truedepth"`, `"m"` |
| `vertices` | Flat list `[x0, y0, z0, x1, …]`. Your face's points (1,220 on current iPhones), each averaged over 120 neutral frames. |
| `triangles` | Flat list of vertex indices, 3 per triangle. |
| `eyes` | `{ left: [x, y, z], right: [x, y, z], radius }`: eye centers, and the eyeball radius the site draws (0.012 m). |
| `blendshapes` | Slider name → `{ indices, deltas }`. How each listed vertex moves when that slider is at 1: `deltas` is flat `[dx, dy, dz, …]`, one triple per index. Only vertices that move more than 0.1 mm are listed. The offsets come from Apple's generic face model, not from your face (plan §5.1). |

### `<clip>.json`: a recorded performance

One file per clip: `idle`, `listening`, `thinking`, `talking`, `sleeping`.

| Field | Meaning |
|---|---|
| `format`, `version` | `"face-clip"`, `1` |
| `name` | The clip name, matching the file name |
| `fps` | Frames per second, `30` |
| `names` | The 52 slider names, in the order each frame lists them |
| `frames` | One list of 52 slider values per frame |
| `head` | One `[x, y, z]` per frame: head rotation in radians, as Euler angles in three.js `"XYZ"` order, relative to the clip's average head pose |

### `visemes.json`: mouth shapes for lip-sync

A viseme is the mouth shape shared by a group of speech sounds. The ids are the standard Oculus
viseme names that lip-sync tools use.

| Field | Meaning |
|---|---|
| `format`, `version` | `"face-visemes"`, `1` |
| `order` | The 15 viseme ids, in capture order |
| `names` | The 52 slider names, in the order each pose lists them |
| `poses` | Viseme id → 52 slider values, averaged over the 1.5 s the shape was held |

| Id | Sounds | Example | Id | Sounds | Example |
|---|---|---|---|---|---|
| `sil` | silence | (rest) | `nn` | n, l | no |
| `PP` | p, b, m | pop | `RR` | r | red |
| `FF` | f, v | fan | `aa` | a | father |
| `TH` | th | think | `E` | e | bed |
| `DD` | t, d | day | `ih` | i | see |
| `kk` | k, g | cat | `oh` | o | go |
| `CH` | ch, j, sh | chair | `ou` | u | blue |
| `SS` | s, z | sun | | | |
