// @ts-check
import { icon, esc, el, notify, categoryIcons, commentText, authorName, setDisplayName } from './shared.js';
/** @typedef {{author:string, text:string, likes:number, liked?:boolean, replyTo?:string}} Comment */
/** @typedef {{id:number,title:string,category:string,author:string,description:string,likes:number,dislikes:number,vote:number,comments:Comment[],total:number}} Topic */
/** @type {Topic[]} */const topics=[
{id:1,title:'Can AI run my homelab?',category:'Tech & setups',author:'Sunny',description:'I’m curious how far we can actually take AI in a self-hosted setup. Can it realistically run useful models on a homelab without breaking the bank? What hardware works well, what are the real limitations, and is it actually worth it for a creator setup?\nLet’s talk real-world experiences, configs, and what you’d do differently.',likes:142,dislikes:18,vote:0,total:24,comments:[{author:'TechNomad',text:'I’ve been running a local model on a mini PC and it’s surprisingly capable for smaller tasks. Not a replacement for cloud, but perfect for learning and experimenting.',likes:27},{author:'PixelLuna',text:'Depends on what you want to do. For text and simple workflows it’s totally doable. For bigger models you’ll definitely feel the hardware limits. Worth it for the control though!',likes:19},{author:'HomeLabDan',text:'I run a 3060 with 32GB RAM and it handles more than I expected. The key is picking the right model size and being realistic about performance.',likes:14}]},
...['Which game deserves a second chance?','Building a quiet streaming PC','Best tools for content creators right now?','Self-hosting vs cloud for a small creator','Questions for a future Q&A stream','What should I review next?','Tips for staying productive while streaming'].map((title,i)=>({id:i+2,title,category:i===0?'Gaming':i===4?'Just chatting':'Tech & setups',author:['PixelLuna','HomeLabDan','TechNomad'][i%3],description:['Some games get overlooked at launch. Which one would you give another chance, and what makes it worth revisiting?','I’d love to discuss a quiet PC that can handle streaming and gaming. Which upgrades make the biggest difference to noise?','What tools actually make your creative workflow easier? Share the ones you keep coming back to.','When is self-hosting worth the maintenance? Let’s compare real costs, convenience, and control.','What have you always wanted to ask? Bring your questions about tech, gaming, and creating.','Suggest a piece of gear, an app, or a game worth trying on stream.','How do you balance making content with everything else? Let’s swap habits that work.'][i],likes:[96,88,70,64,52,48,41][i],dislikes:[12,7,9,22,6,12,8][i],vote:0,total:[18,15,11,19,27,12,14][i],comments:[{author:'PixelNomad',text:'Would love to hear everyone’s experience with this. There’s a lot we could explore together.',likes:5}]}))];
let selected=1,sort='top',commentSort='top',replyTo='';
const current=()=>{const topic=topics.find(t=>t.id===selected);if(!topic)throw new Error('Selected topic missing');return topic};
function renderList(){const query=/** @type {HTMLInputElement} */(el('#search')).value.toLowerCase();const visible=topics.filter(t=>t.title.toLowerCase().includes(query)).sort((a,b)=>sort==='new'?b.id-a.id:(b.likes-b.dislikes)-(a.likes-a.dislikes));el('#topic-count').textContent=`${visible.length} topics`;el('#topics').innerHTML=visible.map(t=>`<button class="topic ${selected===t.id?'selected':''}" data-topic="${t.id}" aria-pressed="${selected===t.id}"><span class="topic-icon">${icon(['screen','game','tower','chat','globe','mic','tool','book'][(t.id-1)%8])}</span><span class="topic-main"><span class="topic-title">${esc(t.title)}</span><span class="topic-meta"><span class="metric">${icon('like')} ${t.likes}</span><span class="metric">${icon('dislike')} ${t.dislikes}</span><span class="metric">${icon('chat')} ${t.total}</span></span></span><span class="chevron">${icon('chevron')}</span></button>`).join('')||'<p class="empty">No topics found. Try a different search or suggest your own.</p>'}
function renderDetail(){const t=current();const comments=t.comments.map((c,index)=>({c,index})).sort((a,b)=>commentSort==='new'?b.index-a.index:b.c.likes-a.c.likes);el('#detail').innerHTML=`<div class="topic-content"><button class="back" id="back">‹ All topics</button><div class="detail-top"><span class="category">${icon(categoryIcons[t.category]??'chat')} ${esc(t.category)}</span><span class="topic-number">TOPIC ${String(t.id).padStart(3,'0')}</span></div><h2>${esc(t.title)}</h2><div class="author">${avatarFor(t.author)}Posted by <strong>${esc(authorName(t.author))}</strong></div><p class="description">${esc(t.description)}</p><div class="votes"><button data-vote="1" aria-pressed="${t.vote===1}">${icon('like')} Like <b>${t.likes}</b></button><button data-vote="-1" aria-pressed="${t.vote===-1}">${icon('dislike')} Dislike <b>${t.dislikes}</b></button></div></div><div class="discussion"><div class="discussion-head"><h3>Discussion</h3><span class="comment-count">${t.total} comments</span><select id="comment-sort" aria-label="Sort comments"><option value="top" ${commentSort==='top'?'selected':''}>Top</option><option value="new" ${commentSort==='new'?'selected':''}>Newest</option></select></div><div>${comments.map(({c,index})=>`<article class="comment">${avatarFor(c.author)}<div class="comment-body"><div class="comment-meta"><strong>${esc(authorName(c.author))}</strong><small>${c.author==='You'?'Just now':'Community member'}</small></div>${c.replyTo?`<small class="replying">Reply to ${esc(authorName(c.replyTo))}</small>`:''}<p>${commentText(c.text)}</p><div class="comment-actions"><button data-comment-like="${index}" aria-label="Like comment by ${esc(authorName(c.author))}" aria-pressed="${!!c.liked}">${icon('like')} ${c.likes}</button><button data-reply="${index}">Reply</button></div></div></article>`).join('')}</div><div id="reply-label" class="replying">${replyTo?`Replying to ${esc(authorName(replyTo))}`:''}</div><form class="composer" id="comment-form"><button type="button" class="composer-avatar" data-avatar-picker aria-label="Edit your profile">${avatarFor('You')}</button><textarea id="comment-text" rows="1" maxlength="2000" required aria-label="Write a comment" placeholder="Write a comment..."></textarea><button class="gold">Post</button></form></div>`}
function render(){renderList();renderDetail()}
el('#topics').addEventListener('click',e=>{const button=/** @type {HTMLElement} */(e.target).closest('[data-topic]');if(!button)return;selected=Number(/** @type {HTMLElement} */(button).dataset.topic);replyTo='';render();document.body.classList.add('show-detail');el('#detail').scrollTop=0});
el('#search').addEventListener('input',renderList);
for(const name of ['top','new'])el('#'+name).addEventListener('click',()=>{sort=name;for(const n of ['top','new']){el('#'+n).classList.toggle('active',n===name);el('#'+n).setAttribute('aria-pressed',String(n===name))}renderList()});
el('#detail').addEventListener('click',e=>{const button=/** @type {HTMLElement} */(e.target).closest('button');if(!button)return;const data=button.dataset;if('avatarPicker' in data){openAvatarPicker();return}if(button.id==='back'){document.body.classList.remove('show-detail');return}if(data.vote){const t=current(),next=t.vote===Number(data.vote)?0:Number(data.vote);if(t.vote===1)t.likes--;if(t.vote===-1)t.dislikes--;if(next===1)t.likes++;if(next===-1)t.dislikes++;t.vote=next;const draft=/** @type {HTMLTextAreaElement} */(el('#comment-text')).value;render();/** @type {HTMLTextAreaElement} */(el('#comment-text')).value=draft;el(`button[data-vote="${data.vote}"]`).focus()}if(data.commentLike!==undefined){const c=current().comments[Number(data.commentLike)];c.liked=!c.liked;c.likes+=c.liked?1:-1;button.innerHTML=`${icon('like')} ${c.likes}`;button.setAttribute('aria-pressed',String(c.liked))}if(data.reply!==undefined){replyTo=current().comments[Number(data.reply)].author;el('#reply-label').textContent=`Replying to ${authorName(replyTo)}`;el('#comment-text').focus()}});
el('#detail').addEventListener('change',e=>{if(/** @type {HTMLElement} */(e.target).id==='comment-sort'){commentSort=/** @type {HTMLSelectElement} */(e.target).value;const draft=/** @type {HTMLTextAreaElement} */(el('#comment-text')).value;renderDetail();/** @type {HTMLTextAreaElement} */(el('#comment-text')).value=draft;el('#comment-sort').focus()}});
el('#detail').addEventListener('submit',e=>{e.preventDefault();const input=/** @type {HTMLTextAreaElement} */(el('#comment-text'));const text=input.value.trim();if(!text){input.setCustomValidity('Please write a comment.');input.reportValidity();return}const t=current();t.comments.push({author:'You',text,likes:0,replyTo});t.total++;replyTo='';commentSort='new';render();el('#comment-text').focus();notify('Comment added to this preview')});
el('#detail').addEventListener('input',e=>{if(e.target instanceof HTMLTextAreaElement)e.target.setCustomValidity('')});
const dialog=/** @type {HTMLDialogElement} */(el('#submit-dialog'));el('#suggest').addEventListener('click',()=>dialog.showModal());el('#submit-dialog .close').addEventListener('click',()=>dialog.close());
el('#topic-form').addEventListener('submit',e=>{e.preventDefault();const form=/** @type {HTMLFormElement} */(e.target),data=new FormData(form);const title=String(data.get('title')??'').trim(),description=String(data.get('details')??'').trim();if(!title||!description){notify('Please add a title and details.');return}const id=Math.max(...topics.map(t=>t.id))+1;topics.push({id,title,description,category:String(data.get('category')),author:'You',likes:0,dislikes:0,vote:0,total:0,comments:[]});selected=id;/** @type {HTMLInputElement} */(el('#search')).value='';form.reset();dialog.close();replyTo='';render();document.body.classList.add('show-detail');notify('Topic added to this preview')});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!(e.target instanceof HTMLInputElement)&&!(e.target instanceof HTMLTextAreaElement)&&!dialog.open&&!avatarDialog.open){e.preventDefault();document.body.classList.remove('show-detail');el('#search').focus()}});
/** @typedef {{index:number, url:string}} AvatarChoice */
/** @type {AvatarChoice} */let userAvatar={index:6,url:''};
/** @type {AvatarChoice} */let draftAvatar={...userAvatar};
const avatarNames=['Dark hair & beard','Natural curls','Classic bob','Dark hair & glasses','Silver pixie','Close crop & beard','Short curls','Teal headscarf','Silver side part','Red hair & freckles','Waves & glasses','Plum undercut','Friendly robot','Bookish cat','Space explorer','Night owl','Jack Russell terrier','Friendly alien'];
const avatarOrder=[0,1,2,3,4,5,6,7,8,9,10,11,12,13,16,17,14,15];
/** @param {AvatarChoice} choice @returns {string} */
function avatarMarkup(choice){
  if(choice.url)return `<img class="portrait" src="${esc(choice.url)}" alt="" draggable="false">`;
  if(choice.index===16||choice.index===17)return `<img class="portrait" src="assets/avatar-${choice.index===16?'jack-russell':'alien'}.png" alt="" draggable="false">`;
  if(choice.index===-1)return '<img class="host-avatar" src="assets/host-badge.png" alt="" draggable="false">';
  const x=(choice.index%4)*100/3,y=Math.floor(choice.index/4)*100/3;
  return `<span class="portrait" style="background-position:${x}% ${y}%" aria-hidden="true"></span>`;
}
/** @param {string} author @returns {string} */
function avatarFor(author){
  if(author==='You')return avatarMarkup(userAvatar);
  /** @type {Record<string,number>} */const assigned={Sunny:-1,TechNomad:0,PixelLuna:2,HomeLabDan:3,PixelNomad:5};
  return avatarMarkup({index:assigned[author]??6,url:''});
}
const avatarDialog=/** @type {HTMLDialogElement} */(el('#avatar-dialog'));
const avatarInput=/** @type {HTMLInputElement} */(el('#avatar-file'));
const avatarSave=/** @type {HTMLButtonElement} */(el('#avatar-save'));
const profileName=/** @type {HTMLInputElement} */(el('#profile-name'));
profileName.addEventListener('input',()=>profileName.setCustomValidity(''));
let uploadSequence=0;
function renderAvatarPicker(){
  el('#avatar-preview-image').innerHTML=avatarMarkup(draftAvatar);
  el('#avatar-preview-name').textContent=draftAvatar.url?'Your uploaded picture':draftAvatar.index===-1?'Original avatar':avatarNames[draftAvatar.index];
  el('#avatar-grid').innerHTML=avatarOrder.map(index=>({name:avatarNames[index],index})).map(({name,index})=>`<button type="button" class="avatar-option" data-avatar="${index}" aria-label="${name}" title="${name}" aria-pressed="${!draftAvatar.url&&draftAvatar.index===index}">${avatarMarkup({index,url:''})}</button>`).join('');
}
function clearUnusedDraft(){if(draftAvatar.url&&draftAvatar.url!==userAvatar.url)URL.revokeObjectURL(draftAvatar.url)}
function openAvatarPicker(){
  profileName.value=authorName('You');profileName.setCustomValidity('');
  draftAvatar={...userAvatar};avatarInput.value='';el('#avatar-error').textContent='';avatarSave.disabled=false;
  renderAvatarPicker();avatarDialog.showModal();
}
el('#profile').addEventListener('click',openAvatarPicker);
el('#avatar-close').addEventListener('click',()=>avatarDialog.close());
el('#avatar-cancel').addEventListener('click',()=>avatarDialog.close());
avatarDialog.addEventListener('close',()=>{uploadSequence++;clearUnusedDraft()});
el('#avatar-grid').addEventListener('click',e=>{
  const button=/** @type {HTMLElement} */(e.target).closest('button[data-avatar]');if(!button)return;
  const index=Number(/** @type {HTMLElement} */(button).dataset.avatar);
  uploadSequence++;clearUnusedDraft();draftAvatar={index,url:''};avatarInput.value='';avatarSave.disabled=false;el('#avatar-error').textContent='';renderAvatarPicker();
  el(`[data-avatar="${index}"]`).focus();
});
avatarInput.addEventListener('change',async()=>{
  const file=avatarInput.files?.[0];if(!file)return;
  const sequence=++uploadSequence;avatarSave.disabled=false;el('#avatar-error').textContent='';
  if(!['image/png','image/jpeg','image/webp'].includes(file.type)){el('#avatar-error').textContent='Choose a JPG, PNG or WebP image.';return}
  if(file.size>5*1024*1024){el('#avatar-error').textContent='That picture is too large. Choose one under 5 MB.';return}
  avatarSave.disabled=true;
  const url=URL.createObjectURL(file),picture=new Image();picture.src=url;
  try{
    await picture.decode();
    if(sequence!==uploadSequence||!avatarDialog.open){URL.revokeObjectURL(url);return}
    if(picture.naturalWidth>8192||picture.naturalHeight>8192){URL.revokeObjectURL(url);el('#avatar-error').textContent='Choose a picture no larger than 8192 pixels on either side.';return}
    clearUnusedDraft();draftAvatar={index:-1,url};renderAvatarPicker();
  }catch{
    URL.revokeObjectURL(url);
    if(sequence===uploadSequence)el('#avatar-error').textContent='This image could not be opened. Try another JPG, PNG or WebP.';
  }finally{if(sequence===uploadSequence)avatarSave.disabled=false}
});
avatarSave.addEventListener('click',()=>{
  const nextName=profileName.value.trim();
  profileName.setCustomValidity(nextName.length===0?'Enter a display name.':nextName.length>40?'Use 40 characters or fewer.':'');
  if(!profileName.reportValidity())return;
  setDisplayName(nextName);
  const previous=userAvatar.url;userAvatar={...draftAvatar};
  const draft=/** @type {HTMLTextAreaElement} */(el('#comment-text')).value;
  el('#profile').innerHTML=avatarMarkup(userAvatar);renderDetail();
  /** @type {HTMLTextAreaElement} */(el('#comment-text')).value=draft;
  if(previous&&previous!==userAvatar.url)URL.revokeObjectURL(previous);
  avatarDialog.close();document.dispatchEvent(new Event('profilechange'));notify('Profile updated for this preview');
});
el('#profile').innerHTML=avatarMarkup(userAvatar);
render();
