# Natural cycle

The natural cycle runs your light on a real reef's day: its sunrise and
sunset, its seasons, and its moon, worked out fresh for every date. It is
modelled on the work that first got Acropora to broadcast spawn reliably in
closed aquaria.

## The research it follows

**Craggs et al. 2017**, *Inducing broadcast coral spawning ex situ: Closed
system mesocosm design and husbandry protocol*, Ecology and Evolution 7:
11066-11078 (Horniman Museum, Project Coral). Acropora from Singapore (Kusu
reef) and the Great Barrier Reef (Lizard Island) spawned in London. Their
lighting:

* the reef's sunrise, sunset, moonrise and moonset times, changing through the
  year;
* a 3 hour ramp from 0% at sunrise to the midday level, a midday plateau, and
  a 3 hour ramp down to 0% at sunset;
* midday intensity scaled through the year between 60% and 100%, following the
  reef's monthly sunlight;
* moonlight (white, about 1 lux at full moon) from moonrise to moonset,
  following the phase;
* the clock shifted so spawning happened at convenient hours.

Spawning ex situ came later than on the reef: 6 to 16 nights after the full
moon, against 3 to 6 in the wild.

**Lin et al. 2021**, *Moonrise timing is key for synchronized spawning in
coral Dipsastraea speciosa*, PNAS 118: e2101985118. Before the full moon, the
moon is already up at sunset. After it, the moon rises about 50 minutes later
each night, so a dark gap opens between sunset and moonrise. That dark gap
triggers spawning.

**de la Torre Cerro et al. 2025**, *Evaluating the role of moonlight-darkness
dynamics as proximate spawning cues in an Acropora coral*, Coral Reefs 44:
501. In Palau, Acropora aff. hyacinthus kept in darkness after sunset for two
or three nights spawned a night earlier: darkness after sunset acts as a
spawning cue in Acropora too.

## What the app does each day

1. **Sun.** Sunrise and sunset for the reef and date (computed, checked
   against PyEphem to within a few seconds). 0% at sunrise, rising linearly
   over the ramp (3 hours by default) to the midday level, holding, and back to
   0% at sunset.
2. **Season.** The day's top-of-atmosphere sunlight at the reef's latitude,
   placed between the year's lowest and highest and mapped to 60% to 100% of
   your mix (both adjustable). Clouds and monsoons are not included, so
   equatorial reefs get the small twice-yearly swing of the sun alone.
3. **Moon.** The moon's real altitude and phase for the reef. Your full-moon
   level per channel is scaled by the phase and rounded to whole percent, so a
   thin moon is off. It brightens over about 25 minutes after moonrise as it
   climbs and fades the same way before moonset. Moonlight only matters at
   night: during the day the sun's level wins.
4. **Fit.** The light holds one point per clock hour and fades linearly
   between them. The day's curve is fitted to the best 24 points by dynamic
   programming, with errors at low light weighted heavily so that sunset, the
   dark gap and moonrise stay accurate. On the light, the moon comes on within
   a few minutes to about 20 minutes of the real moonrise, and the dark gap
   grows night by night after the full moon as it should.
5. **Clock.** The reef's mean solar time is moved so its noon lands at
   "Midday on your tank" (13:00 by default). Sun and moon move together, so the
   gaps between them are unchanged. Daylight saving on the phone is
   compensated, so the reef's rhythm does not jump twice a year.
6. **Calendar shift.** Optionally run the reef's year shifted by up to 6
   months, for example to bring a spawning season to a time that suits you. The
   moon is computed for the shifted date too, so phases and season stay
   consistent with each other.

## Keeping the light up to date

The light only knows one 24 hour day, which it repeats. The app sends each new
day:

* whenever the app connects to the light (once per day), and at midnight
  while it is open;
* from an Android background job that wakes about once an hour and sends the
  day's light once, if the phone can reach the light. It uses 60 days the app
  prepared in advance; opening the app tops them up.

If a day is missed the light repeats the previous one: the sun is still right
to a minute, the moon about 50 minutes off per missed day.

**On the light's own hotspot**, the phone only reaches the light while it is
joined to that hotspot, so updates happen when you connect. For hands-off
daily updates, put the light on your home WiFi (Lights & backup, Put a light
on WiFi); the phone then updates it whenever it is home.

## Limits worth knowing

* **Moonlight brightness.** The light's dimmest step is 1%, much brighter than
  real moonlight (the study used about 1 lux at full moon). With the default
  1% Blue, the moon shows while it is more than half full, which covers the
  nights around the full moon that carry the spawning cue. Timing is faithful;
  absolute brightness is not. A separate dim moonlight would be closer to the
  study.
* **Temperature.** The study also ran each reef's yearly temperature curve.
  The light cannot do that; a heater and chiller controller (for example Home
  Assistant) would have to.
* **No guarantees.** Spawning also depends on colony maturity, nutrition,
  water quality and temperature. The light reproduces the light cues only.
