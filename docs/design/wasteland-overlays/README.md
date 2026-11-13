# Wasteland overlay preview

Interactive design preview for merged chat (#663) and the character playground (#664).
Channel connections and live activity depend on #662.
Chat cards use the approved compact Mix It Up design: thin mustard borders, Segoe UI, and 520 ms vertical motion.

## Open

From the repository root, run:

```sh
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `http://127.0.0.1:8765/docs/design/wasteland-overlays/`.
Serve the page over HTTP so it can load the local artwork.

## Controls

- Select a sender and send a message or command.
- Set the inactivity timeout. The default is 60 seconds.
- Use the busy-chat demo to rotate 70 participants through 40 slots.
- Show merged chat above the playground or check transparency.
- Download the selected platform's sprite sheet or the terrain atlas.

The playground uses 30 ranked slots and 10 rotating slots.
A message resets inactivity and reverses a timeout exit.
An offscreen sender enters before a queued command runs.
Respawn waits 2.5 seconds. Terrain changes last 30 seconds.

## Check the simulation

Run the regression checks with Node.js:

```sh
node --test docs/design/wasteland-overlays/simulation.test.cjs
```

These checks run the preview's simulation functions with DOM and artwork stubs.
They do not test browser rendering.

## Artwork

- `assets/courier-source.png`: generated courier reference, with 12 states and 4 frames per state.
- `assets/terrain-source.png`: generated terrain and prop reference.
- `assets/courier-purple-4x.png`: aligned example export, with 128 px cells in a 512 by 1536 px sheet.
- `playground-render.png`: the canvas renderer with a sample background and 40 characters.

The courier has a copper helmet, canvas workwear, dark boots, and platform-colored accents.
YouTube uses red, Twitch uses purple, and Kick uses green.
The runtime aligns grounded frames and applies the colors.
Source artwork and frame mapping are separate from simulation rules.
Future themes can replace the artwork without changing those rules.

## Limits

This page uses synthetic events. It does not connect accounts or read live chat.
The composition toggle shows a chat snapshot.
The busy-chat demo represents 1,000 viewers with 70 chat participants.
It is not a load benchmark.

Rank scores decay, repeated messages have a scoring cooldown, and commands expire after 10 seconds.
Rotation runs every 15 seconds, with a 10-second minimum stay before replacement.
These scheduling values are preview choices for review.

Browser checks confirmed artwork loading, the 12 animation rows, crowd controls, composition, and transparency.
Browser export checks and new screenshot transfer did not complete.
OBS checks remain incomplete.
