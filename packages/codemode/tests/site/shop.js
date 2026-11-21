// A tiny multi-page shop. Every page registers its own WebMCP tools, so an agent has to
// follow the tool surface across navigations.
export { products } from "./catalog.js";

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
