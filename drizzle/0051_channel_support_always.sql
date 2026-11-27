-- Each connected channel reads support events (follows, subscriptions, gifts, raids and paid messages). The switch
-- of each channel is gone, so `support_events` is no choice now: it tells whether the connection reads them.
-- YouTube and Kick need no new permission: their connections read support events from now on. A Twitch connection
-- reads them only when its authorization has the three scopes for them. A Twitch connection without the scopes
-- keeps chat and stays at 0: its card asks the owner to reconnect one time. No row and no token changes.
UPDATE `channel_connections` SET `support_events` = 1
WHERE `support_events` = 0 AND (
  `platform` IN ('youtube', 'kick')
  OR (
    `platform` = 'twitch'
    AND ' ' || `scopes` || ' ' LIKE '% moderator:read:followers %'
    AND ' ' || `scopes` || ' ' LIKE '% channel:read:subscriptions %'
    AND ' ' || `scopes` || ' ' LIKE '% bits:read %'
  )
);
