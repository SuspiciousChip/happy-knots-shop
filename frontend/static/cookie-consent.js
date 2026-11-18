(()=>{
  const cookieName='hk_cookie_consent';
  const banner=document.querySelector('#cookieBanner');
  const backdrop=document.querySelector('#cookieDialogBackdrop');
  const analytics=document.querySelector('#cookieAnalytics');
  const marketing=document.querySelector('#cookieMarketing');
  if(!banner||!backdrop)return;

  const read=()=>{
    const match=document.cookie.split('; ').find(row=>row.startsWith(cookieName+'='));
    if(!match)return null;
    try{return JSON.parse(decodeURIComponent(match.slice(cookieName.length+1)))}catch{return null}
  };
  const write=preferences=>{
    const value=encodeURIComponent(JSON.stringify({essential:true,analytics:!!preferences.analytics,marketing:!!preferences.marketing,version:1}));
    document.cookie=`${cookieName}=${value}; Max-Age=31536000; Path=/; SameSite=Lax${location.protocol==='https:'?'; Secure':''}`;
    banner.hidden=true;
    backdrop.hidden=true;
    document.body.classList.remove('cookie-dialog-open');
    document.dispatchEvent(new CustomEvent('happyknots:consent',{detail:preferences}));
  };
  const open=()=>{
    const saved=read()||{};
    analytics.checked=!!saved.analytics;
    marketing.checked=!!saved.marketing;
    backdrop.hidden=false;
    document.body.classList.add('cookie-dialog-open');
    backdrop.querySelector('[data-cookie-close]').focus();
  };
  const close=()=>{
    backdrop.hidden=true;
    document.body.classList.remove('cookie-dialog-open');
  };

  document.querySelectorAll('[data-cookie-accept]').forEach(button=>button.addEventListener('click',()=>write({analytics:true,marketing:true})));
  document.querySelectorAll('[data-cookie-essential]').forEach(button=>button.addEventListener('click',()=>write({analytics:false,marketing:false})));
  document.querySelectorAll('[data-cookie-manage],[data-cookie-settings]').forEach(button=>button.addEventListener('click',open));
  document.querySelectorAll('[data-cookie-close]').forEach(button=>button.addEventListener('click',close));
  document.querySelector('[data-cookie-save]').addEventListener('click',()=>write({analytics:analytics.checked,marketing:marketing.checked}));
  backdrop.addEventListener('click',event=>{if(event.target===backdrop)close()});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!backdrop.hidden)close()});
  if(!read())banner.hidden=false;
})();
