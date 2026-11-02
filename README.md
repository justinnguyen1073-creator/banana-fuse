# Banana Fuse

A 3D co-op bomb-defusal party game for 1 to 4 players in the browser. It's inspired by BOMBANANA!. Each player gets a role with a missing sense,. Roles are dealt at the start of a round and stay fixed until it ends.

Made for 3 players, modeled on BOMBANANA!:

| Role | Sees | Hears | Says |
| --- | --- | --- | --- |
| Blind | Outlines of the bomb only. Only one who can touch it. | Everyone | Mute hears Blind. Deaf can't. |
| Deaf | The bomb, the timer, everyone's gestures | Nothing, not even the bomb | Everyone hears Deaf |
| Mute | The manual and the team, never the bomb | Everyone | Nothing. Gestures only. |

Pick roles in the lobby or hit Random. Roles stay fixed for the whole round. With 1 player you get solo practice, with 2 it's Blind + Guide.

Voice chat is built in and the game enforces who can hear whom during a round. In the lobby everyone can talk.

Controls: click the bomb (Blind), E for the gesture wheel, Space or right-click to lean in, move the mouse to look around, M to show or hide the manual (Mute).

## Run it

```
npm install
npm start
```

Open http://localhost:3000. Leave the room code blank to create a room, then send friends the link shown in the lobby.

## Let friends join from their own homes

They need to reach your computer. The quickest way is a Cloudflare quick tunnel (free, no account):

```
cloudflared tunnel --url http://localhost:3000
```

It prints an `https://....trycloudflare.com` URL. Give that to your friends. It works in any browser on Mac or Windows.
