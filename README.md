# slopsmith-plugin-flappy-bend

A Flappy Bird clone for [Slopsmith](https://github.com/byrongamatos/slopsmith)
— but instead of tapping a button, you **bend a guitar string** to position
the bird.

## How it plays

1. Pick a backing track from the Minigames hub.
2. The track tells you which string and fret to hold (e.g. "G string, fret 7 — D4").
3. Play the note, let it settle — this is the bird's resting (bottom) position.
4. The track plays. Pipes scroll in from the right. The pipe gap-centers trace
   the track's ideal bend curve.
5. **Bend up** to raise the bird. **Release** to let it fall. Match the curve
   to fly through the gaps.

Score = pipes passed + pitch-accuracy bonus.

## Requirements

- [`slopsmith-plugin-minigames`](https://github.com/byrongamatos/slopsmith-plugin-minigames) — the framework that hosts this game.

## Tracks

Tracks live under `tracks/<id>/`:

- `track.json` — metadata + piecewise bend curve
- `track.ogg` — audio (mono, 44.1 kHz)

Add your own by dropping a directory under `tracks/`.
