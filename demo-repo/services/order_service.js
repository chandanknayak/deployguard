import { chargeCard, refundTransaction } from "./payment_service.js";
import { evaluateFraudRisk } from "./fraud_detection.js";

export const ROUTE_PLACE_ORDER = "POST /api/v1/orders";

export async function placeOrder(cart, paymentMethod, sessionToken) {
  const fraud = await evaluateFraudRisk(cart, sessionToken);
  if (fraud.blocked) {
    return { status: "REJECTED_FRAUD", score: fraud.score };
  }
  const receipt = await chargeCard(
    cart.totalAmount,
    cart.currency,
    `order-${cart.orderId}`,
    { maxAttempts: 3 }
  );
  return {
    orderId: cart.orderId,
    paymentStatus: receipt.status,
    chargedAmount: receipt.amount,
  };
}

export async function cancelOrder(orderId, txId) {
  const refund = await refundTransaction(txId, `order-cancel:${orderId}`);
  return {
    orderId,
    refundStatus: refund.status,
  };
}
