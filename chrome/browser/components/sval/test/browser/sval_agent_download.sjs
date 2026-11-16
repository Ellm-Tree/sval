/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// A file served as an attachment, so loading it starts a download. The query
// names the file; `pdf` in it serves a PDF, which Firefox would otherwise
// open itself once it is saved.
function handleRequest(request, response) {
  const query = new URLSearchParams(request.queryString);
  const name = query.get("name") || "report.txt";
  const pdf = query.has("pdf");
  response.setHeader("Cache-Control", "no-cache", false);
  response.setHeader(
    "Content-Type",
    pdf ? "application/pdf" : "application/octet-stream",
    false
  );
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${name}"`,
    false
  );
  response.write(pdf ? "%PDF-1.4\n%%EOF\n" : "agent download body\n");
}
