// Dismissing or reading a reminder never changes the underlying task status.
export function reminderSummary(pendingTasks,information,dismissedKeys=new Set()) {
  const keys=[...pendingTasks.map(t=>`task:${t.order_id}:${t.step}`),...information.map(n=>`info:${n.id}`)];
  return {keys,orderCount:new Set(pendingTasks.map(t=>t.order_id)).size,taskCount:pendingTasks.length,infoCount:information.length,visible:keys.some(key=>!dismissedKeys.has(key))};
}
export function workNotificationUI({state,api,esc,showOrder,refreshOrders,render,renderNav,toast,canRefreshWorkspace=()=>true}) {
  let source,timer,user,epoch=0,cursor=0,ready=false,pulling=false,again=false,audioContext,soundBuffer,enabled=false;
  let notifications=[],unread=0,pendingTasks=[],information=[],dismissedKeys=new Set();
  const $=s=>document.querySelector(s);
  const preference=()=>`orderhub-sound-${user?.id}`;
  function controls({showPopup=true}={}){
    $('#workNoticeBtn').textContent=`🔔 工单提醒${unread?'（'+unread+'）':''}`;
    $('#soundToggle').textContent=enabled?'🔊 声音已开启':'🔇 开启声音';
    $('#soundToggle').setAttribute('aria-pressed',String(enabled));
    state.unreadWorkNotifications=unread;
    if(state.user&&!document.activeElement?.closest('#nav'))renderNav();
    if(showPopup)popup();
    if(state.route==='workNotifications'&&canRefreshWorkspace()){$('#content').innerHTML=page();bind();}
  }
  async function tone(withReminder=false){
    const AudioClass=window.AudioContext||window.webkitAudioContext;
    if(!AudioClass)throw Error('当前浏览器不支持提示音');
    audioContext ||= new AudioClass();
    await audioContext.resume();
    if(audioContext.state!=='running')throw Error('请点击开启声音，检查浏览器是否静音');
    // Same waveform as reference 01-soft-dingdong: warm harmonics and a soft decay.
    if(!soundBuffer){
      const rate=44100;
      soundBuffer=audioContext.createBuffer(1,Math.round(rate*0.85),rate);
      const samples=soundBuffer.getChannelData(0);
      let peak=0;
      for(let i=0;i<samples.length;i++){
        const time=i/rate;let value=0;
        for(const [start,frequency,duration] of [[0,659.25,0.35],[0.23,880,0.48]]){
          const t=time-start;
          if(t<0||t>=duration)continue;
          const envelope=Math.min(1,t/0.008)*Math.min(1,(duration-t)/0.06)*Math.exp(-4*t/duration);
          for(const [harmonic,gain] of [[1,1],[2,0.12],[3,0.04]])value+=gain*Math.sin(2*Math.PI*frequency*harmonic*t)*envelope*(harmonic===1?1:Math.exp(-4*t));
        }
        samples[i]=value;peak=Math.max(peak,Math.abs(value));
      }
      for(let i=0;i<samples.length;i++)samples[i]*=0.30/(peak||1);
    }
    if(withReminder)popup();
    // Show the reminder in the same action, then play two complete ding-dong cues.
    const startsAt=audioContext.currentTime+0.02;
    for(let repeat=0;repeat<2;repeat++){
      const note=audioContext.createBufferSource();
      note.buffer=soundBuffer;note.connect(audioContext.destination);
      note.start(startsAt+repeat*(soundBuffer.duration+0.12));
    }
  }
  async function soundFor(event,version){
    if(!enabled){popup();return;}
    if(audioContext?.state!=='running'){enabled=false;controls();toast('浏览器暂停了声音，请再次点击“开启声音”');return;}
    try{const claim=await api(`/api/work-notifications/${event.id}/sound-claim`,{method:'POST',body:'{}'});if(version!==epoch)return;if(claim.claimed&&enabled)await tone(true);else popup();}catch(error){if(version===epoch){popup();toast(error.message);}}
  }
  function dismiss(){
    dismissedKeys=new Set(reminderSummary(pendingTasks,information).keys);
    $('#workNoticePopup').classList.add('hidden');
  }
  async function openTask(orderId,step){
    dismiss();
    const notice=notifications.find(n=>n.order_id===orderId&&n.step===step&&n.kind==='task');
    if(notice)return open(notice.id);
    try{await refreshOrders();render();showOrder(orderId);}catch(error){toast(error.message);}
  }
  function popup(){
    const panel=$('#workNoticePopup'),summary=reminderSummary(pendingTasks,information,dismissedKeys);
    if(!summary.visible){panel.classList.add('hidden');return;}
    panel.innerHTML=`<button type="button" class="close" aria-label="收起工单提醒">×</button><b>工单待办提醒</b>${summary.taskCount?`<section class="reminder-group"><strong>需要处理 · ${summary.orderCount}张工单 / ${summary.taskCount}项待办</strong>${pendingTasks.slice(0,3).map((t,index)=>`<button type="button" class="reminder-task" data-pending-index="${index}"><span>${esc(t.order_id)} · ${esc(t.storeName)}</span><small>${esc(t.title)}</small></button>`).join('')}<button type="button" class="primary reminder-all-tasks">查看全部待办</button></section>`:''}${summary.infoCount?`<section class="reminder-group reminder-information"><strong>仅需查看 · ${summary.infoCount}条提醒</strong>${information.slice(0,2).map(n=>`<button type="button" class="reminder-task" data-info-id="${n.id}"><span>${esc(n.order_id)} · ${esc(n.storeName)}</span><small>${esc(n.title)}</small>${n.trackingNumber?`<small>物流：${esc(n.logistics)} · ${esc(n.trackingNumber)}</small>`:''}</button>`).join('')}<button type="button" class="ghost reminder-all-info">查看全部提醒</button></section>`:''}<small class="reminder-footer">不会自动消失；收起或查看不代表工单已完成。</small>`;
    panel.classList.remove('hidden');panel.querySelector('.close').onclick=dismiss;
    panel.querySelectorAll('[data-pending-index]').forEach(button=>button.onclick=()=>{const t=pendingTasks[Number(button.dataset.pendingIndex)];void openTask(t.order_id,t.step);});
    panel.querySelectorAll('[data-info-id]').forEach(button=>button.onclick=()=>{dismiss();void open(button.dataset.infoId);});
    const tasksButton=panel.querySelector('.reminder-all-tasks');if(tasksButton)tasksButton.onclick=async()=>{dismiss();try{await refreshOrders();state.route='todos';render();}catch(error){toast(error.message);}};
    const infoButton=panel.querySelector('.reminder-all-info');if(infoButton)infoButton.onclick=()=>{dismiss();state.route='workNotifications';render();};
  }
  async function pull(version=epoch){
    if(!user||version!==epoch)return;
    if(pulling){again=true;return;}pulling=true;
    try{
      const data=await api('/api/work-notifications');if(version!==epoch)return;
      const fresh=ready?data.notifications.filter(n=>n.id>cursor&&!n.read_at&&(n.kind!=='task'||n.taskStatus==='待处理')):[];
      notifications=data.notifications;pendingTasks=data.pendingTasks||[];information=data.information||[];unread=data.unreadCount;cursor=Math.max(cursor,data.cursor);ready=true;controls({showPopup:!fresh.length});
      if(fresh.length){await soundFor(fresh[0],version);if(version!==epoch)return;if(canRefreshWorkspace()){await refreshOrders();if(version!==epoch)return;if(canRefreshWorkspace())render();}}
    }catch(error){if(version===epoch&&state.user)toast('工单提醒连接中断，正在自动重连');}
    finally{if(version===epoch){pulling=false;if(again){again=false;void pull(version);}}}
  }
  async function open(id){
    const notice=notifications.find(n=>n.id===Number(id))||information.find(n=>n.id===Number(id));if(!notice)return;
    dismiss();
    try{await api(`/api/work-notifications/${notice.id}/read`,{method:'POST',body:'{}'});await refreshOrders();await pull();$('#workNoticePopup').classList.add('hidden');render();showOrder(notice.order_id);}catch(error){toast(error.message);}
  }
  function page(){return `<div class="page-head"><div><h2>工单提醒</h2><p>查看仅标为已读，不会自动完成工单；显示最近100条。</p></div><span class="status amber">${unread}条未读</span></div><div class="approval-grid">${notifications.map(n=>`<article class="card finance-notice ${n.read_at?'':'unread'}"><div><h3>${esc(n.order_id)} · ${esc(n.storeName)} <span class="status ${n.read_at?'green':'amber'}">${n.read_at?'已读':'未读'}</span></h3><p>${esc(n.title)}</p>${n.trackingNumber?`<p>物流：${esc(n.logistics)} · ${esc(n.trackingNumber)}</p>`:''}<small>${esc(new Date(n.created_at).toLocaleString('zh-CN',{hour12:false}))}${n.kind==='task'&&n.taskStatus!=='待处理'?' · 此环节已处理':''}</small></div><div class="card-actions"><button type="button" class="primary work-notice-open" data-id="${n.id}">查看工单</button>${!n.read_at?`<button type="button" class="ghost work-notice-read" data-id="${n.id}">标为已读</button>`:''}</div></article>`).join('')||'<div class="panel empty">暂无工单提醒</div>'}</div>`;}
  function bind(){document.querySelectorAll('.work-notice-open').forEach(button=>button.onclick=()=>open(button.dataset.id));document.querySelectorAll('.work-notice-read').forEach(button=>button.onclick=async()=>{try{await api(`/api/work-notifications/${button.dataset.id}/read`,{method:'POST',body:'{}'});await pull();}catch(error){toast(error.message);}});}
  function stop(){epoch++;source?.close();source=null;clearInterval(timer);user=null;ready=false;pulling=false;again=false;cursor=0;notifications=[];pendingTasks=[];information=[];dismissedKeys=new Set();unread=0;enabled=false;state.unreadWorkNotifications=0;$('#workNoticePopup').classList.add('hidden');$('#workNoticePopup').replaceChildren();void audioContext?.close().catch(()=>{});audioContext=null;soundBuffer=null;}
  async function start(current){
    stop();user=current;const version=epoch;enabled=false;
    let wasEnabled=false;try{wasEnabled=localStorage.getItem(preference())==='on';}catch{}
    controls();if(wasEnabled)toast('请点击“开启声音”，激活本次登录的提示音');
    await pull(version);if(version!==epoch)return;
    const connection=new EventSource('/api/work-notifications/stream');source=connection;connection.addEventListener('changed',()=>{if(version===epoch)void pull(version);});connection.addEventListener('expired',()=>{connection.close();if(version===epoch)void pull(version);});
    connection.onopen=()=>{if(version===epoch)void pull(version);};
    timer=setInterval(()=>void pull(version),30000);
  }
  $('#workNoticeBtn').onclick=()=>{state.route='workNotifications';render();};
  $('#soundToggle').onclick=async()=>{if(!user)return;if(enabled){enabled=false;try{localStorage.setItem(preference(),'off');}catch{}controls();return;}try{await tone();enabled=true;try{localStorage.setItem(preference(),'on');}catch{}controls();toast('声音提醒已开启，新工单到达时叮咚两遍');}catch(error){toast(error.message);}};
  $('#soundTest').title='试听：柔和叮咚，连续两遍';
  $('#soundTest').onclick=async()=>{try{await tone();toast('已播放试听；请确认设备音量及浏览器未静音');}catch(error){toast(error.message);}};
  return {start,stop,page,bind};
}
