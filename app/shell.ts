export const shell = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Suggest a topic, vote, and help shape Misha's next stream.">
<title>Misha | Next conversation</title>
<link rel="stylesheet" href="fonts.css">
<link rel="stylesheet" href="style.css">
</head>
<body>
<header>
<a class="brand" href="./" aria-label="Misha community home">
<img class="brand-avatar" src="assets/host-badge.png" alt="Misha">
</a>
<nav aria-label="Main navigation">
<button data-view="topics" aria-label="Topics" title="Topics" aria-current="page">
<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
<path d="M4 4h16v12H9l-5 4V4Z"/>
<path d="M8 8h8M8 12h5"/>
</svg>
<span class="nav-label">Topics</span>
</button>
<button data-view="polls" aria-label="Polls" title="Polls">
<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
<path d="M5 20V10h4v10M10 20V4h4v16M15 20v-7h4v7"/>
</svg>
<span class="nav-label">Polls</span>
</button>
<button data-view="schedule" aria-label="Schedule" title="Schedule">
<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
<rect x="3" y="5" width="18" height="16" rx="2"/>
<path d="M7 3v4m10-4v4M3 11h18"/>
</svg>
<span class="nav-label">Schedule</span>
</button>
<button data-view="about" aria-label="About" title="About">
<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="12" cy="12" r="9"/>
<path d="M12 11v6m0-10v1"/>
</svg>
<span class="nav-label">About</span>
</button>
<button data-view="community" aria-label="Community" title="Community">
<svg class="nav-icon" viewBox="0 0 24 24" aria-hidden="true">
<circle cx="9" cy="8" r="3"/>
<path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>
</svg>
<span class="nav-label">Community</span>
</button>
</nav>
<div class="header-end">
<button class="gold" id="suggest" aria-label="Suggest a topic" title="Suggest a topic">
<span class="suggest-plus" aria-hidden="true">+</span>
<span class="suggest-label">Suggest a topic</span>
</button>
<button class="profile" id="profile" aria-label="Edit your profile" title="Edit your profile">
<span class="avatar">
</span>
</button>
</div>
</header>
<main id="topics-view">
<section class="browse" aria-label="Browse topics">
<div class="intro">
<h1>Pick the next conversation</h1>
<p>Suggest topics. Vote. Chat. Help shape the stream.</p>
</div>
<label class="search">
<svg viewBox="0 0 24 24" aria-hidden="true">
<circle cx="10" cy="10" r="7"/>
<path d="m15 15 6 6"/>
</svg>
<input id="search" type="search" placeholder="Search topics..." aria-label="Search topics">
<kbd>/</kbd>
</label>
<div class="list-toolbar">
<div class="tabs" aria-label="Topic sorting">
<button id="top" class="active" aria-pressed="true">Top</button>
<button id="new" aria-pressed="false">New</button>
</div>
<span id="topic-count">
</span>
</div>
<div id="topics" tabindex="0" aria-label="Scrollable topic list">
</div>
</section>
<div id="splitter" role="separator" tabindex="0" aria-label="Resize topic panels" aria-orientation="vertical" aria-controls="topics detail" aria-valuemin="25" aria-valuemax="65" aria-valuenow="40" title="Drag to resize. Arrow keys adjust; double-click resets.">
<span>
</span>
</div>
<section class="detail" id="detail" tabindex="0" aria-label="Selected topic">
</section>
</main>
<section id="polls-view" class="page-panel" hidden aria-label="Live polls">
<div class="page-title">
<div>
<span class="eyebrow">YOUR VOICE, ON AIR</span>
<h1>Live polls</h1>
<p>One question. Everyone has a say.</p>
</div>
<button class="gold" id="create-poll" hidden>+ Create poll</button>
</div>
<p id="poll-connection" role="status">Connecting to polls...</p>
<div class="poll-toolbar">
<div class="tabs" aria-label="Poll sorting">
<button id="poll-newest" aria-pressed="true" class="active">Newest</button>
<button id="poll-top" aria-pressed="false">Top</button>
</div>
<button id="all-polls" hidden>‹ All polls</button>
</div>
<div id="poll-cards">
</div>
<section id="poll-discussion" class="poll-card" hidden aria-labelledby="poll-discussion-heading">
<span class="eyebrow">POLL CONVERSATION</span>
<h2 id="poll-discussion-heading">Discussion</h2>
<p id="poll-discussion-reference">
</p>
<button id="poll-load-older" type="button" hidden>Load older comments</button>
<p id="poll-history-error" role="alert">
</p>
<div id="poll-comments">
</div>
<form id="poll-comment-form" class="composer">
<textarea id="poll-comment-text" required maxlength="2000" rows="2" aria-label="Discuss this poll" placeholder="What do you think?" >
</textarea>
<button class="gold" type="submit">Post</button>
</form>
<p id="poll-comment-error" role="alert">
</p>
</section>
</section>
<section id="schedule-view" class="page-panel" hidden>
<span class="eyebrow">WHAT'S NEXT</span>
<h1>Stream schedule</h1>
<div class="info-card">
<h2>Next stream to be announced</h2>
<p>In the meantime, help choose what we talk about.</p>
<button class="gold" data-view="topics">Explore topics</button>
</div>
</section>
<section id="about-view" class="page-panel" hidden>
<span class="eyebrow">BEHIND THE MIC</span>
<h1>Hey, I'm Misha.</h1>
<div class="info-card">
<img class="about-avatar" src="assets/host-badge.png" alt="Misha">
<h2>Tech. Games. Good conversations.</h2>
<p>A space to explore ideas, share experiences, and shape the next stream together.</p>
<button class="gold" data-view="topics">Join the conversation</button>
</div>
</section>
<section id="community-view" class="page-panel" hidden>
<span class="eyebrow">PART OF THE CONVERSATION</span>
<h1>Community</h1>
<div class="community-grid">
<div class="info-card">
<h2>Bring an idea</h2>
<p>Suggest a topic, vote on your favorites, and discuss it with everyone.</p>
<button class="gold" data-view="topics">Browse topics</button>
</div>
<div class="info-card">
<h2>Have your say live</h2>
<p>Vote in timed polls during the stream and see where the community lands.</p>
<button class="gold" data-view="polls">Open polls</button>
</div>
</div>
</section>
<dialog id="poll-dialog" aria-labelledby="poll-form-title">
<form id="poll-form">
<div class="modal-heading">
<span class="eyebrow">ASK THE COMMUNITY</span>
<button type="button" class="close" id="poll-close" aria-label="Close poll form">×</button>
</div>
<h2 id="poll-form-title">Create a poll</h2>
<label>Question<input name="question" required maxlength="160" placeholder="What should we decide together?">
</label>
<fieldset class="poll-types">
<legend>Poll type</legend>
<label>
<input type="radio" name="kind" value="choice" checked> Multiple choice</label>
<label>
<input type="radio" name="kind" value="binary"> Yes / No</label>
</fieldset>
<label id="poll-options-label">Options, one per line<textarea name="options" rows="4" placeholder="Option one&#10;Option two" required>
</textarea>
<small>2 to 6 options, up to 80 characters each.</small>
</label>
<p id="binary-help" hidden>A centered meter moves toward Yes or No as votes arrive. Percentages appear when you reveal the results.</p>
<label>Voting time<select name="duration">
<option value="0">Unlimited - until I end it</option>
<option value="30">30 seconds</option>
<option value="60" selected>1 minute</option>
<option value="120">2 minutes</option>
<option value="300">5 minutes</option>
<option value="600">10 minutes</option>
</select>
</label>
<p id="poll-form-error" role="alert">
</p>
<button class="gold" type="submit">Start poll</button>
</form>
</dialog>
<dialog id="submit-dialog">
<form id="topic-form">
<div class="modal-heading">
<span class="eyebrow">PUT YOUR IDEA ON THE AIR</span>
<button type="button" class="close" aria-label="Close topic form">×</button>
</div>
<h2>Suggest a topic</h2>
<p>What would make a great conversation?</p>
<label>Title<input name="title" required maxlength="100" placeholder="Give your idea a clear title">
</label>
<label>Details<textarea name="details" required maxlength="2000" rows="4" placeholder="What should we explore? Why does it interest you?">
</textarea>
</label>
<fieldset class="category-field">
<legend>Category</legend>
<details id="category-picker">
<summary id="category-selected">
</summary>
<div id="category-options">
</div>
</details>
</fieldset>
<button class="gold" type="submit">Submit topic</button>
</form>
</dialog>
<dialog id="avatar-dialog" aria-labelledby="avatar-title">
<div class="modal-heading">
<span class="eyebrow">MAKE YOURSELF AT HOME</span>
<button type="button" id="avatar-close" class="close" aria-label="Close profile editor">×</button>
</div>
<h2 id="avatar-title">Edit your profile</h2>
<p>A familiar face. A little personality. Entirely you.</p>
<label for="profile-name">Display name<input id="profile-name" type="text" maxlength="40" required autocomplete="nickname" placeholder="What should we call you?" aria-describedby="profile-name-help">
</label>
<p id="profile-name-help">Shown on your topics and comments in this preview.</p>
<div class="avatar-preview">
<span id="avatar-preview-image">
</span>
<div>
<strong id="avatar-preview-name">
</strong>
<span>Your community profile picture</span>
</div>
</div>
<div class="avatar-grid" id="avatar-grid" aria-label="Available avatars">
</div>
<div class="upload-section">
<label class="upload-label" for="avatar-file">
<svg viewBox="0 0 24 24" aria-hidden="true">
<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>
</svg> Upload your own picture</label>
<input id="avatar-file" type="file" accept="image/png,image/jpeg,image/webp">
<p>JPG, PNG or WebP. Up to 5 MB.</p>
</div>
<p id="avatar-error" role="alert">
</p>
<div class="avatar-modal-actions">
<button id="avatar-cancel">Cancel</button>
<button class="gold" id="avatar-save">Save changes</button>
</div>
</dialog>
<div id="status" role="status">
</div>
<script type="module" src="app.js">
</script>
<script type="module" src="ui.js">
</script>
<script type="module" src="polls.js">
</script>
</body>
</html>
`;
