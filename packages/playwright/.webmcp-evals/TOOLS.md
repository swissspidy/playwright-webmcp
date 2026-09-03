# WebMCP tools seen by the test suite

## `add_to_cart`

Add a product to the shopping cart by product id, with an optional quantity. Returns the cart total.

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `productId` | number | yes | Id of the product from search_products |
| `quantity` | number | no | How many to add; defaults to 1 |

Example:

```json
{
  "tool": "add_to_cart",
  "arguments": {
    "productId": 1,
    "quantity": 2
  },
  "result": {
    "items": 1,
    "total": 40
  }
}
```

## `checkout`

Start the checkout flow for the current cart.

_Registered imperatively._

No parameters.

## `find_products`

Search the product catalogue by keyword and return matching products.

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Keyword |

## `flaky`

Always fails, to show that runtime errors on valid input are reported.

_Registered imperatively._

No parameters.

## `host_tool`

Return the current checkout summary including item count and subtotal for the host page.

_Registered imperatively._

No parameters.

## `list_reviews`

List customer reviews for a product id, newest first. Returns rating and text for each review.

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `productId` | number | yes | Product id to list reviews for |

Example:

```json
{
  "tool": "list_reviews",
  "arguments": {
    "productId": 1
  },
  "result": {
    "reviews": [
      {
        "productId": 1,
        "rating": 5,
        "text": "Great"
      }
    ]
  }
}
```

## `log in`

_Registered declaratively (form)._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `username` | string | no |  |
| `password` | string | no |  |

## `lookup`

Look up a product by id and return a record that contains a null field.

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `id` | number | yes |  |

Example:

```json
{
  "tool": "lookup",
  "arguments": {
    "id": 1
  },
  "result": {
    "id": 1,
    "name": "Thing",
    "discount": null
  }
}
```

## `lookup_products`

Search the product catalogue by keyword and return the matching products.

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | no | Keyword |
| `apiKey` | string | no | Key |

## `partner_private`

Internal partner diagnostics that must not be reachable from the embedding page.

_Registered imperatively._

No parameters.

Example:

```json
{
  "tool": "partner_private",
  "arguments": {},
  "result": {
    "secret": true
  }
}
```

## `partner_quote`

Get a shipping quote from the partner carrier for a destination country and parcel weight in kilograms.

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `country` | string | yes | ISO country code of the destination |
| `weightKg` | number | no | Parcel weight in kilograms |

Example:

```json
{
  "tool": "partner_quote",
  "arguments": {
    "country": "CH",
    "weightKg": 2
  },
  "result": {
    "country": "CH",
    "weightKg": 2,
    "price": 15,
    "currency": "CHF"
  }
}
```

## `quick_search`

Search

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `q` | string | no |  |

## `search_products`

Search the product catalogue by keyword. Returns matching products with id, name and price.

_Registered imperatively._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `query` | string | yes | Keyword to search for, matched against product names |

Example:

```json
{
  "tool": "search_products",
  "arguments": {
    "query": "shirt"
  },
  "result": {
    "products": [
      {
        "id": 1,
        "name": "Red shirt",
        "price": 20
      },
      {
        "id": 2,
        "name": "Blue shirt",
        "price": 22
      }
    ]
  }
}
```

## `subscribe_newsletter`

Subscribe an email address to the weekly newsletter and confirm the subscription.

_Registered declaratively (form)._

| Parameter | Type | Required | Description |
| --- | --- | --- | --- |
| `email` | string | yes | Email address to subscribe |
| `frequency` | "weekly" \| "monthly" | no | How often to send the newsletter |

Example:

```json
{
  "tool": "subscribe_newsletter",
  "arguments": {
    "email": "a@example.com",
    "frequency": "monthly"
  },
  "result": {
    "subscribed": "a@example.com",
    "agent": true
  }
}
```
