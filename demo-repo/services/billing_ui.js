export function formatInvoiceCsv(rows) {
  const headers = ["Invoice ID", "Date", "Customer", "Amount", "Status"];
  const body = rows.map((row) =>
    [row.id, row.date, row.customer, row.amount, row.status].join(",")
  );
  return [headers.join(","), ...body].join("\n");
}

export function formatCurrencyLabel(amount, currency = "USD") {
  return `${currency.toUpperCase()} ${Number(amount).toFixed(2)}`;
}
