'use strict';

function renderLibraryPage() {
return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="noindex,nofollow"><title>Your library | BeyondMythos</title><style>
:root{color-scheme:dark}body{background:#090e1a;color:#f8f4eb;font:16px/1.6 system-ui,-apple-system,sans-serif;margin:0}.wrap{width:min(740px,calc(100% - 32px));margin:48px auto}a{color:#a6e1db}h1{font:normal 44px Georgia,serif}article{background:#152034;border:1px solid #39475b;border-radius:14px;margin:18px 0;padding:20px}.links{display:flex;flex-wrap:wrap;gap:12px}.download{display:inline-block;background:#efcf92;color:#1b2532;border-radius:7px;padding:7px 13px;text-decoration:none;font-weight:700}#status{color:#bdc9d9}</style></head><body><main class="wrap"><a href="/">← BeyondMythos</a><h1>Your digital library</h1><p id="status" role="status">Verifying access…</p><div id="library"></div></main><script>
(async()=>{
const status=document.getElementById('status'),root=document.getElementById('library');
const token=new URLSearchParams(location.hash.slice(1)).get('token') || new URLSearchParams(location.search).get('token');
if(token)history.replaceState(null,'',location.pathname);
if(!token){status.textContent='A private access link is required. Use the purchase-recovery form on the storefront.';return;}
function safePath(p){return typeof p==='string' && p.startsWith('/') && !p.startsWith('//') && !p.includes('\\\\')?p:null}
try{
const response=await fetch('/api/customer/access?token='+encodeURIComponent(token),{credentials:'omit',cache:'no-store'});
if(!response.ok)throw new Error('This access link is expired or invalid. Please request a new link.');
const data=await response.json();
if(!Array.isArray(data.purchases)||!data.purchases.length){status.textContent='No purchases were found for this account.';return;}
status.textContent='Access verified. Your available downloads:';
for(const purchase of data.purchases){
const article=document.createElement('article');const heading=document.createElement('h2');heading.textContent='Order '+String(purchase.id||'');article.appendChild(heading);
const state=document.createElement('p');state.textContent='Status: '+String(purchase.status||'unknown');article.appendChild(state);
if(purchase.status==='paid'&&Array.isArray(purchase.downloads)){
const group=document.createElement('div');group.className='links';
for(const entry of purchase.downloads){
const detailPath=safePath(entry.url);if(!detailPath)continue;
const detailRes=await fetch(detailPath,{credentials:'omit',cache:'no-store'});
if(!detailRes.ok)continue;
const detail=await detailRes.json();
for(const file of detail.downloads||[]){const href=safePath(file.url);if(!href)continue;const a=document.createElement('a');a.className='download';a.href=href;a.rel='noreferrer';a.textContent=String(entry.name||'Download')+' ('+String(file.format||'file').toUpperCase()+')';group.appendChild(a)}
}article.appendChild(group);
}root.appendChild(article)
}
}catch(e){status.textContent=e.message||'Could not load your library.'}
})();</script></body></html>`;
}
module.exports={renderLibraryPage};
