(()=>{
 const root=document.getElementById('exports-root')
 root.innerHTML='<div class="home-heading"><h2>播放器清单</h2><button id="export-start">生成 / 重新核验清单</button></div><p id="export-status" role="status">尚未生成</p><div id="export-links" class="home-actions"></div><p class="home-note">收录官网正在热播首屏的推荐、最热、最新，以及云端与本机观看历史；电视剧按卡片对应的一集导出，不自动展开全剧。后台逐条检查，只有当前完整播放核验通过的内容才进入 M3U；待核验、试看及核验失败均不收录。打开本页即预热，首页不等待慢速历史读取；对应分类有有效条目后才能导入。重启仅恢复仍在原有效期内且登录凭据一致的已验证缓存，不延长授权期限。缓存到期重新核验，外部播放器请刷新订阅获取最新清单。清单带有统一弹幕关联，需 Ceau 等兼容播放器支持；本网页的进度与自动下一集功能不会随清单传递。</p>'
 const status=document.getElementById('export-status'),button=document.getElementById('export-start'),links=document.getElementById('export-links')
 let busy=false
 async function update(){
  if(busy)return;busy=true
  try{
   const response=await fetch('/api/exports'),data=await response.json();if(!response.ok)throw Error(data.error)
   button.disabled=data.running
   status.textContent=(data.running?'正在生成':data.finished?'本轮检查已完成':'尚未生成')+' · 已检查 '+data.checked+' / '+data.total+' 部 · 当前有效 '+data.ready.all+' 项 · 无完整权限 '+data.denied+' 部 · 核验失败 '+data.failed+' 部 · 不支持 '+data.skipped+' 项'+(data.current?' · '+data.current:'')+(data.error?' · '+data.error:'')+(data.warnings.length?' · '+data.warnings.join('；'):'')
   links.replaceChildren()
   for(const [scope,label] of [['all','全部'],['recommend','首页推荐'],['hot','首页最热'],['new','首页最新'],['history','观看历史']]){
    const link=document.createElement('a');if(data.ready[scope])link.href='/playlist.m3u'+(scope==='all'?'':'?scope='+scope);else{link.setAttribute('aria-disabled','true');link.style.opacity='.55';link.title='正在预热；完整权限核验通过后可导入'}link.textContent=label+' M3U（'+data.ready[scope]+'）'+(data.ready[scope]?'':' · 等待核验');links.append(link)
   }
  }catch{status.textContent='清单生成状态暂不可用，请稍后重试'}finally{busy=false}
 }
 button.onclick=async()=>{button.disabled=true;try{const response=await fetch('/api/exports/start',{method:'POST'});if(!response.ok)throw Error();await update()}catch{button.disabled=false;status.textContent='清单生成未启动，请重试'}}
 void update();setInterval(update,3000)
})();
