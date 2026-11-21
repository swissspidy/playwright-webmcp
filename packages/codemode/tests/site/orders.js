// A long, deterministic order history: a tool result too large to be worth reading in full.
// Plain module without DOM access, so the benchmark can compute expected answers from it.
import { products } from "./catalog.js";

export function orderHistory() {
  let seed = 42;
  const rand = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return Math.floor(seed / 65536) % n;
  };
  const statuses = ["delivered", "delivered", "delivered", "returned", "canceled"];
  const orders = [];
  for (let i = 0; i < 200; i++) {
    const month = 1 + (i % 24);
    const year = month > 12 ? 2026 : 2025;
    const date = `${year}-${String(((month - 1) % 12) + 1).padStart(2, "0")}-${String(1 + rand(28)).padStart(2, "0")}`;
    const items = [];
    for (let n = 1 + rand(3); n > 0; n--) {
      const p = products[rand(products.length)];
      items.push({ productId: p.id, name: p.name, category: p.category, quantity: 1 + rand(3), unitPrice: p.price });
    }
    const total = items.reduce((sum, item) => sum + item.quantity * item.unitPrice, 0);
    orders.push({
      id: "",
      date,
      status: statuses[rand(statuses.length)],
      shipping: { method: rand(2) ? "standard" : "express", address: "1 Example Street, Springfield" },
      items,
      total,
    });
  }
  // Oldest first, numbered in that order.
  orders.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  orders.forEach((order, i) => (order.id = `ORD-${10000 + i}`));
  return orders;
}
