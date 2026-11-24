# Website UI kit

This kit is a copy of the StreamBullets web app that you can click through.
It shows the viewer side and the streamer side.

The kit keeps the current screen in the `sb-kit-screen` key of `localStorage`.

| Screen | File | Source |
| --- | --- | --- |
| Landing, with the station poster and "Your voice, on air." | `Landing.jsx` | `app/components/station/landing.css`, `app/routes/home.tsx` |
| Streamer directory, with search and streamer cards | `Directory.jsx` | `app/routes/streamers.tsx` |
| Topic board, with the list and detail views, votes, discussion, and the composer | `TopicBoard.jsx` | `app/components/streamer/topic-board.tsx`, `app/components/discussion.tsx` |
| Polls, with vote, End & reveal, and reactions | `PollsView.jsx` | `app/components/poll.tsx`, `app/components/streamer/polls-view.tsx` |

`WebsiteApp.jsx` connects the dialog to suggest a topic, the account menu, and the toast.
The Schedule, About, and Community tabs show a note. The kit does not copy them.
`kit.css` holds the layout. The parts come from the bundle, `components/bundle.js`.
