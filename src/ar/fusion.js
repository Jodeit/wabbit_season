import * as THREE from 'three';

/**
 * Reconcile geometry inferred from the camera against geometry a sensor
 * actually measured.
 *
 * The two are not equal partners and must not be treated as such. A depth
 * sensor reports what is there; the floor-line inference reports what the
 * picture is consistent with. So where both have an opinion the sensor wins
 * outright, and the inference is only kept where the sensor is silent.
 *
 * Being wrong in a measurable way is the useful part. The ground-plane
 * estimate scales linearly with the assumed eye height —
 *
 *     distance = eyeHeight / tan(angle below horizon)
 *
 * — so if sensed distances come back consistently 12% short, the assumed eye
 * height is 12% too large, and a device that can measure anything at all can
 * calibrate the guessing for the parts it cannot reach.
 */

/** Inferred points further than this from a measurement are simply wrong. */
const AGREEMENT = 0.35;
/** Below this many comparisons, any statistic is noise. */
const MIN_SAMPLES = 8;

/**
 * @param {object} opts
 * @param {Array<{p: THREE.Vector3, n: THREE.Vector3}>} opts.inferred
 * @param {THREE.Mesh|null} opts.surface   sensed geometry, if any
 * @param {THREE.Camera} opts.camera
 * @returns {{accepted: Array, stats: object}}
 */
export function reconcile({ inferred, surface, camera, tolerance = AGREEMENT }) {
  const stats = {
    compared: 0, agreed: 0, corrected: 0, rejected: 0, unverified: 0,
    meanError: 0, scale: 1, agreement: 1,
  };
  let hasSensed = !!surface?.geometry?.getAttribute?.('position')?.count;
  // Runtime geometry arrives as a group of meshes rather than one mesh.
  if (!hasSensed && surface?.isObject3D) {
    surface.traverse((o) => {
      if (o.isMesh && o.geometry?.getAttribute?.('position')?.count) hasSensed = true;
    });
  }
  if (!inferred.length || !hasSensed) {
    stats.unverified = inferred.length;
    return { accepted: inferred, stats };
  }

  const origin = camera.getWorldPosition(new THREE.Vector3());
  const raycaster = new THREE.Raycaster();
  const direction = new THREE.Vector3();
  const accepted = [];
  const errors = [];
  const ratios = [];

  for (const sample of inferred) {
    direction.copy(sample.p).sub(origin);
    const inferredDistance = direction.length();
    if (inferredDistance < 1e-3) continue;
    direction.divideScalar(inferredDistance);

    raycaster.set(origin, direction);
    const hit = raycaster.intersectObject(surface, true)[0];
    if (!hit) {
      // The sensor has nothing to say here, which is exactly the gap the
      // inference exists to fill.
      stats.unverified++;
      accepted.push(sample);
      continue;
    }

    stats.compared++;
    const error = Math.abs(hit.distance - inferredDistance);
    errors.push(error);
    ratios.push(hit.distance / inferredDistance);

    if (error <= tolerance) {
      stats.agreed++;
      // Confirmed — but take the measured position, not ours.
      stats.corrected++;
      accepted.push({ p: hit.point.clone(), n: sample.n, confirmed: true });
    } else {
      // Measured and inferred disagree beyond argument. The sensor is right.
      stats.rejected++;
    }
  }

  if (errors.length) {
    stats.meanError = errors.reduce((a, b) => a + b) / errors.length;
    stats.agreement = stats.agreed / stats.compared;
    stats.scale = median(ratios);
  }
  return { accepted, stats };
}

function median(values) {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * What eye height would have made the inference agree with the measurements?
 *
 * Returns null when there is too little evidence, or when the correction is so
 * large that something other than eye height is wrong — a wildly different
 * answer means the assumption being tested is not the broken one.
 */
export function calibrateEyeHeight(current, stats) {
  if (stats.compared < MIN_SAMPLES) return null;
  const suggested = current * stats.scale;
  if (suggested < 0.9 || suggested > 2.2) return null;
  if (Math.abs(suggested - current) < 0.02) return null;
  return suggested;
}

/**
 * Does the measured room look like the room in front of the camera?
 *
 * A headset serves geometry from a saved space setup, which may be of an
 * entirely different room — and it will serve it confidently. Widespread
 * disagreement between what is measured and what is seen is the one signal
 * available that the two are not the same place.
 */
export function roomLooksWrong(stats) {
  return stats.compared >= MIN_SAMPLES * 3 && stats.agreement < 0.25;
}

export { AGREEMENT as FUSION_TOLERANCE };
