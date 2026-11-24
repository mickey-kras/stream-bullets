# Website UI kit

This kit is a copy of the StreamBullets website that you can click through.
It uses the parts of the design system and the page markup of the app.
The app CSS in `components/bundle.css` gives all styles.

The kit shows the page of the streamer Sunny to a viewer with an account.
The landing page shows the view of a reader without an account.

## Screens

| Screen | Link | File | App source |
| --- | --- | --- | --- |
| Topic board, with the list, the topic, votes and the discussion | `#topics` | `TopicBoard.jsx` | `app/routes/streamer.tsx`, `app/components/streamer/topic-board.tsx` |
| Polls, with the votes and the discussion of one poll | `#polls` | `PollsView.jsx` | `app/components/streamer/polls-view.tsx`, `app/components/poll.tsx` |
| Streamer directory, with the search | `#streamers` | `Directory.jsx` | `app/routes/streamers.tsx` |
| Landing page, with the station poster | `#landing` | `Landing.jsx` | `app/routes/home.tsx`, `app/components/station/landing.css` |

The links of the kit are hash links, so the back button of the browser works.
Other links, such as **Schedule** or **Privacy**, show a note. The kit does not copy these screens.

## Behavior

- Select a topic to show it. On a phone, the topic replaces the list. **All topics** shows the list again.
- Write a comment and select **Post**. The comment goes to the top of the discussion.
- Select **Discuss** on a poll to show the poll and its discussion. **All polls** shows the list again.
- The **+** button opens the dialog to suggest a topic.
- The avatar button opens the account menu. **Sign out** goes to the landing page.
- The actions show a toast message.

## Files

- `WebsiteApp.jsx` connects the screens, the dialog, the footer and the toast.
- `data.js` holds the sample content.
- `main.jsx` starts the kit. The `node design/build.ts` command builds it into `kit.js`, which `preview.html` loads.
- `kit.css` has only a small number of rules. The app puts each page in the body of the document. The kit puts the page in `#root`, so these rules make `#root` and the body work as in the app.

## Differences from the app

The app shows a 3D station on the landing page. The kit shows the poster image that the app shows before the station loads.
The kit does not have the dialogs to create a poll, to sign in, or to change the language.
