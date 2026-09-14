/**
 * Tool definitions kept next to the data they operate on. They are plain
 * objects, so `useWebMCP(searchTool)` registers them and the ESLint plugin
 * lints them where they are written (it follows `const` bindings).
 */
export const catalogue = [
  { id: 1, name: "Red shirt", price: 20 },
  { id: 2, name: "Blue shirt", price: 22 },
  { id: 3, name: "Green hat", price: 12 },
];

export const searchTool = {
  name: "search_products",
  description: "Search the product catalogue by keyword. Returns matching products with id, name and price.",
  inputSchema: {
    type: "object",
    properties: { query: { type: "string", description: "Keyword to search for, matched against product names" } },
    required: ["query"],
  },
  annotations: { readOnlyHint: true },
  execute({ query }) {
    const q = String(query).toLowerCase();
    return { products: catalogue.filter((p) => p.name.toLowerCase().includes(q)) };
  },
};

/** A project-specific wrapper; eslint.config.js lists it under settings.webmcp.definitions. */
export function defineShopTool(tool) {
  return { ...tool, annotations: { consequentialHint: true, ...tool.annotations } };
}

export const addToCartTool = (cart, setCart) =>
  defineShopTool({
    name: "add_to_cart",
    description: "Add a product to the shopping cart by product id, with an optional quantity. Returns the cart total.",
    inputSchema: {
      type: "object",
      properties: {
        productId: { type: "number", description: "Id of the product from search_products" },
        quantity: { type: "number", description: "How many to add; defaults to 1", minimum: 1 },
      },
      required: ["productId"],
    },
    execute({ productId, quantity = 1 }) {
      const product = catalogue.find((p) => p.id === productId);
      if (!product) throw new Error(`Unknown product ${productId}`);
      const next = [...cart, { product, quantity }];
      setCart(next);
      return { items: next.length, total: next.reduce((sum, item) => sum + item.product.price * item.quantity, 0) };
    },
  });
