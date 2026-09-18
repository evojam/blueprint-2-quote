---
kind: research
---
```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["brief"],
  "properties": {
    "brief": { "type": "string" }
  }
}
```

Pass an object, not a string, as the `outcome` argument of `submit_outcome`. The object must contain exactly one field, `brief`, whose value is the complete extracted text. Preserve meaningful line breaks and ordering when possible. Use `brief: ""` when the PDF has no extractable text. Do not include file paths, attachment IDs, analysis, summaries, or extra fields.
