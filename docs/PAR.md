# PAR calibration and planner

Someone with a PAR meter calibrates a light type once. The calibration ships
with the app (`android/app/src/main/assets/www/js/par-data.js`), and then
anyone with that light can ask for a PAR at a spot in their tank and get
channel settings.

## Calibrating

Lights & backup, PAR, **Calibrate with a PAR meter**.

1. Dark room, wavemakers and return pump off (flat surface), sensor level.
2. Enter the light's height above the water and your meter's correction.
   The app adds and multiplies for you, so always type the meter's own
   number. Every reading is also kept raw in the calibration file.
3. Tap **Warm up: all at 100%** and wait about 10 minutes with the screen open.
4. Tap **Start**. For each reading the app sets the light; you hold the
   meter where it says and type the number. **Stop for now** keeps your
   progress, and the light goes back to its schedule.

Default positions: in air 20 cm below the light, and in water at 10, 25 and
40 cm deep under the centre, 30 cm to the side at 10 cm deep, and 15 and 30 cm
to the side at 40 cm deep. You can change them. Measure "to the side" along
the light's long side.

At each position: everything off (room light, subtracted from the rest),
each channel alone at 100%, all channels at 100% and at 50%. At the position
marked "Curves" (25 cm deep, centre, by default), each channel also at 10,
25, 50 and 75%. That comes to 88 readings for a K7 Pro, about 40 minutes.

When it is done the app shows how closely the model matches your readings
(under 10% is good). **Save calibration file** writes a JSON file; its
contents go in place of `null` in `par-data.js` to build it into the app.
**Load calibration file** puts one on another phone or Mac without a rebuild.

## How the estimate works

PAR from different channels adds up, so for channel values v:

    PAR = combined(load) x sum over channels c of  I0[c] x G(c, spot) x curve[c](v[c])

* `curve[c]` is what share of full output the channel gives at a slider value,
  measured at the "Curves" position. LED drivers are rarely linear,
  least of all at low settings.
* `combined` is how much less the light gives with many channels on at once
  (heat, or a power limit in the driver), from the all-channels readings
  compared with the channels added up.
* `G` is geometry: the fixture modelled as a square of LEDs, each channel's
  beam spread as cos^m of the angle (m fitted per channel), refraction and
  reflection at the water surface (Snell and Fresnel), and absorption in
  clear seawater (noticeable only for red). Because this is physics rather
  than a lookup table, the planner can estimate spots and light heights that
  were never measured.
* `I0[c]` (strength), `m[c]` and the fixture size are fitted to the readings.

The planner keeps the mix's ratios and finds the brightness that gives the
asked-for PAR.

## Limits

* Glass walls and white sand reflect light back, so near the walls and
  close to the sand the real reading is usually higher than the estimate.
* Estimates are good to about 10 to 20% in a typical tank. The meter itself
  is usually good to about 5%, so differences under that are not worth chasing.
* LEDs fade with age. Re-measure the in-air reading now and then and compare.
* Each light type needs its own calibration (K7 Pro and K7 Mini differ).
