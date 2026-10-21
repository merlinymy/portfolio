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
  dent your forehead in the scan.

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
| 4 | Face texture | about 10 s | Three photos with a relaxed face: straight on, then turned a little to your left, then to your right. A script uses them to paint your real skin, brows and lips onto the mesh, and they guide the shape of the rest of your head. |
| 5 | Eye range | about 15 s | Keep your head still and move only your eyes: center, then as far left, right, up and down as is comfortable, holding each look while the bar fills. This tells the site how far your eyes and eyelids move when they follow a visitor's pointer. |

## Get the files to the Mac

Tap **Share**, AirDrop the files to this Mac, and move them into `knowledge/faceScan/`. Once everything
is captured there are 12: `face.json`, `visemes.json`, `gaze.json`, `texture.json`, five clips and
three `texture-*.jpg` photos. Git ignores that folder.

## Turn them into the website's files

From the repo root, run:

```
npm run face
```

This runs `tools/face/build.ts`, which checks the files and writes four files to
`apps/site/public/face/`:
- `face.glb`
- `clips.bin`
- `visemes.json`
- `gaze.json`

Commit those four, because Cloudflare builds the site from GitHub and can't see `knowledge/`. They
hold only what the site shows anyway: the mesh, the movement and the mouth shapes. The texture
photos stay private.

Run it again after any recapture. Nothing changes on the site until you do.

Then refresh the two still pictures, so they show the new face:
1. `npm run build`
2. `npm run face:still`
3. `npm run build` again, so the new pictures are in the site.

The second step opens the built site in Chrome, holds your neutral face, and saves:
- `still.jpg`, shown instead of the 3D face in browsers that can't draw it
- `preview.jpg`, the 1200 × 630 picture LinkedIn, Slack and messaging apps show when someone shares
  a link to the site

## Head, neck, shoulders and hair

The iPhone only scans your face. A script generates the rest around it from your scan and the three
texture photos (plan §5.8):

```
npm run head
```

What it does:
- **Builds the shape.** It combines simple shapes (a skull, a jaw, a neck, the shoulders) into one
  smooth surface. Near your face, that surface gives way to your scan, so it flows out of your
  scan's edge without a step.
- **Leaves your face alone.** The part your scan covers is cut away, so your scanned face itself is
  never changed. Two simple ears are added on the sides.
- **Measures it from your photos,** through a camera model fitted to each photo from your scan's
  points. The script prints what it measured, and falls back to typical proportions for anything a
  photo doesn't show clearly.
  - The front photo gives the head's width and top, and the neck's width.
  - The turned photos give the back of the head and the ears.
- **Colors every point from your photos,** for photo color and realistic mode. The colors come from
  whichever photo sees each point best. Points no photo sees, like the back of the head, use hair
  or shirt colors.
- **Writes `apps/site/public/face/head.glb`.** Commit it with the face files. It holds about 12,000
  point colors sampled from the photos, but not the photos themselves. Blender opens it too.

Run it again after `npm run face` whenever the face scan changes.

**Checking it against your photos.** `HEAD_OVERLAY=<folder> npm run head` draws the head (green) and
your scan (red) over each photo, through that photo's camera. Write the images outside the repo,
since they show your photos. Add `HEAD_DEBUG=1` to print what each photo measured.

**The hair is generated in the browser,** from the settings in the lab's Hair section: loose or bun,
strand count, length, part, bun height and size. So changing the style needs no rebuild.

**Realistic mode's skin image.** `npm run face` also writes `face-texture.jpg`: your three photos
wrapped onto the scan. It's your face unwrapped flat, so git ignores it. A deploy skips it too, even
one run from this Mac (`apps/site/public/.assetsignore`). The lab's "realistic" slider uses it on this
Mac; elsewhere it falls back to the face's point colors.

## Voice sample (for the voice clone, phase 3)

While you're set up, record yourself reading the text below in a quiet room, at a normal speaking
pace. It takes about 35 seconds.

**How to record:**
- **With a proper mic on the Mac (best):**
  1. In QuickTime Player, choose File → New Audio Recording.
  2. Click the arrow next to the record button, pick the mic, and set Quality to Maximum.
  3. Keep the mic about 10–15 cm from your mouth, slightly off to the side.
  4. Keep your loudest words well below the top of the level meter, because clipping ruins a clone.
  5. Do two or three takes and keep the best.
- **Otherwise:** use Voice Memos on the phone.
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

The first five sections describe the app's files; the last two describe what `npm run face` writes.

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

`left` and `right` are the prompts the app showed ("look as far to your left"). People often
mirror that prompt while watching themselves on screen, so the site doesn't trust the labels: it
tells the sides apart by `lookAt`, where x is positive toward your own left.

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

### `face.glb`: the mesh for the site and for Blender

A glTF binary file, a standard 3D format that three.js and Blender both open. It contains one mesh,
`Face`, in the same coordinates and meters as `face.json`:

| Part | What it holds |
|---|---|
| Triangle primitive | The vertices, the triangles and the UVs (`TEXCOORD_0`). Blender imports this as the face surface. |
| Line primitive | The same vertices, with an index list of every distinct triangle side (3,526 edges). The site draws these as the wireframe lines. |
| Morph targets | One per slider, named in the mesh's `extras.targetNames`, in the same order as the clips' `names`. Stored sparse: only vertices that move take up space. |
| `COLOR_0` | Each point's color in the texture photos, in linear RGB, mostly from the photo that faced it most squarely. The lab's "photo color" effect uses it. The photos themselves aren't included. |
| Node `extras.eyes` | The eye centers and radius from `face.json`. |

### `clips.bin`: all five clips, packed

One little-endian binary file, about a third the size of the JSON clips:

1. The 4 bytes `FCLP`.
2. A version number (uint32, `1`).
3. The header's length in bytes (uint32).
4. The header, as JSON padded with spaces to a multiple of 4 bytes. It gives `fps`, the slider
   `names`, `weightScale`, `angleScale`, and per clip its `name`, `frames` and the byte offsets of
   its three blocks.
5. Per clip, three blocks:
   - **Slider values:** uint8, frames × sliders. Multiply by `weightScale` (1/255).
   - **Head angles:** int16, frames × 3. Multiply by `angleScale` (1/10,000) for radians.
   - **Eye angles:** int16, frames × 6, scaled the same way.

`lookAt` isn't packed, because the site turns the eyes with the eye angles instead.

### `head.glb`: the head, neck and shoulders

Written by `npm run head`, in the same face space and meters as `face.json`. One mesh, `Head`:

| Part | What it holds |
|---|---|
| Triangle primitive | The surface, for Blender, and for hiding what's behind the head on the site |
| Line primitive | The triangles' edges, drawn as the head's wireframe |
| `_HEAD_WEIGHT` | How much each point turns with the head: 1 for the head, 0 for the shoulders, blending across the neck |
| `_SEAM_INDEX`, `_SEAM_WEIGHT` | The scan outline vertex each point near the face's edge follows, and how much. Points farther than 3 cm from the edge have weight 0. |
| `COLOR_0` | Each point's color from the texture photos (linear RGB); hair or shirt colors where no photo sees it |
| Node `extras` | `pivot` (where the head turns, at the top of the neck), `eyeY`, `scalp` (the triangles the hair grows from), the simple shapes the hair drapes over (`torso`, a dome over the shoulders, and `neck`, a cylinder), `ears`, and `measured` (what came from the photos) |

