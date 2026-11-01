# Homebridge Z-Wave USB architecture

This plugin is a Homebridge dynamic platform backed directly by the local `zwave-js` driver. It
does not require MQTT or another Z-Wave server. HomeKit and Matter publication share the same
feature handlers, while the Homebridge custom UI provides configuration and node maintenance.

## Design goals

- **Stable identity:** Keep HomeKit and Matter identities stable while node metadata and interviews
  improve.
- **One source of device behavior:** Reuse the HomeKit-facing feature handlers for Matter commands
  rather than creating a second Z-Wave control path.
- **Fail-closed maintenance:** Recheck device identity, metadata, and compatibility at the backend
  before a maintenance write.
- **Honest asynchronous state:** Treat sleeping-node work, supervised commands, and device reports
  as distinct lifecycle stages.
- **Direct mode:** Communicate with USB Z-Wave controllers through the local `zwave-js` driver.

## Architecture

- `src/index.ts`: Entry point.
- `src/platform/ZWaveUsbPlatform.ts`: Orchestrates node discovery, accessory caching, and lifecycle.
- `src/zwave/ZWaveController.ts`: Wrapper for the `zwave-js` Driver. Implements custom log piping and terminal-based S2 PIN entry.
- `src/accessories/AccessoryFactory.ts`: Maps Z-Wave nodes/endpoints to HomeKit features.
- `src/accessories/ZWaveAccessory.ts`: Encapsulates a Z-Wave node as a HomeKit accessory.
- `src/accessories/ControllerAccessory.ts`: Provides Inclusion/Exclusion/Heal switches in HomeKit.
- `src/features/*`: Implementation of specific HomeKit services (Switch, Lock, Sensors, etc.).
- `src/devices/deviceOverrides.ts`: Per-device exceptions keyed on the Manufacturer Specific fingerprint, for hardware that cannot be classified from its Command Classes alone.
- `src/zwave/nodeApi.ts`: Runtime accessors for Command Class APIs that are not part of the node interface, so node mocks stay small.
- `src/platform/TypeOverrideStore.ts`: Versioned, per-network persistence for user device-type decisions and hardware observations.
- `src/platform/TypeOverrideResolver.ts`: Cohort resolution, compatibility checks, stale-write guards, and serialized type decisions.
- `src/platform/NodeTypePayload.ts`: Values and codes consumed by the Device type section.
- `src/platform/NodeParametersPayload.ts`: Groups Configuration values into endpoint/parameter models.
- `src/platform/NodeParametersRefresh.ts`: Tracks read-only Configuration re-reads against per-value baselines.
- `src/platform/NodeParametersWrite.ts`: Validates and tracks one Configuration write and its explicit readback.
- `homebridge-ui/server.js`: Narrow IPC adapter between config-ui-x and the platform routes.
- `homebridge-ui/public/index.html`: Browser-owned UI state and event wiring.
- `homebridge-ui/public/ui-helpers.js`: Pure presentation descriptions shared by the page and unit tests.

## Management surfaces

### Controller accessory

The HomeKit controller accessory provides system status, inclusion, exclusion, and network healing.
When secure inclusion needs a PIN, the plugin accepts it from either the temporary file or the
custom manager characteristic during the inclusion window.

- **Terminal**: `echo "PIN" > s2_pin.txt`
- **HomeKit**: Write to `S2 PIN Input` characteristic in third-party apps.

### Homebridge custom UI

The Configuration tab owns plugin settings and security keys. The Maintenance tab owns node lists,
node detail pages, firmware updates, failed-node removal, route rebuilding, radio diagnostics,
device-type decisions, and Configuration parameter inspection and editing.

The browser describes intent, but the platform decides whether it is still safe. Mutating routes
carry a device identity, fingerprint, revision, acknowledgments, or a combination appropriate to
the operation. Expected refusals return controlled codes beside fresh state so the UI can explain
what changed without exposing driver text.

### Log piping

All internal Z-Wave JS logs are redirected to the Homebridge logger.

- Debug: Raw protocol events.
- Info: Node status, interview stages, and security alerts.

## Accessory planning and reconciliation

`AccessoryFactory.planFeatures()` reads a node once and produces the ordered plan used to construct
features, compute the graph signature, and calculate the HomeKit category. With no override, the
plan preserves the existing detection order. A compatible override replaces only the primary
feature group.

`ZWaveUsbPlatform` compares graph signatures during reconciliation. Metadata-only changes update an
existing wrapper. A structural change stops and replaces the wrapper. Failed replacements are not
left recorded as healthy and are retried by later reconciliation.

### Stability settings

- `softReset: false`: Prevents hangs on Aeotec Z-Stick controllers.
- `didFinishLaunching` Wait: Ensures the driver is ready before HomeKit starts.
- Homebridge-Managed Storage: Cache and config are stored in the user's Homebridge folder.

## Minimum HomeKit Mapping

- **Actuators**: Binary Switches, Dimmers, RGB/Color Lights, Locks, Thermostats, Window Coverings, Garage Doors, Sirens.
- **Sensors**: Contact, Motion, Leak, Smoke, CO, Air Quality (CO2, VOC, PM2.5), Temperature, Humidity, Illuminance.
- **Misc**: Central Scene (Programmable Switches), Battery Service.

## Identity & Caching

- **UUIDs**: Stable UUIDs derived from `homebridge-zwave-usb-[homeId]-[nodeId]`.
- **Reconciliation**: The platform claims compatible cached accessories, delays destructive cleanup
  until the controller state is known, and provides explicit stale-accessory cleanup in the UI.
- **Type overrides**: User decisions belong to a Manufacturer Specific fingerprint on one Z-Wave
  network, not to a reusable node number.
- **Refresh and write tokens**: Parameter operations belong to the live node object and are removed
  when that node leaves or is replaced.

## Configuration parameter model

Configuration values are grouped by endpoint and parameter number. Partial values remain fields of
one parameter. A whole value is composed only when the fields agree on width, have valid
non-overlapping masks covering every bit, and all carry values.

The viewer's Re-read lifecycle uses per-value timestamp baselines and never treats dispatch
completion as a device answer. The writer validates against live metadata, fails closed when a
partial write cannot preserve sibling bits, and confirms readable writes only through an explicit
Configuration Get. The optimistic zwave-js cache is presentation state, not confirmation evidence.

## Testing Strategy

- **Jest**: Mocked Z-Wave JS driver with full `EventEmitter` support.
- **Linting**: Strict `typescript-eslint` rules with zero-warning tolerance.
- **CI**: GitHub Actions for every push (lint + test + build).
- **Matter host checks**: Fresh and restored endpoint construction against an installed Homebridge
  Matter runtime.
- **Browser harnesses**: Interaction, width, theme, focus, and announcement checks against the real
  page and helpers.
- **Mutation checks**: Targeted mutations for safety-critical rules and assertions, run against a
  verified-green baseline.

## Release Management

- **Versioning**: Follow SemVer.
- **Changelog**: Maintain `CHANGELOG.md` with detailed notes for every release.

## Matter publication

`MatterAccessories` owns registration, cached ownership, removal, and listener cleanup for all
supported Z-Wave services. `serviceMappings.ts` translates HAP services into Matter clusters and
routes commands through existing characteristic handlers. One stable accessory UUID identifies
the node; additional services use stable service-UUID/subtype part identifiers. Coverings retain
the root endpoint used by the initial Matter implementation.

A rebuilt wrapper rebinds listeners and command resolution without re-registering a live UUID.
Shutdown invalidates work still constructing descriptors. Capability changes that alter the
endpoint structure take effect after restart. The cache sweep follows the controller's node list,
not interview completion or the publication queue, and Matter errors do not restart Z-Wave.

`node scripts/verify-matter-host.mjs /path/to/node_modules/homebridge` checks fresh and restored
endpoint construction against an installed Homebridge 2.4 runtime after `npm run build`. It uses
a temporary, uncommissioned Matter server without starting network advertisement. This supplements
the unit tests; it does not establish physical-device or controller-app compatibility.

### Optional Matter measurement servers

`deviceComposition.ts` composes host-provided CO2, TVOC, and PM2.5 measurement servers. CO2 and
AQ HAP services sharing an endpoint contribute bindings to one Matter service; each binding keeps
its source service and checks the driver cache before treating a getter default as a reading.

Homebridge 2.4 compares root server names during cache reclamation but omits optional child
servers. Explicitly composing the root's required bridged-info server makes the host reconstruct
the requested graph instead of attaching to incomplete cached children. The plugin keeps the
same accessory UUID and child IDs. `verify-matter-lifecycle.mjs` checks this path across three
starts with the host's actual serializer and registration code, including independent batteries.
No host registry, private runtime object, or on-disk cache is modified by the plugin.
