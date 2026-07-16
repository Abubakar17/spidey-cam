// Finger Magic — shader library.
// One vertex shader for every quad; one fragment shader per comic filter.
//
// Coordinate conventions used everywhere below:
//   screen UV : (0,0) top-left of the canvas, (1,1) bottom-right. This is the
//               *display* space, which is mirrored relative to the raw camera.
//   local UV  : (0,0)..(1,1) across the hand-held quad itself, projectively
//               interpolated (see v_uvq). Filter *patterns* live here, so dot
//               grids and burst lines skew as the hands tilt.
// sampleVideo() applies the mirror flip in exactly one place so no filter has
// to think about it.

export const VERT = `#version 300 es
in vec2 a_pos;   // clip space
in vec3 a_uvq;   // (u*q, v*q, q) — projective correction for a general quad
out vec2 v_screenUV;
out vec3 v_uvq;
void main() {
  v_uvq = a_uvq;
  v_screenUV = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// ---------------------------------------------------------------------------
// Full-screen mirrored video passthrough (drawn first, under every quad).
// ---------------------------------------------------------------------------
export const VIDEO_FRAG = `#version 300 es
precision highp float;
in vec2 v_screenUV;
in vec3 v_uvq;
uniform sampler2D u_video;
out vec4 outColor;
void main() {
  outColor = vec4(texture(u_video, vec2(1.0 - v_screenUV.x, v_screenUV.y)).rgb, 1.0);
}`;

// ---------------------------------------------------------------------------
// Shared prelude. Each filter supplies filterColor().
// ---------------------------------------------------------------------------
const PRELUDE = `#version 300 es
precision highp float;

in vec2 v_screenUV;
in vec3 v_uvq;

uniform sampler2D u_video;
uniform float u_time;
uniform vec2  u_res;        // canvas resolution in px
uniform vec2  u_quadSize;   // quad's approximate width/height in px
uniform vec4  u_quadBounds; // quad screen-UV bounding box: (minX, minY, maxX, maxY)
uniform float u_alpha;
uniform float u_flash;      // 0..1 white flash on stamp

out vec4 outColor;

// Spider-Verse animates ON TWOS — the linework is redrawn 12 times a second, not
// 24, and that stepped cadence is most of why it reads as drawn instead of
// rendered. TWOS is the quantised clock; anything hand-drawn-looking (boil,
// krackle, misregistration, speed lines) should tick on it rather than u_time,
// or it turns into smooth CGI slither and the illusion dies.
#define TWOS (floor(u_time * 12.0) / 12.0)

vec3 sampleVideo(vec2 s) {
  return texture(u_video, vec2(1.0 - s.x, s.y)).rgb;
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
mat2 rot2(float a) { float s = sin(a), c = cos(a); return mat2(c, -s, s, c); }

float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i),               hash21(i + vec2(1.0, 0.0)), f.x),
             mix(hash21(i + vec2(0.0,1.0)), hash21(i + vec2(1.0, 1.0)), f.x), f.y);
}

// Classic Ben-Day cell: a dot whose radius grows with ink density.
float halftoneDot(vec2 g, float density) {
  vec2 c = fract(g) - 0.5;
  float r = sqrt(clamp(density, 0.0, 1.0)) * 0.78;
  return 1.0 - smoothstep(r - 0.09, r + 0.09, length(c));
}

float sobelMag(vec2 s, vec2 t) {
  float tl = luma(sampleVideo(s + vec2(-t.x, -t.y)));
  float tm = luma(sampleVideo(s + vec2( 0.0, -t.y)));
  float tr = luma(sampleVideo(s + vec2( t.x, -t.y)));
  float ml = luma(sampleVideo(s + vec2(-t.x,  0.0)));
  float mr = luma(sampleVideo(s + vec2( t.x,  0.0)));
  float bl = luma(sampleVideo(s + vec2(-t.x,  t.y)));
  float bm = luma(sampleVideo(s + vec2( 0.0,  t.y)));
  float br = luma(sampleVideo(s + vec2( t.x,  t.y)));
  float gx = -tl - 2.0 * ml - bl + tr + 2.0 * mr + br;
  float gy = -tl - 2.0 * tm - tr + bl + 2.0 * bm + br;
  return length(vec2(gx, gy));
}

// Punch the webcam's flat, low-contrast picture into comic territory: saturate
// hard, then crush to a few flat levels. Nearly every filter starts here.
vec3 popColor(vec3 rgb, float levels) {
  float l = luma(rgb);
  vec3 sat = clamp(mix(vec3(l), rgb, 1.75), 0.0, 1.0);
  sat = clamp((sat - 0.5) * 1.25 + 0.52, 0.0, 1.0);
  return clamp(floor(sat * levels) / (levels - 1.0), 0.0, 1.0);
}

vec3 filterColor(vec2 luv, vec2 suv);
`;

const MAIN = `
void main() {
  vec2 luv = clamp(v_uvq.xy / v_uvq.z, 0.0, 1.0);
  vec3 c = filterColor(luv, v_screenUV);
  c = mix(c, vec3(1.0), u_flash);
  outColor = vec4(c, u_alpha);
}`;

const build = (body) => PRELUDE + body + MAIN;

// ---------------------------------------------------------------------------
// 1. Ben-Day Pop
// Dots as SHADING, not as a uniform screen over everything: density ramps up in
// the shadows and vanishes in the highlights, over flat posterised colour with a
// bold ink outline. The grid breathes on twos.
// ---------------------------------------------------------------------------
const BENDAY = `
vec3 filterColor(vec2 luv, vec2 suv) {
  vec3 rgb = sampleVideo(suv);
  float l = luma(rgb);
  vec3 flatCol = popColor(rgb, 4.0);

  float dens = smoothstep(0.78, 0.10, l);          // ink only where it's dark
  vec2 g = rot2(radians(15.0)) * (luv * (u_quadSize / 6.5));
  g *= 1.0 + 0.05 * sin(TWOS * 3.14159);           // gentle breathe, stepped
  float d = halftoneDot(g, dens);

  vec3 shadowInk = vec3(0.86, 0.10, 0.42);         // magenta shadow ink
  vec3 col = mix(flatCol, flatCol * shadowInk, d * 0.9);

  float e = smoothstep(0.26, 0.68, sobelMag(suv, 1.3 / u_res));
  return mix(col, vec3(0.04, 0.03, 0.07), e);
}`;

// ---------------------------------------------------------------------------
// 2. Riso Misprint
// Two spot inks on cheap paper, each with its own screen angle, pulling apart
// from each other with a stepped wobble — off-register printing.
// ---------------------------------------------------------------------------
const RISO = `
vec3 filterColor(vec2 luv, vec2 suv) {
  float t = TWOS;
  // Misregistration grows toward the quad edges, like a badly aligned plate.
  vec2 drift = (luv - 0.5) * 0.03 * smoothstep(0.0, 0.7, length(luv - 0.5));
  vec2 wob = vec2(sin(t * 2.7), cos(t * 3.3)) * 0.004 + drift;

  float a = luma(sampleVideo(suv + wob));
  float b = luma(sampleVideo(suv - wob));

  // Plate separation is the whole ballgame: give both plates a broad density
  // ramp and they both ink everything, and you get mud. Pink carries the broad
  // midtones, blue only drops into the genuine shadows.
  float dA = smoothstep(0.82, 0.18, a);            // pink plate: midtones
  float dB = smoothstep(0.40, 0.01, b);            // blue plate: shadows only

  vec2 g = luv * (u_quadSize / 5.5);
  float sA = halftoneDot(rot2(radians(15.0)) * g, dA);
  float sB = halftoneDot(rot2(radians(75.0)) * g + 0.37, dB);

  vec3 paper = vec3(0.96, 0.94, 0.87);
  vec3 inkA = vec3(1.00, 0.11, 0.45);              // fluorescent pink
  vec3 inkB = vec3(0.05, 0.42, 0.92);              // process blue

  vec3 col = paper;
  col *= mix(vec3(1.0), inkA, sA);
  col *= mix(vec3(1.0), inkB, sB);
  col *= 0.97 + 0.03 * vnoise(luv * 220.0);        // paper tooth
  return col;
}`;

// ---------------------------------------------------------------------------
// 3. Boil Sketch
// Hand-drawn animation "boils": every redraw the line lands in a slightly
// different place. Displacing the edge lookup by stepped noise makes the ink
// crawl exactly the way pencil tests do — the single most convincing trick here.
// ---------------------------------------------------------------------------
const BOIL = `
vec3 filterColor(vec2 luv, vec2 suv) {
  float t = TWOS;
  vec2 n = vec2(vnoise(luv * 6.0 + t * 17.0),
                vnoise(luv * 6.0 + 41.0 - t * 13.0)) - 0.5;
  vec2 s = suv + n * 0.007;                        // the boil

  float e = sobelMag(s, 1.5 / u_res);
  float l = luma(sampleVideo(s));
  l = clamp((l - 0.5) * 1.6 + 0.5, 0.0, 1.0);

  vec3 paper = vec3(0.90, 0.93, 0.99);
  vec3 ink   = vec3(0.07, 0.16, 0.48);

  float line = smoothstep(0.09, 0.34, e);          // webcam edges are soft — bite early
  float shadow = smoothstep(0.58, 0.10, l);

  // Cross-hatching that boils along with the line.
  vec2 h = (luv + n * 0.02) * (u_quadSize / 5.0);
  float h1 = smoothstep(0.2, 0.85, sin((h.x + h.y) * 3.14159));
  float h2 = smoothstep(0.5, 0.95, sin((h.x - h.y) * 3.14159));
  float hatch = (h1 * shadow + h2 * smoothstep(0.35, 0.02, l)) * 0.55;

  vec3 col = mix(paper, paper * 0.90, shadow * 0.45);
  return mix(col, ink, clamp(line + hatch, 0.0, 1.0));
}`;

// ---------------------------------------------------------------------------
// 4. Dimension Glitch
// Miles phasing out of sync: hard RGB separation, blocky row tears and inverted
// pops, all re-seeded on twos so it stutters instead of shimmering.
// ---------------------------------------------------------------------------
const GLITCH = `
vec3 filterColor(vec2 luv, vec2 suv) {
  float t = floor(u_time * 12.0);
  float burst = step(0.68, hash21(vec2(t, 3.0)));  // occasional big tear

  float row = floor(luv.y * 24.0);
  float on = step(0.70, hash21(vec2(row * 1.31, t)));
  float tear = (hash21(vec2(row, t * 0.7)) - 0.5) * 0.13 * on * (0.35 + burst);
  vec2 s = suv + vec2(tear, 0.0);

  float split = (0.005 + 0.013 * burst) * (0.55 + 0.45 * sin(u_time * 9.0));
  vec3 col = vec3(
    sampleVideo(s + vec2(split, 0.0)).r,
    sampleVideo(s).g,
    sampleVideo(s - vec2(split, 0.0)).b
  );
  col = popColor(col, 5.0);

  float blk = step(0.93, hash21(floor(luv * vec2(11.0, 15.0)) + t));
  col = mix(col, 1.0 - col, blk * burst * 0.85);   // inverted blocks
  col = mix(col, vec3(1.0, 0.18, 0.62), on * burst * 0.14);
  col *= 0.90 + 0.10 * sin(suv.y * u_res.y * 2.0);
  return col;
}`;

// ---------------------------------------------------------------------------
// 5. Ink & Hatch
// Screen-printed panel: heavy black outline over flat colour, cross-hatching
// carrying the shadows instead of a gradient.
// ---------------------------------------------------------------------------
const INK = `
vec3 filterColor(vec2 luv, vec2 suv) {
  vec3 rgb = sampleVideo(suv);
  float l = luma(rgb);
  vec3 col = popColor(rgb, 4.0);

  vec2 h = luv * (u_quadSize / 4.5);
  float shadow = smoothstep(0.5, 0.06, l);
  float h1 = smoothstep(0.30, 0.9, sin((h.x + h.y) * 3.14159)) * smoothstep(0.55, 0.2, l);
  float h2 = smoothstep(0.55, 0.95, sin((h.x - h.y) * 3.14159)) * smoothstep(0.3, 0.02, l);
  col = mix(col, col * 0.35, clamp(h1 + h2, 0.0, 1.0) * 0.9);

  // Two edge scales: a fat contour plus fine interior detail.
  float e = max(sobelMag(suv, 1.2 / u_res), sobelMag(suv, 2.6 / u_res) * 0.85);
  float ink = smoothstep(0.20, 0.58, e);
  return mix(col, vec3(0.03, 0.02, 0.05), ink);
}`;

// ---------------------------------------------------------------------------
// 6. Kirby Krackle
// Jack Kirby's cosmic energy: clusters of black bubbles blooming in the dark
// areas with a pink/cyan energy fringe. Bubbles re-seed on twos so they pop.
// ---------------------------------------------------------------------------
const KRACKLE = `
// Signed distance to the nearest bubble in a jittered grid.
float krackle(vec2 p, float t) {
  vec2 i = floor(p), f = fract(p) - 0.5;
  float best = 1e9;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y));
      vec2 id = i + o;
      vec2 c = o + (vec2(hash21(id), hash21(id + 7.7)) - 0.5) * 0.7;
      float r = 0.16 + 0.30 * hash21(id + floor(t * 6.0) * 0.13);
      best = min(best, length(f - c) - r);
    }
  }
  return best;
}
vec3 filterColor(vec2 luv, vec2 suv) {
  vec3 rgb = sampleVideo(suv);
  float l = luma(rgb);
  float dens = smoothstep(0.62, 0.04, l);          // energy lives in shadow
  float t = TWOS;

  vec2 p = luv * (u_quadSize / 24.0);
  p += vec2(0.0, -t * 0.55);                       // drift upward
  float d = krackle(p, t);

  float bub  = 1.0 - smoothstep(-0.03, 0.03, d);
  float glow = 1.0 - smoothstep(0.0, 0.16, d);

  vec3 base = popColor(rgb, 4.0);
  vec3 energy = mix(vec3(0.10, 0.95, 1.0), vec3(1.0, 0.20, 0.80),
                    0.5 + 0.5 * sin(t * 5.0 + luv.y * 7.0));

  vec3 col = base;
  col = mix(col, energy, glow * dens * 0.75);
  col = mix(col, vec3(0.02, 0.02, 0.04), bub * dens);

  float e = smoothstep(0.26, 0.66, sobelMag(suv, 1.3 / u_res));
  return mix(col, vec3(0.03, 0.02, 0.05), e * 0.8);
}`;

// ---------------------------------------------------------------------------
// 7. Speed Burst
// The action panel: subject clean in the middle, black speed lines exploding
// outward across paper. Lines re-seed on twos so they strobe outward.
// ---------------------------------------------------------------------------
const BURST = `
vec3 filterColor(vec2 luv, vec2 suv) {
  vec3 base = popColor(sampleVideo(suv), 4.0);
  float e = smoothstep(0.24, 0.62, sobelMag(suv, 1.3 / u_res));
  base = mix(base, vec3(0.03, 0.02, 0.05), e);

  // Aspect-correct the polar field or the burst turns into an oval.
  vec2 d = luv - 0.5;
  d.x *= u_quadSize.x / max(u_quadSize.y, 1.0);
  float rad = length(d) * 2.0;
  float ang = atan(d.y, d.x) / 6.28318 + 0.5;

  float N = 46.0;
  float cell = floor(ang * N);
  float t = floor(u_time * 12.0);
  float seed = hash21(vec2(cell, t));
  // Lines have to clear a head-sized subject (roughly rad 0.7 for a face filling
  // the band) or the burst eats the very thing it's meant to be pointing at.
  float start = 0.62 + 0.30 * seed;
  float w = 0.10 + 0.24 * hash21(vec2(cell, 3.0));
  float f = abs(fract(ang * N) - 0.5);
  float line = (1.0 - smoothstep(w * 0.5, w, f)) * smoothstep(start, start + 0.10, rad);

  // Fade the picture to paper FIRST, then lay lines over the top. Cross-fading
  // straight from a dark base to the line layer instead leaves a muddy grey ring
  // wherever the two are half-mixed.
  vec3 paper = vec3(0.98, 0.96, 0.89);
  vec3 col = mix(base, paper, smoothstep(0.58, 0.98, rad));
  return mix(col, vec3(0.04, 0.03, 0.05), line);
}`;

// ---------------------------------------------------------------------------
// 8. Neon Vibe
// Spot-lit dimensional glow: the picture drops to near-black and only the
// contours survive, lit in a chroma band that scrolls through the frame.
// ---------------------------------------------------------------------------
const NEON = `
vec3 filterColor(vec2 luv, vec2 suv) {
  float core = smoothstep(0.22, 0.52, sobelMag(suv, 1.3 / u_res));
  float halo = smoothstep(0.06, 0.44, sobelMag(suv, 3.2 / u_res));

  vec3 c1 = vec3(0.10, 1.00, 0.90);
  vec3 c2 = vec3(1.00, 0.15, 0.70);
  vec3 hue = mix(c1, c2, 0.5 + 0.5 * sin(luv.y * 5.0 - u_time * 2.5));

  vec3 col = sampleVideo(suv) * 0.10;              // ghost of the picture
  col += hue * halo * 0.85;
  col += vec3(1.0) * core * 0.85;
  // Stepped flicker so it feels drawn, not rendered.
  col *= 0.90 + 0.10 * hash21(vec2(floor(TWOS * 12.0), 1.0));
  return clamp(col, 0.0, 1.0);
}`;

export const FILTERS = [
  { name: 'Ben-Day Pop',      color: '#ff3d8b', frag: build(BENDAY)  },
  { name: 'Riso Misprint',    color: '#ffd23f', frag: build(RISO)    },
  { name: 'Boil Sketch',      color: '#5b8cff', frag: build(BOIL)    },
  { name: 'Dimension Glitch', color: '#38e1ff', frag: build(GLITCH)  },
  { name: 'Ink & Hatch',      color: '#e8e8f0', frag: build(INK)     },
  { name: 'Kirby Krackle',    color: '#9b5cff', frag: build(KRACKLE) },
  { name: 'Speed Burst',      color: '#ff8a2b', frag: build(BURST)   },
  { name: 'Neon Vibe',        color: '#2ff3c4', frag: build(NEON)    },
];
