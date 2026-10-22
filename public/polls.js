// @ts-check
import { el, esc, icon, notify, commentText, authorName } from './shared.js';
import { showView } from './ui.js';
/** @typedef {{likes:number, dislikes:number, reaction:number, comments:number, id:string, question:string, kind:'choice'|'binary', options:string[], endsAt:number, revealed:boolean, total:number, score:number, counts:number[]|null, myVote:number|null}} Poll */
/** @typedef {{polls:Poll[], comments:{id:string,mine:boolean,text:string,createdAt:number}[], nextCommentsCursor:string|null, canHost:boolean, signedIn:boolean, serverNow:number}} Snapshot */
/** @type {Snapshot|null} */let snapshot=null;
let selectedPoll='', pollSort='newest', commentSignature='', pendingDiscussionFocus=false;
let discussionRevision=0, snapshotRevision=-1, draftRevision=0;
let loadingOlder=false, loadedOlder=false;
/** @type {string|null} */let olderCursor=null;
let clockOffset=0, lastRender='', fetching=false, saving=false;
const panel=el('#polls-view'), cards=el('#poll-cards');
const dialog=/** @type {HTMLDialogElement} */(el('#poll-dialog'));
const form=/** @type {HTMLFormElement} */(el('#poll-form'));
const now=()=>Date.now()+clockOffset;
/** @param {number} count @param {number} total @returns {string} */
const percent=(count,total)=>`${total ? Math.round(count/total*100) : 0}%`;
/** @param {Poll} poll @returns {string} */
function pollMarkup(poll){
  const closed=poll.revealed||(poll.endsAt!==0&&poll.endsAt<=now());
  const badge=poll.revealed?'Results revealed':closed?'Voting closed':'Voting live';
  const disabled=closed||!snapshot?.signedIn;
  const values=poll.counts??poll.options.map(()=>0);
  const options=poll.options.map((option,index)=>({option,index})).sort((a,b)=>poll.kind==='binary'?b.index-a.index:a.index-b.index).map(({option,index})=>`<button class="poll-option" data-poll="${poll.id}" data-choice="${index}" aria-pressed="${poll.myVote===index}" ${disabled?'disabled':''}><span class="fill" style="width:${poll.kind==='choice'?percent(values[index],poll.total):'0%'}"></span><span>${poll.myVote===index?'✓ ':''}${esc(option)}</span>${poll.counts?`<span class="option-score"><small>${values[index]} ${values[index]===1?'vote':'votes'}</small>${percent(values[index],poll.total)}</span>`:''}</button>`).join('');
  const score=Math.max(-100,Math.min(100,poll.score));
  const leaning=poll.total===0?'Waiting for the first vote':score===0?'Evenly split':score>0?'Leaning Yes':'Leaning No';
  const meter=`<div class="binary-labels"><span>No</span><span>${leaning}</span><span>Yes</span></div><div class="binary-meter" role="meter" aria-label="Community balance, negative is No and positive is Yes" aria-valuemin="-100" aria-valuemax="100" aria-valuenow="${Math.round(score)}" aria-valuetext="${leaning}"><span class="binary-fill ${score<0?'negative':''}" style="left:${score<0?50+score/2:50}%;width:${Math.abs(score)/2}%"></span></div><div class="binary-axis"><span>-100</span><span>0</span><span>+100</span></div><div class="binary-votes">${options}</div>`;
  return `<article class="poll-card" data-poll-card="${poll.id}"><div class="poll-topline"><span class="poll-badge">${!closed?'<span class="live-dot"></span>':''}${badge}</span><span class="poll-countdown" data-deadline="${poll.endsAt}" data-revealed="${poll.revealed}"></span></div><h2>${esc(poll.question)}</h2>${poll.kind==='binary'?meter:options}<div class="poll-footer"><p>${poll.total} ${poll.total===1?'vote':'votes'}${poll.myVote!==null?' · Your vote is in':''}<br>${!snapshot?.signedIn?'Sign in to vote.':poll.revealed?'Final results':closed?'Waiting for the host to reveal results.':'You can change your vote until voting closes.'}</p>${snapshot?.canHost&&!poll.revealed?`<button data-reveal="${poll.id}">${closed?'Reveal results':'End & reveal'}</button>`:''}</div><div class="poll-engagement"><button data-react="1" data-id="${poll.id}" aria-label="Like poll" aria-pressed="${poll.reaction===1}" ${snapshot?.signedIn?'':'disabled'}>${icon('like')} ${poll.likes}</button><button data-react="-1" data-id="${poll.id}" aria-label="Dislike poll" aria-pressed="${poll.reaction===-1}" ${snapshot?.signedIn?'':'disabled'}>${icon('dislike')} ${poll.dislikes}</button><a class="discuss-link" href="#poll=${poll.id}">${icon('chat')} Discuss it · ${poll.comments}</a><button data-copy="${poll.id}">Copy poll link</button></div></article>`;
}
function tick(){
  if(!snapshot||panel.hidden)return;
  const signature=JSON.stringify([snapshot.polls,snapshot.canHost,snapshot.signedIn,snapshot.polls.map(p=>p.endsAt!==0&&p.endsAt<=now())]);
  if(signature!==lastRender){
    const active=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const focused=active?.dataset.react?`[data-id="${active.dataset.id}"][data-react="${active.dataset.react}"]`:active?.dataset.poll?`[data-poll="${active.dataset.poll}"][data-choice="${active.dataset.choice}"]`:active?.dataset.reveal?`[data-reveal="${active.dataset.reveal}"]`:null;
    cards.innerHTML=snapshot.polls.map(pollMarkup).join('')||'<div class="poll-empty"><h2>The mic is yours.</h2><p>No polls yet. The next question starts here.</p></div>';
    if(focused)/** @type {HTMLElement|null} */(cards.querySelector(focused))?.focus();
    lastRender=signature;
  }
  for(const timer of cards.querySelectorAll('[data-deadline]')){
    const seconds=Math.max(0,Math.ceil((Number(timer.getAttribute('data-deadline'))-now())/1000));
    timer.textContent=timer.getAttribute('data-revealed')==='true'?'Final':timer.getAttribute('data-deadline')==='0'?'No time limit':seconds===0?'Time is up':`${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')} remaining`;
  }
}
async function refresh(){
  if(fetching||panel.hidden||document.hidden)return;
  fetching=true;
  try{
    const requestKey=`${pollSort}:${selectedPoll}`, requestRevision=discussionRevision;
    const response=await fetch(`/api/polls?sort=${pollSort}${selectedPoll?'&poll='+encodeURIComponent(selectedPoll):''}`,{cache:'no-store'});
    if(requestKey!==`${pollSort}:${selectedPoll}`||requestRevision!==discussionRevision)return;
    if(!response.ok)throw new Error('Could not load polls. Reconnecting...');
    const result=/** @type {Snapshot} */(await response.json());
    if(requestKey!==`${pollSort}:${selectedPoll}`||requestRevision!==discussionRevision)return;
    if(selectedPoll && (loadedOlder||loadingOlder) && snapshotRevision===discussionRevision && snapshot) {
      if(result.nextCommentsCursor&&!result.comments.some(comment=>snapshot?.comments.some(previous=>previous.id===comment.id))) olderCursor=result.nextCommentsCursor;
      result.comments=mergeComments(snapshot.comments,result.comments);
    } else olderCursor=result.nextCommentsCursor??null;
    snapshot=result;snapshotRevision=requestRevision;
    clockOffset=snapshot.serverNow-Date.now();
    el('#create-poll').hidden=!snapshot.canHost;
    el('#poll-connection').textContent='Live updates every 2 seconds';
    tick();renderDiscussion();
  }catch(error){el('#poll-connection').textContent=error instanceof Error?error.message:'Could not load polls.';}
  finally{fetching=false;}
}
/** @param {Record<string,unknown>} body @returns {Promise<void>} */
async function mutate(body){
  const response=await fetch('/api/polls',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){const result=/** @type {{error?:string}} */(await response.json());throw new Error(result.error??'The poll could not be updated.');}
}
cards.addEventListener('click',async(event)=>{
  const button=event.target instanceof Element?/** @type {HTMLButtonElement|null} */(event.target.closest('button')):null;
  if(!button||saving)return;
  if(button.dataset.copy){
    try{await navigator.clipboard.writeText(`${location.origin}/#poll=${button.dataset.copy}`);notify('Poll link copied. Paste it into a conversation.');}
    catch{location.hash=`poll=${button.dataset.copy}`;notify('Copy the poll link from the address bar.');}return;
  }
  saving=true;button.disabled=true;
  try{
    if(button.dataset.react){const poll=snapshot?.polls.find(p=>p.id===button.dataset.id);const value=Number(button.dataset.react);await mutate({action:'react',id:button.dataset.id,value:poll?.reaction===value?0:value});}
    else if(button.dataset.reveal)await mutate({action:'reveal',id:button.dataset.reveal});
    else if(button.dataset.poll)await mutate({action:'vote',id:button.dataset.poll,choice:Number(button.dataset.choice)});
    await refresh();
  }catch(error){el('#poll-connection').textContent=error instanceof Error?error.message:'Could not save. Please try again.';}
  finally{saving=false;lastRender='';tick();renderDiscussion();}
});
el('#create-poll').addEventListener('click',()=>{el('#poll-form-error').textContent='';dialog.showModal();});
el('#poll-close').addEventListener('click',()=>dialog.close());
form.addEventListener('change',()=>{
  const binary=new FormData(form).get('kind')==='binary';
  el('#poll-options-label').hidden=binary;el('#binary-help').hidden=!binary;
  /** @type {HTMLTextAreaElement} */(form.elements.namedItem('options')).required=!binary;
});
form.addEventListener('submit',async(event)=>{
  event.preventDefault();if(saving)return;
  const data=new FormData(form),kind=String(data.get('kind'));
  const options=kind==='binary'?['Yes','No']:String(data.get('options')).split('\n').map(value=>value.trim()).filter(Boolean);
  if(options.length<2||options.length>6||options.some(value=>value.length>80)||new Set(options.map(value=>value.toLowerCase())).size!==options.length){el('#poll-form-error').textContent='Add 2 to 6 different options, each under 81 characters.';return;}
  saving=true;const submit=/** @type {HTMLButtonElement} */(form.querySelector('[type="submit"]'));submit.disabled=true;
  try{await mutate({action:'create',question:String(data.get('question')).trim(),kind,options,duration:Number(data.get('duration'))});dialog.close();selectDiscussion('');history.replaceState(null,'',location.pathname);form.reset();el('#poll-options-label').hidden=false;el('#binary-help').hidden=true;/** @type {HTMLTextAreaElement} */(form.elements.namedItem('options')).required=true;await refresh();}
  catch(error){el('#poll-form-error').textContent=error instanceof Error?error.message:'Could not start poll. Please try again.';}
  finally{saving=false;submit.disabled=false;renderDiscussion();}
});
document.addEventListener('viewchange',()=>{void refresh();});
document.addEventListener('visibilitychange',()=>{void refresh();});
setInterval(()=>{void refresh();},2000);
setInterval(tick,500);

function renderDiscussion(){
  const poll=snapshotRevision===discussionRevision?snapshot?.polls.find(p=>p.id===selectedPoll):undefined;
  el('#all-polls').hidden=!selectedPoll;
  el('#poll-discussion').hidden=!poll;
  /** @type {HTMLTextAreaElement} */(el('#poll-comment-text')).disabled=!poll||!snapshot?.signedIn;
  /** @type {HTMLButtonElement} */(el('#poll-comment-form button')).disabled=!poll||!snapshot?.signedIn||saving;
  const older=/** @type {HTMLButtonElement} */(el('#poll-load-older'));
  older.hidden=!poll||!olderCursor;
  older.disabled=loadingOlder;
  older.textContent=loadingOlder?'Loading older comments...':'Load older comments';
  if(!poll)return;
  el('#poll-discussion-reference').textContent=poll.question;
  if(pendingDiscussionFocus){pendingDiscussionFocus=false;el('#poll-discussion').scrollIntoView({block:'start',behavior:'smooth'});}
  const signature=JSON.stringify(snapshot?.comments);
  if(signature!==commentSignature){
    el('#poll-comments').innerHTML=snapshot?.comments.map(comment=>`<article class="comment"><strong>${comment.mine?esc(authorName('You')):'Community member'}</strong><small>${new Date(comment.createdAt).toLocaleString()}</small><p>${commentText(comment.text)}</p></article>`).join('')||'<p class="empty">Start the conversation. What shaped your vote?</p>';
    commentSignature=signature;
  }
}
/** @param {Snapshot['comments']} previous @param {Snapshot['comments']} incoming */
function mergeComments(previous,incoming){
  return [...new Map([...previous,...incoming].map(comment=>[comment.id,comment])).values()]
    .sort((a,b)=>a.createdAt-b.createdAt||(a.id<b.id?-1:a.id>b.id?1:0));
}
el('#poll-load-older').addEventListener('click',async()=>{
  if(loadingOlder||!olderCursor||!selectedPoll||snapshotRevision!==discussionRevision)return;
  const revision=discussionRevision, pollId=selectedPoll, cursor=olderCursor;
  loadingOlder=true;el('#poll-history-error').textContent='';renderDiscussion();
  try{
    const response=await fetch(`/api/polls?poll=${encodeURIComponent(pollId)}&before=${encodeURIComponent(cursor)}`,{cache:'no-store'});
    if(revision!==discussionRevision)return;
    if(!response.ok)throw new Error('Could not load older comments. Please try again.');
    const result=/** @type {Snapshot} */(await response.json());
    if(revision!==discussionRevision||!snapshot)return;
    snapshot.comments=mergeComments(result.comments,snapshot.comments);
    if(olderCursor===cursor)olderCursor=result.nextCommentsCursor??null;
    loadedOlder=true;
    renderDiscussion();
  }catch(error){
    if(revision===discussionRevision)el('#poll-history-error').textContent=error instanceof Error?error.message:'Could not load older comments.';
  }finally{
    if(revision===discussionRevision){loadingOlder=false;renderDiscussion();}
  }
});
// Invalidate the displayed thread before a new selection can accept comments.
/** @param {string} next */
function selectDiscussion(next){
  if(next!==selectedPoll){
    selectedPoll=next;discussionRevision++;
    loadingOlder=false;loadedOlder=false;olderCursor=null;
    el('#poll-history-error').textContent='';
    /** @type {HTMLTextAreaElement} */(el('#poll-comment-text')).value='';
    commentSignature='';el('#poll-comment-error').textContent='';
  }
  renderDiscussion();
}
function openReference(){
  const match=location.hash.match(/^#poll=([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i);
  const next=match?.[1]??'';
  selectDiscussion(next);lastRender='';pendingDiscussionFocus=!!next;
  if(selectedPoll)showView('polls');
  void refresh();
}
window.addEventListener('hashchange',openReference);
document.addEventListener('click',event=>{const link=event.target instanceof Element?event.target.closest('a[href^="#poll="]'):null;if(link&&link.getAttribute('href')===location.hash)openReference();});
function allPolls(){selectDiscussion('');history.replaceState(null,'',location.pathname);lastRender='';el('#poll-discussion').hidden=true;el('#all-polls').hidden=true;void refresh();}
el('#all-polls').addEventListener('click',allPolls);
for(const sort of ['newest','top'])el(`#poll-${sort}`).addEventListener('click',()=>{
  pollSort=sort;
  for(const name of ['newest','top']){el(`#poll-${name}`).setAttribute('aria-pressed',String(name===sort));el(`#poll-${name}`).classList.toggle('active',name===sort);}
  allPolls();
});
el('#poll-comment-text').addEventListener('input',()=>{draftRevision++;});
el('#poll-comment-form').addEventListener('submit',async(event)=>{
  event.preventDefault();if(saving||!selectedPoll||snapshotRevision!==discussionRevision||!snapshot?.signedIn||!snapshot.polls.some(p=>p.id===selectedPoll))return;
  const input=/** @type {HTMLTextAreaElement} */(el('#poll-comment-text')),text=input.value.trim();
  if(!text){el('#poll-comment-error').textContent='Please write a comment.';return;}
  const pollId=selectedPoll, submittedRevision=discussionRevision, submittedDraft=draftRevision;
  saving=true;const button=/** @type {HTMLButtonElement} */(el('#poll-comment-form button'));button.disabled=true;
  try{
    await mutate({action:'comment',id:pollId,text});
    if(submittedRevision===discussionRevision){
      if(submittedDraft===draftRevision)input.value='';
      el('#poll-comment-error').textContent='';
    }
    await refresh();
  }
  catch(error){if(submittedRevision===discussionRevision)el('#poll-comment-error').textContent=error instanceof Error?error.message:'Could not post your comment.';}
  finally{saving=false;renderDiscussion();}
});
if(location.hash.startsWith('#poll='))openReference();

document.addEventListener('profilechange',()=>{commentSignature='';renderDiscussion()});
