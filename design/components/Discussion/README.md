The discussion shows the comments of a topic or a poll.

It has these parts:

- A head with the title, the sort menu, and the refresh button.
- The composer: the avatar of the viewer, a text editor with a format toolbar, and the gold **Post** button.
- The list of comment threads.

The **Post** button stays dim until the viewer types a comment.
A guest sees the **Sign in to comment** button in place of the composer.

```jsx
<Discussion>
  <Thread
    id="1"
    author="PixelLuna"
    comment={<Comment name="PixelLuna" preset={6} time="30 minutes ago" answered>Depends on what you want to do.</Comment>}
    replies={[<Comment key="r1" name="Sunny" time="20 minutes ago" replyTo={{ id: "1", name: "PixelLuna" }}>Same here.</Comment>]}
  />
  <Comment name="TechNomad" preset={0} time="1 hour ago">Surprisingly capable for smaller tasks.</Comment>
</Discussion>
```

The file also exports these parts:

- `Comment`: one comment with the **Like**, **Reply**, and **Report** actions and the relative time.
  - `answered` adds the answered line. Give `{ title, date, href }` to link the stream.
  - `translation={{ from, original }}` adds the **Show original** button.
  - `edited` adds the **Edited** note. Set `edited="history"` to show the button that opens the earlier texts.
  - `reported`, `canEdit`, `canDelete`, `owner`, and `removed` show the other states of the app.
- `Thread`: a comment, its replies, and the button that hides the replies.
- `Composer`: the composer. Give `replyingTo` to show the **Replying to** line and the **Cancel** button.

The format toolbar shows its look only. The text box accepts plain text.
