/* =====================================================================
   WaterBackground — the Dashboard's premium fluid-motion background layer
   =====================================================================

   A subtle, unframed water/ripple visual that sits BEHIND the Dashboard
   content (never behind a table — the KPI/chart cards are opaque white and
   cover the animation; only the workspace gutters reveal it). It is fully
   isolated from React report state: the render loop lives in a single effect
   and mutates plain uniforms, so it never triggers a React re-render and can
   never touch a formula, a value or a request.

   Everything about it fails safe:
     - Three.js is DYNAMICALLY imported, so it is code-split into its own
       lazy chunk and never blocks the initial data render or the main bundle.
     - A pure-CSS gradient fallback is painted immediately and stays visible if
       WebGL is unavailable, the import fails, motion is reduced, or the device
       is low-power / mobile. The Dashboard is fully usable in every case.
     - Device pixel ratio is capped, the loop pauses when the tab is hidden or
       the layer scrolls out of view, it honours prefers-reduced-motion, and it
       only reads the pointer on pointer-capable (fine) devices.
     - It is absolutely positioned and pointer-transparent, so it can never
       cause layout shift or intercept a click.                              */

import React, { useEffect, useRef } from "react";

/** Coarse capability probe. Returns true when we should NOT start WebGL and
 *  should leave the static CSS fallback in place instead. */
function shouldUseStaticFallback() {
  if (typeof window === "undefined") return true;
  try {
    const reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return true;
    // Low-power / mobile: a coarse pointer on a small viewport, or a very
    // low core count. Tablets and desktops keep the live layer.
    const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
    const small = window.innerWidth < 900;
    if (coarse && small) return true;
    const cores = navigator.hardwareConcurrency;
    if (typeof cores === "number" && cores > 0 && cores <= 3) return true;
  } catch (_e) { return true; }
  return false;
}

/** Real WebGL support probe (independent of Three.js loading). */
function webglAvailable() {
  try {
    const canvas = document.createElement("canvas");
    return !!(window.WebGLRenderingContext && (canvas.getContext("webgl") || canvas.getContext("experimental-webgl")));
  } catch (_e) {
    return false;
  }
}

const VERTEX = `
  void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

// A gentle, layered water surface: two drifting fbm fields make a soft caustic,
// a slow sine ripple adds a highlight, and the whole thing is kept at a low
// alpha and faded toward the top so the page heading stays clean.
const FRAGMENT = `
  precision mediump float;
  uniform float uTime;
  uniform vec2  uRes;
  uniform vec2  uPointer;
  uniform float uIntensity;

  float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
               mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++){ v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
  }
  void main(){
    vec2 uv = gl_FragCoord.xy / uRes.xy;
    float aspect = uRes.x / max(uRes.y, 1.0);
    vec2 p = vec2(uv.x * aspect, uv.y) * 2.6;
    p += uPointer * 0.18;                       // subtle pointer parallax
    float t = uTime * 0.045;
    float n1 = fbm(p + vec2(t, t * 0.6));
    float n2 = fbm(p * 1.7 - vec2(t * 0.7, t));
    float caustic = smoothstep(0.35, 0.95, n1 * 0.6 + n2 * 0.5);
    float ripple = sin((uv.x * 5.0 + n1 * 4.0) + uTime * 0.28) * 0.5 + 0.5;

    // Soft Upriver navy -> blue water palette (never a harsh gradient).
    vec3 deep  = vec3(0.086, 0.145, 0.235);     // #16253C-ish navy
    vec3 mid   = vec3(0.145, 0.400, 0.640);     // #2566A3-ish blue
    vec3 light = vec3(0.560, 0.780, 0.945);     // #8FC7F1-ish highlight
    vec3 col = mix(deep, mid, caustic);
    col = mix(col, light, ripple * 0.22 * caustic);

    float alpha = (0.05 + caustic * 0.15 + ripple * 0.04) * uIntensity;
    alpha *= 0.35 + smoothstep(0.0, 0.65, uv.y) * 0.65;   // fade under the header
    gl_FragColor = vec4(col, alpha);
  }
`;

export default function WaterBackground() {
  const hostRef = useRef(null);
  const canvasRef = useRef(null);

  useEffect(() => {
    // If we cannot / should not run WebGL, leave the CSS fallback and do nothing.
    if (shouldUseStaticFallback() || !webglAvailable()) return undefined;

    const canvas = canvasRef.current;
    const host = hostRef.current;
    if (!canvas || !host) return undefined;

    let renderer = null;
    let scene = null;
    let camera = null;
    let material = null;
    let geometry = null;
    let mesh = null;
    let raf = 0;
    let disposed = false;
    let visible = true;       // tab visible
    let onScreen = true;      // layer intersects the viewport
    let lastFrame = 0;
    const start = (typeof performance !== "undefined" ? performance.now() : Date.now());

    const pointer = { x: 0, y: 0 };       // target
    const smooth = { x: 0, y: 0 };        // eased, fed to the shader
    const finePointer = !!(window.matchMedia && window.matchMedia("(pointer: fine)").matches);

    const DPR_CAP = 1.5;
    const FRAME_MS = 1000 / 30;           // throttle to ~30fps

    const size = () => {
      const w = Math.max(1, host.clientWidth);
      const h = Math.max(1, host.clientHeight);
      return { w, h };
    };

    const onPointerMove = (event) => {
      const { w, h } = size();
      // -1..1 around the centre
      pointer.x = (event.clientX / w) * 2 - 1;
      pointer.y = (event.clientY / h) * 2 - 1;
    };
    const onVisibility = () => { visible = !document.hidden; if (visible && !raf && !disposed) loop(start); };

    function resize() {
      if (!renderer) return;
      const { w, h } = size();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
      renderer.setSize(w, h, false);
      if (material) material.uniforms.uRes.value.set(w * renderer.getPixelRatio(), h * renderer.getPixelRatio());
    }

    function loop(now) {
      raf = 0;
      if (disposed) return;
      if (!visible || !onScreen) return;      // fully paused, no RAF queued
      raf = window.requestAnimationFrame(loop);
      if (now - lastFrame < FRAME_MS) return; // frame throttle
      lastFrame = now;
      // ease the pointer so parallax is gentle
      smooth.x += (pointer.x - smooth.x) * 0.05;
      smooth.y += (pointer.y - smooth.y) * 0.05;
      material.uniforms.uTime.value = (now - start) / 1000;
      material.uniforms.uPointer.value.set(smooth.x, smooth.y);
      renderer.render(scene, camera);
    }

    let ro = null;
    let io = null;

    (async () => {
      let THREE;
      try {
        THREE = await import("three");
      } catch (_e) {
        return; // import failed -> CSS fallback stays; Dashboard unaffected
      }
      if (disposed) return;
      try {
        renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: false, powerPreference: "low-power" });
        renderer.setClearColor(0x000000, 0);
        scene = new THREE.Scene();
        camera = new THREE.Camera();       // full-screen quad; no projection needed
        geometry = new THREE.PlaneGeometry(2, 2);
        material = new THREE.ShaderMaterial({
          vertexShader: VERTEX,
          fragmentShader: FRAGMENT,
          transparent: true,
          depthTest: false,
          depthWrite: false,
          uniforms: {
            uTime: { value: 0 },
            uRes: { value: new THREE.Vector2(1, 1) },
            uPointer: { value: new THREE.Vector2(0, 0) },
            uIntensity: { value: 1 },
          },
        });
        mesh = new THREE.Mesh(geometry, material);
        scene.add(mesh);
        resize();

        // Pause when the layer scrolls out of the viewport.
        io = new IntersectionObserver((entries) => {
          onScreen = entries.some((entry) => entry.isIntersecting);
          if (onScreen && visible && !raf && !disposed) loop(performance.now());
        }, { threshold: 0 });
        io.observe(host);

        // Follow container size changes without a React re-render.
        if (typeof ResizeObserver !== "undefined") {
          ro = new ResizeObserver(() => resize());
          ro.observe(host);
        } else {
          window.addEventListener("resize", resize);
        }

        if (finePointer) window.addEventListener("pointermove", onPointerMove, { passive: true });
        document.addEventListener("visibilitychange", onVisibility);

        loop(performance.now());
      } catch (_e) {
        // Any WebGL init failure: dispose what exists and keep the fallback.
        try { if (renderer) renderer.dispose(); } catch (_err) { /* noop */ }
        renderer = null;
      }
    })();

    return () => {
      disposed = true;
      if (raf) window.cancelAnimationFrame(raf);
      try { document.removeEventListener("visibilitychange", onVisibility); } catch (_e) { /* noop */ }
      try { window.removeEventListener("pointermove", onPointerMove); } catch (_e) { /* noop */ }
      try { window.removeEventListener("resize", resize); } catch (_e) { /* noop */ }
      try { if (io) io.disconnect(); } catch (_e) { /* noop */ }
      try { if (ro) ro.disconnect(); } catch (_e) { /* noop */ }
      try { if (geometry) geometry.dispose(); } catch (_e) { /* noop */ }
      try { if (material) material.dispose(); } catch (_e) { /* noop */ }
      try { if (renderer) renderer.dispose(); } catch (_e) { /* noop */ }
    };
  }, []);

  // The host is the static CSS fallback; the canvas draws over it when WebGL runs.
  return (
    <div className="water-bg" ref={hostRef} aria-hidden="true">
      <canvas className="water-bg-canvas" ref={canvasRef} />
    </div>
  );
}
