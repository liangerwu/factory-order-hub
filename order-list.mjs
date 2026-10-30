export function validOrderDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(value + 'T00:00:00Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10) === value;
}
export function filterOrders(orders, {query='',type='all',from='',to=''} = {}) {
  const text = query.trim().toLowerCase();
  return orders.filter(order => {
    const day = String(order.orderDate || order.created || '').slice(0,10);
    return (type === 'all' || order.workflowType === type) && (!from || day >= from) && (!to || day <= to) &&
      (!text || `${order.id} ${order.shopOrderNumber || ''} ${order.storeName || order.customer || ''} ${order.recipient || ''} ${order.product} ${order.creatorName} ${order.ownerName || ''}`.toLowerCase().includes(text));
  });
}
