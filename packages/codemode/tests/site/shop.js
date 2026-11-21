// A tiny multi-page shop. Every page registers its own WebMCP tools, so an agent has to
// follow the tool surface across navigations.
export const products = [
  { id: 1, name: "Espresso machine", category: "kitchen", price: 349 },
  { id: 2, name: "Burr grinder", category: "kitchen", price: 129 },
  { id: 3, name: "Desk lamp", category: "office", price: 59 },
  { id: 4, name: "Milk frother", category: "kitchen", price: 39 },
];

export const mc = document.modelContext ?? navigator.modelContext;

export function cart() {
  return JSON.parse(localStorage.getItem("cart") ?? "[]");
}

export function saveCart(items) {
  localStorage.setItem("cart", JSON.stringify(items));
}

/** MCP-style text content holding JSON, as many WebMCP tools return today. */
export function json(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
