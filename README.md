# feedBack-plugin-flappy-bend

A Flappy Bird clone for [feedBack](https://github.com/got-feedback/feedBack)
— but instead of tapping a button, you **bend a guitar string** to position
the bird.

## How it plays

1. Open **FeedBarcade** in the sidebar (the Minigames hub), choose Flappy Bend and pick a backing track.
2. The track tells you which string and fret to hold (e.g. "G string, fret 7 — D4").
3. Play the note, let it settle — this is the bird's resting (bottom) position.
4. The track plays. Pipes scroll in from the right. The pipe gap-centers trace
   the track's ideal bend curve.
5. **Bend up** to raise the bird. **Release** to let it fall. Match the curve
   to fly through the gaps.

Score = pipes passed + pitch-accuracy bonus.

## Requirements

- The Minigames hub, which is bundled with feedBack core (`plugins/minigames`). There is nothing extra to install. It provides the hub screen and the `window.feedBackMinigames` SDK this game registers with.
- A guitar input (microphone or audio interface) for pitch detection.

Flappy Bend itself is bundled with the feedBack Desktop app.

## Tracks

Tracks live under `assets/tracks/<id>/track.json`, and each one must also be listed in `assets/tracks/index.json`:

```json
{ "tracks": [ { "id": "warmup-1", "title": "Warm-Up Ladder" } ] }
```

There is no audio file. The backing music (drums, bass and a chord pad) is synthesized live from the `music` block.

`track.json` fields:

| Field | Meaning |
|---|---|
| `id`, `title` | Must match the `index.json` entry. |
| `duration_ms` | Track length. Defaults to 30000. |
| `instrument` | The note to hold: `string`, `fret`, `base_note`, `base_freq_hz`. |
| `max_cents` | The bend at the top of the screen. Defaults to 200. |
| `bends` | The ideal bend curve: `[{ "t_ms": 0, "cents": 0 }, …]`, interpolated between points. Pipe gaps follow it. |
| `music.tempo_bpm` | Backing tempo. Falls back to `bpm`. |
| `music.chords` | `[{ "t_ms": 0, "root": 50, "quality": "maj" }, …]`. `root` is a MIDI note. `quality` is `maj`, `min`, `7` or `maj7`. |

To add a track, create `assets/tracks/<id>/track.json` and add the id to `index.json`.
