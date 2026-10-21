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
- Tie long hair back loosely, so your forehead, cheeks, hairline and ears are clear. Hair over the
  face disturbs tracking and covers skin the texture photos need. Avoid a tight headband, which can
  dent your forehead in the scan. Let your hair down again for the reference photos.

Each capture starts with a 3-2-1 countdown, and its button shows a checkmark once the file is saved.

**Redoing a step:**
- Redo any step at any time, in any order. Only that step's file is replaced.
- **Cancel** keeps the previous file: nothing is written until a capture finishes.
- Mouth shapes redo as a whole set of 15.
- Captured files stay on the phone between launches and app updates; only deleting the app removes
  them.
- After a redo, AirDrop just the changed file and replace the old one in `knowledge/faceScan/`. If the
  Mac renames it, for example to `idle 2.json`, rename it back to the exact original name.

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
| 3 | Mouth shapes | about 1 min | 15 shapes. For each one you get 2 s to form it, then hold it still for 1.5 s while the bar fills. Make only the big sound shown, such as **AH**, not the example word under it: saying "father" leaves your mouth on the "-er". Exaggerate a little. If one goes wrong, run the whole set again. |
| 4 | Face texture | about 10 s | Three photos with a relaxed face: straight on, then turned a little to your left, then to your right. A script uses them to paint your real skin, brows and lips onto the mesh. |
| 5 | Eye range | about 15 s | Keep your head still and move only your eyes: center, then as far left, right, up and down as is comfortable, holding each look while the bar fills. This tells the site how far your eyes and eyelids move when they follow a visitor's pointer. |

## Get the files to the Mac

Tap **Share**, AirDrop the files to this Mac, and move them into `knowledge/faceScan/`. Once everything
is captured there are 12: `face.json`, `visemes.json`, `gaze.json`, `texture.json`, five clips and
three `texture-*.jpg` photos. Git ignores that folder; the website's build turns it into
`apps/site/public/face/`.

## Reference photos for the head and hair

The iPhone only scans your face. The rest of your head and your hair are modeled later in Blender,
around the face mesh, so they need reference photos rather than a scan.

**Setup:**
- Use the Camera app's 10-second self-timer, with the phone propped at head height about 1.5 m
  away. The rear camera gives the most detail.
- Have your hair styled the way you want it to look on the site.
- Use soft, even light and a plain background if you can.
- Keep a neutral face, looking straight ahead rather than at the phone.

Stand on one spot and turn; the phone stays put.

| Photo | How |
|---|---|
| Front | Facing the phone |
| Three-quarter left and right | Turn 45° each way |
| Left and right profile | Turn 90° each way |
| Back | Turn all the way around |
| Top | Put the phone somewhere higher than your head, pointing down |
| Hair close-ups | The front hairline, the ends, and how it falls over your shoulders |

Save them to `knowledge/faceScan/photos/`. Git ignores all of `knowledge/`, since these are personal
photos.

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
| `uvs` | Flat list `[u0, v0, u1, …]`: ARKit's texture coordinates, one pair per vertex. They say where each vertex sits in a flat texture image, so a texture can be wrapped onto the mesh. |
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
| `eyes` | One `[lx, ly, lz, rx, ry, rz]` per frame: each eyeball's rotation relative to the face, in radians, same Euler order. The eyelids' part of a glance is in the `eyeLook…` sliders in `frames`. |
| `lookAt` | One `[x, y, z]` per frame: the point both eyes converge on, in face space (meters) |

Frames are on a fixed 30 fps grid. When tracking drops out for a moment, the missed frames repeat
the next tracked pose, so playback runs at the speed you actually moved.

### `gaze.json`: how far your eyes move

| Field | Meaning |
|---|---|
| `format`, `version` | `"face-gaze"`, `1` |
| `order` | The five directions in capture order: `center`, `left`, `right`, `up`, `down` |
| `names` | The 52 slider names, in the order each pose lists its weights |
| `poses` | Direction → `{ weights, eyes, lookAt }`, averaged over the 1.5 s the look was held. `weights` holds the 52 slider values; `eyes` and `lookAt` mean the same as in a clip. |

`left` and `right` are your own left and right.

### `texture.json` and `texture-*.jpg`: photos for texturing

The app saves three front-camera photos: `texture-front.jpg`, `texture-left.jpg` and
`texture-right.jpg`. They're saved exactly as the camera sensor delivers them, sideways, so a photo
viewer may show them rotated. The pixel positions below match the files as saved.

| Field | Meaning |
|---|---|
| `format`, `version` | `"face-texture"`, `1` |
| `shots` | One entry per photo |
| `shots[].name`, `shots[].image` | `front`, `left` or `right`, and the photo's file name |
| `shots[].width`, `shots[].height` | Photo size in pixels |
| `shots[].cameraInFace` | The camera's position in face space. A texturing script uses it to tell which vertices faced the camera in that photo. |
| `shots[].pixels` | Flat list `[x0, y0, x1, …]`: where each mesh vertex landed in the photo, in pixels from the top-left corner |

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
