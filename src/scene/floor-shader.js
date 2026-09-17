/* ---- infinite floor shader --------------------------------------------
   Drawn as a plate that rides along under the camera target while the
   grid itself is evaluated in world coordinates, so the lines belong to
   the lattice and not to the plate.  Page boundaries -- the multiples of
   each axis role's period -- get a second, brighter rule, which is what
   makes the catalogue's pagination legible from the air. */
export const FLOOR_VERT = `
varying vec3 vW;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

export const FLOOR_FRAG = `
uniform vec2  uCenter;
uniform float uCell;
uniform vec2  uPeriod;
uniform float uFade;
uniform vec3  uColA;
uniform vec3  uColB;
uniform vec2  uPinC;
uniform float uPinR;
uniform float uPinOn;
varying vec3 vW;

float rule(float x, float s){
  float q = x / s;
  float d = abs(fract(q - 0.5) - 0.5) / max(fwidth(q), 1e-5);
  return 1.0 - min(d, 1.0);
}

void main(){
  vec2 p = vW.xz;
  float cellL = max(rule(p.x, uCell), rule(p.y, uCell));
  float pageL = max(rule(p.x, uCell * uPeriod.x), rule(p.y, uCell * uPeriod.y));

  float r = length(p - uCenter);
  float fade = 1.0 - smoothstep(uFade * 0.30, uFade, r);

  vec3 col = uColA * cellL * 0.55 + uColB * pageL * 1.15;
  float a = (cellL * 0.34 + pageL * 0.72) * fade;

  // District rim: a Chebyshev square, so the boundary the recipe actually
  // uses is the boundary you see.
  if (uPinOn > 0.5){
    vec2 q = abs(p - uPinC) - vec2(uPinR);
    float sd = max(q.x, q.y);
    float w = max(fwidth(sd), 1e-5);
    float rim = 1.0 - smoothstep(0.0, w * 1.7, abs(sd));
    float in0 = 1.0 - smoothstep(-w, 0.0, sd);
    col += vec3(1.0, 0.24, 0.65) * rim * 1.7 + vec3(0.42, 0.06, 0.62) * in0 * 0.34;
    a = max(a, (rim * 0.9 + in0 * 0.09) * fade);
  }

  if (a < 0.002) discard;
  gl_FragColor = vec4(col, a);
}`;

