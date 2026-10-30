import {workNotificationUI} from './work-notifications-ui.mjs';
import {businessDate, statusClass, createRequestId, parseShippingAddress} from './order-utils.mjs';
import { activeTasks, shippingChecks, requiresAdminApproval, isTailPaymentHandoff, isCustomWorkflow, applyProcurementMode, procurementModeLocked, flowStepNumber } from './workflow.mjs';
import { filterOrders } from './order-list.mjs';
import { employeeViews } from './employees-ui.mjs';
import { finalPaymentAmount, calculateOrderPricing, parseProductDescription } from './order-amounts.mjs';
const navItems = [
  ['dashboard', '◈', '管理看板'], ['orders', '▤', '订单中心'], ['todos', '✓', '我的待办'],
  ['workNotifications','♧','工单提醒'], ['finance', '¥', '财务收款'], ['notifications','♧','工单修改提醒'], ['approvals', '◇', '状态审批'], ['shipping', '⇥', '发货放行'], ['employees','♧','员工与权限']
];
const navIconPaths={dashboard:'<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',orders:'<path d="M7 3h10l3 3v15H4V3h3Z"/><path d="M8 9h8M8 13h8M8 17h5"/>',todos:'<rect x="4" y="4" width="16" height="17" rx="3"/><path d="M9 4V2h6v2M8 13l3 3 5-6"/>',finance:'<rect x="3" y="5" width="18" height="15" rx="3"/><path d="M3 9h18M14 14h7"/><circle cx="16" cy="14" r=".5"/>',approvals:'<path d="M12 3 4 7v6c0 4 8 8 8 8s8-4 8-8V7l-8-4Z"/><path d="m8 12 3 3 5-6"/>',shipping:'<path d="M3 5h11v12H3V5Zm11 5h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>',notifications:'<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>'};
navIconPaths.workNotifications=navIconPaths.notifications;
navIconPaths.employees='<circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 5"/>';
const navIcon=key=>`<svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${navIconPaths[key]||navIconPaths.orders}</svg>`;
const workflowNames = { custom: '定制客户', regular: '常规订单', urgent: '加急订单', foreign: '外贸订单' };
const workflowShort = { custom: '定制', regular: '常规', urgent: '加急', foreign: '外贸' };
const routeTitles = {
  employees:['EMPLOYEES','员工与权限'], dashboard: ['WORKSPACE', '管理看板'], orders: ['ORDERS', '订单中心'], todos: ['TASKS', '我的待办'],
  workNotifications:['WORK NOTICES','工单提醒'], notifications:['NOTIFICATIONS','工单修改提醒'], finance: ['FINANCE', '财务收款'], approvals: ['APPROVAL', '状态审批'], shipping: ['SHIPPING', '发货放行']
};
let state = { route: 'dashboard', user: null, orders: [], workflows: [], query: '', filter: 'all', dateFrom:'', dateTo:'', notifications:[], unreadNotifications:0, employees:[], handovers:[], employeeRoles:[], employeeQuery:'' };
const selectedOrderIds = new Set();
const $ = selector => document.querySelector(selector);
const money = value => `¥${Number(value || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = () => businessDate();
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
const fieldText = (order, key) => esc(order.entryValues?.[key] ?? order[key] ?? '');
const canSeeFinance = () => ['业务员','财务'].includes(state.user?.role);
const finalPaymentText = order => finalPaymentAmount(order) === null ? '—' : money(finalPaymentAmount(order));
const displayCustomer = order => order.storeName || order.customer || '未填写店铺';

async function api(url, options = {}) {
  const requestUser=state.user;
  const response = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if(response.status===401&&state.user&&state.user===requestUser){state.user=null;state.orders=[];state.employees=[];state.handovers=[];state.notifications=[];state.unreadNotifications=0;selectedOrderIds.clear();closeModal();clearPrivateView();$('#appShell').classList.add('hidden');$('#loginScreen').classList.remove('hidden');$('#loginForm').reset();$('#loginForm button').disabled=false;$('#loginError').textContent='账号状态或登录信息已变化，请重新登录';}
  if (!response.ok) throw new Error(data.error || '操作失败');
  return data;
}
async function refreshOrders() {
  const userId=state.user?.id,finance=state.user?.role==='财务';
  const [orders,workflows,notices,staff] = await Promise.all([api('/api/orders'),api('/api/workflows'),finance?api('/api/notifications'):Promise.resolve({notifications:[],unreadCount:0}),state.user?.role==='超级管理员'?api('/api/employees'):Promise.resolve({employees:[],handovers:[],roles:[]})]);
  if(state.user?.id!==userId) return;
  state.employees=staff.employees||[];state.handovers=staff.handovers||[];state.employeeRoles=staff.roles||[];
  state.orders=orders.orders||[]; state.workflows=workflows.workflows||[];
  state.notifications=notices.notifications||[];state.unreadNotifications=notices.unreadCount||0;

}
function toast(message) {
  const element = $('#toast'); element.textContent = message; element.classList.add('show');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2500);
}
let modalIsDirty = null;
function closeModal() {
  document.querySelector('#discardOrderPrompt')?.remove(); modalIsDirty=null;
  $('#modal').classList.add('hidden'); $('#modalBody').replaceChildren();
  $('#appShell').inert=false; $('#workNoticePopup').inert=false;
  document.body.classList.remove('modal-open');
}
function requestModalClose() {
  if ($('#modalBody form .modal-foot button:not([type=button]):disabled')) return toast('正在保存工单，请稍候');
  if (modalIsDirty?.()) {
    if ($('#discardOrderPrompt')) return;
    const prompt=document.createElement('div');prompt.id='discardOrderPrompt';prompt.setAttribute('role','alertdialog');prompt.setAttribute('aria-modal','true');prompt.setAttribute('aria-label','工单尚未保存');
    prompt.style.cssText='position:fixed;inset:0;z-index:2000;background:#16213966;display:grid;place-items:center;padding:24px';
    prompt.innerHTML='<div style="background:white;border-radius:20px;padding:28px;max-width:420px;box-shadow:0 20px 60px #16213933"><h3>工单尚未保存</h3><p>关闭会丢失本次未保存的内容，是否继续填写？</p><div class="card-actions"><button type="button" class="primary" id="keepEditingOrder">继续填写</button><button type="button" class="ghost" id="discardOrderChanges">放弃并关闭</button></div></div>';
    document.body.appendChild(prompt);$('#modalBody').inert=true;$('#keepEditingOrder').onclick=()=>{prompt.remove();$('#modalBody').inert=false;};$('#discardOrderChanges').onclick=closeModal;$('#keepEditingOrder').focus();return;
  }
  closeModal();
}
function modal(html, small = false) {
  modalIsDirty=null;
  $('#modalBody').className = `modal${small ? ' small' : ''}`; $('#modalBody').innerHTML = html; $('#modal').classList.remove('hidden');
  $('#modalBody').scrollTop = 0; $('#modalBody').inert=false;
  $('#modalBody').setAttribute('role','dialog'); $('#modalBody').setAttribute('aria-modal','true');
  $('#appShell').inert=true; $('#workNoticePopup').inert=true;document.body.classList.add('modal-open');
  const openedForm=$('#modalBody form');
  queueMicrotask(()=>{
    if(openedForm&&openedForm===$('#modalBody form')&&!modalIsDirty){
      const snapshot=()=>JSON.stringify({fields:Array.from(openedForm.elements).map(el=>[el.id||el.name,el.type==='checkbox'?el.checked:el.value]),images:Array.from(openedForm.querySelectorAll('img')).map(img=>img.getAttribute('src'))});
      const initial=snapshot();modalIsDirty=()=>snapshot()!==initial;
    }
    if(!$('#modal').classList.contains('hidden')) ($('#modalBody input:not([type=hidden]):not([disabled]), #modalBody textarea, #modalBody select, #modalBody button'))?.focus();
  });
  document.querySelectorAll('[data-close]').forEach(button => button.onclick = requestModalClose);
}
function currentTask(order) { return activeTasks(order)[0]; }
function isShipping(task) { return task && task.ownerRole === '仓库' && (task.name.includes('发货') || task.name.includes('出货')); }
function visibleNav() {
  return navItems.filter(([key]) => {
    if (key === 'employees') return state.user.role === '超级管理员';
    if (key === 'notifications') return state.user.role === '财务';
    if (key === 'finance') return state.user.role === '财务';
    if (key === 'approvals') return state.user.role === '超级管理员';
    if (key === 'shipping') return ['仓库', '超级管理员'].includes(state.user.role);
    return true;
  });
}
function myTodos() {
  const result = [];
  state.orders.forEach(order => {
    for (const task of activeTasks(order)) {
      if (state.user.role === '超级管理员' && task.status === '待管理员审批') result.push({ order, task });
      else if (task.ownerRole === state.user.role && task.status === '待处理') result.push({ order, task });
    }

  });
  return result;
}
function gate(order) {
  return shippingChecks(order);
}
function canShip(order) { return gate(order).every(item => item[1]); }
function kpi(label, value, sub, icon, warn = false) {
  return `<div class="card kpi"><div class="kpi-head"><span>${label}</span><i class="kpi-icon">${icon}</i></div><b>${value}</b><small class="${warn ? 'warn' : ''}">${sub}</small></div>`;
}

function renderNav() {
  $('#nav').innerHTML = `<div class="nav-label">工作区</div>${visibleNav().map(([key, icon, label]) => {
    const badge = key === 'workNotifications' ? (state.unreadWorkNotifications||0) : key === 'todos' ? myTodos().length : key === 'approvals' ? pendingApprovals().length : key === 'notifications' ? state.unreadNotifications : 0;
    return `<button class="${state.route === key ? 'active' : ''}" data-route="${key}"><span>${navIcon(key)}</span>${label}${badge ? `<i class="nav-badge">${badge}</i>` : ''}</button>`;
  }).join('')}`;
  document.querySelectorAll('[data-route]').forEach(button => button.onclick = () => { state.route = button.dataset.route; render(); });
}
function pendingApprovals() {
  return state.orders.flatMap(order => order.flowTasks.filter(task => task.status === '待管理员审批').map(task => ({ order, task })));
}
const noticeFieldLabels = {pricingVersion:'计价方式',lineItems:'产品明细',itemsSubtotal:'产品合计',grossAmount:'总货款',discountAmount:'优惠金额',productSourceText:'原货品描述',productSourceImages:'产品识别原图',businessSelfProcurement:'采购方式',orderDate:'日期',storeName:'店铺名称',shopOrderNumber:'店铺订单号',customer:'店铺／客户',recipient:'收件人姓名',contact:'收件人电话',address:'收件地址',product:'货品明细',productItems:'产品明细',specialNotes:'特殊备注',notes:'备注',price:'单价',amount:'实际总货款',codAmount:'代收',trackingNumber:'物流单号',paymentAccount:'收款账户',logisticsRequirements:'客户要求物流信息',freight:'运费',cost:'成本',grossProfit:'毛利',salesperson:'业务员',images:'货品图片',shippingMarkDescription:'唛头描述',shippingMarkImages:'唛头图片',prepaymentAmount:'预付款金额',paymentProofs:'付款凭证',depositAmount:'预付款要求',depositRequirement:'预付款要求',depositConfirmed:'预付款要求'};
function noticeFields(notice) { return [...new Set(notice.changedFields.map(key=>noticeFieldLabels[key]).filter(Boolean))].join('、') || '订单资料'; }
function notificationBanner() {
  return state.user.role==='财务'&&state.unreadNotifications ? `<div class="finance-notice-banner"><div><b>业务修改了工单 · ${state.unreadNotifications}条未读提醒</b><p>修改已生效，请查看最新资料。</p></div><button class="ghost" data-go="notifications">查看修改提醒</button></div>` : '';
}
function renderNotifications() {
  return `<div class="page-head"><div><h2>工单修改提醒</h2><p>业务保存后立即生效，财务查看提醒无需审批。未读优先，显示最近100条。</p></div><span>${state.unreadNotifications}条未读</span></div><div class="approval-grid">${state.notifications.map(notice=>`<article class="card finance-notice ${notice.read_at?'':'unread'}"><div><h3>${esc(notice.order_id)} · ${esc(notice.storeName)} <span class="status ${notice.read_at?'green':'amber'}">${notice.read_at?'已读':'未读'}</span></h3><p>${esc(notice.actor)} 修改了：${esc(noticeFields(notice))}</p><small>${esc(new Date(notice.created_at).toLocaleString('zh-CN',{hour12:false}))}</small></div><div class="card-actions"><button class="primary view-order-notice" data-notice-id="${esc(notice.id)}" data-order-id="${esc(notice.order_id)}">查看最新工单</button>${!notice.read_at?`<button class="ghost read-order-notice" data-notice-id="${esc(notice.id)}">标为已读</button>`:''}</div></article>`).join('')||'<div class="panel empty"><b>暂无修改提醒</b>业务员修改工单后会自动出现在这里</div>'}</div>`;
}
async function readOrderNotice(id,orderId) {
  try {
    await api(`/api/notifications/${encodeURIComponent(id)}/read`,{method:'POST',body:'{}'});
    await refreshOrders();render();if(orderId)showOrder(orderId);
  } catch(error) {toast(error.message);}
}
function renderDashboard() {
  const active = state.orders.filter(order => order.status !== '已完成').length;
  const pendingAmount = state.orders.reduce((sum, order) => sum + Math.max(0, order.amount - order.received), 0);
  const pendingAdmin = pendingApprovals().length;
  const ready = state.orders.filter(canShip).length;
  const distribution = ['custom', 'regular', 'urgent', 'foreign'].map(type => ({ type, count: state.orders.filter(order => order.workflowType === type).length }));
  return `<div class="page-head"><div><h2>今日经营概览</h2><p>${state.user.role === '业务员' ? '仅显示由你负责的订单（含交接订单）' : '订单进度、待办和收款情况'}</p></div><small>${state.user.name}</small></div>
    ${notificationBanner()}<div class="kpis">${kpi('在执行订单', active, `共 ${state.orders.length} 单`, '▤')}${kpi('我的待办', myTodos().length, '当前岗位需处理', '✓')}${canSeeFinance() ? kpi('待收金额', money(pendingAmount), '客户实际未到账', '¥') : kpi('已完成订单', state.orders.filter(order=>order.status === '已完成').length, '当前可见范围', '✓')}${kpi('待管理员审批', pendingAdmin, '业务状态修改申请', '◇', pendingAdmin > 0)}</div>
    <div class="dashboard-grid"><div class="panel"><div class="panel-head"><div><h3>最近订单</h3><p>点击订单可查看完整流程</p></div><button class="link-btn" data-go="orders">查看全部 →</button></div>${orderTable(state.orders.slice(0, 6), false)}</div>
    <div class="panel"><div class="panel-head"><div><h3>订单类型分布</h3><p>按当前可见范围统计</p></div></div><div class="progress-list">${distribution.map((item, index) => {
      const percent = state.orders.length ? Math.round(item.count / state.orders.length * 100) : 0;
      return `<div class="progress-row"><b>${workflowShort[item.type]} ${item.count}单</b><div class="bar ${index === 1 ? 'green' : index === 2 ? 'amber' : ''}"><i style="width:${percent}%"></i></div><span>${percent}%</span></div>`;
    }).join('')}</div><div class="panel-head block-head"><div><h3>发货状态</h3><p>服务器硬性检查</p></div></div><div class="metric-callout"><b>${ready}</b><span>单已满足发货条件</span></div></div></div>`;
}
function orderTable(list, full = true, selectable = false) {
  if (!list.length) return '<div class="empty"><b>暂无订单</b>当前范围内没有订单</div>';
  return `<div class="table-wrap"><table><thead><tr>${selectable ? `<th class="selection-cell"><input type="checkbox" id="selectAllOrders" aria-label="全选筛选结果" ${list.length && list.every(o=>selectedOrderIds.has(o.id)) ? 'checked' : ''}></th>` : ''}<th>订单编号</th><th>订单类型</th><th>客户 / 产品</th><th>负责人</th>${canSeeFinance() ? '<th>实际总货款</th>' : ''}${full && canSeeFinance() ? '<th title="业务填写的预付款金额，实际到账以财务核对为准">预付款</th><th title="实际总货款减去业务填写的预付款">尾款</th>' : ''}<th>要求交期</th><th>当前状态</th>${full && canSeeFinance() ? '<th>到账</th>' : ''}${selectable ? '<th>操作</th>' : ''}</tr></thead><tbody>${list.map(order => `<tr data-order="${order.id}">
    ${selectable ? `<td class="selection-cell"><input type="checkbox" class="order-selection" data-id="${esc(order.id)}" aria-label="选择订单 ${esc(order.id)}" ${selectedOrderIds.has(order.id) ? 'checked' : ''}></td>` : ''}<td class="order-cell"><b>${esc(order.id)}</b><small>${esc(order.created)}录入</small></td><td><span class="workflow-badge ${order.workflowType}">${workflowShort[order.workflowType]}</span></td>
    <td class="order-cell"><b>${esc(displayCustomer(order))}</b><small>${esc(order.product)} · ${order.qty == null ? '数量见明细' : `${order.qty}件`}${order.recipient ? ` · ${esc(order.recipient)}` : ''}</small></td><td>${esc(order.ownerName||order.creatorName)}</td>${canSeeFinance() ? `<td class="money">${order.entryValues ? fieldText(order, 'amount') : money(order.amount)}</td>` : ''}${full && canSeeFinance() ? `<td class="money" title="${String(order.prepaymentAmount ?? '').trim() ? '业务填写的预付款金额' : '尚未填写预付款金额'}">${String(order.prepaymentAmount ?? '').trim() ? money(order.prepaymentAmount) : '—'}</td><td class="money" title="实际总货款－预付款">${finalPaymentText(order)}</td>` : ''}<td>${esc(order.delivery)}</td>
    <td><span class="status ${statusClass(order.status)}">${esc(order.status)}</span></td>${full && canSeeFinance() ? `<td>${money(order.received)}</td>` : ''}${selectable ? `<td><button type="button" class="link-btn export-order" data-id="${esc(order.id)}">导出</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}
function filteredOrders() { return filterOrders(state.orders,{query:state.query,type:state.filter,from:state.dateFrom,to:state.dateTo}); }
async function downloadOrders(ids, button) {
  if (!ids.length) return toast('请先勾选订单');
  if (ids.length>5000) return toast('单次最多导出5000单，请缩小日期范围');
  if (button) button.disabled=true;
  try {
    const response=await fetch('/api/orders/export',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids})});
    if (!response.ok) { const data=await response.json(); throw new Error(data.error || '导出失败'); }
    const blob=await response.blob(),url=URL.createObjectURL(blob),link=document.createElement('a');
    link.href=url;link.download=`订单导出-${date()}-${ids.length}单.xlsx`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    toast(`已导出${ids.length}个订单`);
  } catch(error) { toast(error.message); }
  finally { if (button?.isConnected) button.disabled=false; }
}
function renderOrders() {
  const list=filteredOrders();
  const visibleIds=new Set(list.map(o=>o.id));
  for (const id of selectedOrderIds) if (!visibleIds.has(id)) selectedOrderIds.delete(id);
  return `<div class="page-head"><div><h2>全部订单</h2><p>${state.user.role === '业务员' ? '不同业务员之间的数据已隔离' : '统一订单编号，查看完整执行流程'}</p></div><span>共 ${list.length} 条</span></div>
    <section class="orders-panel"><div class="filter-heading"><b>筛选订单</b><small>按类型与日期快速查找，支持批量导出</small></div><div class="toolbar order-filters"><div class="search"><label class="filter-label" for="searchInput">关键词</label><input id="searchInput" value="${esc(state.query)}" placeholder="搜索订单号、客户、产品或创建人"></div><div class="filter-column"><label for="typeFilter">订单类型</label><select id="typeFilter" class="filter" aria-label="筛选订单类型"><option value="all">全部类型</option>${Object.entries(workflowNames).map(([value,label])=>`<option value="${value}" ${state.filter===value?'selected':''}>${label}</option>`).join('')}</select></div>
    <div class="date-filter"><label for="orderDateFrom">开始日期</label><input id="orderDateFrom" type="date" value="${esc(state.dateFrom)}" ${state.dateTo?`max="${esc(state.dateTo)}"`:''}></div><span class="date-divider">至</span><div class="date-filter"><label for="orderDateTo">结束日期</label><input id="orderDateTo" type="date" value="${esc(state.dateTo)}" ${state.dateFrom?`min="${esc(state.dateFrom)}"`:''}></div><button type="button" class="ghost" id="clearOrderFilters">重置筛选</button></div>
    <div class="export-toolbar"><span id="selectedOrderCount">已选 ${selectedOrderIds.size} 单 · 按订单日期筛选</span><div><button type="button" class="ghost" id="exportFilteredOrders" ${list.length?'':'disabled'}>导出筛选结果（${list.length}）</button><button type="button" class="primary" id="exportSelectedOrders" ${selectedOrderIds.size?'':'disabled'}>导出已选（${selectedOrderIds.size}）</button></div></div>${orderTable(list,true,true)}</section>`;
}
function renderTodos() {
  const items = myTodos();
  return `<div class="page-head"><div><h2>${esc(state.user.role)}的待办</h2><p>系统只允许处理当前流程节点，不能跳步</p></div><span class="status amber">${items.length} 项</span></div><div class="todo-grid">${items.map(({ order, task }) => `<article class="card todo-card" data-order="${order.id}"><div class="top"><span class="workflow-badge ${order.workflowType}">${workflowShort[order.workflowType]}</span><small>${task.step === '付款' ? '付款待办' : `第 ${flowStepNumber(order,task)} 步`}</small></div><h3>${esc(task.name)}</h3><p>${esc(displayCustomer(order))} · ${esc(order.product)}</p><footer><span>${order.id}</span><span class="avatar">${esc(task.ownerRole.slice(0, 1))}</span></footer></article>`).join('') || '<div class="panel empty"><b>暂无待办</b>当前岗位的任务已经处理完成</div>'}</div>`;
}
function renderFinance() {
  return `${notificationBanner()}<div class="page-head"><div><h2>财务收款</h2><p>登记客户实际到账；工单付款在对应流程节点登记</p></div></div><div class="note">财务核对后可自行确认流程，不再限制实际到账必须达到指定金额；实际到账、未到账金额仍按收款记录显示。</div><div class="finance-grid">${state.orders.map(order => `<article class="card finance-card"><div><h3>${esc(order.customer)} <span class="status ${statusClass(order.financeStatus)}">${esc(order.financeStatus)}</span></h3><div class="meta-line"><span>订单 <b>${order.id}</b></span><span>类型 <b>${workflowShort[order.workflowType]}</b></span></div><div class="amount-progress"><span>应收 ${order.entryValues ? fieldText(order,'amount') : money(order.amount)}</span><div class="bar green"><i style="width:${order.amount ? Math.min(100,order.received/order.amount*100) : 0}%"></i></div><b>实到 ${money(order.received)}</b></div></div><div class="card-actions">${state.user.role === '财务' && order.received < order.amount ? `<button class="ghost receipt-btn" data-id="${order.id}">登记到账</button>` : `<button class="ghost" data-open-order="${order.id}">查看</button>`}</div></article>`).join('') || '<div class="panel empty">暂无订单</div>'}</div>`;
}
function renderApprovals() {
  const items = pendingApprovals();
  return `<div class="page-head"><div><h2>业务状态审批</h2><p>业务员提交的流程状态修改，由超级管理员批准后生效</p></div><span class="status amber">${items.length} 项待审批</span></div><div class="approval-grid">${items.map(({ order, task }) => `<article class="card approval-card"><div><h3>${esc(order.customer)} · ${task.step === '付款' ? '付款待办' : `第 ${flowStepNumber(order,task)} 步`}</h3><div class="meta-line"><span>订单 <b>${order.id}</b></span><span>申请人 <b>${esc(task.approvalRequestedBy)}</b></span><span>申请内容 <b>${esc(task.name)}</b></span></div><p class="muted-copy">说明：${esc(task.note || '无')}</p></div><div class="card-actions"><button class="danger approval-action" data-id="${order.id}" data-step="${task.step}" data-action="reject">驳回</button><button class="success approval-action" data-id="${order.id}" data-step="${task.step}" data-action="approve">批准</button></div></article>`).join('') || '<div class="panel empty"><b>暂无待审批状态</b>业务员尚未提交状态修改申请</div>'}</div>`;
}
function renderShipping() {
  const list = state.orders.filter(order => order.status !== '已完成' || order.shipment);
  return `<div class="page-head"><div><h2>发货放行</h2><p>未满足条件的订单，服务器拒绝发货</p></div></div><div class="shipping-grid">${list.map(order => {
    const checks = gate(order), allowed = canShip(order);
    const shipped = order.flowTasks.some(task => isShipping(task) && task.status === '已完成');
    const needsWaybill=shipped&&state.user.role==='仓库'&&!['自提','客户自提'].includes(order.shipment?.method)&&!order.shipment?.documents?.length;
    return `<article class="card shipping-card"><div><h3>${order.id} · ${esc(order.customer)} <span class="status ${shipped || allowed ? 'green' : 'red'}">${shipped ? '已发货' : allowed ? '可发货' : '禁止发货'}</span></h3><div class="meta-line"><span>${esc(order.product)}</span><span>${order.qty == null ? '数量见明细' : `<b>${esc(order.qty)}</b> 件`}</span><span>${workflowNames[order.workflowType]}</span></div>${order.logisticsRequirements ? `<div class="note" style="white-space:pre-wrap"><b>客户要求物流信息：</b>${esc(order.logisticsRequirements)}</div>` : ''}<div class="gate-list">${shipped ? `<span class="gate">✓ 已完成发货</span>${needsWaybill?'<span class="gate fail">待上传快递面单</span>':''}<span class="gate">${esc(order.shipment?.method || '物流')}</span><span class="gate">${esc(order.logistics || '未填写物流公司')} · ${esc(order.trackingNumber || '未填写物流单号')}</span>` : checks.map(([label, ok]) => `<span class="gate ${ok ? '' : 'fail'}">${ok ? '✓' : '×'} ${label}</span>`).join('')}</div></div><div class="card-actions">${shipped && state.user.role === '仓库' ? `<button class="${needsWaybill?'danger needs-waybill':'primary'} tracking-btn" data-id="${order.id}">${needsWaybill?'上传快递面单（待上传）':order.shipment?.documents?.length?'查看 / 修改快递面单':'修改物流信息'}</button>` : ''}<button class="success ship-btn" data-id="${order.id}" ${allowed && state.user.role === '仓库' ? '' : 'disabled'}>${shipped ? '已发货' : state.user.role === '仓库' ? '确认发货' : '仅仓库操作'}</button></div></article>`;
  }).join('') || '<div class="panel empty">暂无待发货订单</div>'}</div>`;
}

const staffViews=employeeViews({state,api,modal,closeModal,refreshOrders,render,toast,esc});
const workNoticeUI=workNotificationUI({state,api,esc,showOrder,refreshOrders,render,renderNav,toast,canRefreshWorkspace});
const renderers = { workNotifications:workNoticeUI.page, employees:staffViews.renderEmployees, notifications:renderNotifications, dashboard: renderDashboard, orders: renderOrders, todos: renderTodos, finance: renderFinance, approvals: renderApprovals, shipping: renderShipping };
function render() {
  if (!renderers[state.route] || !visibleNav().some(item => item[0] === state.route)) state.route = 'dashboard';
  renderNav();
  $('#eyebrow').textContent = routeTitles[state.route][0]; $('#pageTitle').textContent = routeTitles[state.route][1];
  $('#currentUser').textContent = `${state.user.name} · ${state.user.role}`;
  $('#newOrderBtn').style.display = state.user.role === '业务员' ? '' : 'none';
  $('#content').dataset.page=state.route; $('#content').innerHTML = renderers[state.route](); bind();
}
function bind() {
  workNoticeUI.bind();
  staffViews.bindEmployees();
  document.querySelectorAll('.view-order-notice').forEach(button=>button.onclick=()=>readOrderNotice(button.dataset.noticeId,button.dataset.orderId));
  document.querySelectorAll('.read-order-notice').forEach(button=>button.onclick=()=>readOrderNotice(button.dataset.noticeId));
  document.querySelectorAll('[data-open-order]').forEach(button => button.onclick = () => showOrder(button.dataset.openOrder));
  document.querySelectorAll('[data-order]').forEach(element => element.onclick = event => { if (!event.target.closest('button,input,label')) showOrder(element.dataset.order); });
  document.querySelectorAll('[data-go]').forEach(element => element.onclick = () => { state.route = element.dataset.go; render(); });
  const updateSelection = () => {
    const list=filteredOrders(),n=list.filter(o=>selectedOrderIds.has(o.id)).length;
    $('#selectedOrderCount').textContent=`已选 ${n} 单 · 按订单日期筛选`;
    const button=$('#exportSelectedOrders');button.textContent=`导出已选（${n}）`;button.disabled=!n;
    const all=$('#selectAllOrders');if(all){all.checked=!!list.length&&n===list.length;all.indeterminate=n>0&&n<list.length;}
  };
  document.querySelectorAll('.order-selection').forEach(input=>input.onchange=()=>{if(input.checked)selectedOrderIds.add(input.dataset.id);else selectedOrderIds.delete(input.dataset.id);updateSelection();});
  if($('#selectAllOrders')) $('#selectAllOrders').onchange=event=>{for(const order of filteredOrders()) {if(event.target.checked)selectedOrderIds.add(order.id);else selectedOrderIds.delete(order.id);}document.querySelectorAll('.order-selection').forEach(input=>input.checked=selectedOrderIds.has(input.dataset.id));updateSelection();};
  for(const [selector,key] of [['#orderDateFrom','dateFrom'],['#orderDateTo','dateTo']]) if($(selector)) $(selector).onchange=event=>{const value=event.target.value;if(value&&((key==='dateFrom'&&state.dateTo&&value>state.dateTo)||(key==='dateTo'&&state.dateFrom&&value<state.dateFrom))){event.target.value=state[key];return toast('开始日期不能晚于结束日期');}state[key]=value;render();};
  if($('#clearOrderFilters')) $('#clearOrderFilters').onclick=()=>{state.query='';state.filter='all';state.dateFrom='';state.dateTo='';selectedOrderIds.clear();render();};
  document.querySelectorAll('.export-order').forEach(button=>button.onclick=()=>downloadOrders([button.dataset.id],button));
  if($('#exportSelectedOrders')) $('#exportSelectedOrders').onclick=event=>downloadOrders(filteredOrders().filter(o=>selectedOrderIds.has(o.id)).map(o=>o.id),event.currentTarget);
  if($('#exportFilteredOrders')) $('#exportFilteredOrders').onclick=event=>downloadOrders(filteredOrders().map(o=>o.id),event.currentTarget);
  if($('#selectAllOrders')) updateSelection();
  const search = $('#searchInput'); if (search) search.oninput = event => { state.query = event.target.value; renderOrdersOnly(); };
  const filter = $('#typeFilter'); if (filter) filter.onchange = event => { state.filter = event.target.value; render(); };
  document.querySelectorAll('.receipt-btn').forEach(button => button.onclick = () => receiptModal(button.dataset.id));
  document.querySelectorAll('.approval-action').forEach(button => button.onclick = () => reviewTask(button.dataset.id, Number(button.dataset.step), button.dataset.action));
  document.querySelectorAll('.tracking-btn').forEach(button => button.onclick = () => trackingModal(button.dataset.id));
  document.querySelectorAll('.ship-btn').forEach(button => button.onclick = () => shippingModal(button.dataset.id));
}
function renderOrdersOnly() {
  const cursor = $('#searchInput').selectionStart; $('#content').innerHTML = renderOrders(); bind(); $('#searchInput').focus(); $('#searchInput').setSelectionRange(cursor, cursor);
}

function newOrderModal(source = null, editing = false) {
  if ($('#modalBody form')) return toast('请先保存或关闭当前填写窗口，再打开其他工单');
  if (source && state.user.role !== '业务员') return toast('仅业务员可以复制建单');
  let selectedImages = source ? (source.images || []).map(image => ({sourceImageId:image.id, name:image.name, url:image.url})) : [];
  const selectedMarkImages = source ? (source.shippingMarkImages || []).map(image=>({sourceImageId:image.id,name:image.name,url:image.url})) : [];
  let readingImages = 0;
  const selectedProofs = editing ? (source.paymentProofs || []).map(image=>({sourceImageId:image.id,name:image.name,url:image.url})) : [];
  let selectedProducts = source ? (source.lineItems?.length ? source.lineItems.map(item=>({...source.productItems?.find(p=>p.code===item.code),...item,name:item.product})) : (source.productItems || []).map(item => ({...item}))) : [];
  let calculatedPricing=!editing||source?.pricingVersion===1,pricingTouched=false;
  let lastParsedText=source?.lineItems?.length?(source.productSourceText||'').trim():'';
  let productResults = [];
  let productSearchVersion = 0;
  let productSearchTimer;
  modal(`<div class="modal-head"><div><h2>${editing ? '修改工单信息' : source ? '复制建单' : '新建订单'}</h2><p>${editing ? `修改 ${esc(source.id)} 的资料，保存后保留原有流程与资金记录` : source ? `复制自 ${esc(source.id)}，请核对并修改信息后创建新订单` : '填写店铺名称，选择订单类型后录入订单内容'}</p></div><button class="close" data-close>×</button></div><form id="orderForm"><div class="modal-body"><div class="form-step-title"><span>01</span><div><h3>订单与收货信息</h3><p>确认店铺、订单类型和收件资料</p></div></div>
    <div class="form-section"><div class="field"><label for="orderStoreName">店铺名称</label><input id="orderStoreName" name="storeName" type="text" placeholder="请输入店铺名称"></div></div>
    <div class="form-section"><div class="field"><label for="shopOrderNumber">店铺订单号</label><input id="shopOrderNumber" name="shopOrderNumber" type="text" placeholder="请输入店铺订单号"></div></div>
    <div class="form-section"><div class="field"><label for="workflowType">订单类型</label><select id="workflowType" name="workflowType" required><option value="">请选择订单类型</option>${state.workflows.map(flow => `<option value="${flow.type}">${esc(workflowNames[flow.type])}</option>`).join('')}</select></div>
    <div id="businessProcurementSection" class="field hidden"><label for="businessSelfProcurement"><input id="businessSelfProcurement" name="businessSelfProcurement" type="checkbox" style="width:auto;margin-right:8px">标贴由业务自行采购</label><small id="businessProcurementHint" class="calculation-note">勾选后，标贴采购由本订单业务员确认，财务付款环节保留。</small></div>
    <div id="workflowPreview" class="workflow-preview">选择类型后查看对应的处理流程。</div>
    </div>
    <div class="form-grid">
    <div class="field full"><label for="orderDate">日期</label><input id="orderDate" name="orderDate" type="date" value="${date()}" required></div>
    <div class="field"><label for="orderRecipient">收件人姓名</label><input id="orderRecipient" name="recipient" autocomplete="shipping name" required></div>
    <div class="field"><label for="orderContact">收件人电话</label><input id="orderContact" name="contact" type="tel" autocomplete="shipping tel" placeholder="请输入手机号、座机或国际号码"></div>
    <div class="field full"><label for="orderAddress">收件地址</label><input id="orderAddress" name="address" required></div>
    <div class="field full"><label for="addressParseText">地址解析</label><textarea id="addressParseText" maxlength="5000" placeholder="粘贴客户发来的整段收货信息，例如：张三，13800138000，河南省郑州市金水区花园路88号"></textarea><div class="card-actions"><button type="button" class="ghost" id="parseOrderAddress">解析并填入</button></div><small class="calculation-note">支持姓名、电话、地址混合或分行粘贴。解析将替换上方识别到的对应内容，请核对后提交。</small><p id="addressParseStatus" class="calculation-note" role="status" aria-live="polite"></p></div>
    <div class="form-step-title"><span>02</span><div><h3>货品与包装</h3><p>录入产品明细、备注及参考图片</p></div></div>
    <div id="productItemsSection" class="field full hidden">
      <label for="productCodeSearch">产品明细</label>
      <div class="product-search-tools"><input id="productCodeSearch" type="search" autocomplete="off" placeholder="输入关键词或数字，顺序不限，例如：135 皮革 护理"><button type="button" class="ghost" id="continueAddProduct">＋ 继续新增产品</button></div>
      <small id="productSearchHint" class="calculation-note" aria-live="polite">支持多个关键词、编码和数字组合搜索，顺序不限，可用空格分隔。</small>
      <div id="productSearchResults" class="product-search-results hidden"></div>
    </div>
    <div class="field full"><label for="orderProduct">定制类货品明细</label><textarea id="orderProduct" name="product" required></textarea></div><div id="customPricingTools" class="field full"><div class="card-actions"><button type="button" class="ghost" id="parseProductDetails">解析货品明细</button><button type="button" class="ghost" id="addPricingLine">＋ 新增产品明细</button></div><small id="productParseStatus" class="calculation-note" role="status">可粘贴货品描述后解析，也可手动添加；单价未写明时留空，需核对补齐。</small></div><div id="selectedProductItems" class="field full"></div><div id="customNotesField" class="field full"><label for="pricingNotes">包装与特殊备注</label><textarea id="pricingNotes" placeholder="例如：装一箱，装不下联系业务"></textarea></div>
    <div class="field full"><label for="orderImages">货品图片</label><div id="goodsDropZone" class="image-drop-zone"><p>拖拽货品图片到这里，或点击下方选择文件</p><input id="orderImages" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple></div><small class="calculation-note">最多4张，每张不超过5MB。支持JPG、PNG、WebP、GIF，可点击预览图片放大查看。</small><div id="orderImagePreview" class="order-image-grid"></div></div>
    <div id="shippingMarkSection" class="field full hidden"><label for="shippingMarkDescription">唛头描述</label><textarea id="shippingMarkDescription" name="shippingMarkDescription" placeholder="填写外箱唛头文字、箱号及印刷要求"></textarea><label for="shippingMarkImages">唛头图片</label><div id="markDropZone" class="image-drop-zone"><p>拖拽唛头图片到这里，或点击下方选择文件</p><input id="shippingMarkImages" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple></div><small class="calculation-note">最多4张，每张不超过5MB，可点击预览放大查看。</small><div id="shippingMarkPreview" class="order-image-grid"></div></div>
    <div class="form-step-title"><span>03</span><div><h3>金额与交付</h3><p>核对金额、收款账户和付款凭证</p></div></div>
    <div class="field"><label for="orderAccount">收款账户</label><div id="paymentAccountPicker" class="payment-account-picker"><input name="paymentAccount" id="orderAccount" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="paymentAccountResults" autocomplete="off" placeholder="输入关键词或数字搜索，顺序不限，也可自行输入"><div id="paymentAccountResults" role="listbox" class="payment-account-results hidden"></div></div><small id="paymentAccountHint" class="calculation-note">支持多个关键词和数字组合搜索，顺序不限，可用空格分隔；也可直接填写。</small></div>
    <div class="field full"><label for="orderLogisticsRequirements">客户要求物流信息</label><textarea id="orderLogisticsRequirements" name="logisticsRequirements" maxlength="2000" placeholder="例如：指定德邦物流、送货上门、运费到付或客户自提"></textarea></div>
    <div class="field"><label for="orderFreight">运费</label><input id="orderFreight" name="freight" type="number" min="0" step="0.01" placeholder="未填写按0计算"></div>

    <div class="field"><label for="orderTotal">总货款</label><input id="orderTotal" type="text" readonly class="calculated-input" placeholder="产品金额合计＋运费"></div><div class="field"><label for="orderDiscount">优惠金额</label><input id="orderDiscount" name="discountAmount" type="number" min="0" step="0.01" value="0"></div><div class="field"><label for="orderActualTotal">实际总货款</label><input id="orderActualTotal" name="amount" type="text" readonly class="calculated-input" placeholder="总货款－优惠金额"><small id="pricingHint" class="calculation-note" role="status">请添加产品明细并补齐单价。</small></div>
    <div class="field"><label for="orderPrepayment">预付款金额</label><input id="orderPrepayment" name="prepaymentAmount" type="number" min="0" max="1000000000000" step="0.01" placeholder="填写本次预付款金额"><small class="calculation-note">由业务填写，实际到账以财务核对为准。</small></div>
    <div class="field full"><label for="orderFinalPayment">尾款金额</label><input id="orderFinalPayment" type="text" readonly aria-readonly="true" class="calculated-input" placeholder="按实际总货款和预付款自动计算"><small class="calculation-note" id="finalPaymentHint">尾款＝实际总货款－预付款；实际到账以财务核对为准。</small></div>
    <div class="field full"><label for="paymentProofImages">付款凭证</label><div id="proofDropZone" class="image-drop-zone"><p>拖拽付款凭证图片到这里，或点击下方选择文件</p><input id="paymentProofImages" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple></div><small class="calculation-note">最多4张，每张不超过5MB，可预览、移除；复制建单时不沿用旧凭证。</small><div id="paymentProofPreview" class="order-image-grid"></div></div>
    <div class="field"><label for="orderCost">成本</label><input id="orderCost" name="cost" type="text"></div>
    <div class="field"><label for="orderProfit">毛利</label><input id="orderProfit" name="grossProfit" type="text"></div>
    <div class="field"><label for="orderSalesperson">业务员</label><input id="orderSalesperson" name="salesperson" value="${esc(state.user.name)}"></div>
    <div class="field"><label for="orderCod">代收</label><input id="orderCod" name="codAmount" type="text"></div>
    </div></div><div class="modal-foot"><button type="button" class="ghost" data-close>取消</button><button class="primary">${editing ? '保存修改' : '提交工单'}</button></div></form>`);
  const currentOrderForm = $('#orderForm');
  const updateFinalPayment = () => {
    const result=finalPaymentAmount({pricingVersion:calculatedPricing?1:undefined,amount:$('#orderActualTotal').value,prepaymentAmount:$('#orderPrepayment').value});
    $('#orderFinalPayment').value=result===null?'':result.toFixed(2);
    const hasBoth=$('#orderActualTotal').value.trim()&&$('#orderPrepayment').value.trim();
    $('#finalPaymentHint').textContent=result===null&&hasBoth?'金额暂时无法计算，请核对总货款与预付款。':'尾款＝实际总货款－预付款；实际到账以财务核对为准。';
  };
  const pricingLines=()=>selectedProducts.map(p=>({product:p.product||p.name||'',color:p.color||'',specification:p.specification||'',quantity:p.quantity,unitPrice:p.unitPrice??'',unit:p.unit||'',code:p.code||''}));
  const updatePricing=()=>{
    if(!calculatedPricing&&!pricingTouched){$('#pricingHint').textContent='历史订单保留原金额；补齐产品明细及单价后转为自动计价。';updateFinalPayment();return;}
    try{
      const totals=calculateOrderPricing(pricingLines(),$('#orderFreight').value,$('#orderDiscount').value);
      calculatedPricing=true;$('#orderTotal').value=totals.grossAmount.toFixed(2);$('#orderActualTotal').value=totals.amount.toFixed(2);
      totals.lineItems.forEach((line,i)=>{const el=$('#lineAmount'+i);if(el)el.textContent=money(line.amount);});
      $('#pricingHint').textContent=`产品合计 ${money(totals.itemsSubtotal)}＋运费 ${money(totals.freight)}－优惠 ${money(totals.discountAmount)}＝${money(totals.amount)}`;
    }catch(error){$('#orderTotal').value='';$('#orderActualTotal').value='';$('#pricingHint').textContent=error.message;selectedProducts.forEach((p,i)=>{const el=$('#lineAmount'+i);if(el){try{el.textContent=money(calculateOrderPricing([pricingLines()[i]],0,0).amount);}catch{el.textContent='待补价格';}}});}
    updateFinalPayment();
  };
  for(const id of ['#orderFreight','#orderDiscount'])$(id).addEventListener('input',()=>{pricingTouched=true;updatePricing();});
  $('#orderPrepayment').addEventListener('input',updateFinalPayment);
  let accountResults = [], activeAccount = -1, accountVersion = 0, accountTimer;
  const accountInput = $('#orderAccount'), accountList = $('#paymentAccountResults');
  const closeAccountList = () => {
    accountVersion++; accountList.classList.add('hidden'); accountInput.setAttribute('aria-expanded','false');
    accountInput.removeAttribute('aria-activedescendant'); activeAccount = -1;
  };
  const chooseAccount = index => { if (accountResults[index]) { accountInput.value = accountResults[index].name; closeAccountList(); } };
  const searchAccounts = async () => {
    if ($('#orderForm') !== currentOrderForm) return;
    const version = ++accountVersion;
    try {
      const data = await api('/api/payment-accounts?q=' + encodeURIComponent(accountInput.value.trim()));
      if (version !== accountVersion || $('#orderForm') !== currentOrderForm) return;
      accountResults = data.accounts || []; activeAccount = -1;
      accountList.innerHTML = accountResults.length ? accountResults.map((item,index) => `<button id="accountOption${index}" type="button" role="option" aria-selected="false" tabindex="-1" data-account-index="${index}">${esc(item.name)}</button>`).join('') : '<div class="account-no-match">没有匹配账户，可以直接使用已输入的文字。</div>';
      accountList.classList.remove('hidden'); accountInput.setAttribute('aria-expanded','true');
      $('#paymentAccountHint').textContent = accountResults.length ? `找到${accountResults.length}个账户，点击选用；也可保留自行输入的内容。` : '可直接填写新账户，无需从列表选择。';
      accountList.querySelectorAll('[data-account-index]').forEach(button => {
        button.onmousedown = event => event.preventDefault();
        button.onclick = () => chooseAccount(Number(button.dataset.accountIndex));
      });
    } catch { if (version === accountVersion && $('#orderForm') === currentOrderForm) $('#paymentAccountHint').textContent = '账户列表暂时无法加载，可直接手动输入。'; }
  };
  accountInput.onfocus = searchAccounts;
  accountInput.oninput = () => { closeAccountList(); clearTimeout(accountTimer); accountTimer = setTimeout(searchAccounts,150); };
  accountInput.onkeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); closeAccountList(); return; }
    if (event.key === 'Enter') { event.preventDefault(); if (activeAccount >= 0) chooseAccount(activeAccount); else { clearTimeout(accountTimer); searchAccounts(); } return; }
    if (!['ArrowDown','ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    if (accountList.classList.contains('hidden')) { searchAccounts(); return; }
    if (!accountResults.length) return;
    activeAccount = activeAccount < 0 ? (event.key === 'ArrowDown' ? 0 : accountResults.length - 1) : (activeAccount + (event.key === 'ArrowDown' ? 1 : -1) + accountResults.length) % accountResults.length;
    accountList.querySelectorAll('[data-account-index]').forEach((button,index) => button.setAttribute('aria-selected',String(index === activeAccount)));
    const option = accountList.querySelector('#accountOption' + activeAccount);
    accountInput.setAttribute('aria-activedescendant', option.id); option.scrollIntoView({block:'nearest'});
  };
  $('#paymentAccountPicker').onfocusout = event => { if (!event.currentTarget.contains(event.relatedTarget)) closeAccountList(); };
  $('#workflowType').onchange = event => {
    const definition = state.workflows.find(item => item.type === event.target.value);
    const flow=definition?{...definition,steps:definition.steps.map(step=>({...step}))}:null;
    const selfProcurement=$('#businessSelfProcurement');
    if(!isCustomWorkflow(flow?.type))selfProcurement.checked=false;
    selfProcurement.disabled=!isCustomWorkflow(flow?.type)||(editing&&procurementModeLocked(source));
    $('#businessProcurementSection').classList.toggle('hidden',!isCustomWorkflow(flow?.type));
    $('#businessProcurementHint').textContent=editing&&procurementModeLocked(source)?'标贴采购或付款环节已确认，不能切换采购方式。':'勾选后，标贴采购由本订单业务员确认，财务付款环节保留。';
    if(flow)applyProcurementMode({workflowType:flow.type,businessSelfProcurement:selfProcurement.checked,flowTasks:flow.steps});
    $('#workflowPreview').innerHTML = flow ? `<details class="workflow-details"><summary><span>${esc(flow.label)}<small>${flow.steps.length}步流程</small></span><span class="workflow-details-hint">查看处理流程</span></summary><ol>${flow.steps.map(step => `<li><span>${esc(step.name)}</span><small>${esc(step.ownerRole)}</small></li>`).join('')}</ol></details>` : '选择类型后查看对应的处理流程。';
    $('#shippingMarkSection').classList.toggle('hidden', flow?.type !== 'foreign');
    $('#shippingMarkDescription').disabled = flow?.type !== 'foreign';
    const custom = isCustomWorkflow(flow?.type);
    const standard = ['regular','urgent'].includes(flow?.type);
    document.querySelector('label[for="orderProduct"]').textContent = standard ? '特殊备注' : '定制类货品明细';
    $('#orderProduct').name = standard ? 'specialNotes' : 'product';
    $('#orderProduct').required = !standard&&!calculatedPricing;
    $('#customPricingTools').classList.toggle('hidden',standard);
    $('#customNotesField').classList.toggle('hidden',standard);
    $('#productItemsSection').classList.toggle('hidden', !standard);
    $('#productItemsSection').querySelectorAll('input,button').forEach(element => element.disabled = !standard);
    productSearchVersion++;
    $('#productSearchResults').classList.add('hidden');
  };
  $('#businessSelfProcurement').onchange=()=>$('#workflowType').dispatchEvent(new Event('change'));
  $('#parseOrderAddress').onclick=()=>{
    const text=$('#addressParseText').value.trim();
    if(!text){$('#addressParseStatus').textContent='请先粘贴收货信息。';return;}
    const parsed=parseShippingAddress(text),targets={recipient:'#orderRecipient',contact:'#orderContact',address:'#orderAddress'},labels={recipient:'姓名',contact:'电话',address:'地址'};
    const filled=[],missing=[];
    for(const [key,selector]of Object.entries(targets)){if(parsed[key]){$(selector).value=parsed[key];$(selector).dispatchEvent(new Event('input',{bubbles:true}));filled.push(labels[key]);}else missing.push(labels[key]);}
    $('#addressParseStatus').textContent=filled.length?`已填入${filled.join('、')}，请核对。${missing.length?'未确定的'+missing.join('、')+'请手动填写，原有内容已保留。':''}`:'未能确定姓名、电话和地址，请补充清晰信息或手动填写；原有内容已保留。';
  };
  const renderProducts = () => {
    $('#selectedProductItems').innerHTML=selectedProducts.length?`<div class="table-wrap pricing-table"><table><thead><tr><th>产品</th><th>颜色</th><th>规格</th><th>数量</th><th>单价</th><th>金额</th><th>操作</th></tr></thead><tbody>${selectedProducts.map((p,i)=>`<tr>${[['name','产品',p.product||p.name||''],['color','颜色',p.color||''],['specification','规格',p.specification||''],['quantity','数量',p.quantity??''],['unitPrice','单价',p.unitPrice??'']].map(([key,label,value])=>`<td><input aria-label="第${i+1}行${label}" data-line-index="${i}" data-line-field="${key}" value="${esc(value)}" ${['quantity','unitPrice'].includes(key)?`type="number" min="${key==='quantity'?'0.001':'0'}" step="${key==='quantity'?'0.001':'0.01'}"`:''} ${key==='color'||key==='specification'||(key==='unitPrice'&&!calculatedPricing)?'':'required'} ${p.code&&['name','specification'].includes(key)?'readonly':''}></td>`).join('')}<td><span id="lineAmount${i}">待补价格</span>${p.unit?`<small>${esc(p.unit)}</small>`:''}</td><td>${p.code?`<small>${esc(p.code)}</small><label>箱规<input aria-label="第${i+1}行箱规" data-line-index="${i}" data-line-field="casePack" type="number" min="1" step="1" value="${esc(p.casePack??'')}"></label>`:''}<button type="button" class="danger remove-product-item" data-product-index="${i}">移除</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted-copy">尚未添加产品明细。</p>';
    document.querySelectorAll('[data-line-field]').forEach(input=>input.oninput=()=>{const p=selectedProducts[Number(input.dataset.lineIndex)];p[input.dataset.lineField]=input.value;if(input.dataset.lineField==='name')p.product=input.value;pricingTouched=true;updatePricing();});
    document.querySelectorAll('.remove-product-item').forEach(button=>button.onclick=()=>{selectedProducts.splice(Number(button.dataset.productIndex),1);pricingTouched=true;renderProducts();});
    updatePricing();
  };
  $('#addPricingLine').onclick=()=>{if(selectedProducts.length>=100)return toast('每单最多100条产品明细');selectedProducts.push({name:'',color:'',specification:'',quantity:1,unitPrice:''});pricingTouched=true;renderProducts();};
  $('#parseProductDetails').onclick=()=>{
    const sourceText=$('#orderProduct').value.trim();
    if(sourceText&&sourceText===lastParsedText&&selectedProducts.length)return toast('这段内容已解析，请直接修改下方明细，避免重复添加');
    const parsed=parseProductDescription(sourceText);
    if(!parsed.items.length){$('#productParseStatus').textContent='未解析出明确产品和数量，请补充描述或手动新增。';return;}
    if(selectedProducts.length+parsed.items.length>100)return toast('每单最多100条产品明细');
    selectedProducts.push(...parsed.items);lastParsedText=sourceText;pricingTouched=true;renderProducts();
    if(parsed.unparsed.length)$('#pricingNotes').value=[$('#pricingNotes').value,...parsed.unparsed.filter(text=>!/(?:单价|价格|金额|元|¥|￥)/.test(text))].filter(Boolean).join('；');
    $('#productParseStatus').textContent=`已增加${parsed.items.length}条明细，请核对产品、颜色、规格、数量，并补齐单价。${parsed.unparsed.length?'其余内容保留在原文；非价格说明已带入备注，请核对。':''}`;
  };
  const addProduct = product => {
    const existing = selectedProducts.find(item => item.code === product.code);
    if (existing) { existing.quantity = Number(existing.quantity || 0) + 1; toast('该编码已添加，数量增加1'); }
    else {
      if (selectedProducts.length >= 100) return toast('每单最多添加100条产品明细');
      selectedProducts.push({ ...product, quantity: 1, casePack: '',unitPrice:'' });
    }
    pricingTouched=true;renderProducts();
    productSearchVersion++; $('#productCodeSearch').value = '';
    $('#productSearchResults').classList.add('hidden');
    $('#productSearchHint').textContent = `已添加${selectedProducts.length}种产品，可继续搜索添加。`;
    $('#productCodeSearch').focus();
  };
  const searchProducts = async () => {
    if ($('#orderForm') !== currentOrderForm) return;
    const query = $('#productCodeSearch').value.trim(), version = ++productSearchVersion;
    $('#productSearchHint').textContent = '正在搜索…';
    try {
      const data = await api('/api/products?q=' + encodeURIComponent(query));
      if (version !== productSearchVersion || $('#orderForm') !== currentOrderForm) return;
      productResults = data.products || [];
      $('#productSearchResults').innerHTML = productResults.map((item,index) => `<button type="button" class="product-search-option" data-result-index="${index}"><span><b>${esc(item.code)}</b><small>${esc(item.name)}</small><small>${esc(item.specification || item.category || '')}</small></span><span class="product-add-label">＋ 添加</span></button>`).join('') || '<p class="muted-copy">未找到匹配产品，请核对编码或换一个关键词。</p>';
      $('#productSearchResults').classList.remove('hidden');
      $('#productSearchHint').textContent = `产品库共${data.total}条，匹配${data.matched}条，当前展示${productResults.length}条；关键词与数字顺序不限。`;
      document.querySelectorAll('[data-result-index]').forEach(button => button.onclick = () => addProduct(productResults[Number(button.dataset.resultIndex)]));
    } catch(error) { if (version === productSearchVersion && $('#orderForm') === currentOrderForm && $('#productSearchHint')) $('#productSearchHint').textContent = error.message; }
  };
  $('#productCodeSearch').oninput = () => { productSearchVersion++; clearTimeout(productSearchTimer); productSearchTimer = setTimeout(searchProducts,200); };
  $('#productCodeSearch').onkeydown = event => {
    if (event.key === 'Enter') { event.preventDefault(); clearTimeout(productSearchTimer); searchProducts(); }
    if (event.key === 'Escape') { productSearchVersion++; $('#productSearchResults').classList.add('hidden'); }
  };
  $('#continueAddProduct').onclick = () => { $('#productCodeSearch').focus(); searchProducts(); };
  renderProducts();
  const renderImages = () => {
    $('#orderImagePreview').innerHTML = selectedImages.map((item, index) => `<figure class="order-image"><a href="${esc(item.dataUrl || item.url)}" data-preview-image><img src="${esc(item.dataUrl || item.url)}" alt="${esc(item.name)}"></a><figcaption>${esc(item.name)}</figcaption><button type="button" class="image-remove" data-image-index="${index}" aria-label="删除图片${index + 1}">×</button></figure>`).join('');
    document.querySelectorAll('[data-image-index]').forEach(button => button.onclick = () => { selectedImages.splice(Number(button.dataset.imageIndex), 1); renderImages(); });
  };
  const setupUploader = (inputId, zoneId, items, renderPreview) => {
    const input = $(inputId), zone = $(zoneId);
    const addFiles = async files => {
      if (!files.length) return;
      if (input.disabled) return toast('图片正在读取，请稍候');
      if (items.length + files.length > 4) return toast('每个图片区最多上传4张图片');
      if (files.some(file => !['image/jpeg','image/png','image/webp','image/gif'].includes(file.type) || file.size > 5 * 1024 * 1024)) return toast('请选择5MB以内的JPG、PNG、WebP或GIF图片');
      readingImages++; input.disabled = true;
      try {
        const images = await Promise.all(files.map(file => new Promise((resolve,reject) => {
          const reader = new FileReader(); reader.onload = () => resolve({name:file.name,dataUrl:reader.result});
          reader.onerror = () => reject(new Error('图片读取失败，请重新选择')); reader.readAsDataURL(file);
        })));
        items.push(...images); renderPreview();
      } catch(error) { toast(error.message); }
      finally { readingImages--; input.disabled = false; input.value = ''; }
    };
    input.onchange = () => { const files = Array.from(input.files || []); input.value = ''; addFiles(files); };
    for (const type of ['dragenter','dragover']) zone.addEventListener(type,event => { event.preventDefault(); event.stopPropagation(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave',event => { if (!zone.contains(event.relatedTarget)) zone.classList.remove('drag-over'); });
    zone.addEventListener('drop',event => { event.preventDefault(); event.stopPropagation(); zone.classList.remove('drag-over'); addFiles(Array.from(event.dataTransfer?.files || [])); });
  };
  const renderProofs = () => {
    $('#paymentProofPreview').innerHTML = selectedProofs.map((item,index) => `<figure class="order-image"><a href="${esc(item.dataUrl || item.url)}" data-preview-image><img src="${esc(item.dataUrl || item.url)}" alt="${esc(item.name)}"></a><figcaption>${esc(item.name)}</figcaption><button type="button" class="image-remove" data-proof-index="${index}" aria-label="删除付款凭证${index+1}">×</button></figure>`).join('');
    document.querySelectorAll('[data-proof-index]').forEach(button => button.onclick = () => { selectedProofs.splice(Number(button.dataset.proofIndex),1); renderProofs(); });
  };
  const renderMarkImages = () => {
    $('#shippingMarkPreview').innerHTML = selectedMarkImages.map((item,index)=>`<figure class="order-image"><a href="${esc(item.dataUrl || item.url)}" data-preview-image><img src="${esc(item.dataUrl || item.url)}" alt="${esc(item.name)}"></a><figcaption>${esc(item.name)}</figcaption><button type="button" class="image-remove" data-mark-index="${index}" aria-label="删除唛头图片${index+1}">×</button></figure>`).join('');
    document.querySelectorAll('[data-mark-index]').forEach(button=>button.onclick=()=>{selectedMarkImages.splice(Number(button.dataset.markIndex),1);renderMarkImages();});
  };
  setupUploader('#shippingMarkImages','#markDropZone',selectedMarkImages,renderMarkImages);
  setupUploader('#orderImages','#goodsDropZone',selectedImages,renderImages);
  setupUploader('#paymentProofImages','#proofDropZone',selectedProofs,renderProofs);
  if (source) {
    for (const key of ['storeName','workflowType','recipient','contact','codAmount','address','paymentAccount','logisticsRequirements','freight','cost','grossProfit','shippingMarkDescription']) {
      currentOrderForm.elements.namedItem(key).value = source.entryValues?.[key] ?? source[key] ?? '';
    }
    $('#orderTotal').value=source.grossAmount??(source.entryValues?.amount??source.amount??'');
    $('#orderActualTotal').value=source.entryValues?.amount??source.amount??'';
    $('#orderDiscount').value=source.discountAmount??0;
    $('#pricingNotes').value=source.specialNotes||source.notes||'';
    $('#businessSelfProcurement').checked=source.businessSelfProcurement===true;
    $('#workflowType').dispatchEvent(new Event('change'));
    $('#orderProduct').value = ['regular','urgent'].includes(source.workflowType) ? (source.specialNotes || source.notes || '') : (source.productSourceText || source.entryValues?.product || source.product || '');
    if (editing) {
      $('#orderDate').value = source.orderDate || source.created;
      $('#shopOrderNumber').value = source.shopOrderNumber || '';
      $('#orderSalesperson').value = source.salesperson || source.creatorName;
      $('#orderPrepayment').value = source.prepaymentAmount ?? '';
      $('#workflowType').disabled = true;
    }
    renderProducts(); renderImages(); renderProofs(); renderMarkImages();
  }
  updatePricing();
  const draftSnapshot=()=>JSON.stringify({fields:Array.from(currentOrderForm.elements).filter(el=>['INPUT','TEXTAREA','SELECT'].includes(el.tagName)&&el.type!=='file').map(el=>[el.id||el.name,el.type==='checkbox'?el.checked:el.value]),selectedProducts,selectedImages,selectedProofs,selectedMarkImages});
  const initialDraftSnapshot=draftSnapshot();
  modalIsDirty=()=>readingImages>0||draftSnapshot()!==initialDraftSnapshot;
  $('#orderForm').onsubmit = async event => {
    event.preventDefault(); if (readingImages) return toast('图片正在读取，请稍候'); const button = event.submitter; button.disabled = true;
    const fields = {...Object.fromEntries(new FormData(event.target)),businessSelfProcurement:$('#businessSelfProcurement').checked};
    if (editing) fields.workflowType = source.workflowType;
    const standard = ['regular','urgent'].includes(fields.workflowType);
    const legacyProducts = editing && standard && !source.productItems?.length && !selectedProducts.length;
    let pricingPayload={};
    if(calculatedPricing||pricingTouched){
      try{calculateOrderPricing(pricingLines(),fields.freight,fields.discountAmount);}catch(error){toast(error.message);button.disabled=false;return;}
      if(standard&&selectedProducts.some(p=>!p.code)) {toast('常规和加急订单请从产品库搜索选择产品');button.disabled=false;return;}
      pricingPayload={pricingVersion:1,lineItems:pricingLines(),productSourceText:standard?'':$('#orderProduct').value,specialNotes:standard?fields.specialNotes:$('#pricingNotes').value};
    }

    if (standard && !selectedProducts.length && !legacyProducts) { toast('请至少搜索选择一个产品'); button.disabled = false; return; }
    try { const { order } = await api(editing ? `/api/orders/${source.id}` : '/api/orders', { method: editing ? 'PUT' : 'POST', body: JSON.stringify({ ...fields, ...pricingPayload, ...(editing ? {infoRevision:source.infoRevision || 0} : source ? {sourceOrderId:source.id} : {}), ...(legacyProducts ? {product:source.product} : {}), shippingMarkImages: fields.workflowType === 'foreign' ? selectedMarkImages : [], images: selectedImages, paymentProofs: selectedProofs, ...(standard && !legacyProducts ? { productItems: selectedProducts.map(({code,quantity,casePack}) => ({code,quantity,casePack})) } : {}) }) }); await refreshOrders(); closeModal(); state.route = 'orders'; render(); toast(`订单 ${order.id} ${editing ? '已保存修改' : '已创建'}`); }
    catch (error) { toast(error.message); button.disabled = false; }
  };
}
function showOrder(id) {
  if ($('#modalBody form')) return toast('请先保存或关闭当前填写窗口，再打开其他工单');
  const order = state.orders.find(item => item.id === id); if (!order) return;
  const task = activeTasks(order).find(task => task.ownerRole === state.user.role && task.status === '待处理') || currentTask(order);
  const flow = order.flowTasks.map(item => `<div class="flow-row ${item.status === '已完成' ? 'done' : item.status === '待管理员审批' ? 'review' : item.status === '待处理' ? 'current' : ''}"><span class="flow-step">${flowStepNumber(order,item)}</span><div><b>${esc(item.name)}</b><small>责任岗位：${esc(item.ownerRole)}${item.assignee ? ` · 经办：${esc(item.assignee)}` : ''}</small>${item.completedAt ? `<small>完成时间：${esc(new Date(item.completedAt).toLocaleString('zh-CN',{hour12:false}))}</small>` : ''}${canSeeFinance() && item.note ? `<small>处理说明：${esc(item.note)}</small>` : ''}${item.rejectionReason ? `<em>驳回原因：${esc(item.rejectionReason)}</em>` : ''}</div><span class="status ${statusClass(item.status)}">${item.status}</span></div>`).join('');
  const canAct = task && task.status === '待处理' && task.ownerRole === state.user.role && !isShipping(task);
  const actionLabel = isTailPaymentHandoff(order, task) ? '提交财务审核' : requiresAdminApproval(order, task) ? '提交审批' : '确认完成';
  modal(`<div class="modal-head"><div><h2>${order.id} <span class="status ${statusClass(order.status)}">${esc(order.status)}</span></h2><p>${esc(order.workflowLabel)} · 原创建人 ${esc(order.creatorName)} · 当前负责人 ${esc(order.ownerName||order.creatorName)}</p></div><button class="close" data-close>×</button></div><div class="modal-body">
    <div class="detail-summary"><div class="detail-block"><small>店铺 / 货物</small><b>${esc(displayCustomer(order))}</b><span>${esc(order.product)}</span></div><div class="detail-block"><small>数量</small><b>${order.qty == null ? '见货物明细' : `${order.qty} 件`}</b></div>${canSeeFinance() ? `<div class="detail-block"><small>实际总货款</small><b>${order.entryValues ? fieldText(order, 'amount') : money(order.amount)}</b></div><div class="detail-block"><small>实际到账</small><b>${money(order.received)}</b></div>` : ''}</div>
    <div class="form-section"><h3>订单与收货信息</h3><div class="meta-grid">${isCustomWorkflow(order)?`<span>采购方式 <b>${order.businessSelfProcurement?'标贴由业务自行采购':'美工、采购按岗位处理'}</b></span>`:''}<span>店铺订单号 <b>${esc(order.shopOrderNumber || '未填写')}</b></span><span>订单日期 <b>${esc(order.orderDate || order.created)}</b></span><span>收件人姓名 <b>${esc(order.recipient || '未填写')}</b></span><span>收件人电话 <b>${esc(order.contact || '未填写')}</b></span><span>收件地址 <b>${esc(order.address)}</b></span><span>客户要求物流信息 <b style="white-space:pre-wrap">${esc(order.logisticsRequirements || '未填写')}</b></span><span>物流公司 <b>${esc(order.logistics || '未填写')}</b></span><span>物流单号 <b>${esc(order.trackingNumber || '未填写')}</b></span>${canSeeFinance() ? `<span>代收金额 <b>${order.entryValues ? fieldText(order, 'codAmount') : money(order.codAmount)}</b></span>` : ''}<span>包装要求 <b>${esc(order.pack || '无')}</b></span><span>要求交期 <b>${esc(order.delivery)}</b></span></div></div>
    ${canSeeFinance() ? `<div class="form-section"><h3>金额与核算</h3><div class="meta-grid">${order.pricingVersion===1?`<span>总货款 <b>${money(order.grossAmount)}</b></span><span>优惠金额 <b>${money(order.discountAmount)}</b></span><span>实际总货款 <b>${money(order.amount)}</b></span>`:''}<span>运费 <b>${order.entryValues ? fieldText(order, 'freight') : money(order.freight)}</b></span><span>订单总成本 <b>${order.entryValues ? fieldText(order, 'cost') : money(order.cost)}</b></span><span>毛利 <b>${order.entryValues ? fieldText(order, 'grossProfit') : money(order.grossProfit)}</b></span><span>收款账户 <b>${esc(order.paymentAccount || '未填写')}</b></span><span>业务员 <b>${esc(order.salesperson || order.creatorName)}</b></span></div></div>` : ''}
    ${order.lineItems?.length ? `<div class="form-section"><h3>产品明细</h3><div class="table-wrap"><table><thead><tr><th>产品</th><th>颜色</th><th>规格</th><th>数量</th>${canSeeFinance()?'<th>单价</th><th>金额</th>':''}</tr></thead><tbody>${order.lineItems.map(p=>`<tr><td>${esc(p.product)}</td><td>${esc(p.color)}</td><td>${esc(p.specification)}</td><td>${esc(p.quantity)}${esc(p.unit)}</td>${canSeeFinance()?`<td>${money(p.unitPrice)}</td><td>${money(p.amount)}</td>`:''}</tr>`).join('')}</tbody></table></div></div>`:''}
    ${!order.lineItems?.length && order.productItems?.length ? `<div class="form-section"><h3>产品明细</h3><div class="table-wrap"><table><thead><tr><th>产品编码</th><th>产品名称</th><th>规格／分类</th><th>数量</th><th>箱规</th></tr></thead><tbody>${order.productItems.map(item => `<tr><td>${esc(item.code)}</td><td>${esc(item.name)}</td><td>${esc(item.specification || item.category || '')}</td><td>${item.quantity}${esc(item.unit)}</td><td>${esc(item.casePack ?? '')}</td></tr>`).join('')}</tbody></table></div></div>` : ''}
    ${order.specialNotes || order.notes ? `<div class="note"><b>${['regular','urgent'].includes(order.workflowType) ? '特殊备注' : '订单备注'}：</b>${esc(order.specialNotes || order.notes)}</div>` : ''}
    ${order.images?.length ? `<div class="form-section"><h3>货品图片</h3><div class="order-image-grid">${order.images.map(image => `<figure class="order-image"><a href="${esc(image.url)}" data-preview-image><img src="${esc(image.url)}" alt="${esc(image.name)}" loading="lazy"></a><figcaption>${esc(image.name)}</figcaption></figure>`).join('')}</div></div>` : ''}
    ${order.shipment ? `<div class="form-section"><h3>物流发货信息</h3><div class="meta-grid"><span>物流公司 <b>${esc(order.logistics||'未填写')}</b></span><span>物流单号 <b>${esc(order.trackingNumber||'未填写')}</b></span><span>日期 <b>${esc(order.shipment.date||'未填写')}</b></span><span>姓名 <b>${esc(order.shipment.recipient??order.recipient??'未填写')}</b></span><span>地址 <b>${esc(order.shipment.address??order.address??'未填写')}</b></span><span>件数 <b>${esc(order.shipment.packageCount??'未填写')}</b></span>${canSeeFinance()||state.user.role==='仓库'?`<span>运费 <b>${order.shipment.freight==null?'未填写':money(order.shipment.freight)}</b></span>`:''}</div>${order.shipment.documents?.length?`<h4>快递面单 / 物流单</h4><div class="order-image-grid">${order.shipment.documents.map(d=>`<figure class="order-image"><a href="${esc(d.url)}" data-preview-image><img src="${esc(d.url)}" alt="${esc(d.name)}" loading="lazy"></a><figcaption>${esc(d.name)}</figcaption></figure>`).join('')}</div>`:''}</div>`:''}
    ${order.workflowType === 'foreign' ? `<div class="form-section"><h3>唛头信息</h3><p style="white-space:pre-wrap">${esc(order.shippingMarkDescription || '未填写唛头描述')}</p><div class="order-image-grid">${(order.shippingMarkImages || []).map(image=>`<figure class="order-image"><a href="${esc(image.url)}" data-preview-image><img src="${esc(image.url)}" alt="${esc(image.name)}" loading="lazy"></a><figcaption>${esc(image.name)}</figcaption></figure>`).join('') || '<p class="muted-copy">未上传唛头图片</p>'}</div></div>` : ''}
    ${canSeeFinance()&&order.productSourceImages?.length?`<div class="form-section"><h3>产品识别原图（仅业务与财务可见）</h3><div class="order-image-grid">${order.productSourceImages.map(image=>`<figure class="order-image"><a href="${esc(image.url)}" data-preview-image><img src="${esc(image.url)}" alt="${esc(image.name)}"></a><figcaption>${esc(image.name)}</figcaption></figure>`).join('')}</div></div>`:''}
    ${canSeeFinance() ? `<div class="form-section"><h3>预付款与付款凭证</h3><p>预付款金额：${esc(order.prepaymentAmount ?? '未填写') || '未填写'} · 尾款金额：${finalPaymentText(order)} <small>（业务填写，实际到账以财务核对为准）</small></p>${order.paymentProofs?.length ? `<div class="order-image-grid">${order.paymentProofs.map(image => `<figure class="order-image"><a href="${esc(image.url)}" data-preview-image><img src="${esc(image.url)}" alt="${esc(image.name)}" loading="lazy"></a><figcaption>${esc(image.name)}</figcaption></figure>`).join('')}</div>` : '<p class="muted-copy">未上传付款凭证</p>'}</div>` : ''}
    ${canSeeFinance() && order.changeHistory?.length ? `<div class="form-section"><h3>资料修改记录</h3>${order.changeHistory.map(item=>`<p>${esc(item.operator)} · ${esc(item.createdAt)} · 修改了${item.changes.length}项资料</p>`).join('')}</div>` : ''}
    ${order.handoverHistory?.length?`<div class="form-section"><h3>负责人交接记录</h3>${order.handoverHistory.map(h=>`<p>${esc(h.fromName)} → ${esc(h.toName)} · 办理人 ${esc(h.operator)} · ${esc(new Date(h.createdAt).toLocaleString('zh-CN'))}</p>`).join('')}</div>`:''}
    <div class="form-section"><h3>完整流程</h3><div class="flow-list">${flow}</div></div>
    ${canSeeFinance() ? `<div class="form-section"><h3>资金记录</h3><div class="meta-line"><span>客户应收 <b>${order.entryValues ? fieldText(order, 'amount') : money(order.amount)}</b></span><span>客户实到 <b>${money(order.received)}</b></span><span>工单付款 <b>${money((order.outgoingPayments || []).reduce((sum, item) => sum + item.amount, 0))}</b></span></div></div>` : ''}
    ${canSeeFinance() ? `<div class="form-section"><h3>收付款明细</h3>${[...(order.receipts || []).map(r=>({...r,kind:'客户到账',when:r.date})),...(order.outgoingPayments || []).map(r=>({...r,kind:'工单付款',when:r.createdAt}))].map(r=>`<p>${esc(r.kind)} · ${money(r.amount)} · ${esc(r.when)} · ${esc(r.operator)}${r.note ? ` · ${esc(r.note)}` : ''}</p>`).join('') || '<p class="muted-copy">暂无收付款记录</p>'}</div>` : ''}
    </div><div class="modal-foot">${canAct ? `<button class="primary" id="completeTask">${actionLabel}</button>` : ''}${task && isShipping(task) && state.user.role === '仓库' && canShip(order) ? '<button class="success" id="shipOrder">确认发货</button>' : ''}<button class="ghost" data-close>关闭</button></div>`);
  const complete = $('#completeTask'); if (complete) complete.onclick = () => taskModal(order, task);
  const ship = $('#shipOrder'); if (ship) ship.onclick = () => shippingModal(order.id);
  if (order.sourceOrderId) {
    const note = document.createElement('p'); note.className = 'calculation-note'; note.textContent = '复制自订单：' + order.sourceOrderId;
    $('#modal .modal-head p').append(note);
  }
  if (state.user.role === '业务员') {
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'ghost'; copy.textContent = '复制建单';
    copy.onclick = () => newOrderModal(order); $('#modal .modal-foot').prepend(copy);
    const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'primary'; edit.textContent = '修改工单信息';
    edit.onclick = () => newOrderModal(order,true); $('#modal .modal-foot').prepend(edit);
  }
}
function taskModal(order, task) {
  if ($('#modalBody form')) return toast('请先保存或关闭当前填写窗口，再打开其他工单');
  const outgoing = task.name === '财务确认工单付款';
  const receiptReview = ['财务确认收款','财务审核','财务审核尾款'].includes(task.name);
  const adminReview = requiresAdminApproval(order, task);
  const tailHandoff = isTailPaymentHandoff(order, task);
  const submitLabel = tailHandoff ? '提交财务审核' : adminReview ? '提交审批' : '确认完成';
  modal(`<div class="modal-head"><div><h2>${submitLabel} · 第 ${flowStepNumber(order,task)} 步</h2><p>${esc(task.name)}</p></div><button class="close" data-close>×</button></div><form id="taskForm"><div class="modal-body"><div class="note">${receiptReview ? '请核对工单后确认。实际到账不设最低金额限制，确认流程不会自动增加到账金额或标记全额收款。' : tailHandoff ? '确认催收尾款及发货安排后，提交财务审核尾款。工单将直接进入财务待办。' : adminReview ? '确认当前岗位工作已完成，并提交主账号审批？' : '确认当前岗位工作已完成，并提交下一环节？'}</div>${outgoing ? '<div class="field"><label>本次工单付款金额 <em>*</em></label><input name="outgoingAmount" type="number" min="0.01" step="0.01" required></div>' : ''}<div class="field task-note"><label>处理说明${adminReview ? ' / 审批说明' : ''}</label><textarea name="note" placeholder="填写处理结果、确认内容或凭证说明"></textarea></div>${adminReview ? '<div class="note">提交后状态不会立即完成，需超级管理员批准。</div>' : ''}</div><div class="modal-foot"><button type="button" class="ghost" data-close>取消</button><button class="primary">${submitLabel}</button></div></form>`, true);
  $('#taskForm').onsubmit = async event => {
    event.preventDefault(); const button = event.submitter; button.disabled = true;
    try { await api(`/api/orders/${order.id}/task`, { method: 'POST', body: JSON.stringify({ step: task.step, ...Object.fromEntries(new FormData(event.target)) }) }); await refreshOrders(); closeModal(); render(); toast(tailHandoff ? '已提交财务审核尾款' : adminReview ? '已提交审批' : '当前工单步骤已确认完成'); }
    catch (error) { toast(error.message); button.disabled = false; }
  };
}
function receiptModal(id) {
  if ($('#modalBody form')) return toast('请先保存或关闭当前填写窗口，再打开其他工单');
  const order = state.orders.find(item => item.id === id);
  const outstanding = Math.max(0,Math.round((order.amount-order.received)*100)/100);
  const requestId = createRequestId();
  modal(`<div class="modal-head"><div><h2>登记客户实际到账</h2><p>${order.id} · 尚未到账 ${money(outstanding)}</p></div><button class="close" data-close>×</button></div><form id="receiptForm"><div class="modal-body"><div class="form-grid"><div class="field"><label>本次到账金额 <em>*</em></label><input name="amount" type="number" min="0.01" max="${outstanding}" step="0.01" required></div><div class="field"><label>到账日期 <em>*</em></label><input name="date" type="date" value="${date()}" required></div><div class="field full"><label>银行流水 / 备注</label><textarea name="note"></textarea></div></div></div><div class="modal-foot"><button type="button" class="ghost" data-close>取消</button><button class="primary">确认到账</button></div></form>`, true);
  $('#receiptForm').onsubmit = async event => {
    event.preventDefault(); const data = {...Object.fromEntries(new FormData(event.target)),requestId}; const button=event.submitter; button.disabled=true;
    try { await api(`/api/orders/${order.id}/receipt`, { method: 'POST', body: JSON.stringify(data) }); await refreshOrders(); closeModal(); render(); toast(`已登记到账 ${money(data.amount)}`); }
    catch (error) { toast(error.message); button.disabled=false; }
  };
}
async function reviewTask(id, step, action) {
  const reason = action === 'reject' ? prompt('请输入驳回原因：', '请核实流程完成情况后重新提交') : '';
  if (action === 'reject' && reason === null) return;
  try { await api(`/api/orders/${id}/task-approval`, { method: 'POST', body: JSON.stringify({ step, action, reason }) }); await refreshOrders(); render(); toast(action === 'approve' ? '状态修改已批准' : '状态修改已驳回'); }
  catch (error) { toast(error.message); }
}
function trackingModal(id) {
  if ($('#modalBody form')) return toast('请先保存或关闭当前填写窗口，再打开其他工单');
  const order=state.orders.find(o=>o.id===id);
  if(state.user.role!=='仓库'||!order?.shipment)return;
  const shipment=order.shipment;
  let documents=(shipment.documents||[]).map(d=>({sourceImageId:d.id,name:d.name,url:d.url})),ocrBusy=false,uploadBusy=false;
  modal(`<div class="modal-head"><div><h2>上传快递面单 / 修改物流信息</h2><p>${esc(order.id)} · ${esc(order.customer)}</p></div><button class="close" data-close>×</button></div><form id="trackingForm"><div class="modal-body">${order.logisticsRequirements?`<div class="note" style="white-space:pre-wrap"><b>客户要求物流信息：</b>${esc(order.logisticsRequirements)}</div>`:''}<details class="form-section" ${documents.length?'':'open'}><summary>上传快递面单，识别物流公司和单号</summary><div class="field task-note"><label for="shippingDocInput">快递面单 / 快递物流单</label><div id="shippingDocDrop" class="image-drop-zone"><p>拖拽图片到这里，或点击选择图片，上传后自动识别</p><input id="shippingDocInput" type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple></div><small class="calculation-note">最多2张，每张不超过5MB。识别结果请核对后保存，未识别的内容可手动填写。</small><div id="shippingDocPreview" class="order-image-grid"></div><button type="button" class="ghost" id="retryShippingOcr">重新识别图片</button><p id="shippingOcrStatus" role="status" aria-live="polite" class="calculation-note"></p><details id="shippingOcrDetails" class="hidden"><summary>查看识别原文</summary><pre id="shippingOcrText" style="white-space:pre-wrap"></pre></details></div></details><div>
    <div class="field"><label for="updateLogistics">物流公司</label><input id="updateLogistics" name="logistics" maxlength="200" value="${esc(order.logistics||'')}" placeholder="例如：顺丰、中通、德邦"></div>
    <div class="field task-note"><label for="updateTracking">物流单号</label><input id="updateTracking" name="trackingNumber" maxlength="200" required value="${esc(order.trackingNumber||'')}" placeholder="请输入物流单号"></div>
    </div><div class="note">保存后自动同步至业务订单详情，保留原发货日期和流程进度。</div></div><div class="modal-foot"><button type="button" class="ghost" data-close>取消</button><button class="primary">保存物流信息</button></div></form>`,true);
  const ocrFields=['logistics','trackingNumber'],lastOcrValues={};
  const renderDocuments=()=>{
    $('#shippingDocPreview').innerHTML=documents.map((d,i)=>`<figure class="order-image"><a href="${esc(d.dataUrl||d.url)}" data-preview-image><img src="${esc(d.dataUrl||d.url)}" alt="${esc(d.name)}"></a><figcaption>${esc(d.name)}</figcaption><button class="image-remove" type="button" data-remove-shipping-doc="${i}" aria-label="移除面单图片${i+1}">×</button></figure>`).join('');
    document.querySelectorAll('[data-remove-shipping-doc]').forEach(button=>button.onclick=()=>{if(ocrBusy)return;documents.splice(Number(button.dataset.removeShippingDoc),1);
      for(const key of ocrFields){const input=$('#trackingForm').elements.namedItem(key);if(input.value===lastOcrValues[key])input.value='';delete lastOcrValues[key];}
      $('#shippingOcrStatus').textContent='已移除图片，请重新核对物流信息';$('#shippingOcrDetails').classList.add('hidden');$('#shippingOcrText').textContent='';
      renderDocuments();if(documents.length)void recognizeDocuments();});
    $('#retryShippingOcr').disabled=ocrBusy||!documents.length;
  };
  const recognizeDocuments=async()=>{
    if(ocrBusy||!documents.length)return;
    ocrBusy=true;$('#shippingDocInput').disabled=true;$('#retryShippingOcr').disabled=true;$('#trackingForm button.primary').disabled=true;
    const form=$('#trackingForm'),before=Object.fromEntries(ocrFields.map(key=>[key,form.elements.namedItem(key).value]));
    $('#shippingOcrStatus').textContent='正在识别面单，请稍候……';
    try{
      const images=await Promise.all(documents.map(async d=>{if(d.dataUrl)return d;const response=await fetch(d.url);if(!response.ok)throw Error('图片读取失败');const blob=await response.blob();return await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({name:d.name,dataUrl:r.result});r.onerror=()=>reject(Error('图片读取失败'));r.readAsDataURL(blob);});}));
      const result=await api(`/api/orders/${order.id}/shipping-ocr`,{method:'POST',body:JSON.stringify({images})});
      if(!document.body.contains(form))return;
      for(const key of ocrFields){
        const input=form.elements.namedItem(key);
        if(input.value!==before[key])continue;
        if(result.fields?.[key]!=null){input.value=String(result.fields[key]);lastOcrValues[key]=input.value;}
        else if(lastOcrValues[key]!=null&&input.value===lastOcrValues[key]){input.value='';delete lastOcrValues[key];}
      }
      $('#shippingOcrStatus').textContent=ocrFields.map(key=>{
        const label=key==='logistics'?'物流公司':'物流单号',value=result.fields?.[key];
        if(result.status?.[key]==='conflict')return `${label}：存在不同结果（${(result.candidates?.[key]||[]).join('、')}），请核对图片并手动填写`;
        if(value!=null)return `${label}：${value}${form.elements.namedItem(key).value===String(value)?'，已回填':'，保留您刚填写的内容'}`;
        return `${label}：未识别，请手动填写`;
      }).join('；')+'。请核对后保存。';
      $('#shippingOcrText').textContent=result.text||'未识别到文字';$('#shippingOcrDetails').classList.remove('hidden');
    }catch(error){if(document.body.contains(form))$('#shippingOcrStatus').textContent=error.message+'；图片已保留，可手动填写后保存。';}
    finally{ocrBusy=false;if(document.body.contains(form)){$('#shippingDocInput').disabled=false;$('#trackingForm button.primary').disabled=false;renderDocuments();}}
  };
  const addDocuments=async files=>{
    if(ocrBusy||uploadBusy)return;
    const list=Array.from(files);if(!list.length)return;
    if(documents.length+list.length>2)return toast('最多上传2张，请先移除多余图片');
    if(list.some(f=>!['image/jpeg','image/png','image/webp','image/gif'].includes(f.type)||f.size>5*1024*1024))return toast('请上传JPG、PNG、WebP或GIF图片，每张不超过5MB');
    uploadBusy=true;
    try{const incoming=await Promise.all(list.map(file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:file.name,dataUrl:reader.result});reader.onerror=()=>reject(Error('图片读取失败'));reader.readAsDataURL(file);})));if(!$('#trackingForm'))return;documents.push(...incoming);renderDocuments();await recognizeDocuments();}catch(error){toast(error.message);}finally{uploadBusy=false;}
  };
  $('#shippingDocInput').onchange=event=>{void addDocuments(event.target.files);event.target.value='';};
  const docZone=$('#shippingDocDrop');docZone.ondragover=event=>{event.preventDefault();docZone.classList.add('dragover');};docZone.ondragleave=()=>docZone.classList.remove('dragover');docZone.ondrop=event=>{event.preventDefault();docZone.classList.remove('dragover');void addDocuments(event.dataTransfer.files);};
  $('#retryShippingOcr').onclick=()=>void recognizeDocuments();renderDocuments();
  $('#trackingForm').onsubmit=async event=>{
    event.preventDefault();if(ocrBusy||uploadBusy)return toast('正在读取或识别图片，请稍候');const button=event.submitter;button.disabled=true;
    try{await api(`/api/orders/${order.id}/tracking`,{method:'POST',body:JSON.stringify({...Object.fromEntries(new FormData(event.target)),documents,infoRevision:order.infoRevision||0})});await refreshOrders();closeModal();render();toast('物流信息已保存并同步至业务订单');}
    catch(error){toast(error.message);button.disabled=false;}
  };
}
function shippingModal(id) {
  if ($('#modalBody form')) return toast('请先保存或关闭当前填写窗口，再打开其他工单');
  const order = state.orders.find(item => item.id === id); if (!canShip(order)) return toast('当前订单尚未满足发货条件');
  modal(`<div class="modal-head"><div><h2>确认发货</h2><p>${order.id} · ${esc(order.customer)}</p></div><button class="close" data-close>×</button></div><form id="shipForm"><div class="modal-body">${order.logisticsRequirements?`<div class="note" style="white-space:pre-wrap"><b>客户要求物流信息：</b>${esc(order.logisticsRequirements)}</div>`:''}<div class="form-grid"><div class="field"><label>发货日期</label><input name="date" type="date" value="${date()}" required></div><div class="field"><label>发货方式</label><select name="method"><option>物流</option><option>客户自提</option></select></div><div class="field"><label for="shipLogistics">物流公司</label><input id="shipLogistics" name="logistics" maxlength="200" value="${esc(order.logistics || '')}" placeholder="例如：顺丰、中通、德邦"></div><div class="field"><label for="shipTracking">物流单号</label><input id="shipTracking" name="trackingNumber" maxlength="200" value="${esc(order.trackingNumber || '')}" placeholder="填写后自动同步至业务订单页面"></div><div class="field full"><label for="shipNote">发货备注</label><textarea id="shipNote" name="note"></textarea></div></div><div class="note">物流公司与物流单号在确认发货后自动同步到业务订单详情。提交时服务器会再次检查前序流程和财务节点。</div></div><div class="modal-foot"><button type="button" class="ghost" data-close>取消</button><button class="success">确认发货</button></div></form>`, true);
  $('#shipForm').onsubmit = async event => {
    event.preventDefault(); const button=event.submitter; button.disabled=true;
    try { await api(`/api/orders/${order.id}/ship`, { method: 'POST', body: JSON.stringify(Object.fromEntries(new FormData(event.target))) }); await refreshOrders(); closeModal(); render(); toast(`订单 ${order.id} 已发货`); }
    catch (error) { toast(error.message); button.disabled=false; }
  };
}
async function login(event) {
  event.preventDefault(); const button = event.submitter, body = Object.fromEntries(new FormData(event.target)); button.disabled = true; $('#loginError').textContent = '';
  try { const data = await api('/api/login', { method: 'POST', body: JSON.stringify(body) }); state.user = data.user; if(state.user.mustChangePassword){showInitialPasswordForm();return;} await refreshOrders(); $('#loginScreen').classList.add('hidden'); $('#appShell').classList.remove('hidden'); render(); void workNoticeUI.start(state.user); }
  catch (error) { $('#loginError').textContent = error.message; button.disabled = false; }
}
function clearPrivateView() {
  workNoticeUI.stop();
  closeModal();
  for (const selector of ['#content','#nav','#currentUser']) $(selector).replaceChildren();
  document.querySelectorAll('.image-viewer').forEach(viewer=>viewer.remove());
  state.query=''; state.filter='all'; state.dateFrom=''; state.dateTo=''; state.route='dashboard';
}
async function logout() { await api('/api/logout', { method: 'POST', body: '{}' }); state.user = null; state.orders = []; state.employees=[];state.handovers=[];state.employeeQuery=''; state.notifications=[];state.unreadNotifications=0; selectedOrderIds.clear(); state.dateFrom=''; state.dateTo=''; clearPrivateView(); $('#appShell').classList.add('hidden'); $('#loginScreen').classList.remove('hidden'); $('#loginForm').reset(); $('#loginForm button').disabled = false; }
async function boot() { try { const data = await api('/api/me'); state.user = data.user; if(state.user.mustChangePassword){showInitialPasswordForm();return;} await refreshOrders(); $('#appShell').classList.remove('hidden'); render(); void workNoticeUI.start(state.user); } catch { $('#loginScreen').classList.remove('hidden'); } }

$('#loginForm').onsubmit = login;
$('#logoutBtn').onclick = logout;
$('#newOrderBtn').onclick = () => newOrderModal();
// Clicking the dimmed area must never discard an open form.
$('#modal').onclick = event => { if (event.target === $('#modal')) event.stopPropagation(); };
document.addEventListener('keydown',event=>{
  if(event.key!=='Tab'||$('#modal').classList.contains('hidden')||$('.image-viewer'))return;
  const root=$('#discardOrderPrompt')||$('#modalBody');
  const controls=Array.from(root.querySelectorAll('button,input,select,textarea,a[href],summary')).filter(el=>!el.disabled&&el.tabIndex>=0&&el.getClientRects().length);
  if(!controls.length)return;
  const first=controls[0],last=controls.at(-1);
  if(!root.contains(document.activeElement)){event.preventDefault();first.focus();}
  else if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
  else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
});
window.addEventListener('beforeunload',event=>{if(modalIsDirty?.()){event.preventDefault();event.returnValue='';}});
document.addEventListener('click', event => {
  const link = event.target.closest('[data-preview-image]');
  if (!link) return;
  event.preventDefault();
  const viewer = document.createElement('div');
  viewer.className = 'image-viewer';
  viewer.innerHTML = `<button type="button" aria-label="关闭图片">×</button><img src="${esc(link.getAttribute('href'))}" alt="货品图片预览">`;
  const close = () => { viewer.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = event => { if (event.key === 'Escape') close(); };
  viewer.onclick = event => { if (event.target === viewer || event.target.closest('button')) close(); };
  document.addEventListener('keydown', onKey);
  document.body.appendChild(viewer); viewer.querySelector('button').focus();
});
boot();
// Never rebuild controls while a user is editing, selecting or filling a dialog.
function canRefreshWorkspace() {
  return $('#modal').classList.contains('hidden') && !document.activeElement?.closest('#content input,#content textarea,#content select,#nav button') && !window.getSelection()?.toString();
}
let refreshingWorkspace = false;
setInterval(async () => {
  if (!state.user || state.user.mustChangePassword || refreshingWorkspace || !canRefreshWorkspace() || document.visibilityState !== 'visible') return;
  const userId = state.user.id;
  refreshingWorkspace = true;
  try { await refreshOrders(); if (state.user?.id === userId && canRefreshWorkspace()) render(); } catch { /* Retry at the next interval. */ }
  finally { refreshingWorkspace = false; }
}, 15000);

function showInitialPasswordForm(){
 $('#loginScreen').classList.add('hidden');$('#appShell').classList.add('hidden');
 modal(`<div class="modal-head"><h2>首次登录：修改初始密码</h2></div><form id="initialPasswordForm"><div class="modal-body"><p>请设置您自己的新密码，完成后重新登录。</p><div class="field"><label for="oldPassword">初始密码</label><input id="oldPassword" name="currentPassword" type="password" autocomplete="current-password" required></div><div class="field"><label for="newPassword">新密码（至少8位）</label><input id="newPassword" name="newPassword" type="password" minlength="8" maxlength="128" autocomplete="new-password" required></div><div class="field"><label for="confirmPassword">确认新密码</label><input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required></div><p id="passwordError" role="status"></p></div><div class="modal-foot"><button class="primary">保存新密码并重新登录</button></div></form>`,true);
 $('#initialPasswordForm').onsubmit=async event=>{
 event.preventDefault();const data=Object.fromEntries(new FormData(event.target));if(data.newPassword!==data.confirmPassword){$('#passwordError').textContent='两次新密码不一致';return;}
 const button=event.submitter;button.disabled=true;
 try{await api('/api/change-password',{method:'POST',body:JSON.stringify(data)});state.user=null;closeModal();$('#loginScreen').classList.remove('hidden');$('#loginForm button').disabled=false;$('#loginForm').reset();$('#loginError').textContent='密码已修改，请使用新密码登录';}
 catch(error){$('#passwordError').textContent=error.message;button.disabled=false;}
 };
}
