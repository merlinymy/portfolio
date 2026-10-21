# Face looks: artistic styles for the face

Status: **plan, with your answers in (2026-10-21).** Nothing is built yet.

Today the face is drawn as glowing points and edges. This plan adds other **looks**: different ways
of drawing the same moving face. Each is a set of shaders, small programs that run on the graphics
chip and decide the color of every pixel. Because every look draws the same animated face, each one
keeps your expressions, lip-sync, head turns and gaze for free.

## Decided so far (your answers, 2026-10-21)

- **Water:** the whole face is made of water, not droplets on glass or a drop into a pool.
- **Sand:** your face rises out of a field of sand as a relief, not blown sand or an imprint.
- **How they're used:** they're options in the lab (`?lab`) to compare. You pick one default for
  the site later, or keep the points and edges.
- **Phones:** every look must hold 60 frames a second on your iPhone, using a lighter version of
  the same idea where needed. Nothing is desktop-only.
- **Ink:** white ink in black water, seen from underwater. Details are under "Ink in water" below.
- **Every setting goes in the lab,** each with a short note saying what it does (shown when you
  hover it). This applies to every look.
- **Eyes:** each look draws eyes that fit it. A lab switch can still put the glowing eye rings on
  top.
- **Order:** flame, ink, water, sand.

## The four looks

Every look follows the face's states. Speaking makes it react to your voice's loudness (the
existing "voice pulse"). A strike, thinking and sleeping each change it in a way that fits the look,
using the state colors the lab already has.

All sizes and frame budgets below are **estimates**, to be measured on the iPhone as each look is
built.

### 1. Flame

- **What you'd see:** your face as fire on the dark page. The features glow like embers, and flames
  lick upward off the brow, nose and lips, with sparks drifting up.
- **How it's made:**
  1. Each frame, the face is drawn into a small hidden picture. Expressive parts glow brighter.
  2. That picture is fed back into itself frame after frame, shifted upward and stirred by
     swirling noise, and dimmed a little each time. That's what makes trails rise like flames.
  3. A color ramp turns brightness into fire colors: dark red, orange, yellow, white.
- **How it reacts:**
  - Speaking flares the fire with your voice.
  - Thinking burns low and blue at the base.
  - Sleeping smolders as embers.
  - A strike flashes white-hot.
  - The pointer bends the flames as it passes.
- **Cost:** a 256 × 256 hidden picture, a few drawing passes a frame, and up to 1,000 sparks.

**What "expressive" means here.** The capture recorded how far each point moves across all your
expressions. Points that move a lot, such as the lips, eyelids and brows, count as expressive.
They're drawn brighter, so the features stay readable inside the effect.

### 2. Ink in water

- **What you'd see:** an underwater view. The camera looks level, just below the surface, so the
  water's surface shows from underneath: a shimmering, rippling ceiling along the top, catching the
  light from above. Below it, your face hangs in black water, and white ink billows off it, curling
  into slow eddies and fading. Fresh ink keeps redrawing the face, so it stays recognisable. Faint
  caustics play over the ink. Caustics are the moving net of light that sunlight makes underwater.
- **How it's made:**
  - **The ink:** the same feedback loop as the flame, but the motion is curl noise, a swirling
    flow that never piles up or thins out, so the ink swirls the way it does in water. The face
    injects ink where it is. When it moves, the ink trails behind it, as if pushed through the
    water. Ink that rises spreads out under the surface.
  - **The surface from below:** the underside of a rippling sheet of water, seen almost edge-on. At
    that angle water acts like a mirror: light from below bounces back down, which is why a surface
    seen from underneath looks like silver. Here it mirrors the dark water and the ink, with bright
    glints where the ripples face the light.
  - **The caustics:** a moving light pattern from above that brightens the ink where it falls.
- **Lab settings:** ink color and amount, how fast it fades, swirl size and speed, how far the ink
  trails, the surface's height in the view, the ripple size and speed, the shimmer, the caustics,
  and the face strength. Each has a short note.
- **How it reacts:**
  - The pointer stirs the water.
  - A click sends out a pulse that pushes the ink.
  - Speaking puffs ink from the mouth.
  - A strike turns the ink red.
- **Cost:** a 192 × 192 flow and the surface band, a few passes a frame.
- **Later, if wanted:** a true fluid simulation, the kind used in WebGL fluid demos. It reacts more
  realistically to the pointer but takes about 20 passes a frame. Start without it.

### 3. Face of water

- **What you'd see:** your face as a clear, liquid surface. It catches light along its edges and
  curves, shimmers as it moves, and drips now and then from the chin and nose tip.
- **How it's made:**
  - The face surface is shaded like water:
    - **Reflections** of soft studio lights built in code. A dark page has nothing to reflect, so
      the look brings its own lights.
    - **Fresnel:** water reflects more at grazing angles, which is why the rim of a water surface
      shines while its middle looks clear.
    - **Small moving ripples** in the surface.
  - Drops are small particles that form, stretch and fall.
- **How it reacts:**
  - A click sends a real ripple across the water. The existing ripple effect becomes literal.
  - Speaking makes the surface tremble with your voice.
  - A strike turns the water red and choppy.
  - Sleeping goes still.
- **Cost:** the face drawn once more with richer shading, and up to 200 drops. This is the
  cheapest of the four.

### 4. Raised from sand

- **What you'd see:** a field of fine sand facing you, lit low from one side, with your face
  rising out of it as a relief. The light rakes across the features. When you turn or talk, the
  sand shifts to follow, a moment behind. Grains trickle down the slopes, and a breeze lifts a few
  off the ridges.
- **How it's made:**
  1. Each frame, the face's distance from the sand is drawn into a small hidden height map.
  2. The height map is softened at the edges, so the face slopes into the sand like a pile rather
     than a cut-out.
  3. A fine grid of points lifts the sand surface by that height.
  4. Sand shading adds grain and occasional glints.
  5. The height map follows the face with a slight delay, so the sand settles rather than snapping.
- **How it reacts:**
  - Talking and turning reshape the relief.
  - A click sends a ripple through the sand.
  - Speaking shakes loose a few grains.
  - A strike tints the light red.
  - Sleeping lowers the light to dusk.
- **Cost:** a 192 × 192 grid (37,000 points), a 256 × 256 height map, and up to 3,000 grains.

## Shared pieces, built once

1. **The look switcher.** A "Look" folder in the lab picks the look, with that look's own controls
   underneath. Every control has a short note saying what it does. Only the chosen look is built,
   so the others cost nothing. "Export settings" saves the choice and its settings like every
   other setting.
2. **The face as a smooth surface.** The face's triangles get smooth normals (which way the surface
   faces at each point) each frame, as realistic mode already does.
3. **The face picture.** A small hidden picture of the face, drawn each frame. For each pixel it
   holds:
   - whether the face covers it;
   - how near it is;
   - which way the surface faces there;
   - how expressive that spot is.

   Flame, ink and sand all start from this picture.
4. **The feedback loop.** Two hidden pictures that take turns being drawn from each other, for the
   flame and ink trails.
5. **Particles from the face.** Sparks, drops and grains are launched from points on the face and
   move by formula on the graphics chip, so they cost the main processor nothing.
6. **A frame-time meter in the lab,** plus automatic quality. If a look can't keep 60 frames a
   second for a few seconds, it lowers its own resolution.
7. **A "face strength" control on every look,** setting how much of the face shows through the
   effect. Ink and flame can easily swallow the face, and this keeps it recognisable.

## What stays the same

- **Points and edges stays the default** until you pick something else.
- Lip-sync, expressions, gaze, the buttons and panels, and the face states all work in every look.
- **Reduced motion:** each look has a calm version, with slower movement and no particles.
- **Browsers without 3D** still get the still image of the points-and-edges face.
- **Download size:** looks are code, with no image files, so each adds only a few kilobytes.
- **Offscreen:** the face already stops drawing when it's scrolled out of view, so the looks don't
  drain a phone's battery there.

## Build order

Each step ends with something you can try in the lab, checked on your iPhone before the next.

| Step | What | You can see |
|---|---|---|
| 0 | The look switcher, the face picture and the frame-time meter | Nothing changes yet, but the meter shows the frame budget |
| 1 | Flame | The first new look; it proves the feedback loop works |
| 2 | Ink in water | Reuses the loop with swirling motion and pointer stirring |
| 3 | Face of water | The surface shading, reflections, ripples and drops |
| 4 | Raised from sand | The height map, the sand grid and grains |
| 5 | Compare and pick | You choose the site's default, or keep points and edges |

**Cheap extras once these exist,** if you want them:
- **Smoke:** the ink loop with different colors and motion.
- **Liquid metal:** the water shading with mirror-like reflections.

## Risks

| Risk | Mitigation |
|---|---|
| The face gets lost inside the ink or fire | The "face strength" control, and expressive parts drawn brighter |
| A look is too heavy for the iPhone | Budgets above, the frame-time meter, automatic quality, and a check after each step |
| The face is a mask with no back of the head, and its edge shows | Each look fades out toward the rim: flames and ink hide it, and water and sand blend it into the surroundings |
| Water looks dull on a dark page | It brings its own studio lights to reflect |
| The ink look's water surface along the top crowds the name and tagline beside the face | A lab setting for the surface's height, and the band fades out at the sides; you set where it sits |
| Lip-sync is hard to read in some looks | Flame, ink and water draw the face itself, so the mouth shows directly. In sand, the mouth is lit to stand out |

## Your answers to the open questions (2026-10-21)

1. **Ink:** white ink in black water, seen from just below the surface, with the surface
   shimmering along the top. Every parameter goes in the lab with a short note.
2. **Eyes:** each look draws its own. A lab switch can put the glowing rings on top.
3. **Order:** flame, ink, water, sand.
