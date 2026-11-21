export interface Order {
  id: string;
  date: string;
  status: "delivered" | "returned" | "canceled";
  shipping: { method: "standard" | "express"; address: string };
  items: Array<{ productId: number; name: string; category: string; quantity: number; unitPrice: number }>;
  total: number;
}

export function orderHistory(): Order[];
