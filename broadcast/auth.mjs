let config = null;
const KEY = 'courtlens.broadcast.cloudAuth';
const PENDING = 'courtlens.broadcast.cloudPending';
const encode = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const random = size => encode(crypto.getRandomValues(new Uint8Array(size)));
const saved = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };

export async function initCloudAuth() {
  try {
    const response = await fetch('/cloud-config.json',{cache:'no-store'});
    if(response.ok) {
      const item=await response.json();
      if(item.schema==='courtlens-cloud-config/1' && item.clientId && item.hostedUiDomain && item.redirectUri) config=item;
    }
  } catch { /* Local mode has no cloud config. */ }
  if(!config) return false;
  const url=new URL(location.href),code=url.searchParams.get('code'),receivedState=url.searchParams.get('state');
  if(!code) return true;
  let pending;
  try { pending=JSON.parse(sessionStorage.getItem(PENDING)||'null'); } catch { pending=null; }
  if(!pending || receivedState!==pending.state) throw new Error('登录状态不匹配，请重新登录。');
  const response=await fetch(`${config.hostedUiDomain}/oauth2/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:config.clientId,code,redirect_uri:config.redirectUri,code_verifier:pending.verifier})});
  if(!response.ok) throw new Error('登录已过期或未完成，请重新登录。');
  const token=await response.json();
  sessionStorage.setItem(KEY,JSON.stringify({accessToken:token.access_token,idToken:token.id_token,refreshToken:token.refresh_token,expiresAt:Date.now()+Number(token.expires_in||3600)*1000}));
  sessionStorage.removeItem(PENDING);
  history.replaceState(null,'',pending.returnTo||'/broadcast/');
  return true;
}
export function cloudEnabled() { return !!config; }
export async function apiToken() {
  if(!config) return null;
  const current=saved();
  if(current?.idToken && current.expiresAt>Date.now()+60000) return current.idToken;
  if(!current?.refreshToken) return null;
  try {
    const response=await fetch(`${config.hostedUiDomain}/oauth2/token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'refresh_token',client_id:config.clientId,refresh_token:current.refreshToken})});
    if(!response.ok) return null;
    const token=await response.json();
    sessionStorage.setItem(KEY,JSON.stringify({accessToken:token.access_token,idToken:token.id_token,refreshToken:token.refresh_token||current.refreshToken,expiresAt:Date.now()+Number(token.expires_in||3600)*1000}));
    return token.id_token || null;
  } catch { return null; }
}
export async function signIn() {
  if(!config) return;
  const verifier=random(48),challenge=encode(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier)))),state=random(24);
  sessionStorage.setItem(PENDING,JSON.stringify({verifier,state,returnTo:location.pathname+location.search}));
  const url=new URL(`${config.hostedUiDomain}/oauth2/authorize`);
  url.search=new URLSearchParams({response_type:'code',client_id:config.clientId,redirect_uri:config.redirectUri,scope:'openid email',code_challenge_method:'S256',code_challenge:challenge,state}).toString();
  location.assign(url.href);
}
