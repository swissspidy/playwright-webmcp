---
"@swissspidy/eslint-plugin-webmcp": patch
---

`tool-title-missing` and `annotations-explicit` report a missing field at the tool's name. When the tool had an input schema, they pointed into it, at the schema's own `title` when it had one.
