/* =====================================================================
   water-capability — the pure decision for the Dashboard's WaterBackground
   =====================================================================

   Extracted from the component so it can be unit-tested without a DOM. It
   answers ONE question: given the device's capabilities, should we leave the
   static CSS wash in place instead of starting the WebGL layer?

   The rule is deliberately conservative — reduced-motion, a coarse pointer on a
   small viewport, or a very low core count all fall back to the static wash.
   WebGL availability is probed separately (it needs a real canvas) and passed
   in by the caller so this stays pure.                                       */

/**
 * @param {object} caps
 * @param {boolean} [caps.reduceMotion]   prefers-reduced-motion: reduce
 * @param {boolean} [caps.coarsePointer]  pointer: coarse (touch)
 * @param {number}  [caps.innerWidth]     viewport width in px
 * @param {number}  [caps.cores]          navigator.hardwareConcurrency
 * @returns {boolean} true => keep the static CSS fallback, do NOT start WebGL
 */
export function shouldUseStaticFallback(caps = {}) {
  const { reduceMotion, coarsePointer, innerWidth, cores } = caps;
  if (reduceMotion) return true;
  // Low-power / mobile: a coarse pointer on a small viewport. Tablets and
  // desktops (fine pointer, or a wide coarse screen) keep the live layer.
  if (coarsePointer && typeof innerWidth === "number" && innerWidth < 900) return true;
  if (typeof cores === "number" && cores > 0 && cores <= 3) return true;
  return false;
}
