---
title: Test form
description: Internal POST test form lab for checking a browser-submitted response in place.
---

# Test form

Use this page as a plain test form. It is intentionally not wired to watasu,
Agent Cards, external agents, or any hosted submit route.

The form below sends one JSON `POST` request to this docs site's internal
`/api/test-form` endpoint and shows the response status, content type, request
JSON, and response body on this page. It does not save submissions, add them to
the URL, write them to localStorage/sessionStorage, or print them to the
console.
