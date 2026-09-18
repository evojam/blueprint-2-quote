---
kind: artifact
---
The PDF processing tool is the only output writer. A successful finalization atomically creates validated `brief.json`, `floor-plans.json`, and one `floor-plan-page-####.png` for every page classified as a floor plan. List only the two JSON manifests in the `artifacts` argument passed to `submit_outcome`; filesystem-authoritative capture collects the server-authored PNG files from `out/`.

A safely rejected document leaves only the tool-authored, schema-valid `processing-error.json`. Never submit a partial success artifact set.

Pass a complete outcome object. On success, use this shape:

```text
{
  "kind": "artifact",
  "artifacts": [
    {
      "path": "brief.json",
      "fileName": "brief.json",
      "mimeType": "application/json",
      "caption": "Validated property brief manifest."
    },
    {
      "path": "floor-plans.json",
      "fileName": "floor-plans.json",
      "mimeType": "application/json",
      "caption": "Validated floor-plan manifest."
    }
  ],
  "summary": "Processed the PDF into a property brief and floor-plan artifacts."
}
```

After a rejected document or failed finalization, use this shape:

```text
{
  "kind": "artifact",
  "artifacts": [
    {
      "path": "processing-error.json",
      "fileName": "processing-error.json",
      "mimeType": "application/json",
      "caption": "PDF processing error report."
    }
  ],
  "summary": "PDF processing failed; see processing-error.json."
}
```
