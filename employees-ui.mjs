export function employeeViews({state,api,modal,closeModal,refreshOrders,render,toast,esc}) {
  const $=selector=>document.querySelector(selector);
  const stamp=value=>new Date(value).toLocaleString('zh-CN',{hour12:false});
  function renderEmployees() {
    const query=(state.employeeQuery||'').trim().toLowerCase();
    const list=state.employees.filter(e=>`${e.name} ${e.phone} ${e.username} ${e.role}`.toLowerCase().includes(query));
    return `<div class="page-head"><div><h2>员工与权限</h2><p>统一管理员工账号，交接历史订单与进行中的工作</p></div><button class="primary" id="addEmployee">＋ 新增员工</button></div>
      <div class="kpis employee-kpis"><div class="card kpi"><div class="kpi-head">员工账号</div><b>${state.employees.length}</b><small>包含主账号</small></div><div class="card kpi"><div class="kpi-head">启用中</div><b>${state.employees.filter(e=>e.active).length}</b><small>可正常登录</small></div><div class="card kpi"><div class="kpi-head">已停用</div><b>${state.employees.filter(e=>!e.active).length}</b><small>历史资料继续保留</small></div><div class="card kpi"><div class="kpi-head">交接记录</div><b>${state.handovers.length}</b><small>最近100次交接</small></div></div>
      <section class="panel employee-panel"><div class="panel-head"><div><h3>员工账号</h3><p>手机号＋密码登录；现有账号继续可用</p></div><div class="search"><label class="sr-only" for="employeeSearch">搜索员工</label><input id="employeeSearch" placeholder="搜索姓名、手机号或岗位" value="${esc(state.employeeQuery||'')}"></div></div><div class="table-wrap"><table><thead><tr><th>员工</th><th>登录手机号／账号</th><th>岗位</th><th>状态</th><th>负责订单</th><th>操作</th></tr></thead><tbody>${list.map(e=>`<tr><td><div class="employee-name"><span>${esc(e.name.slice(0,1))}</span><b>${esc(e.name)}</b></div></td><td>${esc(e.phone||e.username)}${e.phone?`<small class="employee-login-note">原账号：${esc(e.username)}</small>`:''}</td><td>${esc(e.role)}</td><td><span class="status ${e.active?'green':'red'}">${e.active?'启用':'停用'}</span></td><td><b>${e.orderCount}</b> 单<small class="employee-login-note">进行中 ${e.activeOrderCount} 单</small></td><td><div class="employee-actions"><button class="link-btn edit-employee" data-id="${e.id}">编辑信息／岗位</button>${e.id!==state.user.id?`<button class="link-btn toggle-employee" data-id="${e.id}">${e.active?'停用':'启用'}</button>`:''}${e.role!=='超级管理员'?`<button class="link-btn handover-employee" data-id="${e.id}">离职交接</button>`:''}</div></td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel employee-history"><div class="panel-head"><div><h3>交接记录</h3><p>原创建人及历史经办记录保留，当前负责人随交接调整</p></div></div>${state.handovers.length?`<div class="table-wrap"><table><thead><tr><th>时间</th><th>离职员工</th><th>接替员工</th><th>岗位</th><th>交接订单</th><th>办理人</th><th>备注</th></tr></thead><tbody>${state.handovers.map(h=>`<tr><td>${esc(stamp(h.created_at))}</td><td>${esc(h.from_name)}</td><td>${esc(h.to_name)}</td><td>${esc(h.role)}</td><td>${h.orderCount} 单</td><td>${esc(h.actor)}</td><td>${esc(h.note||'—')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty"><b>暂无交接记录</b>完成离职交接后，会自动留存记录</div>'}</section>`;
  }
  function employeeModal(employee=null) {
    const editing=!!employee,self=employee?.id===state.user.id;
    const roles=employee?.role==='超级管理员'?['超级管理员']:[...new Set([...(employee?[employee.role]:[]),...state.employeeRoles])];
    modal(`<div class="modal-head"><div><h2>${editing?'编辑员工信息':'新增员工'}</h2><p>${editing?'更换手机号后，该员工需重新登录，订单与历史记录保留':'填写员工资料，设置登录手机号和岗位'}</p></div><button class="close" data-close>×</button></div><form id="employeeForm"><div class="modal-body"><div class="form-grid"><div class="field"><label for="employeeName">员工姓名</label><input id="employeeName" name="name" maxlength="40" value="${esc(employee?.name||'')}" required></div><div class="field"><label for="employeePhone">登录手机号</label><input id="employeePhone" name="phone" type="tel" inputmode="numeric" pattern="1[3-9][0-9]{9}" maxlength="11" value="${esc(employee?.phone||'')}" ${editing?'':'required'} placeholder="11位手机号"></div><div class="field full"><label for="employeeRole">岗位</label><select id="employeeRole" name="role" ${self?'disabled':''}>${roles.map(role=>`<option value="${esc(role)}" ${employee?.role===role?'selected':''}>${esc(role)}</option>`).join('')}</select></div>${editing?'':`<div class="field full"><label for="employeePassword">初始登录密码</label><input id="employeePassword" name="password" type="password" minlength="8" maxlength="128" autocomplete="new-password" placeholder="至少8位，请交给员工本人" required></div>`}</div><p id="employeeFormError" class="login-error" role="alert"></p></div><div class="modal-foot"><button type="button" class="ghost" data-close>取消</button><button class="primary">${editing?'保存修改':'创建员工账号'}</button></div></form>`,true);
    $('#employeeForm').onsubmit=async event=>{
      event.preventDefault();const button=event.submitter;button.disabled=true;
      try {
        await api(editing?`/api/employees/${employee.id}`:'/api/employees',{method:editing?'PUT':'POST',body:JSON.stringify(Object.fromEntries(new FormData(event.target)))});
        if(self){location.reload();return;}
        await refreshOrders();closeModal();render();toast(editing?'员工信息已更新，请员工重新登录':'员工账号已创建，可用手机号和密码登录');
      }catch(error){$('#employeeFormError').textContent=error.message;button.disabled=false;}
    };
  }
  function toggleEmployee(employee) {
    modal(`<div class="modal-head"><div><h2>${employee.active?'停用':'启用'}员工账号</h2><p>${esc(employee.name)} · ${esc(employee.role)}</p></div><button class="close" data-close>×</button></div><div class="modal-body"><p>${employee.active?'停用后将禁止该员工登录，并退出已登录设备。订单和历史记录继续保留。':'启用后，该员工可继续使用原账号或手机号及密码登录。'}</p>${employee.active&&employee.orderCount?`<div class="note">该员工仍负责${employee.orderCount}张订单；需要接替工作时，可使用“离职交接”。</div>`:''}<p id="employeeToggleError" class="login-error" role="alert"></p></div><div class="modal-foot"><button class="ghost" data-close>取消</button><button class="${employee.active?'danger':'primary'}" id="confirmEmployeeToggle">确认${employee.active?'停用':'启用'}</button></div>`,true);
    $('#confirmEmployeeToggle').onclick=async event=>{
      event.currentTarget.disabled=true;
      try{await api(`/api/employees/${employee.id}`,{method:'PUT',body:JSON.stringify({active:!employee.active})});await refreshOrders();closeModal();render();toast('账号状态已更新');}
      catch(error){$('#employeeToggleError').textContent=error.message;event.target.disabled=false;}
    };
  }
  function handoverModal(employee) {
    const candidates=state.employees.filter(e=>e.id!==employee.id&&e.active&&e.role===employee.role);
    let preview=null;
    modal(`<div class="modal-head"><div><h2>离职交接</h2><p>选择接替人，核对交接范围后确认</p></div><button class="close" data-close>×</button></div><form id="handoverForm"><div class="modal-body"><div class="handover-source"><small>离职员工</small><b>${esc(employee.name)} <span>${esc(employee.role)}</span></b></div><div class="field"><label for="handoverTo">接替员工</label><select id="handoverTo" name="toEmployeeId" required><option value="">请选择相同岗位的在职员工</option>${candidates.map(e=>`<option value="${e.id}">${esc(e.name)} · ${esc(e.phone||e.username)}</option>`).join('')}</select>${!candidates.length?'<small class="calculation-note">请先新增或启用一位相同岗位的接替员工。</small>':''}</div><div class="field task-note"><label for="handoverNote">交接备注</label><textarea id="handoverNote" name="note" maxlength="500" placeholder="可填写交接说明"></textarea></div><div id="handoverPreview"></div><p id="handoverError" class="login-error" role="alert"></p></div><div class="modal-foot"><button type="button" class="ghost" data-close>取消</button><button class="primary" ${candidates.length?'':'disabled'}>预览交接内容</button></div></form>`);
    const button=$('#handoverForm button.primary');
    $('#handoverTo').onchange=()=>{preview=null;$('#handoverPreview').innerHTML='';$('#handoverError').textContent='';button.textContent='预览交接内容';button.disabled=!$('#handoverTo').value;};
    $('#handoverForm').onsubmit=async event=>{
      event.preventDefault();button.disabled=true;$('#handoverError').textContent='';
      const body=Object.fromEntries(new FormData(event.target));
      try {
        if(!preview) {
          preview=await api(`/api/employees/${employee.id}/handover-preview?to=${encodeURIComponent(body.toEmployeeId)}`);
          $('#handoverPreview').innerHTML=`<div class="handover-summary"><div><small>全部历史与当前订单</small><b>${preview.total}</b></div><div><small>进行中订单</small><b>${preview.inProgress}</b></div><div><small>待处理／待审批任务</small><b>${preview.pendingTasks}</b></div></div><div class="note">${employee.role==='业务员'?'客户、店铺和收件资料随订单交接。接替人可查看历史、继续处理、修改和复制订单。':'岗位待办仍按岗位共享，由在职的同岗位员工继续处理。'}原创建人、历史经办记录和收付款记录保留。确认后旧账号立即停用。</div>${preview.orders.length?`<div class="handover-order-list"><table><thead><tr><th>订单</th><th>店铺</th><th>状态</th></tr></thead><tbody>${preview.orders.map(o=>`<tr><td>${esc(o.id)}</td><td>${esc(o.storeName)}</td><td>${esc(o.status)}</td></tr>`).join('')}</tbody></table></div>`:''}<label class="handover-check"><input type="checkbox" required>我已核对接替员工与交接范围</label>`;
          button.textContent='确认交接并停用旧账号';button.disabled=true;
          $('#handoverPreview input[type="checkbox"]').onchange=event=>{button.disabled=!event.target.checked;};return;
        }
        const result=await api(`/api/employees/${employee.id}/handover`,{method:'POST',body:JSON.stringify({...body,previewToken:preview.previewToken})});
        await refreshOrders();closeModal();render();toast(`已交接${result.handover.orderCount}张订单，旧账号已停用`);
      }catch(error){$('#handoverError').textContent=error.message;preview=null;$('#handoverPreview').innerHTML='';button.textContent='重新预览交接内容';button.disabled=false;}
    };
  }
  function bindEmployees() {
    if(state.route!=='employees')return;
    $('#addEmployee').onclick=()=>employeeModal();
    $('#employeeSearch').oninput=event=>{const cursor=event.target.selectionStart;state.employeeQuery=event.target.value;render();$('#employeeSearch').focus();$('#employeeSearch').setSelectionRange(cursor,cursor);};
    for(const [selector,action] of [['.edit-employee',employeeModal],['.toggle-employee',toggleEmployee],['.handover-employee',handoverModal]])document.querySelectorAll(selector).forEach(button=>button.onclick=()=>action(state.employees.find(e=>e.id===Number(button.dataset.id))));
  }
  return {renderEmployees,bindEmployees};
}
