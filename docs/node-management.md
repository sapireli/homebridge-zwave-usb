# Node maintenance, device types, and Configuration parameters

The Homebridge custom UI provides a network overview and a detail page for each Z-Wave node. This
guide explains what the detail page can change, what it only observes, and which operations may
wait for a sleeping device.

## Open a node

Open the plugin settings, choose **Maintenance**, and use the chevron in a node's **Details** column.
The detail page keeps the node name, status, firmware, and maintenance actions together. Depending
on the node, it also provides these sections:

- **Device type** explains what HomeKit publishes and why.
- **Parameters** presents the settings reported through Configuration CC.
- **Diagnostics** presents radio, route, and command information.

**All nodes** returns to the network overview at its previous scroll position.

## Device type

### Detected, verified, and overridden types

The page distinguishes three sources:

- **Detected automatically from the device** is the plugin's ordinary capability classification.
- **Built-in verified registry** is the plugin's reviewed default for known hardware.
- **Your override** is a choice saved from the Device type section.

Without an override, the plugin keeps its normal classification. An override does not teach the
plugin that every device with similar command classes has the same purpose; it applies only to the
reported hardware fingerprint on this Z-Wave network.

### Hardware scope

Z-Wave can reuse a node number after a device is removed. A saved device type is therefore keyed to
the Manufacturer Specific fingerprint: manufacturer ID, product type, and product ID. It is not
keyed to the node number.

Every interviewed node on the same network reporting that fingerprint forms one hardware cohort.
The confirmation lists the nodes the decision covers. If a node number later reports different
hardware, the saved override does not move to it. The page instead offers an acknowledgment for the
old observation.

### Compatible choices only

The plugin offers a HomeKit type only when every affected node reports the values that feature
needs to build and operate a working service. The backend checks the same rule again when Apply is
pressed, so an old page or a manually constructed request cannot bypass it.

A multi-endpoint device has no single root type to replace safely and is shown read-only.

### What Apply and Revert change

Apply saves the override before rebuilding each affected HomeKit accessory whose service graph
changes. A node already publishing the requested graph is left alone. A failure on one node does
not prevent the others from rebuilding; its warning remains until a later successful reconcile.

Replacing a HomeKit service can require rooms, scenes, and automations that used the old service to
be configured again. The accessory identity remains stable, but HomeKit treats the replacement as
a different service.

Revert removes the override and returns each affected node to its detected or verified default.
Remove is offered only for a saved override that no device is using.

HomeKit receives the replacement service in the running session. A Matter endpoint keeps its
current type until Homebridge restarts, and the confirmation states that requirement when it
applies.

### Saved overrides unavailable

Overrides are stored in a versioned file for the Z-Wave network under the Homebridge storage path.
If the file cannot be read safely, the plugin:

- applies no saved override;
- disables type changes;
- leaves the file unchanged; and
- writes the file path and technical reason to the Homebridge log.

Repair or remove the file only after reading that log. Restart Homebridge after correcting it so
the plugin can load it before classifying accessories.

## Configuration parameters

Configuration parameters are device-specific settings such as LED behavior, motion timeouts,
reporting thresholds, or power-restoration behavior. Their meaning and safe values come from the
metadata available to zwave-js and, when necessary, the device manual.

### What the page shows

A parameter may include:

- its number, label, and description;
- current numeric value, unit, and named state;
- default and recommended values;
- range and permitted values;
- encoded size and format;
- last report time; and
- Advanced, Read-only, Not readable, Destructive, or Requires re-inclusion marks.

Metadata varies by device. A missing row means the device configuration information did not supply
that fact; it is not an inferred default.

Advanced parameters are hidden until **Show advanced** is opened. Search matches parameter numbers,
labels, descriptions, and divided-field labels.

### Partial parameters

One Configuration parameter can be divided into several bitmask fields. The page keeps those fields
inside one parameter instead of presenting them as unrelated settings.

A partial field is writable only when every sibling field has reported a numeric value, all fields
agree on the encoded width, and their non-overlapping masks account for every bit. Otherwise, the
plugin cannot preserve the neighboring bits and refuses the write. Use **Re-read values** and wait
for the missing fields before trying again.

### Cached values and Re-read

Opening Parameters reads only the zwave-js cache. It does not contact the device.

**Re-read values** asks the device to report the readable Configuration values known when the
request begins. The request may remain pending while a sleeping device waits for its next wake-up.
The page marks the exact values still outstanding and does not claim success merely because the
request was dispatched.

A second press while the request is running sends nothing new. If it settles with readable values
still outstanding, the page offers a retry with a fresh baseline. Values that disappear or stop
being readable are reported separately rather than counted as answers. A retry asks only about
values that are currently available.

Write-only settings are marked **Not readable** and are not included in the wait.

### Editing a value

The editor uses a select when the permitted choices can be represented completely in no more than
24 entries. A larger or continuous set uses a number field bounded by the intersection of the
reported range, permitted values, step, encoding size, and signed or unsigned format.

For a sparse permitted set that is too large for a select, the Allowed values row remains the
complete list and the field says **Only the permitted values shown above can be saved.** A number
inside the field's visible bounds is still refused unless it appears in that set.

The browser is not the authority. Immediately before sending, the backend reads the live metadata
again and refuses a stale or invalid request.

Only one setting change may run for a node at a time. A change cannot begin while a parameter
Re-read is active. Once the Set has been sent and only confirmation remains, another Re-read is
safe because it sends Gets rather than changing the value.

There is no bulk edit and no device-wide Default Reset. A displayed default can be entered or
selected when it is otherwise permitted.

### Dangerous settings

A setting marked **Destructive** may reset or erase device settings. A setting marked **Requires
re-inclusion** may stop working until the device is excluded and included again. The confirmation
names the setting, the device, and every applicable risk.

The acknowledgment is checked against the current metadata by the backend. Calling the route
outside the page does not bypass it.

### Sent, confirmed, different, and unconfirmed

An accepted Z-Wave Set does not prove that the device applied the value. zwave-js may optimistically
place the requested value in its cache before the physical device reports anything.

For a readable value, the plugin therefore sends an explicit Configuration Get after the Set:

- **Confirmed** means the device reported the requested number.
- **Different** means the device reported another number, which the page shows.
- **Unconfirmed** means no usable answer was received.
- **Sent** is terminal only for a value the device cannot report back.

If supervision says the device is still applying the change, the plugin waits the complete
reported duration before asking. Reading sooner could return the old value and incorrectly call it
the final result.

A sleeping device may leave a write queued until it wakes. The page request returns immediately,
and later visits resume the same queued operation rather than sending another one.

## Diagnostics

Diagnostics reads the controller's current information for the selected node. Depending on what
zwave-js reports, it may include neighbors, the last working route, repeaters, signal measurements,
round-trip time, command counts, and background RSSI.

The report is a current observation, not a promise that the same route will be used for the next
command. Z-Wave can choose a different route for each transmission.

Window coverings may also provide movement and stop test controls. These issue ordinary device
commands and describe the position the device reports afterward.

## Troubleshooting

### The Parameters section says the interview is unfinished

Wake the device and use **Refresh Info**. A sleeping device may need more than one wake-up to finish
an interview or deliver Configuration reports.

### Re-read remains pending

The device has not yet reported every readable value included in the attempt. Wake a sleeping
device. If the attempt later settles incomplete, use Retry.

### Some values could not be confirmed because they are no longer available

One or more values the attempt was waiting for disappeared or became unreadable, so they were
reported separately rather than counted as answers. Nothing from that attempt remains outstanding,
so this is not a device that has yet to reply.

A retry asks only about the values available when it starts. If an unavailable value later returns
and becomes readable, a later re-read includes it.

### A partial field cannot be changed

One or more sibling fields are missing or cannot be composed safely. Re-read the values. If the
device still does not report every field, leave the parameter unchanged and consult its manual.

### A saved device type cannot be applied

The device may no longer report the values the selected feature requires, or another node with the
same fingerprint may be incompatible. Review the cohort and the current choices shown on the page.

### This parameter changed while the page was open

The live parameter definition no longer matches the one the editor displayed. Review its current
range, permitted values, size, format, and safety marks before trying again.

### The device changed while this page was open

The node number no longer belongs to the device identity the page opened. Return to **All nodes**
and open the current device rather than retrying from the stale page.

### Reload the page and try again

The change arrived without the device identity the plugin uses to confirm which node was meant.
Reload the page and make the change again. If the message returns, open the node from **All nodes**
so the page loads a fresh payload before you edit.

None of these three messages means the device rejected the value. Each is refused before anything
reaches the network, so nothing was sent.

### HomeKit changed but Matter did not

Restart Homebridge. Matter endpoint structure is restored from the new device type at startup.
