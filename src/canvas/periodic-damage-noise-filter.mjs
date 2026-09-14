/** Fine grain or flowing blood, combined with tint in one alpha-preserving pass. */
export const PERIODIC_DAMAGE_NOISE_FRAGMENT = `
precision highp float;
varying vec2 vTextureCoord;
uniform sampler2D uSampler;
uniform vec3 damageColor;
uniform float intensity;
uniform float noiseFrame;
uniform float seed;
uniform float bleedingFlow;
uniform float flowTime;
uniform vec4 inputSize;
uniform vec4 outputFrame;

float noise(vec2 point) {
  // Same per-pixel grain as PIXI.NoiseFilter used by the old fire effect.
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

float flowHash(vec2 point) {
  vec3 p = fract(vec3(point.xyx) * 0.1031);
  p += dot(p, p.yzx + 33.33);
  return fract((p.x + p.y) * p.z);
}

// Smooth fluid density and its analytic gradient. The gradient supplies wet
// highlights without extra texture samples or neighboring fragment reads.
vec3 flowNoise(vec2 point) {
  vec2 cell = floor(point);
  vec2 f = fract(point);
  vec2 u = f * f * (3.0 - 2.0 * f);
  vec2 du = 6.0 * f * (1.0 - f);
  float a = flowHash(cell);
  float b = flowHash(cell + vec2(1.0, 0.0));
  float c = flowHash(cell + vec2(0.0, 1.0));
  float d = flowHash(cell + vec2(1.0, 1.0));
  float crossTerm = a - b - c + d;
  return vec3(a + (b - a) * u.x + (c - a) * u.y + crossTerm * u.x * u.y,
    du.x * ((b - a) + crossTerm * u.y), du.y * ((c - a) + crossTerm * u.x));
}

// Six profiles: thin trail, heavy run, rounded bead, joining fork, broken
// droplets and broad smear. A fresh event ID randomizes every new emission;
// unlike wrapping the head with fract(time), it never replays one fixed drop.
vec2 bloodStreamEvent(vec2 point, float lanes, float lane, float eventId, float localTime) {
  vec2 key = vec2(lane + seed * 1.37, eventId * 1.73);
  float random = flowHash(key);
  if (random < 0.16) return vec2(0.0);
  float shape = floor(flowHash(key + vec2(5.7, 13.1)) * 6.0);
  float size = flowHash(key + vec2(12.3, 5.5));
  float speed = flowHash(key + vec2(1.3, 41.7));
  float age = localTime - eventId * 6.0 - random * 1.8;
  if (age < 0.0 || age > 12.0) return vec2(0.0);
  float head = -0.3 + age * (0.24 + speed * 0.15);
  float center = (lane + 0.24 + random * 0.52) / lanes;
  center += sin(point.y * (8.0 + size * 9.0) + random * 20.0) * (0.003 + size * 0.012);
  float dx = point.x - center;
  float aboveHead = head - point.y;
  float widthScale = shape < 1.0 ? 0.65 : (shape < 2.0 ? 1.6 : (shape > 4.0 ? 1.8 : 1.0));
  float tailLength = shape < 1.0 ? 0.62 : (shape < 2.0 ? 0.38 : (shape < 3.0 ? 0.14 : (shape > 4.0 ? 0.24 : 0.5)));
  float thickness = 0.75 + 0.25 * sin(aboveHead * (24.0 + size * 16.0) + random * 13.0);
  float width = (0.004 + size * 0.006) * widthScale * thickness * (0.7 + 0.3 * intensity);
  float edge = abs(dx);
  if (shape > 2.5 && shape < 3.5) {
    float fork = smoothstep(0.025, 0.26, aboveHead) * (0.01 + size * 0.014);
    edge = min(abs(dx - fork), abs(dx + fork * 0.6));
  }
  float trail = (1.0 - smoothstep(width * 0.55, width * 1.55, edge))
    * smoothstep(-0.008, 0.025, aboveHead)
    * (1.0 - smoothstep(tailLength * 0.25, tailLength, aboveHead));
  if (shape > 3.5 && shape < 4.5) trail *= smoothstep(-0.2, 0.65, sin(aboveHead * 110.0 + random * 8.0));
  float dropHeight = (0.012 + size * 0.012) * (shape < 2.0 ? 1.2 : 0.85);
  vec2 dropPoint = vec2(dx / (width * 1.9), (point.y - head) / dropHeight);
  float drop = 1.0 - smoothstep(0.65, 1.0, length(dropPoint));
  vec2 shinePoint = vec2((dx + width * 0.4) / width, (point.y - head + 0.005) / 0.008);
  float shine = (1.0 - smoothstep(0.15, 0.75, length(shinePoint))) * drop;
  return vec2(max(trail, drop), shine);
}

vec2 bloodStreams(vec2 point) {
  const float lanes = 8.0;
  float lane = floor(point.x * lanes);
  float localTime = flowTime + flowHash(vec2(lane, seed)) * 6.0;
  float eventId = floor(localTime / 6.0);
  // The previous emission stays alive until its entire tail leaves the token.
  return max(bloodStreamEvent(point, lanes, lane, eventId, localTime),
    bloodStreamEvent(point, lanes, lane, eventId - 1.0, localTime));
}

void main() {
  vec4 base = texture2D(uSampler, vTextureCoord);
  if (base.a <= 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }
  // Generalize the old fire ColorMatrix channel gains to the damage color.
  // Default fire (#ff6a2a) gives [1.8, 0.68, 0.2], close to the legacy
  // [1.8, 0.65, 0.2]. Other damage types use their own hue in the same matrix.
  float low = min(damageColor.r, min(damageColor.g, damageColor.b));
  float high = max(damageColor.r, max(damageColor.g, damageColor.b));
  vec3 hue = high > low ? (damageColor - low) / (high - low) : vec3(0.5);
  vec3 gains = vec3(1.0) + (1.6 * hue - 0.8) * intensity;
  vec3 tinted = clamp(base.rgb * gains, vec3(0.0), vec3(base.a));
  if (bleedingFlow > 0.5) {
    // Convert pooled filter UVs to token-local coordinates measured in token
    // heights, keeping drops round and moving downward at any token scale.
    vec2 point = vTextureCoord * inputSize.xy / max(outputFrame.w, 1.0);
    // Advect several elongated scales at different speeds. Slow lateral
    // warping makes rivulets bend, join, widen and break into wet patches.
    float time = flowTime * 0.55;
    float broad = flowNoise(point * vec2(5.0, 1.7) + vec2(seed * 0.017, -time * 0.28)).x;
    vec2 warped = vec2(point.x + (broad - 0.5) * 0.09, point.y);
    vec2 flowPoint = warped * vec2(18.0, 3.7) + vec2(seed * 0.031, -time);
    vec3 coarse = flowNoise(flowPoint);
    vec3 fine = flowNoise(flowPoint * vec2(2.03, 1.31) + vec2(7.3, -time * 0.19));
    float density = coarse.x * 0.72 + fine.x * 0.28;
    float fluid = smoothstep(0.48 - intensity * 0.04, 0.73, density);
    float film = smoothstep(0.36, 0.76, broad) * 0.24;
    vec2 drops = bloodStreams(warped);
    float wet = max(fluid, drops.x * 0.85);
    vec2 slope = coarse.yz * 0.72 + fine.yz * vec2(2.03, 1.31) * 0.28;
    vec3 normal = normalize(vec3(-slope * vec2(0.9, 0.3), 1.0));
    float gloss = pow(max(dot(normal, vec3(-0.4, -0.55, 0.733)), 0.0), 16.0);
    float shine = gloss * smoothstep(0.48, 0.7, density) + drops.y * 0.35;
    float light = dot(base.rgb, vec3(0.299, 0.587, 0.114));
    // Thick pools are dark; thin edges retain the underlying artwork. A small
    // tinted highlight gives wet depth without turning the blood into a glow.
    vec3 blood = damageColor * ((0.18 + 0.5 * (1.0 - wet)) * base.a + 0.3 * light);
    float coverage = min(0.92, wet * 0.84 + film) * intensity;
    vec3 color = mix(mix(base.rgb, tinted, 0.12), blood, coverage);
    color += (damageColor * 0.6 + vec3(0.16)) * shine * 0.36 * intensity * base.a;
    gl_FragColor = vec4(clamp(color, vec3(0.0), vec3(base.a)), base.a);
    return;
  }
  float animatedSeed = fract(seed * 0.0137 + noiseFrame * 0.01) + 0.01;
  float grain = (noise(gl_FragCoord.xy * animatedSeed) - 0.5) * 0.25 * intensity;
  // Add subtle monochrome grain after tinting, as the legacy filter stack did.
  // Multiplying by alpha preserves transparent pixels and hidden-token opacity.
  vec3 color = clamp(tinted + grain * base.a, vec3(0.0), vec3(base.a));
  gl_FragColor = vec4(color, base.a);
}
`;

let NoiseFilterClass = null;

export function createPeriodicDamageNoiseFilter(seed = 0) {
  // Lazy initialization allows system modules to load before the canvas exists.
  NoiseFilterClass ??= class PeriodicDamageNoiseFilter extends PIXI.Filter {
    constructor(tokenSeed) {
      super(undefined, PERIODIC_DAMAGE_NOISE_FRAGMENT, {
        damageColor: new Float32Array([1, 0, 0]),
        intensity: 0,
        noiseFrame: 0,
        bleedingFlow: 0,
        flowTime: 0,
        seed: tokenSeed
      });
      this.padding = 0;
      this.resolution = 1;
      this.multisample = PIXI.MSAA_QUALITY.NONE;
    }

    apply(manager, input, output, clearMode) {
      // Only visible, affected meshes reach apply. No ticker/listener per token,
      // no Actor scans here. Grain changes eight times per second; blood flows
      // smoothly using the same render clock and reuses the same filter.
      const now = performance.now();
      this.uniforms.noiseFrame = Math.floor(now / 125) % 4096;
      if (this.uniforms.bleedingFlow) this.uniforms.flowTime = now / 1000;
      manager.applyFilter(this, input, output, clearMode);
    }
  };
  return new NoiseFilterClass(seed);
}
