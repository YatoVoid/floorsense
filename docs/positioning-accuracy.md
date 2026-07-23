# Positioning accuracy: what to expect

This system estimates a device's position from WiFi RSSI (signal
strength) readings across AP nodes, using a log-distance path-loss
model fitted from calibration samples. This page is an honest account
of what that can and can't deliver, so nobody is surprised on real
hardware.

## The realistic ceiling

RSSI-based indoor positioning, even well-calibrated, typically lands in
the **1-4 meter** error range, not centimeters. This isn't a bug or a
gap in this codebase - it's a property of radio physics that no
fitting algorithm removes:

- **Multipath.** Indoor RF reflects off walls, furniture, and people.
  The same true distance can produce noticeably different RSSI
  readings depending on what's between the device and the AP node at
  that moment.
- **Human-body attenuation.** A phone in someone's pocket, or a crowd
  of people between the device and an AP node, measurably weakens the
  signal in a way distance alone doesn't explain.
- **RSSI's own temporal noise.** Even a stationary device's RSSI to a
  fixed AP node varies run to run by several dB, which the path-loss
  model converts directly into distance uncertainty.

Nothing in `packages/positioning` or `packages/backend/src/calibration.ts`
claims otherwise, and no UI copy should ever say "exact location" -
"approximate position" or "estimated position" is the accurate framing.

## What actually improves accuracy (in order of impact)

1. **AP node count and placement.** 3 AP nodes is the minimum for real
   trilateration (fewer than that falls back to a weighted centroid,
   which is a rougher estimate). 4+ AP nodes, physically spread around
   the space rather than clustered in one corner or along one wall
   (collinear layouts are explicitly detected and rejected - see
   `estimateDevicePosition`'s collinearity guard), meaningfully improve
   both accuracy and robustness to any single AP node's noise.
2. **Calibration sample coverage.** Calibration samples should span a
   real range of distances from each AP node, not all clustered near
   one spot. `fitCalibrationProfile` needs `MIN_CALIBRATION_SAMPLES`
   (5) venue-wide to fit at all, and `MIN_CALIBRATION_SAMPLES_PER_AP_NODE`
   (3) of an AP node's own samples before it gets its own fitted
   reference RSSI - below that, it falls back to the venue-wide shared
   value. More, better-spread samples per AP node improve both.
3. **Per-AP-node calibration.** Real AP hardware (including different
   ESP32 units) will have some transmit-power/antenna variance between
   physical units. `fitCalibrationProfile` fits an intercept
   (reference RSSI) per AP node once it has enough of its own samples,
   rather than forcing every AP node through one shared average -
   correcting for exactly this real hardware variance.
4. **Outlier-robust fitting.** A single mis-marked calibration position
   or stray RF reflection shouldn't drag the whole fit off. One robust
   refit pass drops samples whose residual is more than 2.5 standard
   deviations from the initial fit, then refits on what's left.
   **Known limitation:** this specific technique can fail against an
   extreme, out-of-range outlier (a reading far outside the sampled
   distance range with a very large error) - a single bad point like
   that can skew even the *initial* fit badly enough that the
   residual check can't reliably identify it as the outlier. If a
   fitted profile looks physically implausible (e.g. a positive
   path-loss exponent well outside 2-4, or a reference RSSI nowhere
   near what a phone at 1 meter should read), re-calibrate rather than
   trusting it blindly.
5. **Weighted trilateration.** Closer/stronger AP-node readings are
   weighted more heavily than farther/weaker ones when solving for a
   position (the same inverse-square weighting the weighted-centroid
   fallback already used), so one noisy far reading pulls the estimate
   less than an accurate close one does.

## What this does NOT do

- No Kalman filtering, particle filters, or sensor fusion (accelerometer/
  gyroscope from the device side) - out of scope for this project. These
  are the standard next step if meter-level accuracy isn't enough for a
  given use case, at real additional engineering cost.
- No machine-learned fingerprinting (recording full RSSI vectors at many
  known points and matching against them later) - a legitimate
  alternative technique with its own tradeoffs, not implemented here.
- No claim of tracking a specific named individual - this system only
  ever knows a consented, hashed device identifier and its estimated
  position, never a person's identity.
