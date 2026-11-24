The poll card shows a full poll in the Polls view.

The file also exports `PollStatus`, the gold top line, and `PollResults`, the bars of the options.

```jsx
<PollCard title="Should we explore more local AI on stream?" author="Sunny" options={["Yes, more local AI","Mix of both","Stick to cloud"]}
  counts={[48,31,9]} myVote={0} onVote={setVote} countdown="2 min left" owner comments={1} />
```

- A result bar has a gold fill at 40% opacity and a 3px gold right edge.
- The score column uses gold tabular numbers.
