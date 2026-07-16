# Finger Magic

A real-time AR toy: comic-book filters appear inside a frame stretched between your two hands. Pinch both hands to stamp a frame in place, swipe your hands apart to blow them all away.

Vanilla JS + WebGL2 + MediaPipe HandLandmarker. No build step, no dependencies to install.

## Run it

`getUserMedia` only works on a **secure context**, so this must be served over `localhost` or HTTPS — opening `index.html` as a `file://` URL will fail at the camera step (and block the ES module imports).

```bash
npx serve .            # → http://localhost:3000
# or
python -m http.server  # → http://localhost:8000
```

Then open the URL and allow camera access. MediaPipe's wasm runtime and the hand model load from jsdelivr on first run, so the first load needs a network connection.

## The three gestures

| Gesture | What it does |
| --- | --- |
| **Hold up both hands** | Three filter bands stretch between your hands at once, each running a different filter. They warp and skew as you tilt your hands. |
| **Pinch both hands at once** | Stamps the **main** band in place and shifts all three to the next filters. Stamped frames keep filtering live video — only their position is frozen. Up to 6; the oldest fades out. |
| **Swipe both hands apart, fast** | Every frame dissolves outward like comic panels blowing away. |

Press **`f`** to toggle the FPS counter. There are no buttons for the core loop — the hands are the interface.

### The three bands

Each band is a quad spanning the gap between your hands, taking two fingertips from each hand:

| Band | Corners | Stamps? |
| --- | --- | --- |
| **Main** | thumb ↔ index, both hands | Yes — this is the one pinch freezes |
| **Middle** | index ↔ middle, both hands | No |
| **Lower** | middle ↔ pinky, both hands | No |

They're defined in one `FRAME_SPECS` table at the top of [main.js](main.js) — change a landmark there to move a band. The main band is the tallest and overlaps the other two, so it's drawn underneath; the narrow bands sit on top of it. Spreading your fingers separates them.

Filter assignment is `nextFilter`, `+1`, `+2`, so the bands are always showing three different filters and a stamp rotates all three at once.

## Filters

Eight, cycling in this order. All of them animate **on twos** — stepped at 12fps rather than smoothly interpolated, which is the cadence Spider-Verse's linework is drawn on and most of why it reads as drawn instead of rendered.

1. **Ben-Day Pop** — halftone dots as *shading*: density ramps into the shadows and vanishes in highlights, over flat posterised colour with an ink outline. The grid breathes on twos.
2. **Riso Misprint** — two spot inks (fluorescent pink, process blue) on cheap paper, each with its own screen angle, pulling out of register with a stepped wobble that grows toward the edges.
3. **Boil Sketch** — blue-pencil linework where the edge lookup is displaced by stepped noise, so the ink *boils* frame to frame exactly like a hand-drawn pencil test. Cross-hatching boils with it.
4. **Dimension Glitch** — phasing out of sync: hard RGB separation, blocky row tears and inverted pops, re-seeded on twos so it stutters instead of shimmering.
5. **Ink & Hatch** — screen-printed panel: heavy contour plus fine interior linework over flat colour, cross-hatching carrying the shadows.
6. **Kirby Krackle** — cosmic energy: clusters of black bubbles blooming in the dark areas with a pink/cyan energy fringe, drifting upward.
7. **Speed Burst** — the action panel: subject clean in the middle, black speed lines exploding outward across paper, strobing on twos.
8. **Neon Vibe** — the picture drops to near-black and only the contours survive, lit in a chroma band that scrolls through the frame.

## Tuning

The four magic numbers live at the top of [main.js](main.js), in one block:

- **`PINCH_ON = 0.35`** — how closed your fingers must be to count as a pinch, as a fraction of your palm width. Raise it and frames stamp from a lazy half-pinch (and stamp by accident while you gesture); lower it and you have to properly squeeze thumb and index together before anything fires.
- **`PINCH_RELEASE = 0.50`** — how far you must re-open before the next pinch can arm. Widening the gap from `PINCH_ON` kills double-stamps from a trembling hand but makes rapid-fire stamping feel sticky; narrowing it toward 0.35 makes stamping fast and twitchy.
- **`SWIPE_SPEED = 1.8`** — screen-widths per second each hand must reach, in opposite directions, to clear. Lower it and the board wipes when you merely reach for something; raise it and you have to throw your hands out like you mean it.
- **`STAMP_DEBOUNCE = 400`** / **`CLEAR_COOLDOWN = 800`** (ms) — dead time after each gesture. The stamp debounce stops one pinch registering as three; the clear cooldown stops the follow-through of a swipe from immediately re-clearing the fresh frame. Shorten them for a more responsive toy, lengthen them if gestures are double-firing.

Two more that matter if you're chasing feel:

- **`SWIPE_FRAMES = 3`** — consecutive *tracking* frames the swipe must be sustained. This is measured in camera frames, not render frames, so it means ~100ms at 30fps but ~300ms at 10fps. On a low-fps camera the swipe gets noticeably harder to trigger; drop it to 2 if your webcam is slow.
- **`VEL_TAU = 0.045`** — velocity smoothing time constant. It's time-based rather than a fixed per-frame alpha, so `SWIPE_SPEED` means the same thing at 20fps and 60fps. Raise it to reject jitter, lower it to make the swipe fire sooner.

## How it works

- **The quad.** Corners are the two thumb tips and two index tips, sorted by angle around their centroid so the quad can't self-intersect, then rotated so a consistent corner is the UV origin (otherwise filter patterns spin). Local UVs are made perspective-correct by passing `(u·q, v·q, q)` per vertex and dividing in the fragment shader — without that, a tilted quad creases visibly along its triangle diagonal.
- **Two coordinate spaces.** Filters sample the video by *screen* UV, so a frame shows the video that's genuinely underneath it. Filter *patterns* (halftone grid, misprint falloff, hatching) are computed in *local* quad UV, which is what makes them shear as you tilt your hands.
- **Smoothing vs. responsiveness.** Corners are smoothed with a One Euro filter — heavy at rest, light during fast motion. Pinch metrics and wrist velocities deliberately read **raw** landmarks: routing them through the smoother adds enough lag to swallow a quick pinch entirely.
- **Detection vs. render rate.** The camera delivers ~30fps while the page renders at 60. Gesture state only advances on real detections; a repeated camera frame would otherwise read as zero hand motion and drag the velocity average below the swipe threshold.
- **Pinching collapses the frame.** Two of the main band's four corners *are* the thumb and index tips, so the act of pinching squashes it to a sliver. Stamping the corners at the instant the gesture fires would freeze that sliver, so the app remembers the last framing where both hands were open and stamps that instead — the shot you were actually composing. (The other two bands don't touch the thumb, so the pinch doesn't disturb them.)
- **Two clocks.** `u_time` runs smooth for things that should glide; `TWOS` quantises it to 12 steps a second for anything meant to look drawn. Putting boil, krackle, misregistration or speed lines on the smooth clock turns them into CGI slither and the comic illusion collapses.

## Known limits

- Hand tracking is driven from inside the render loop, so if rendering ever drops below the camera's frame rate, the tracking rate drops with it — and the swipe needs a few tracking frames to fire. The unlucky consequence is that the clear gesture is at its least reliable exactly when the board is fullest, which is when you most want it. On a GPU there's plenty of headroom (each band only covers a fraction of the screen); it only bites under software rendering.
- Hand slots are assigned by screen position, so crossing your hands over each other briefly scrambles the per-hand smoothing.
- MediaPipe reports handedness assuming a mirrored image; since the raw camera feed is fed in unmirrored, the label is inverted before display. The quad ordering doesn't rely on it.
