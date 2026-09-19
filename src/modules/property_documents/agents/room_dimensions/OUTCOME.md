---
kind: research
---
```json
{
  "type": "array",
  "items": {
    "type": "object",
    "additionalProperties": false,
    "required": ["id", "name", "location", "dimensions", "confidence", "warnings"],
    "properties": {
      "id": { "type": "string", "minLength": 1 },
      "name": { "type": "string", "nullable": true, "minLength": 1 },
      "location": { "type": "string", "minLength": 1 },
      "dimensions": {
        "type": "array",
        "items": {
          "type": "object",
          "additionalProperties": false,
          "required": ["value", "unit", "orientation", "kind", "sourceText", "confidence"],
          "properties": {
            "value": { "type": "number" },
            "unit": { "type": "string", "nullable": true, "enum": ["mm", "cm", "m", "in", "ft"] },
            "orientation": { "type": "string", "enum": ["horizontal", "vertical", "height", "unknown"] },
            "kind": { "type": "string", "enum": ["linear", "ceiling_height", "unknown"] },
            "sourceText": { "type": "string", "minLength": 1 },
            "confidence": { "type": "number", "minimum": 0, "maximum": 1 }
          }
        }
      },
      "confidence": { "type": "number", "minimum": 0, "maximum": 1 },
      "warnings": {
        "type": "array",
        "items": { "type": "string", "minLength": 1 }
      }
    }
  }
}
```

The schema describes the caller-facing `data` array. Because the MCP adapter accepts a top-level object, pass the complete `{ "kind": "research", "data": [...] }` envelope as the `outcome` argument of `submit_outcome`. Do not add a `rooms` field. Each `data` element is one enclosed room and owns its own `dimensions` array. Use `data: []` when no room can be identified without inventing data. Do not include file paths, attachment IDs, calculations, hidden reasoning, or additional fields.
