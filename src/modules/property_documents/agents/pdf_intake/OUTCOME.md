---
kind: artifact
---
The PDF processing tool is the only output writer. Successful finalization creates strict `brief.json`, strict `pdf-pages.json`, and one `pdf-page-####.png` for every source page. List exactly the two JSON control files in the `artifacts` argument passed to `submit_outcome`; filesystem-authoritative capture collects every server-authored PNG from `out/`.

A safely rejected document leaves only the tool-authored `processing-error.json`. Never submit a partial success artifact set.

Pass a complete outcome object. On success, use this shape:

```text
{
  "kind": "artifact",
  "artifacts": [
    {
      "fileName": "brief.json",
      "mimeType": "application/json",
      "caption": "Exact raw text extracted from the PDF."
    },
    {
      "fileName": "pdf-pages.json",
      "mimeType": "application/json",
      "caption": "Ordered inventory of rendered PDF pages."
    }
  ],
  "summary": "Extracted the raw PDF text and rendered every page."
}
```

After a rejected document or failed finalization, use this shape:

```text
{
  "kind": "artifact",
  "artifacts": [
    {
      "fileName": "processing-error.json",
      "mimeType": "application/json",
      "caption": "PDF processing error report."
    }
  ],
  "summary": "PDF processing failed; see processing-error.json."
}
```
