export type EntryKind = 'topic' | 'choice' | 'binary';
export type SortOrder = 'newest' | 'top';
export type Reaction = -1 | 0 | 1;

export interface Viewer {
  id: string;
  name: string;
  avatar: string | null;
}

export interface Streamer {
  id: string;
  handle: string;
  name: string;
  about: string;
  avatar: string | null;
  background: string | null;
  ownerId: string;
}

export interface StreamerDirectory {
  streamers: Streamer[];
  nextCursor: string | null;
}

export interface Entry {
  id: string;
  streamerId: string;
  authorId: string;
  author: string;
  avatar: string | null;
  kind: EntryKind;
  title: string;
  body: string;
  category: string;
  createdAt: number;
  endsAt: number | null;
  revealed: boolean;
  options: string[];
  counts: number[] | null;
  total: number;
  likes: number;
  dislikes: number;
  comments: number;
  reaction: Reaction;
  myVote: number | null;
}

export interface Comment {
  id: string;
  entryId: string;
  authorId: string;
  author: string;
  avatar: string | null;
  text: string;
  createdAt: number;
  parentId: string | null;
  likes: number;
  liked: boolean;
}

export interface BoardSnapshot {
  streamer: Streamer;
  entries: Entry[];
  nextCursor: string | null;
  revision: number;
  serverNow: number;
}

export interface DiscussionSnapshot {
  comments: Comment[];
  nextCursor: string | null;
}

export interface LiveSnapshot {
  type: 'snapshot';
  revision: number;
  serverNow: number;
  polls: Pick<Entry, 'id' | 'title' | 'kind' | 'options' | 'endsAt' | 'revealed' | 'counts' | 'total'>[];
}
