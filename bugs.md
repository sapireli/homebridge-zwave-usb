# End-to-End Bug Audit (Pass 21)

The following major bugs were identified during a final comprehensive audit.

## 1. Window Covering PositionState Logic Flaw (Major)
**File:** `src/features/WindowCoveringFeature.ts`
**Description:** `handleGetPositionState` compares `current` against `target` to determine direction. However, `current` is fetched from the node's `currentValue`, while `target` is fetched from `handleGetTargetPosition`, which prioritizes `localTargetPosition`.
**Impact:** If a user drags the slider from 0% to 50%, `localTarget` becomes 50. The shade starts moving. If the user then drags it back to 0% *before* the first update arrives, `localTarget` becomes 0. `current` is still 0. The logic sees `current == target` (0 == 0) and reports `STOPPED`. However, the physical shade might still be processing the first command (moving to 50%).
**Correction:** The state should ideally reflect the *last known physical motion* or wait for a report. However, given Z-Wave latency, if we send a new target that matches the current position, reporting `STOPPED` is technically correct for the *intent*, even if the motor is lagging.
**Action:** No code change required, but noteworthy. The "Explicit Stop" fix handles the command side.

## 2. Thermostat Setpoint Rounding Mismatch (Major)
**File:** `src/features/ThermostatFeature.ts`
**Description:** In `setSetpoint`, the code rounds the target value to 0.5 precision. However, `getSetpoint` (used for `handleGetTargetTemp`) does *not* apply the same 0.5 rounding when reading from the device (it only rounds to 1 decimal place: `Math.round(tempC * 10) / 10`).
**Impact:** If a device reports `20.1°C`, `getSetpoint` returns `20.1`. If the user touches the slider, `setSetpoint` will round it to `20.0` or `20.5`. This mismatch causes the slider to "snap" to a slightly different value than what was just read, creating a jarring UI experience.

## 3. Potential "Dead" Node Refresh Loop (Major)
**File:** `src/accessories/ZWaveAccessory.ts`
**Description:** `refresh()` checks `!this.node.ready` and returns. However, it does *not* check if the node is `Dead` (status 4).
**Impact:** If a node is dead, we might still try to read values from the cache. While `getValue` usually returns cached values, `HapStatusError` logic in features relies on `getValue` returning `undefined`. If the cache is stale but present, features will report "success" with old data for a dead node.
**Correction:** We already map `StatusFault` for dead nodes. However, for critical sensors (Lock, Garage), we might want to force an error if the node is dead, rather than returning stale cached state.

## 4. Unhandled 'Security' Event in Controller (Minor)
**File:** `src/zwave/ZWaveController.ts`
**Description:** The controller sets up listeners for inclusion/exclusion/heal. It does *not* listen for 'smart start' or specific security bootstrap failures other than the generic `inclusion stopped`.
**Impact:** If S2 bootstrapping fails silently, the user sees "Driver Ready" but the device might be included insecurely (S0 or None) without warning.

## 5. Thermostat "Auto" Deadband Logic Edge Case (Major)
**File:** `src/features/ThermostatFeature.ts`
**Description:** In `handleSetTargetTemp` (Auto mode), `newHeat` and `newCool` are calculated. Then hardware limits are applied. Then the deadband is enforced.
**Logic:**
```typescript
if (newCool < newHeat + 0.5) {
  if (diff > 0) newHeat = newCool - 0.5;
  else newCool = newHeat + 0.5;
}
```
**Problem:** If `newCool` was clamped to `maxC` (e.g. 30), and `newHeat` was calculated as 30. `newCool < newHeat + 0.5` is true (30 < 30.5). `diff > 0` (user raised temp). `newHeat` becomes 29.5.
**Result:** The user tries to raise the temp, but the heating setpoint is forced *down* to maintain the gap because cooling hit the ceiling. This is "correct" for safety but might be confusing.
**Action:** Acceptable behavior for strict mode.

## 6. Garage Door "Obstruction" State Stickiness (Major)
**File:** `src/features/GarageDoorFeature.ts`
**Description:** The `obstruction` property is read from Z-Wave.
**Impact:** Z-Wave notification values for obstruction are often transient events, not persistent states. If `obstruction` becomes true, does it ever become false automatically? Or does it require a manual clear?
**Action:** Most Z-Wave openers clear the obstruction alarm when the door moves again. However, if the door is stopped, it might remain true. This is acceptable behavior.
