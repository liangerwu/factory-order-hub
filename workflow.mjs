export const isCustomWorkflow = value => ['custom', 'foreign'].includes(typeof value === 'string' ? value : value?.workflowType);
// Keep surviving task IDs stable so historical payments and reminders retain their meaning.
export const dependencies = { 1: [], 2: [1], 3: [2], 4: [3], 7: [4], 8: [7], 9: [8], 10: [9], 11: [10], 12: [11], 13: [12] };
export const customDisplayOrder = [1,2,3,4,7,8,9,10,11,12,13];
export const isDone = (order, step) => order.flowTasks.some(task => task.step === step && task.status === '已完成');
export function ready(order, task) {
  if (!isCustomWorkflow(order)) return order.flowTasks.filter(item => item.step < task.step).every(item => item.status === '已完成');
  return !!dependencies[task.step] && dependencies[task.step].every(step => isDone(order, step));
}
export function activeTasks(order) { return order.flowTasks.filter(task => ['待处理','待管理员审批'].includes(task.status)); }
export const isTailPaymentHandoff = (order, task) => isCustomWorkflow(order) && task?.step === 9;
export const isAfterSalesTask = (order, task) => isCustomWorkflow(order) ? [12,13].includes(task?.step) : order.workflowType === 'regular' && task?.step === 5;
export const isBusinessProcurementTask = (order, task) => isCustomWorkflow(order) && order.businessSelfProcurement === true && task?.step === 3;
export const procurementModeLocked = order => (order?.flowTasks || []).some(task => [3,4].includes(task.step) && ['已完成','待管理员审批'].includes(task.status));
export function applyProcurementMode(order) {
  if(!isCustomWorkflow(order))return;
  for(const task of order.flowTasks){
    if(task.step===3){task.name=order.businessSelfProcurement?'标贴采购（业务自行采购）':'产品包装设计';task.ownerRole=order.businessSelfProcurement?'业务员':'美工';}
  }
}
export const requiresAdminApproval = (order, task) => task?.ownerRole === '业务员' && task.step > 1 && !isBusinessProcurementTask(order, task) && !isTailPaymentHandoff(order, task) && !isAfterSalesTask(order, task);
export function shippingChecks(order) {
  const ship = order.flowTasks.find(task => task.ownerRole === '仓库' && (task.name.includes('出货') || task.name.includes('发货')));
  const before = order.flowTasks.filter(task => task.step < (ship?.step || 999)).map(task => task.step);
  return [['前序流程完成', before.every(step => isDone(order,step))], ['财务节点完成', isDone(order,isCustomWorkflow(order) ? 10 : 2)], ['已到发货节点', !!ship && ship.status === '待处理' && ready(order,ship)]];
}

export function flowStepNumber(order,task){const index=(order.flowTasks||[]).findIndex(t=>t.step===task.step);return index<0?task.step:index+1;}
export function removePackagingSteps(order){
 if(!isCustomWorkflow(order)||order.flowVersion===4)return false;
 const removed=order.flowTasks.filter(t=>!customDisplayOrder.includes(t.step));
 order.archivedFlowTasks=[...(order.archivedFlowTasks||[]),...removed.map(t=>({...t,archiveReason:[5,6].includes(t.step)?'取消包材采购及付款环节':'历史流程调整'}))];
 order.flowTasks=order.flowTasks.filter(t=>customDisplayOrder.includes(t.step)).sort((a,b)=>customDisplayOrder.indexOf(a.step)-customDisplayOrder.indexOf(b.step));
 order.flowVersion=4;return removed.length>0;
}
