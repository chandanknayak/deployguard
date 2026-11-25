import { computeBackoff } from "./payment_service.js";
import { placeOrder } from "./order_service.js";

export const ROUTE_RUN_RENEWAL = "POST /api/v1/subscriptions/renew";

export async function runRenewalBatch(subscriptions, sessionToken) {
  const results = [];
  for (const sub of subscriptions) {
    const order = await placeOrder(
      {
        orderId: `sub-renewal-${sub.id}-${sub.cycle}`,
        totalAmount: sub.planAmount,
        currency: sub.currency,
      },
      sub.paymentMethod,
      sessionToken
    );
    results.push({ subscriptionId: sub.id, status: order.paymentStatus });
  }
  return results;
}

export async function retryFailedInvoice(invoice, sessionToken) {
  const waitMs = computeBackoff(invoice.attempt, 300, 0.3);
  const order = await placeOrder(invoice.cart, invoice.paymentMethod, sessionToken);
  return { invoiceId: invoice.id, waitMs, order };
}
